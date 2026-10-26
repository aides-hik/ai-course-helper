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
        if (current.hidden || current.getAttribute?.("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0" || style?.pointerEvents === "none") return false;
      }
      return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
    } catch { return false; }
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
    const isFinishedTask = (iframe) => {
      var _a;
      let element = iframe;
      while (element) {
        const className = typeof element.className === "string" ? element.className : "";
        if (className.split(/\s+/).includes("ans-job-finished") || ((_a = element.classList) == null ? void 0 : _a.contains("ans-job-finished")))
          return true;
        element = element.parentElement;
      }
      return false;
    };
    const getChapterPage = () => {
      const iframe = document.documentElement.querySelector("iframe");
      return {
        url: window.location.href,
        iframe,
        src: (iframe == null ? void 0 : iframe.src) || "",
        document: (iframe == null ? void 0 : iframe.contentDocument) || null
      };
    };
    const isSamePage = (left, right) => left.url === right.url && left.iframe === right.iframe && left.src === right.src && left.document === right.document;
    const collectChapterFrames = (root, result = [], visited = new Set()) => {
      for (const iframe of Array.from(root?.querySelectorAll?.("iframe") || [])) {
        if (visited.has(iframe)) continue;
        visited.add(iframe);
        result.push(iframe);
        try {
          collectChapterFrames(iframe.contentDocument?.documentElement, result, visited);
        } catch {
          // Cross-origin task frames remain in the list and block completion.
        }
      }
      return result;
    };
    const isTaskFrame = (iframe) => /api\/work|modules\/(?:video|audio|ppt|doc|pdf|innerbook)/i.test(iframe.src || "") || !!iframe.parentElement?.querySelector?.(".ans-job-icon");
    const isWorkConfirmed = (iframe, iframeDocument) => {
      if (isFinishedTask(iframe)) return true;
      const status = iframeDocument?.querySelector?.(".work-status,.workStatus,#workStatus,[data-work-status]");
      return !!status && /^(?:已完成|待批阅|已提交)(?:\s|$)/.test((status.textContent || status.getAttribute?.("data-work-status") || "").trim());
    };
    const chapterSnapshot = (root) => collectChapterFrames(root).map((iframe) => {
      let doc = null;
      try { doc = iframe.contentDocument; } catch { /* inaccessible */ }
      return { iframe, doc, src: iframe.src, ready: doc?.readyState, finished: isFinishedTask(iframe) };
    });
    const sameFrameSnapshot = (left, right) => left.length === right.length && left.every((item, index) => {
      const other = right[index];
      return item.iframe === other.iframe && item.doc === other.doc && item.src === other.src && item.ready === other.ready && item.finished === other.finished;
    });
    const canAdvanceChapter = (root) => {
      const allFrames = collectChapterFrames(root).filter((iframe) => !/^javascript:/i.test(iframe.src || ""));
      if (allFrames.some((iframe) => {
        try {
          const doc = iframe.contentDocument;
          return !iframe.isConnected || !doc || doc.readyState !== "complete" || doc.URL === "about:blank";
        } catch { return true; }
      })) return false;
      const frames = allFrames.filter(isTaskFrame);
      return frames.length > 0 && frames.every((iframe) => {
        try {
          return iframe.isConnected && (isFinishedTask(iframe) || iframe.src.includes("api/work") && isWorkConfirmed(iframe, iframe.contentDocument));
        } catch {
          return false;
        }
      });
    };
    const checkChapterCompletion = async (root, context, taskId) => {
      if (!context.isCurrent() || taskId !== currentWatchIframeTaskId || navigationPending) return;
      const complete = canAdvanceChapter(root);
      const message = complete ? "平台已确认本页任务完成" : "本页仍有未确认完成的任务，请核对平台状态";
      if (message !== lastCompletionMessage) {
        lastCompletionMessage = message;
        logStore.addLog(message, complete ? "success" : "warning");
      }
      if (!complete || !configStore.platformParams.cx.parts[0].params[1].value || Date.now() - lastFrameChange < 1500) return;
      const before = chapterSnapshot(root);
      const nextBtn = root.querySelector("#prevNextFocusNext");
      const button = document.querySelector(".jb_btn.jb_btn_92.fr.fs14.nextChapter");
      if (!cxChapterNavigationAllowed(nextBtn) || !cxChapterNavigationAllowed(button) || typeof button.click !== "function") return;
      const page = typeof getChapterPage === "function" ? getChapterPage() : null;
      const chapterKey = page ? JSON.stringify([cxStableResourceUrl(page.url, page.url, "chapter"), cxStableResourceUrl(page.src, page.url, "chapter")]) : "";
      const departed = checkChapterCompletion.departed || (checkChapterCompletion.departed = new Set());
      if (chapterKey && departed.has(chapterKey)) {
        navigationPending = true;
        logStore.addLog("检测到已经离开的章节再次出现，已停止自动跳章，请手动核对课程进度", "warning");
        return;
      }
      navigationPending = true;
      const allowed = await aiWaitForDelay(Number(configStore.otherParams.params[0].value) || 0, {
        signal: context.signal,
        isCurrent: () => context.isCurrent() && taskId === currentWatchIframeTaskId && !!configStore.platformParams.cx.parts[0].params[1].value
      });
      if (!allowed) {
        if (taskId === currentWatchIframeTaskId) navigationPending = false;
        return;
      }
      if (!context.isCurrent() || taskId !== currentWatchIframeTaskId) return;
      if (!configStore.platformParams.cx.parts[0].params[1].value) {
        navigationPending = false;
        return;
      }
      if (!sameFrameSnapshot(before, chapterSnapshot(root)) || !canAdvanceChapter(root)) {
        navigationPending = false;
        return;
      }
      if (root.querySelector("#prevNextFocusNext") !== nextBtn || document.querySelector(".jb_btn.jb_btn_92.fr.fs14.nextChapter") !== button || !cxChapterNavigationAllowed(nextBtn) || !cxChapterNavigationAllowed(button)) {
        navigationPending = false;
        return;
      }
      if (chapterKey) departed.add(chapterKey);
      try { button.click(); }
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
      const page = getChapterPage();
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
        questionStore.clearQuestion();
        configStore.menuIndex = HOME_TAB_NAME;
        currentPage = page;
        (_b = page.iframe) == null ? void 0 : _b.addEventListener("load", onRootIframeLoad);
      }
      if (!page.iframe || !page.document || page.document.readyState !== "complete" || page.document.URL === "about:blank")
        return;
      const frames = chapterSnapshot(document.documentElement);
      if (!sameFrameSnapshot(lastFrames, frames)) {
        lastFrames = frames;
        lastFrameChange = Date.now();
      }
      if (activeScan) return;
      const signal = chapterController.signal;
      watchIframe(document.documentElement, {
        signal,
        // 直接检查页面，避免在轮询发现切换之前，旧请求已返回。
        isCurrent: () => !signal.aborted && isSamePage(page, getChapterPage())
      });
    };
    const watchIframe = (documentElement, context) => {
      const thisTaskId = currentWatchIframeTaskId;
      const scan = {};
      activeScan = scan;
      const release = () => { if (activeScan === scan) activeScan = null; };
      const allIframes = collectChapterFrames(documentElement);
        rxjs.from(allIframes).pipe(concatMap((iframe) => {
          if (thisTaskId !== currentWatchIframeTaskId || !context.isCurrent())
            return Promise.resolve();
          return processIframe(iframe, context);
        })).subscribe({
          complete: async () => {
            try { await checkChapterCompletion(documentElement, context, thisTaskId); }
            catch (error) { if (context.isCurrent()) logStore.addLog(`无法确认章节完成状态：${String(error)}`, "warning"); }
            finally { release(); }
          },
          error: (error) => {
            release();
            if (context.isCurrent()) {
              logStore.addLog(`任务处理失败：${String(error)}`, "danger");
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
                    return ((_a = configStore.platformParams.cx.parts[0].params.find((param) => param.name === VIDEO_QUIZ_SETTING)) == null ? void 0 : _a.value) !== false;
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
      configStore.menuIndex = ANSWER_TAB_NAME2;
      logStore.addLog("发现一个作业，正在解析", "warning");
      if (isWorkConfirmed(iframe, iframeDocument)) {
        logStore.addLog("作业已经完成，跳过", "success");
        return { state: "completed" };
      }
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
        if (!["waiting", "cancelled"].includes(outcome.state)) attempted.set(iframeDocument, outcome);
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
      var _a, _b;
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
          const ansJobIcon = (_b = iframe.parentElement) == null ? void 0 : _b.querySelector(".ans-job-icon");
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
    const observer = new MutationObserver(() => processIframeTask());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    vue.onBeforeUnmount(() => {
      var _a;
      disposed = true;
      clearInterval(intervalId);
      observer.disconnect();
      (_a = currentPage == null ? void 0 : currentPage.iframe) == null ? void 0 : _a.removeEventListener("load", onRootIframeLoad);
      chapterController.abort();
    });
  };
