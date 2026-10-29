  const cxStableResourceUrl = (raw, base, kind = "work") => {
    if (typeof raw !== "string" || !raw) return "";
    try {
      const url = new URL(raw, base);
      const keys = kind === "context" ? ["courseid", "clazzid", "classid", "cpi", "userid"]
        : kind === "chapter" ? ["courseid", "clazzid", "classid", "cpi", "knowledgeid", "chapterid", "cardid", "num", "page", "pageid", "id"]
        : ["workid", "jobid", "courseid", "clazzid", "classid", "cpi", "knowledgeid", "chapterid", "activityid"];
      const params = [...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]);
      const identified = kind === "context" ? params.some(([key]) => keys.includes(key))
        : params.some(([key]) => (kind === "chapter" ? ["knowledgeid", "chapterid", "cardid"] : ["workid", "jobid"]).includes(key));
      const selected = params.filter(([key]) => identified ? keys.includes(key) : !/^(?:_|t|ts|timestamp|r|random|enc|token|ktoken|enc2|callback|v)$/.test(key));
      selected.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
      url.search = "";
      url.hash = "";
      for (const [key, value] of selected) url.searchParams.append(key, value);
      return url.href;
    } catch { return raw.split("#")[0]; }
  };
  const cxWorkFingerprint = (handler) => {
    try {
      if (typeof handler.parseHtml !== "function") return "";
      handler.questions = [];
      handler.parseHtml();
      if (!handler.questions.length) return "";
      return JSON.stringify(handler.questions.map((question) => ({
        stem: question.searchText?.stem ?? question.title ?? "",
        options: question.searchText?.options ?? question.optionsText ?? Object.keys(question.options || {}),
        images: (question.searchText?.images || []).map(({marker, element}) => [marker, element?.currentSrc || "", ...["src", "srcset", "sizes", "data-src", "data-original", "data-lazy-src", "lazy-src"].map((name) => element?.getAttribute?.(name) || "")]),
        controls: Array.from(question.element?.querySelectorAll?.('input, textarea, [contenteditable="true"]') || [])
          .filter((field) => String(field.tagName).toLowerCase() !== "input" || (field.getAttribute?.("type") || "text").toLowerCase() !== "hidden")
          .map((field) => [String(field.tagName || "").toLowerCase(), field.type || field.getAttribute?.("type") || ""])
      })));
    } catch { return ""; }
  };
  const cxChapterNavigationAllowed = (element) => {
    try {
      if (!element || element.isConnected === false || element.disabled || element.getAttribute?.("aria-disabled") === "true" || element.getAttribute?.("disabled") != null || element.matches?.(":disabled,.disabled,.is-disabled")) return false;
      const view = element.ownerDocument?.defaultView;
      for (let current = element; current; current = current.parentElement) {
        const style = view?.getComputedStyle?.(current) || current.style;
        if (current.disabled || current.getAttribute?.("aria-disabled") === "true" || current.getAttribute?.("disabled") != null || current.matches?.(":disabled,.disabled,.is-disabled")) return false;
        if (current.hidden || current.getAttribute?.("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0" || style?.pointerEvents === "none") return false;
      }
      return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
    } catch { return false; }
  };
  const cxGetChapterNavigation = (root, outerDocument) => {
    const find = (scope, selector) => {
      const matches = Array.from(scope?.querySelectorAll?.(selector) || []);
      const first = scope?.querySelector?.(selector);
      if (first && !matches.includes(first)) matches.unshift(first);
      return [...new Set(matches)];
    };
    const modern = find(root, "#prevNextFocusNext");
    const legacy = find(outerDocument, ".jb_btn.jb_btn_92.fr.fs14.nextChapter");
    const available = (buttons) => buttons.filter((button) => typeof button.click === "function" && cxChapterNavigationAllowed(button));
    const modernAvailable = available(modern);
    const legacyAvailable = available(legacy);
    const base = { modern, legacy, modernAvailable, legacyAvailable };
    const select = (element, kind, label, selector) => ({ ...base, element, kind, label, selector,
      // Keep navigation attributes in memory only; they can contain signed
      // paths. A reused DOM node must not change its destination while waiting.
      action: JSON.stringify(["href", "onclick", "data-url", "data-href", "data-knowledgeid", "data-chapterid", "data-cardid", "data-nextid"].map((name) => element.getAttribute?.(name) ?? null)),
      handler: element.onclick
    });
    // These are alternative platform controls. A hidden legacy control must
    // not block the visible next-section button shown on the current page.
    if (modernAvailable.length === 1) return select(modernAvailable[0], "section", "下一节", "#prevNextFocusNext");
    if (modernAvailable.length > 1) return { ...base, element: null, reason: "存在多个可用的下一节按钮，无法确定跳转目标" };
    if (legacyAvailable.length === 1) return select(legacyAvailable[0], "chapter", "下一章", ".nextChapter");
    return { ...base, element: null, reason: legacyAvailable.length > 1 ? "存在多个可用的下一章按钮，无法确定跳转目标" : "下一节和下一章按钮均不可用" };
  };
  const useCxChapterLogic = () => {
    const logStore = useLogStore();
    const questionStore = useQuestionStore();
    const init = () => {
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get("mooc2") !== "1") {
        currentUrl.searchParams.set("mooc2", "1");
        window.location.href = currentUrl.href;
      }
      questionStore.clearQuestion();
      logStore.addLog(`检测到用户进入到章节学习页面`, "primary");
      logStore.addLog(`正在解析任务点，请稍等5-10秒（如果长时间没有反应，请刷新页面）`, "warning");
    };
    const configStore = useConfigStore();
    const HOME_TAB_NAME = "0";
    const ANSWER_TAB_NAME2 = "1";
    const PDF_COMPLETION_WAIT_SECONDS = 5;
    let runningIframeDocumentTasks = /* @__PURE__ */ new WeakMap();
    let attemptedIframeDocuments = /* @__PURE__ */ new WeakMap();
    let currentPage;
    let chapterController = new AbortController();
    let currentWatchIframeTaskId = 0;
    let disposed = false;
    let activeScan;
    let lastFrames = [];
    let lastFrameChange = Date.now();
    let navigationPending = false;
    let lastCompletionMessage = "";
    let lastDiagnosticKey = "";
    let lastDiagnosticTime = 0;
    let lastNavigationMessage = "";
    let frameNumbers = new WeakMap();
    let nextFrameNumber = 0;
    let mutationScanTimer = null;
    const hasTaskClass = (element, name) => {
      const className = typeof element?.className === "string" ? element.className : "";
      return className.split(/\s+/).includes(name) || !!element?.classList?.contains(name);
    };
    const getTaskIconInfo = (iframe) => {
      // Bind a sibling icon to exactly one resource. A completed icon elsewhere
      // in the chapter must never mark another video or exercise complete.
      for (let container = iframe.parentElement; container; container = container.parentElement) {
        const icons = Array.from(container.children || []).filter((child) => hasTaskClass(child, "ans-job-icon"));
        if (icons.length) {
          const frames = Array.from(container.querySelectorAll?.("iframe") || []);
          return { container, icons: icons.length, frames: frames.length,
            icon: icons.length === 1 && frames.length === 1 && frames[0] === iframe ? icons[0] : null };
        }
        if (hasTaskClass(container, "ans-attach-ct") || /^(?:BODY|HTML)$/i.test(container.tagName || ""))
          return { container, icons: 0, frames: container.querySelectorAll?.("iframe")?.length || 0, icon: null };
      }
      return { container: iframe.parentElement, icons: 0, frames: 0, icon: null };
    };
    const getTaskIcon = (iframe) => getTaskIconInfo(iframe).icon;
    const getTaskCompletionMarker = (iframe) => {
      let element = iframe;
      while (element) {
        if (hasTaskClass(element, "ans-job-finished")) return element === iframe ? "iframe 完成标记" : "祖先容器完成标记";
        if (hasTaskClass(element, "ans-attach-ct")) break;
        element = element.parentElement;
      }
      return hasTaskClass(getTaskIcon(iframe), "ans-job-finished") ? "所属任务图标完成标记" : "";
    };
    const isFinishedTask = (iframe) => !!getTaskCompletionMarker(iframe);
    const getChapterScope = (root = document.documentElement) => {
      const outerFrames = Array.from(root?.querySelectorAll?.("iframe") || []);
      const isCardsFrame = (iframe) => {
        try { return /\/knowledge\/cards(?:\/|$)/i.test(new URL(iframe.src || "", window.location.href).pathname); }
        catch { return false; }
      };
      // The outer study page also contains editor, upload and helper frames.
      // Select the chapter before walking its descendants, never by DOM order.
      let candidates = outerFrames.filter(isCardsFrame);
      if (!candidates.length) candidates = outerFrames.filter((iframe) => (iframe.id || iframe.getAttribute?.("id")) === "iframe" && !isTaskFrame(iframe));
      if (!candidates.length) candidates = outerFrames.filter((iframe) => {
        const raw = typeof iframe.getAttribute === "function" ? iframe.getAttribute("src") : iframe.src;
        return !!raw?.trim() && !/^(?:about:|javascript:|data:)/i.test(raw.trim())
          && !hasTaskClass(iframe, "edui-default") && !isTaskFrame(iframe);
      });
      const iframe = candidates.length === 1 ? candidates[0] : null;
      return { iframe, ignoredCount: iframe ? outerFrames.length - 1 : 0,
        reason: candidates.length > 1 ? "发现多个章节主页面，无法确认当前章节，暂停自动处理"
          : !iframe ? "未找到可确认的章节主页面，等待平台加载" : "" };
    };
    const getChapterPage = (scope = getChapterScope()) => {
      const { iframe } = scope;
      let iframeDocument = null;
      try { iframeDocument = iframe?.contentDocument || null; } catch { /* diagnosed below */ }
      return {
        url: window.location.href,
        iframe,
        src: (iframe == null ? void 0 : iframe.src) || "",
        document: iframeDocument
      };
    };
    const isSamePage = (left, right) => left.url === right.url && left.iframe === right.iframe && left.src === right.src && left.document === right.document;
    const collectChapterFrames = (root, scope = getChapterScope(root)) => {
      const result = [];
      const visited = new Set();
      const visit = (iframe) => {
        if (visited.has(iframe)) return;
        visited.add(iframe);
        result.push(iframe);
        // Platform completion is authoritative. An already completed player's
        // internal blank/cross-origin helper frames are not additional tasks.
        if (isTaskFrame(iframe) && isFinishedTask(iframe)) return;
        try {
          for (const child of Array.from(iframe.contentDocument?.documentElement?.querySelectorAll?.("iframe") || [])) visit(child);
        } catch {
          // Cross-origin task frames remain in the list and block completion.
        }
      };
      const { iframe } = scope;
      if (iframe) visit(iframe);
      return result;
    };
    // Reuse only within the current synchronous scan. Any later callback or
    // post-delay navigation check creates a fresh collection.
    const collectChapterState = (root, scope = getChapterScope(root)) => ({
      scope, iframes: collectChapterFrames(root, scope)
    });
    const isTaskFrame = (iframe) => /api\/work|modules\/(?:video|audio|ppt|doc|pdf|innerbook)/i.test(iframe.src || "") || !!getTaskIcon(iframe);
    const isWorkConfirmed = (iframe, iframeDocument) => {
      if (isFinishedTask(iframe)) return true;
      const status = iframeDocument?.querySelector?.(".work-status,.workStatus,#workStatus,[data-work-status]");
      return !!status && /^(?:已完成|待批阅|已提交)(?:\s|$)/.test((status.textContent || status.getAttribute?.("data-work-status") || "").trim());
    };
    const chapterSnapshot = (root, iframes = collectChapterFrames(root)) => iframes.map((iframe) => {
      let doc = null;
      try { doc = iframe.contentDocument; } catch { /* inaccessible */ }
      return { iframe, doc, src: iframe.src, ready: doc?.readyState, finished: isFinishedTask(iframe) };
    });
    const sameFrameSnapshot = (left, right) => left.length === right.length && left.every((item, index) => {
      const other = right[index];
      return item.iframe === other.iframe && item.doc === other.doc && item.src === other.src && item.ready === other.ready && item.finished === other.finished;
    });
    const frameNumber = (iframe) => {
      if (!frameNumbers.has(iframe)) frameNumbers.set(iframe, ++nextFrameNumber);
      return frameNumbers.get(iframe);
    };
    const safeFrameAddress = (raw) => {
      if (!raw) return "未设置地址";
      try {
        const parsed = new URL(raw, window.location.href);
        if (/^https?:$/.test(parsed.protocol)) return (parsed.origin + parsed.pathname).slice(0, 220);
        return parsed.protocol === "about:" ? "about:blank/srcdoc" : parsed.protocol + "（地址已省略）";
      } catch { return "无法解析的地址（已省略）"; }
    };
    const inspectChapterCompletion = (root, collection) => {
      const scope = collection?.scope || getChapterScope(root);
      const frames = (collection?.iframes || collectChapterFrames(root, scope)).filter((iframe) => !/^javascript:/i.test(iframe.src || "")).map((iframe) => {
        const task = isTaskFrame(iframe);
        const marker = getTaskCompletionMarker(iframe);
        const iconInfo = getTaskIconInfo(iframe);
        const src = iframe.src || "";
        const type = /api\/work/i.test(src) ? "作业" : /modules\/video/i.test(src) ? "视频"
          : /modules\/audio/i.test(src) ? "音频" : /modules\/(?:ppt|doc|pdf)/i.test(src) ? "文档"
          : /modules\/innerbook/i.test(src) ? "电子书" : task ? "其他任务" : "容器";
        let doc = null;
        let documentState = "不可访问或尚未创建";
        let workConfirmed = false;
        let media = null;
        try {
          doc = iframe.contentDocument;
          if (doc) {
            documentState = doc.readyState !== "complete" ? "加载中（" + doc.readyState + "）"
              : doc.URL === "about:blank" ? "空白页 about:blank" : "已加载";
            if (type === "作业") workConfirmed = isWorkConfirmed(iframe, doc);
            if (type === "视频" || type === "音频") {
              const element = doc.documentElement?.querySelector?.("video, audio");
              if (element) media = { current: Number.isFinite(element.currentTime) ? Math.floor(element.currentTime) : null,
                duration: Number.isFinite(element.duration) ? Math.floor(element.duration) : null,
                ended: !!element.ended, paused: !!element.paused };
            }
          }
        } catch { documentState = "不可访问（跨域或读取失败）"; }
        const confirmed = !!marker || workConfirmed;
        let blocked = "";
        if (!iframe.isConnected) blocked = "页面已从文档移除";
        else if (task && marker) { /* platform marker is authoritative */ }
        else if (!doc || doc.readyState !== "complete" || doc.URL === "about:blank") blocked = documentState;
        else if (task && !confirmed) blocked = media?.ended ? "播放已结束，但未识别到平台完成标记" : "未识别到平台完成标记";
        const rawSource = typeof iframe.getAttribute === "function" ? iframe.getAttribute("src") : iframe.src;
        const sourceState = !rawSource?.trim() ? "未设置或为空" : safeFrameAddress(rawSource);
        return { iframe, number: frameNumber(iframe), task, type, marker: marker || (workConfirmed ? "平台作业提交状态" : "无"),
          confirmed, blocked, address: safeFrameAddress(src), documentState, media,
          sourceState,
          classes: typeof iframe.className === "string" ? iframe.className.slice(0, 120) : "",
          containerClasses: typeof iconInfo.container?.className === "string" ? iconInfo.container.className.slice(0, 160) : "",
          iconClasses: typeof iconInfo.icon?.className === "string" ? iconInfo.icon.className.slice(0, 160) : "",
          iconCount: iconInfo.icons, resourceCount: iconInfo.frames };
      });
      const tasks = frames.filter((frame) => frame.task);
      return { frames, tasks, scope, complete: !scope.reason && tasks.length > 0 && !frames.some((frame) => frame.blocked) };
    };
    const canAdvanceChapter = (root) => inspectChapterCompletion(root).complete;
    const logChapterNavigation = (message) => {
      if (message === lastNavigationMessage) return;
      lastNavigationMessage = message;
      logStore.addLog("[章节诊断] 跳章：" + message, "primary");
    };
    const logChapterDiagnostics = (root, phase = "", inspection, collection) => {
      try {
        const report = inspection || inspectChapterCompletion(root, collection);
        const autoNext = !!configStore.platformParams.cx.parts[0].params[1].value;
        const onlyAnswers = !!configStore.platformParams.cx.parts[0].params[2]?.value;
        const navigation = cxGetChapterNavigation(root, document);
        const buttonState = (buttons, available) => !buttons.length ? "未找到" : available.length === 1 ? "可用" : available.length > 1 ? "多个可用，归属不明" : "隐藏或禁用";
        const modernState = buttonState(navigation.modern, navigation.modernAvailable);
        const legacyState = buttonState(navigation.legacy, navigation.legacyAvailable);
        const selectedControl = navigation.element ? navigation.label + " " + navigation.selector : "无（" + navigation.reason + "）";
        const blocked = report.frames.filter((frame) => frame.blocked);
        const reason = report.scope.reason || (!report.frames.length ? "未发现章节 iframe"
          : blocked.length ? blocked.slice(0, 20).map((frame) => "页面#" + frame.number + "：" + frame.blocked).join("；") + (blocked.length > 20 ? "；另有 " + (blocked.length - 20) + " 个阻塞页面" : "")
          : !report.tasks.length ? "未识别到任务页面"
          : !autoNext ? "平台任务已完成，自动跳章开关关闭"
          : Date.now() - lastFrameChange < 1500 ? "平台任务已完成，等待页面稳定 1.5 秒"
          : !navigation.element ? "平台任务已完成，下一步按钮不可用（" + navigation.reason + "）"
          : navigationPending ? "已进入跳章流程，等待平台页面切换" : "完成条件满足，可以跳章");
        const slowFrame = activeScan?.frame && Date.now() - activeScan.frameStartedAt >= 1000 ? frameNumber(activeScan.frame) : 0;
        const processing = slowFrame ? "正在处理页面#" + slowFrame : phase || "扫描状态";
        // The playback position is useful in the message but must not make a
        // progressing video emit a new diagnostic on every 500 ms poll.
        const key = JSON.stringify([reason, phase, slowFrame, autoNext, onlyAnswers, modernState, legacyState, selectedControl,
          report.frames.map(({ iframe, media, ...frame }) => ({ ...frame, media: media && { ended: media.ended, paused: media.paused, duration: media.duration } }))]);
        const now = Date.now();
        if (key === lastDiagnosticKey && now - lastDiagnosticTime < 30000) return;
        lastDiagnosticKey = key;
        lastDiagnosticTime = now;
        logStore.addLog(`[章节诊断] ${processing}：${report.frames.length} 个页面，${report.tasks.length} 个任务，${report.tasks.filter((frame) => frame.confirmed).length} 个已确认；自动跳章=${autoNext ? "开" : "关"}，只答题=${onlyAnswers ? "开" : "关"}`, "primary");
        if (report.scope.ignoredCount) logStore.addLog(`[章节诊断] 扫描范围仅限章节主页面及其内容，已排除外层 ${report.scope.ignoredCount} 个非章节框架（编辑器或辅助页面）`, "info");
        const rows = report.frames.length <= 20 ? report.frames : [...blocked, ...report.frames.filter((frame) => !frame.blocked)].slice(0, 20);
        for (const frame of rows) {
          const media = frame.media ? `；播放=${frame.media.current ?? "未知"}/${frame.media.duration ?? "未知"}秒，结束=${frame.media.ended ? "是" : "否"}，暂停=${frame.media.paused ? "是" : "否"}` : "";
          logStore.addLog(`[章节诊断] 页面#${frame.number} ${frame.type}；${frame.address}；原始src=${frame.sourceState}；文档=${frame.documentState}；完成依据=${frame.marker}；iframe类=${frame.classes || "无"}；容器类=${frame.containerClasses || "无"}；图标类=${frame.iconClasses || "未唯一绑定"}；直属图标=${frame.iconCount}，容器内资源=${frame.resourceCount}${media}；${frame.blocked ? "阻塞=" + frame.blocked : "未阻塞"}${frame.task && frame.marker !== "无" ? "（不检查已完成任务的内部辅助页）" : ""}`, frame.blocked ? "warning" : "info");
        }
        if (report.frames.length > rows.length) logStore.addLog(`[章节诊断] 本组仅列出 ${rows.length}/${report.frames.length} 个页面，优先显示阻塞项`, "info");
        logStore.addLog("[章节诊断] 当前原因：" + reason + `；任务下一步=${modernState}，章节下一章=${legacyState}；本次选择=${selectedControl}`, report.complete ? "primary" : "warning");
      } catch {
        // Diagnostics are observational; DOM changes while inspecting must not
        // interrupt the existing task processor or relax completion checks.
        const now = Date.now();
        if (lastDiagnosticKey !== "diagnostic-read-failed" || now - lastDiagnosticTime >= 30000) {
          lastDiagnosticKey = "diagnostic-read-failed";
          lastDiagnosticTime = now;
          logStore.addLog("[章节诊断] 读取状态时页面发生变化，下次扫描会重新记录", "info");
        }
      }
    };
    const checkChapterCompletion = async (root, context, taskId) => {
      if (!context.isCurrent() || taskId !== currentWatchIframeTaskId || navigationPending) return;
      const collection = collectChapterState(root);
      const report = inspectChapterCompletion(root, collection);
      const complete = report.complete;
      logChapterDiagnostics(root, "", report);
      const message = complete ? "平台已确认本页任务完成" : "本页任务仍在处理中，完成后继续按设置切换。";
      if (message !== lastCompletionMessage) {
        lastCompletionMessage = message;
        logStore.addLog(message, complete ? "success" : "info");
      }
      if (!complete || !configStore.platformParams.cx.parts[0].params[1].value || Date.now() - lastFrameChange < 1500) return;
      const before = chapterSnapshot(root, collection.iframes);
      const navigation = cxGetChapterNavigation(root, document);
      const button = navigation.element;
      if (!button) return;
      const page = typeof getChapterPage === "function" ? getChapterPage() : null;
      const chapterKey = page ? JSON.stringify([cxStableResourceUrl(page.url, page.url, "chapter"), cxStableResourceUrl(page.src, page.url, "chapter")]) : "";
      const departed = checkChapterCompletion.departed || (checkChapterCompletion.departed = new Set());
      if (chapterKey && departed.has(chapterKey)) {
        navigationPending = true;
        logChapterNavigation("已停止：当前章节之前已经离开，触发防循环保护");
        logStore.addLog("检测到已经离开的章节再次出现，已停止自动跳章，请手动核对课程进度", "warning");
        return;
      }
      navigationPending = true;
      logChapterNavigation("检查通过，已选择" + navigation.label + "，等待设置的操作间隔后再次核对");
      const allowed = await aiWaitForDelay(Number(configStore.otherParams.params[0].value) || 0, {
        signal: context.signal,
        isCurrent: () => context.isCurrent() && taskId === currentWatchIframeTaskId && !!configStore.platformParams.cx.parts[0].params[1].value
      });
      if (!allowed) {
        if (taskId === currentWatchIframeTaskId) {
          navigationPending = false;
          if (context.isCurrent()) logChapterNavigation("已取消：跳章开关关闭或当前处理已中止");
        }
        return;
      }
      if (!context.isCurrent() || taskId !== currentWatchIframeTaskId) return;
      if (!configStore.platformParams.cx.parts[0].params[1].value) {
        navigationPending = false;
        logChapterNavigation("已取消：自动跳章开关关闭");
        return;
      }
      const afterCollection = collectChapterState(root);
      const after = chapterSnapshot(root, afterCollection.iframes);
      const afterReport = inspectChapterCompletion(root, afterCollection);
      if (!sameFrameSnapshot(before, after) || !afterReport.complete) {
        navigationPending = false;
        logChapterNavigation("已取消：等待期间页面、任务或完成状态发生变化，将重新检查");
        logChapterDiagnostics(root, "", afterReport);
        return;
      }
      const currentNavigation = cxGetChapterNavigation(root, document);
      if (currentNavigation.element !== button || currentNavigation.kind !== navigation.kind || currentNavigation.action !== navigation.action || currentNavigation.handler !== navigation.handler || !cxChapterNavigationAllowed(button)) {
        navigationPending = false;
        logChapterNavigation("已取消：下一步按钮被替换、隐藏、禁用或跳转目标改变");
        return;
      }
      if (chapterKey) departed.add(chapterKey);
      try {
        logChapterNavigation("已点击" + navigation.label + "（" + navigation.selector + "），等待平台切换页面");
        button.click();
      }
      catch (error) {
        if (chapterKey) departed.delete(chapterKey);
        navigationPending = false;
        throw error;
      }
    };
    const onRootIframeLoad = () => processIframeTask(true);
    const processIframeTask = (force = false) => {
      var _a, _b;
      if (disposed)
        return;
      if (mutationScanTimer !== null) {
        clearTimeout(mutationScanTimer);
        mutationScanTimer = null;
      }
      const root = document.documentElement;
      const scope = getChapterScope(root);
      const page = getChapterPage(scope);
      const changed = !currentPage || !isSamePage(currentPage, page);
      if (changed) {
        (_a = currentPage == null ? void 0 : currentPage.iframe) == null ? void 0 : _a.removeEventListener("load", onRootIframeLoad);
        chapterController.abort();
        chapterController = new AbortController();
        ++currentWatchIframeTaskId;
        runningIframeDocumentTasks = /* @__PURE__ */ new WeakMap();
        attemptedIframeDocuments = /* @__PURE__ */ new WeakMap();
        activeScan = null;
        lastFrames = [];
        lastFrameChange = Date.now();
        navigationPending = false;
        lastCompletionMessage = "";
        lastDiagnosticKey = "";
        lastDiagnosticTime = 0;
        lastNavigationMessage = "";
        frameNumbers = new WeakMap();
        nextFrameNumber = 0;
        questionStore.clearQuestion();
        configStore.menuIndex = HOME_TAB_NAME;
        currentPage = page;
        (_b = page.iframe) == null ? void 0 : _b.addEventListener("load", onRootIframeLoad);
      }
      if (!page.iframe || !page.document || page.document.readyState !== "complete" || page.document.URL === "about:blank") {
        logChapterDiagnostics(root, "等待章节主页面加载", null, {scope});
        return;
      }
      const collection = collectChapterState(root, scope);
      const frames = chapterSnapshot(root, collection.iframes);
      if (!sameFrameSnapshot(lastFrames, frames)) {
        lastFrames = frames;
        lastFrameChange = Date.now();
      }
      logChapterDiagnostics(root, "", null, collection);
      if (activeScan) return;
      const signal = chapterController.signal;
      watchIframe(root, {
        signal,
        // 直接检查页面，避免在轮询发现切换之前，旧请求已返回。
        isCurrent: () => !signal.aborted && isSamePage(page, getChapterPage())
      }, collection.iframes);
    };
    const watchIframe = (documentElement, context, allIframes = collectChapterFrames(documentElement)) => {
      const thisTaskId = currentWatchIframeTaskId;
      const scan = {};
      activeScan = scan;
      const release = () => { if (activeScan === scan) activeScan = null; };
        rxjs.from(allIframes).pipe(concatMap((iframe) => {
          if (thisTaskId !== currentWatchIframeTaskId || !context.isCurrent())
            return Promise.resolve();
          scan.frame = iframe;
          scan.frameStartedAt = Date.now();
          return processIframe(iframe, context).finally(() => {
            if (scan.frame === iframe) scan.frame = null;
          });
        })).subscribe({
          complete: async () => {
            try { await checkChapterCompletion(documentElement, context, thisTaskId); }
            catch { if (context.isCurrent()) logStore.addLog("章节状态读取失败，下次扫描会重试；持续异常时请刷新课程页。", "warning"); }
            finally { release(); }
          },
          error: () => {
            release();
            if (context.isCurrent()) {
              logStore.addLog("当前任务处理失败，请检查播放器或任务页面状态后重试。", "danger");
            }
          }
        });
    };
    const processMedia = async (mediaType, iframe, iframeDocument, context) => {
      return new Promise((resolve, reject) => {
        logStore.addLog(`发现一个${mediaType}，正在解析`, "warning");
        logStore.addLog(`正在尝试播放${mediaType}，请稍等5s`, "primary");
        let isExecuted = false;
        let settled = false;
        let mediaElement = null;
        let quiz;
        let resuming = false;
        const cleanup = () => {
          clearInterval(intervalId2);
          quiz == null ? void 0 : quiz.dispose();
          mediaElement == null ? void 0 : mediaElement.removeEventListener("pause", resume);
          mediaElement == null ? void 0 : mediaElement.removeEventListener("ended", ended);
          context.signal.removeEventListener("abort", finish);
        };
        const finish = () => {
          if (settled)
            return;
          settled = true;
          cleanup();
          mediaElement == null ? void 0 : mediaElement.pause();
          resolve();
        };
        const fail = (error) => {
          if (settled)
            return;
          settled = true;
          cleanup();
          reject(error);
        };
        const resume = async () => {
          if (settled || resuming || (quiz == null ? void 0 : quiz.hasActiveQuiz()))
            return;
          resuming = true;
          try {
            await sleep(configStore.otherParams.params[0].value);
            if (settled)
              return;
            if (!context.isCurrent())
              return finish();
            if (isFinishedTask(iframe))
              return finish();
            if ((quiz == null ? void 0 : quiz.hasActiveQuiz()) || (mediaElement == null ? void 0 : mediaElement.ended))
              return;
            await (mediaElement == null ? void 0 : mediaElement.play());
          } catch (error) {
            fail(error);
          } finally {
            resuming = false;
          }
        };
        const ended = () => {
          if (quiz == null ? void 0 : quiz.hasActiveQuiz())
            return;
          if (context.isCurrent())
            logStore.addLog(`${mediaType}已播放完成`, "success");
          finish();
        };
        const intervalId2 = setInterval(async () => {
          if (settled)
            return;
          if (!context.isCurrent())
            return finish();
          if (!isExecuted)
            mediaElement = iframeDocument.documentElement.querySelector(mediaType);
          if (isFinishedTask(iframe)) {
            logStore.addLog(`${mediaType}任务点已完成，跳过`, "success");
            return finish();
          }
          if (mediaElement && !isExecuted) {
            isExecuted = true;
            try {
              mediaElement.pause();
              mediaElement.muted = true;
              if (mediaType === "video") {
                quiz = watchVideoQuiz({
                  document: iframeDocument,
                  signal: context.signal,
                  isCurrent: () => !settled && context.isCurrent() && !isFinishedTask(iframe),
                  isEnabled: () => {
                    var _a;
                    const enabled = ((_a = configStore.platformParams.cx.parts[0].params.find((param) => param.name === VIDEO_QUIZ_SETTING)) == null ? void 0 : _a.value) !== false;
                    if (enabled && typeof aiHasConfiguredKey === "function" && !aiHasConfiguredKey(configStore)) {
                      if (quiz?.hasActiveQuiz()) aiLogMissingKey(logStore, "video-quiz", iframeDocument);
                      return false;
                    }
                    return enabled;
                  },
                  delayMs: () => Number(configStore.otherParams.params[0].value) * 1e3,
                  search: (question, searchContext) => getAnswer(question, { ...searchContext, skipDelay: true }),
                  similarityThreshold: () => {
                    var _a;
                    return Number(((_a = configStore.otherParams.params.find((param) => param.name.includes("相似"))) == null ? void 0 : _a.value) ?? 85);
                  },
                  publishQuestion: (question) => {
                    configStore.menuIndex = ANSWER_TAB_NAME2;
                    const row = vue.reactive(question);
                    questionStore.addQuestion(row);
                    return row;
                  },
                  onRelease: () => {
                    if (mediaElement == null ? void 0 : mediaElement.ended)
                      ended();
                    else if (mediaElement == null ? void 0 : mediaElement.paused)
                      void resume();
                  },
                  log: (message, type) => logStore.addLog(message, type)
                });
              }
              if (!(quiz == null ? void 0 : quiz.hasActiveQuiz()))
                await mediaElement.play();
              if (settled)
                return;
              if (!context.isCurrent())
                return finish();
              if (isFinishedTask(iframe))
                return finish();
              if (!(quiz == null ? void 0 : quiz.hasActiveQuiz()))
                logStore.addLog("播放成功", "success");
              mediaElement.addEventListener("pause", resume);
              mediaElement.addEventListener("ended", ended);
              if (mediaElement.ended)
                ended();
            } catch (error) {
              fail(error);
            }
          }
        }, 2500);
        context.signal.addEventListener("abort", finish, { once: true });
        if (!context.isCurrent())
          finish();
      });
    };
    const processWork = async (iframe, iframeDocument, iframeWindow, context) => {
      if (!context.isCurrent())
        return { state: "cancelled" };
      if (isWorkConfirmed(iframe, iframeDocument)) {
        logStore.addLog("作业已经完成，跳过", "success");
        return { state: "completed" };
      }
      if (typeof aiHasConfiguredKey === "function" && !aiHasConfiguredKey(configStore)) {
        aiLogMissingKey(logStore, "chapter", iframeDocument);
        return {state: "waiting-for-ai", isCurrent: context.isCurrent};
      }
      configStore.menuIndex = ANSWER_TAB_NAME2;
      logStore.addLog("发现一个作业，正在解析", "primary");
      decrypt(iframeDocument);
      logStore.addLog(`题目列表获取成功`, "primary");
      const handler = new CxQuestionHandler("zj", iframe);
      const fingerprint = cxWorkFingerprint(handler);
      const parentUrl = typeof window === "undefined" ? "" : window.location?.href || "";
      const workUrl = cxStableResourceUrl(iframe.src || iframeDocument.URL || "", parentUrl);
      const workKey = workUrl && fingerprint ? JSON.stringify([cxStableResourceUrl(parentUrl, parentUrl, "context"), workUrl, fingerprint]) : "";
      const logicalCurrent = () => context.isCurrent() && (!fingerprint || cxWorkFingerprint(handler) === fingerprint);
      // Documents and iframe elements can be replaced by a platform save. Keep
      // logical attempts for this page session rather than only by DOM identity.
      const attempts = processWork.attempts || (processWork.attempts = new Map());
      if (workKey && attempts.has(workKey)) {
        const previous = attempts.get(workKey);
        if (!previous.warned) {
          previous.warned = true;
          logStore.addLog("检测到同一作业的已处理题目重新加载，已停止重复解题和暂存，请手动核对保存状态；刷新学习页面可重新尝试", "warning");
        }
        return {state: "needs-review", isCurrent: logicalCurrent};
      }
      const attempt = {state: "running", warned: false};
      if (workKey) attempts.set(workKey, attempt);
      try { await handler.init(context.isCurrent); }
      catch {
        attempt.state = "needs-review";
        logStore.addLog("本次作业解析或解题中断，已停止自动重复尝试，请手动核对或刷新学习页面后重试", "warning");
        return {state: context.isCurrent() ? "needs-review" : "cancelled", isCurrent: logicalCurrent};
      }
      const result = handler.lastSolveResult;
      if (result?.skippedForMissingKey) {
        if (workKey) attempts.delete(workKey);
        return {state: "waiting-for-ai", isCurrent: logicalCurrent};
      }
      const isCurrent = () => context.isCurrent() && !!result && !result.cancelled && result.isCurrent();
      if (!isCurrent()) {attempt.state = "cancelled"; return { state: "cancelled" };}
      if (!result.total) {if (workKey) attempts.delete(workKey); return { state: "waiting" };}
      const outcome = (state) => {attempt.state = state; return { state, isCurrent: result.isCurrent };};
      const refresh = () => {
        if (typeof result.refreshVerification !== "function") return false;
        result.refreshVerification();
        return isCurrent();
      };
      try {
        if (!refresh()) return outcome("needs-review");
        const correctRate = result.rate;
        if (configStore.platformParams.cx.parts[0].params[0].value) {
          logStore.addLog("自动提交已开启，尝试提交", "primary");
          if (!Number.isFinite(correctRate) || result.filled < 1 || !Number.isFinite(Number(configStore.otherParams.params[1].value)) || correctRate < Math.max(1, Math.min(100, Number(configStore.otherParams.params[1].value)))) {
            logStore.addLog(`答案填写率小于${configStore.otherParams.params[1].value}%，暂存`, "danger");
            await iframeWindow.noSubmit();
            return outcome("saved");
          } else {
            logStore.addLog(`答案填写率达到${configStore.otherParams.params[1].value}%，提交`, "success");
            await iframeWindow.btnBlueSubmit();
            if (!isCurrent()) return { state: "cancelled" };
            const allowed = await aiWaitForDelay(Number(configStore.otherParams.params[0].value) / 2 || 0, {
              signal: context.signal,
              isCurrent: () => isCurrent() && !!configStore.platformParams.cx.parts[0].params[0].value
            });
            if (!allowed) return outcome("needs-review");
            if (!isCurrent()) return { state: "cancelled" };
            if (!configStore.platformParams.cx.parts[0].params[0].value || !refresh() || !Number.isFinite(Number(configStore.otherParams.params[1].value)) || result.filled < 1 || result.rate < Math.max(1, Math.min(100, Number(configStore.otherParams.params[1].value)))) {
              logStore.addLog("自动提交已关闭，或填写结果已变化，已停止提交确认", "warning");
              return outcome("needs-review");
            }
            await iframeWindow.submitCheckTimes();
            if (!context.isCurrent()) return { state: "cancelled" };
            const confirmed = isWorkConfirmed(iframe, iframeDocument);
            logStore.addLog(confirmed ? "平台已确认作业提交" : "已发出提交请求，请核对平台保存状态", confirmed ? "success" : "warning");
            return outcome(confirmed ? "completed" : "submitted");
          }
        } else {
          logStore.addLog("未开启自动提交，暂存", "primary");
          await iframeWindow.noSubmit();
          return outcome("saved");
        }
      } catch {
        if (!context.isCurrent()) return { state: "cancelled" };
        logStore.addLog("答案已处理，但平台保存或提交失败，请手动核对后重试", "warning");
        return outcome("needs-review");
      }
    };
    const processPpt = async (iframeWindow, context) => {
      logStore.addLog("发现一个文档，正在解析", "warning");
      const document2 = iframeWindow.document;
      const viewerFrame = document2.querySelector("#panView");
      const scrollViewer = () => {
        var _a, _b, _c;
        const viewerDocument = (viewerFrame == null ? void 0 : viewerFrame.contentDocument) || document2;
        const viewerWindow = (viewerFrame == null ? void 0 : viewerFrame.contentDocument) ? viewerFrame.contentWindow : iframeWindow;
        const top = Math.max(
          ((_a = viewerDocument.body) == null ? void 0 : _a.scrollHeight) || 0,
          ((_b = viewerDocument.documentElement) == null ? void 0 : _b.scrollHeight) || 0,
          ((_c = viewerDocument.scrollingElement) == null ? void 0 : _c.scrollHeight) || 0
        );
        viewerWindow == null ? void 0 : viewerWindow.scrollTo({ top, behavior: "smooth" });
      };
      scrollViewer();
      const configuredInterval = Number(configStore.otherParams.params[0].value);
      await sleep(Math.max(
        PDF_COMPLETION_WAIT_SECONDS,
        Number.isFinite(configuredInterval) ? configuredInterval : 0
      ));
      if (!context.isCurrent())
        return;
      scrollViewer();
      logStore.addLog("已执行文档阅读，请核对平台任务状态", "primary");
      return { state: "attempted" };
    };
    const processBook = async (iframeWindow) => {
      logStore.addLog("发现一个电子书，正在解析", "warning");
      _unsafeWindow.top.onchangepage(iframeWindow.getFrameAttr("end"));
      logStore.addLog("已打开电子书末页，请核对平台任务状态", "primary");
      return Promise.resolve({ state: "attempted" });
    };
    const runIframeDocumentTask = (iframeDocument, task) => {
      const attempted = attemptedIframeDocuments;
      const running = runningIframeDocumentTasks;
      const previous = attempted.get(iframeDocument);
      if (previous && (previous.isCurrent?.() ?? true))
        return Promise.resolve(previous);
      const runningTask = running.get(iframeDocument);
      if (runningTask)
        return runningTask;
      const taskPromise = Promise.resolve().then(task).then((result) => {
        const outcome = result || { state: "waiting" };
        if (!["waiting", "waiting-for-ai", "cancelled"].includes(outcome.state)) attempted.set(iframeDocument, outcome);
        return outcome;
      }).finally(() => {
        running.delete(iframeDocument);
      });
      running.set(iframeDocument, taskPromise);
      return taskPromise;
    };
    const waitIframeLoad = async (iframe, context) => {
      return new Promise((resolve) => {
        const started = Date.now();
        const finish = (loaded = false) => {
          clearInterval(intervalId2);
          context.signal.removeEventListener("abort", finish);
          resolve(loaded === true);
        };
        const check = () => {
          var _a;
          if (!context.isCurrent() || !iframe.isConnected || Date.now() - started >= 15000) return finish();
          if (((_a = iframe.contentDocument) == null ? void 0 : _a.readyState) === "complete") finish(true);
        };
        const intervalId2 = setInterval(check, 500);
        context.signal.addEventListener("abort", finish, { once: true });
        check();
      });
    };
    const processIframeBody = async (iframe, iframeSrc, iframeDocument, iframeWindow, context) => {
      var _a;
      if (!context.isCurrent())
        return;
      if (iframeSrc.includes("javascript:"))
        return Promise.resolve();
      if (isFinishedTask(iframe)) {
        configStore.menuIndex = iframeSrc.includes("api/work") ? ANSWER_TAB_NAME2 : HOME_TAB_NAME;
        if (iframeSrc.includes("video") || iframeSrc.includes("audio")) {
          (_a = iframeDocument.documentElement.querySelector("video, audio")) == null ? void 0 : _a.pause();
        }
        logStore.addLog("发现一个已完成任务点", "success");
        return { state: "completed" };
      } else {
        if (iframeSrc.includes("api/work")) {
          return processWork(iframe, iframeDocument, iframeWindow, context);
        }
        if (configStore.platformParams.cx.parts[0].params[2].value) {
          logStore.addLog("只答题，不做其他已开启，可在设置里调整", "primary");
        } else {
          const ansJobIcon = getTaskIcon(iframe);
          if (ansJobIcon) {
            configStore.menuIndex = HOME_TAB_NAME;
            if (iframeSrc.includes("video")) {
              return processMedia("video", iframe, iframeDocument, context).then(() => ({ state: context.isCurrent() ? "attempted" : "cancelled" }));
            } else if (iframeSrc.includes("audio")) {
              return processMedia("audio", iframe, iframeDocument, context).then(() => ({ state: context.isCurrent() ? "attempted" : "cancelled" }));
            } else if (["ppt", "doc", "pptx", "docx", "pdf"].some((type) => iframeSrc.includes("modules/" + type))) {
              return processPpt(iframeWindow, context);
            } else if (["innerbook"].some((type) => iframeSrc.includes("modules/" + type))) {
              return processBook(iframeWindow);
            }
          }
        }
      }
      return Promise.resolve({ state: "waiting" });
    };
    const processIframe = async (iframe, context) => {
      if (iframe.src.includes("javascript:"))
        return Promise.resolve();
      if (isTaskFrame(iframe) && isFinishedTask(iframe)) {
        // The marker belongs to the chapter document; checking it does not
        // require a finished resource's own document to load or be accessible.
        try {
          if (/modules\/(?:video|audio)/i.test(iframe.src || ""))
            iframe.contentDocument?.documentElement?.querySelector("video, audio")?.pause();
        } catch { /* completed media may be cross-origin */ }
        return { state: "completed" };
      }
      if (!iframe.contentDocument || !iframe.contentWindow)
        return Promise.resolve();
      if (!await waitIframeLoad(iframe, context)) return { state: "waiting" };
      if (!context.isCurrent() || !iframe.isConnected)
        return;
      const iframeSrc = iframe.src;
      const iframeDocument = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDocument || !iframeWindow)
        return Promise.resolve();
      const iframeContext = {
        signal: context.signal,
        isCurrent: () => context.isCurrent() && iframe.isConnected && iframe.contentDocument === iframeDocument && iframe.src === iframeSrc
      };
      return runIframeDocumentTask(iframeDocument, () => processIframeBody(
        iframe,
        iframeSrc,
        iframeDocument,
        iframeWindow,
        iframeContext
      ));
    };
    init();
    processIframeTask();
    const intervalId = setInterval(processIframeTask, 500);
    const observer = new MutationObserver(() => {
      if (disposed || mutationScanTimer !== null) return;
      // A timeout works in background tabs too; rAF alone could stop scanning.
      // The 500 ms poll remains a fallback for nested document changes.
      mutationScanTimer = setTimeout(() => {
        mutationScanTimer = null;
        processIframeTask();
      }, 25);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    vue.onBeforeUnmount(() => {
      var _a;
      disposed = true;
      if (mutationScanTimer !== null) clearTimeout(mutationScanTimer);
      mutationScanTimer = null;
      clearInterval(intervalId);
      observer.disconnect();
      (_a = currentPage == null ? void 0 : currentPage.iframe) == null ? void 0 : _a.removeEventListener("load", onRootIframeLoad);
      chapterController.abort();
    });
  };
