  // Credentials belong to AI inference, never to media/document chapter work.
  const aiHasConfiguredKey = (config = typeof useConfigStore === "function" ? useConfigStore() : null) => {
    const ai = config?.ai || {};
    const provider = ai.provider ?? "openai";
    if (!["openai", "deepseek"].includes(provider)) return false;
    const key = ai[provider === "deepseek" ? "deepseekApiKey" : "apiKey"];
    return typeof key === "string" && !!key.trim();
  };
  const aiMissingKeyNotices = new WeakMap();
  const aiMissingKeyFallbackOwner = {};
  const aiLogMissingKey = (log, scope = "questions", owner = aiMissingKeyFallbackOwner) => {
    const target = owner && ["object", "function"].includes(typeof owner) ? owner : aiMissingKeyFallbackOwner;
    const scopes = aiMissingKeyNotices.get(target) || new Set();
    if (scopes.has(scope)) return false;
    scopes.add(scope);
    aiMissingKeyNotices.set(target, scopes);
    const message = scope === "chapter"
      ? "AI 未配置：本页作业等待手动作答；视频、文档和其他章节任务继续处理。"
      : scope === "video-quiz"
        ? "AI 未配置：请手动完成视频弹题后继续播放；需要自动解题时再填写 API Key。"
        : "AI 未配置：已保留页面已有作答，剩余题目可手动完成，或在「解题」中填写 API Key。";
    if (typeof log === "function") log(message, "info");
    else log?.addLog?.(message, "info");
    return true;
  };
  // Page controls must acknowledge a change before it is counted as filled.
  const aiOptionSelected = (element) => {
    const input = element.matches?.('input[type="radio"],input[type="checkbox"]') ? element : element.querySelector?.('input[type="radio"],input[type="checkbox"]');
    if (input) return input.checked;
    const aria = element.getAttribute?.("aria-checked");
    if (aria === "true" || aria === "false") return aria === "true";
    if (element.matches?.('.active,.checked,.selected,.is-checked,.check_answer,.check_answer_dx')) return true;
    if (element.querySelector?.('.active,.checked,.selected,.is-checked,.check_answer,.check_answer_dx,[aria-checked="true"]')) return true;
    return false;
  };
  const aiTextFields = (question, pageWindow) => aiAnswerFields(question, pageWindow);
  const aiOptionWritable = (element) => aiControlWritable(element) && element.getAttribute?.("aria-disabled") !== "true" && Array.from(element.querySelectorAll?.('input[type="radio"],input[type="checkbox"]') || []).every(aiControlWritable);
  const aiFilledAnswerReceipts = new WeakMap();
  const aiRememberFilledAnswer = (question, verify) => {
    const receipt = Object.freeze({expectedAnswers: Object.freeze(question.answer.map((answer) => String(answer))), verify});
    if (!verify()) return false;
    aiFilledAnswerReceipts.set(question, receipt);
    return true;
  };
  const applyAiAnswers = async (question, pageWindow, workType, findMatchedOption, isCurrent = () => true) => {
    try {
    aiFilledAnswerReceipts.delete(question);
    if (!isCurrent() || !pageWindow || !question.element?.isConnected || !Array.isArray(question.answer) || !question.answer.length) return false;
    const type = String(question.type);
    if (["0", "1", "单选题", "多选题"].includes(type)) {
      const multiple = type === "1" || type === "多选题";
      if (!multiple && question.answer.length !== 1) return false;
      const desired = question.answer.map((value) => findMatchedOption(question.options, String(value)));
      if (desired.some((element) => !element || !element.isConnected) || new Set(desired).size !== desired.length) return false;
      const all = [...new Set(Object.values(question.options))];
      const toggles = all.filter((element) => (multiple || desired.includes(element)) && aiOptionSelected(element) !== desired.includes(element));
      if (all.some((element) => !aiOptionWritable(element))) return false;
      for (const element of toggles) {
        if (!isCurrent()) return false;
        element.click();
      }
      await sleep(0.1);
      return isCurrent() && aiRememberFilledAnswer(question, () => question.element.isConnected && all.every((element) => element.isConnected && aiOptionWritable(element) && aiOptionSelected(element) === desired.includes(element)));
    }
    if (type === "3" || type === "判断题") {
      const token = extractJudgementToken(null, String(question.answer[0]));
      if (!token) return false;
      const matched = Object.entries(question.options).filter(([text, element]) => extractJudgementToken(element, text) === token);
      if (matched.length !== 1) return false;
      const option = matched[0][1];
      const target = workType === "ks" ? option.querySelector(`span[data='${token === "对" ? "true" : "false"}']`) || option : option;
      if (!isCurrent() || !aiOptionWritable(option) || !aiOptionWritable(target)) return false;
      if (!aiOptionSelected(option)) target.click();
      await sleep(0.1);
      const all = [...new Set(Object.values(question.options))];
      return isCurrent() && aiRememberFilledAnswer(question, () => question.element.isConnected && target.isConnected !== false && aiOptionWritable(option) && aiOptionWritable(target) && (aiOptionSelected(option) || aiOptionSelected(target)) && all.filter((element) => element !== option).every((element) => !aiOptionSelected(element)));
    }
    if (["2", "4", "6", "填空题", "简答题"].includes(type)) {
      const fields = aiTextFields(question, pageWindow);
      const fillBlank = type === "2" || type === "填空题";
      if (!fields.length || (fillBlank && fields.length !== question.answer.length)) return false;
      const selected = fillBlank ? fields : [fields[0]];
      let verified = true;
      const checks = [];
      selected.forEach((field, index) => {
        if (!isCurrent()) {verified = false; return;}
        const value = String(question.answer[index] ?? "");
        if (!value.trim()) {verified = false; return;}
        const editor = aiExistingEditorForField(field, pageWindow);
        if (editor) {
          const safeMarkup = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
          editor.setContent(safeMarkup);
          const body = editor.body || editor.document?.body || editor.iframe?.contentDocument?.body;
          const expected = value.replace(/\s/g, "");
          if (!body || String(body.textContent ?? "").replace(/\s/g, "") !== expected || editor.getContentTxt().replace(/\s/g, "") !== expected) verified = false;
          const actualBody = String(body?.textContent ?? "");
          const actualEditor = editor.getContentTxt();
          checks.push(() => aiExistingEditorForField(field, pageWindow) === editor && aiControlWritable(field) && aiControlVisible(body) && String(body.textContent ?? "") === actualBody && editor.getContentTxt() === actualEditor);
        } else {
          const editable = field.getAttribute?.("contenteditable") === "true";
          if (editable) field.textContent = value;
          else {
            const prototype = Object.getPrototypeOf(field);
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(field, value); else field.value = value;
          }
          field.dispatchEvent(new pageWindow.Event("input", {bubbles: true}));
          field.dispatchEvent(new pageWindow.Event("change", {bubbles: true}));
          if ((editable ? field.textContent : field.value) !== value) verified = false;
          checks.push(() => field.isConnected !== false && aiControlWritable(field) && aiControlVisible(field) && (editable ? field.textContent : field.value) === value);
        }
      });
      return verified && isCurrent() && aiRememberFilledAnswer(question, () => {
        const current = aiTextFields(question, pageWindow);
        return question.element.isConnected && fields.length === current.length && fields.every((field, index) => field === current[index]) && checks.every((check) => check());
      });
    }
    return false;
    } catch {
      return false;
    }
  };

  const AI_QUESTION_OPTION_CONTENT = ".node_detail,.fl.after,.answer_p";
  const AI_QUESTION_OPTION_DECORATION = ".before,.ans-videoquiz-opt-label";
  const aiQuestionNodeStamp = (node, visited = new Set(), settings = {root: node}) => {
    if (!node) return "";
    if (typeof node === "string") return JSON.stringify(["shadow-html", node]);
    if (visited.has(node)) return "";
    visited.add(node);
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || "";
    const tag = node.tagName?.toLowerCase();
    if (["input", "textarea", "select", "button", "script", "style"].includes(tag) || node.getAttribute?.("contenteditable") === "true" || node.matches?.(".colorShallow")) return "";
    const optionContent = node.matches?.(AI_QUESTION_OPTION_CONTENT) || node.querySelector?.(AI_QUESTION_OPTION_CONTENT);
    // These wrappers describe a choice's selection state, not its answer text.
    // A selection class on the content or row itself must not hide that content.
    if (node !== settings.root && !optionContent && !node.closest?.(AI_QUESTION_OPTION_CONTENT) && node.matches?.(AI_QUESTION_OPTION_DECORATION)) return "";
    let background = "";
    try {
      const selectionStyle = settings.selectionUi && !optionContent && node.matches?.(".active,.checked,.selected,.is-checked,.check_answer,.check_answer_dx");
      const value = tag && !selectionStyle && !(settings.option && node === settings.root) ? node.ownerDocument?.defaultView?.getComputedStyle?.(node)?.backgroundImage : "";
      if (typeof value === "string" && /url\s*\(/i.test(value)) background = JSON.stringify(["background", value]);
    } catch { /* An inaccessible style cannot contribute a URL. */ }
    if (tag === "img") return JSON.stringify([
      "img",
      ["src", "srcset", "sizes", "alt", "data-src", "data-original", "data-lazy-src", "lazy-src"].map((attribute) => node.getAttribute?.(attribute) ?? ""),
      node.src || "", node.currentSrc || node.src || "", node.baseURI || "", background
    ]);
    if (tag === "source") return JSON.stringify(["source", ["src", "srcset", "sizes", "media", "type"].map((attribute) => node.getAttribute?.(attribute) ?? "")]);
    if (tag === "canvas") return JSON.stringify(["canvas", node.getAttribute?.("width"), node.getAttribute?.("height"), node.width, node.height, background]);
    if (["svg", "object", "embed", "iframe", "math", "video", "audio"].includes(tag)) return JSON.stringify([tag, node.outerHTML || node.textContent || "", background]);
    if (tag === "br") return background + "\n";
    const componentShadow = node.__Ivue__?._data?.shadowDom;
    const shadows = [...new Set([componentShadow, node.shadowRoot].filter(Boolean))].map((shadow) => aiQuestionNodeStamp(shadow, visited, settings)).join("");
    if (node.childNodes) {
      const content = Array.from(node.childNodes).map((child) => aiQuestionNodeStamp(child, visited, settings)).join("") + shadows;
      return background + (tag === "sup" || tag === "sub" ? `<${tag}>${content}</${tag}>` : content);
    }
    return background + String(node.innerHTML ?? node.textContent ?? "") + shadows;
  };
  const aiQuestionOptionVisualStamp = (row) => {
    const visited = new Set();
    const visit = (node) => {
      if (!node || typeof node === "string" || visited.has(node)) return "";
      visited.add(node);
      const tag = node.tagName?.toLowerCase();
      if (["input", "textarea", "select", "button", "script", "style"].includes(tag) || node.getAttribute?.("contenteditable") === "true" || node.matches?.(AI_QUESTION_OPTION_CONTENT)) return "";
      if (node !== row && !node.querySelector?.(AI_QUESTION_OPTION_CONTENT) && !node.closest?.(AI_QUESTION_OPTION_CONTENT) && node.matches?.(AI_QUESTION_OPTION_DECORATION)) return "";
      if (["img", "source", "canvas", "svg", "object", "embed", "iframe", "math", "video", "audio"].includes(tag)) return aiQuestionNodeStamp(node);
      let background = "";
      try {
        const value = node !== row && !node.matches?.(".active,.checked,.selected,.is-checked,.check_answer,.check_answer_dx") ? node.ownerDocument?.defaultView?.getComputedStyle?.(node)?.backgroundImage : "";
        if (typeof value === "string" && /url\s*\(/i.test(value)) background = JSON.stringify(["background", value]);
      } catch { /* Inaccessible styles cannot add image content. */ }
      const shadow = node.__Ivue__?._data?.shadowDom;
      return background + [...Array.from(node.childNodes || []), node.shadowRoot, typeof shadow === "object" ? shadow : null].filter(Boolean).map(visit).join("");
    };
    return visit(row);
  };
  const aiQuestionStamp = (question) => {
    const element = question.element;
    const title = element?.querySelector?.("h3,.fontLabel,.subject_describe,.smallStem_describe,.tkItem_title,.ans-videoquiz-title");
    const optionRows = [
      ...Array.from(element?.querySelectorAll?.(".ans-videoquiz-opt") || []),
      ...Object.values(question.options || {})
    ];
    const optionNodes = [...Array.from(element?.querySelectorAll?.(AI_QUESTION_OPTION_CONTENT) || [])];
    for (const row of optionRows) {
      const content = Array.from(row?.querySelectorAll?.(AI_QUESTION_OPTION_CONTENT) || []);
      optionNodes.push(...(content.length ? content : [row]));
    }
    const options = [...new Set(optionNodes)].map((node) => aiQuestionNodeStamp(node, new Set(), {root: node, option: !node.matches?.(AI_QUESTION_OPTION_CONTENT), selectionUi: true}));
    const optionVisuals = [...new Set(optionRows)].map(aiQuestionOptionVisualStamp);
    // The parser binds actual question images to their original DOM nodes. Keep
    // those sources guarded even when the surrounding row contains choice UI.
    const images = (question.searchText?.images || []).map(({marker, element: image}) => [marker, aiQuestionNodeStamp(image)]);
    return JSON.stringify([
      typeof window === "undefined" ? "" : window.location.href,
      element?.getAttribute?.("data-question-id") || "",
      title ? aiQuestionNodeStamp(title) : aiQuestionNodeStamp(element) || question.title,
      options, images, optionVisuals
    ]);
  };
  const aiQuestionControlIdentity = (question, pageWindow = question.element?.ownerDocument?.defaultView) => {
    const describe = (field) => ({
      field, editor: aiExistingEditorForField(field, pageWindow),
      attributes: JSON.stringify([field.tagName || "", field.id || "", field.name || "", field.type || field.getAttribute?.("type") || "", field.getAttribute?.("role") || "", field.getAttribute?.("data-qtype") || "", field.getAttribute?.("data-question-type") || "", field.getAttribute?.("data-type") || "", !!field.disabled, !!field.readOnly, aiControlWritable(field)])
    });
    return {
      pageWindow,
      type: String(question.type),
      rootType: JSON.stringify(["data-qtype", "data-question-type", "data-type", "role"].map((attribute) => question.element?.getAttribute?.(attribute) || "")),
      controls: Array.from(question.element?.querySelectorAll?.('input, textarea, [contenteditable="true"]') || []).map(describe),
      fields: aiAnswerFields(question, pageWindow).map(describe),
      optionRows: Array.from(question.element?.querySelectorAll?.('.answerBg,[class*="before-after"],.label,.ans-videoquiz-opt') || []).map(describe),
      options: Object.values(question.options || {}).map(describe)
    };
  };
  const aiSameQuestionControlIdentity = (question, expected, pageWindow) => {
    const current = aiQuestionControlIdentity(question, pageWindow || expected.pageWindow);
    return current.type === expected.type && current.rootType === expected.rootType && ["controls", "fields", "optionRows", "options"].every((key) => current[key].length === expected[key].length && current[key].every((value, index) => value.field === expected[key][index].field && value.editor === expected[key][index].editor && value.attributes === expected[key][index].attributes));
  };
  const aiReadExistingAnswer = (question, pageWindow) => {
    try {
      const type = String(question.type);
      if (["0", "1", "3", "单选题", "多选题", "判断题"].includes(type)) {
        const entries = Object.entries(question.options || {});
        const options = entries.map(([, element]) => element);
        if (!options.length || new Set(options).size !== options.length || options.some((element) => !element?.isConnected || !aiOptionWritable(element) || !aiControlVisible(element))) return null;
        const selected = options.map(aiOptionSelected);
        const count = selected.filter(Boolean).length;
        const complete = type === "1" || type === "多选题" ? count > 0 : count === 1;
        return {
          complete, state: JSON.stringify(selected),
          values: entries.filter((_, index) => selected[index]).map(([text]) => text),
          verify: () => options.every((element, index) => element.isConnected && aiOptionWritable(element) && aiControlVisible(element) && aiOptionSelected(element) === selected[index])
        };
      }
      if (!["2", "4", "6", "填空题", "简答题", "论述题"].includes(type)) return null;
      const fields = aiTextFields(question, pageWindow);
      if (!fields.length) return null;
      // Do not hide an unavailable answer box by counting only the usable boxes.
      const rawFields = Array.from(question.element.querySelectorAll('input, textarea, [contenteditable="true"]'));
      if (rawFields.some((field) => {
        const tag = String(field.tagName).toLowerCase();
        const answerField = tag === "textarea" || field.getAttribute?.("contenteditable") === "true" || (tag === "input" && ["", "text", "search", "number", "tel", "url", "email"].includes((field.getAttribute?.("type") || "text").toLowerCase()));
        return answerField && (!aiControlWritable(field) || (!fields.includes(field) && !fields.some((parent) => parent.contains?.(field) || aiExistingEditorForField(parent, pageWindow)?.body === field)));
      })) return null;
      const values = [], states = [], checks = [];
      for (const field of fields) {
        const editor = aiExistingEditorForField(field, pageWindow);
        if (editor) {
          const body = editor.body || editor.document?.body || editor.iframe?.contentDocument?.body;
          const bodyText = String(body?.textContent ?? ""), text = String(editor.getContentTxt());
          values.push(text);
          states.push([bodyText, text]);
          checks.push(() => aiExistingEditorForField(field, pageWindow) === editor && aiControlWritable(field) && aiControlVisible(body) && String(body.textContent ?? "") === bodyText && String(editor.getContentTxt()) === text);
          if (!bodyText.trim() || bodyText.replace(/\s/g, "") !== text.replace(/\s/g, "")) values[values.length - 1] = "";
        } else {
          const editable = field.getAttribute?.("contenteditable") === "true";
          const value = String((editable ? field.textContent : field.value) ?? "");
          values.push(value);
          states.push(value);
          checks.push(() => field.isConnected !== false && aiControlWritable(field) && aiControlVisible(field) && String((editable ? field.textContent : field.value) ?? "") === value);
        }
      }
      return {
        complete: values.every((value) => value.trim()), state: JSON.stringify(states), values,
        verify: () => {
          const current = aiTextFields(question, pageWindow);
          return fields.length === current.length && fields.every((field, index) => field === current[index]) && checks.every((check) => check());
        }
      };
    } catch {return null;}
  };
  const createAiQuestionContext = (question, parentContext = {}, expectedStamp = aiQuestionStamp(question), expectedControls = aiQuestionControlIdentity(question), options = {}) => {
    const controller = new AbortController();
    const isCurrent = () => {
      try {
        return !controller.signal.aborted && !parentContext.signal?.aborted && (parentContext.isCurrent?.() ?? true) && !!question.element?.isConnected && aiQuestionStamp(question) === expectedStamp && aiSameQuestionControlIdentity(question, expectedControls);
      } catch {
        return false;
      }
    };
    const abort = () => controller.abort();
    parentContext.signal?.addEventListener("abort", abort, {once: true});
    // A batch owns one whole-page monitor. Standalone question callers still
    // receive their independent monitor and the same synchronous identity check.
    const timer = options.monitor === false ? null : setInterval(() => {if (!isCurrent()) abort();}, 250);
    if (!isCurrent()) abort();
    return {
      signal: controller.signal, isCurrent,
      dispose() {if (timer !== null) clearInterval(timer); parentContext.signal?.removeEventListener("abort", abort);}
    };
  };
  const solveAiQuestions = async (handler, parentContext = {}) => {
    handler.questions = [];
    handler.correctNum = 0;
    const snapshots = [];
    const verifications = [];
    const result = handler.lastSolveResult = {
      cancelled: false, total: 0, filled: 0, complete: false, rate: 0, skippedForMissingKey: false,
      isCurrent: () => {
        try {
          return !result.cancelled && !parentContext.signal?.aborted && (parentContext.isCurrent?.() ?? true) && snapshots.length > 0 && snapshots.every(({question, element, stamp, controls}) => question.element === element && !!element?.isConnected && aiQuestionStamp(question) === stamp && aiSameQuestionControlIdentity(question, controls, handler._window));
        } catch {return false;}
      },
      refreshVerification: () => {
        let filled = 0;
        const current = result.isCurrent();
        for (const {question, receipt} of verifications) {
          let valid = false;
          try {valid = current && receipt.verify();} catch {valid = false;}
          if (valid) {
            filled += 1;
            question.answerStatus = "success";
            question.fillError = "";
          } else {
            question.answerStatus = "error";
            question.fillError = "已填写的答案或答题控件发生变化，请重新核对；不会自动重新请求模型。";
          }
        }
        result.filled = handler.correctNum = filled;
        result.rate = result.total ? filled / result.total * 100 : 0;
        result.complete = current && result.total > 0 && filled === result.total;
        return result;
      },
      verifyFilled: () => result.refreshVerification().complete
    };
    const cancelled = () => {result.cancelled = true; result.refreshVerification(); return 0;};
    if (parentContext.signal?.aborted || !(parentContext.isCurrent?.() ?? true)) return cancelled();
    handler.parseHtml();
    snapshots.push(...handler.questions.map((question) => ({question, element: question.element, stamp: aiQuestionStamp(question), controls: aiQuestionControlIdentity(question, handler._window)})));
    result.total = snapshots.length;
    if (!handler.questions.length) {
      handler.addLog("未解析到题目，请进入正确页面后重试", "warning");
      return 0;
    }
    handler.addLog(`成功解析到 ${handler.questions.length} 个题目`, "primary");
    const concurrentEnabled = typeof useConfigStore === "function" && useConfigStore().ai?.concurrentEnabled === true;
    const zhsBatch = snapshots.some(({question}) => question.workType === "zhs");
    const configuredLimit = typeof aiConcurrencyLimit === "function" ? Number(aiConcurrencyLimit()) : 1;
    const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(2500, Math.trunc(configuredLimit))) : 1;
    const batchController = new AbortController();
    const rows = snapshots.map(({question}) => vue.reactive({...question, answerStatus: "pending"}));
    rows.forEach((question) => handler.addQuestion(question));
    const abortBatch = () => {result.cancelled = true; batchController.abort();};
    const batchIsCurrent = () => {
      try {return !result.cancelled && !batchController.signal.aborted && !parentContext.signal?.aborted && (parentContext.isCurrent?.() ?? true);}
      catch {return false;}
    };
    const questionIsCurrent = (question, index) => {
      const snapshot = snapshots[index];
      try {
        return batchIsCurrent() && snapshot.question.element === snapshot.element && question.element === snapshot.element && !!snapshot.element?.isConnected && aiQuestionStamp(question) === snapshot.stamp && aiSameQuestionControlIdentity(question, snapshot.controls, handler._window);
      } catch {return false;}
    };
    // Network polling needs the current question, not a recursively repeated
    // scan of every sibling. Writes below retain a full synchronous batch fence.
    const batchContext = {signal: batchController.signal, isCurrent: batchIsCurrent};
    const contexts = new Set();
    const initialStates = rows.map((question) => concurrentEnabled ? aiReadExistingAnswer(question, handler._window)?.state : undefined);
    let nextIndex = 0, fillTail = Promise.resolve();
    const keepExisting = (question, index) => {
      // Without AI credentials, existing answers remain available even when
      // the user normally prefers serial solving with replacement enabled.
      if ((!concurrentEnabled && aiHasConfiguredKey()) || !questionIsCurrent(question, index)) return false;
      const existing = aiReadExistingAnswer(question, handler._window);
      if (!existing?.complete) return false;
      question.answer = existing.values;
      if (!aiRememberFilledAnswer(question, existing.verify)) return false;
      question.answerSource = "existing";
      question.aiExplanation = "保留页面已有作答，未验证答案正确性。";
      question.answerStatus = "success";
      question.fillError = "";
      verifications.push({question, receipt: aiFilledAnswerReceipts.get(question)});
      handler.addLog(`第 ${index + 1} 道题已有作答，已保留；未验证答案正确性`, "primary");
      return true;
    };
    // The abort branch also consumes a late rejection from a non-cooperative request.
    const requestAnswer = (question, context) => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, new Error("本次解答已取消"));
      context.signal.addEventListener("abort", abort, {once: true});
      if (context.signal.aborted) {abort(); return;}
      try {Promise.resolve(getAnswer(question, context)).then((answer) => finish(resolve, answer), (error) => finish(reject, error));}
      catch (error) {finish(reject, error);}
    });
    const solveOne = async (index) => {
      const snapshot = snapshots[index], question = rows[index];
      if (!questionIsCurrent(question, index)) {abortBatch(); return;}
      if (keepExisting(question, index)) return;
      if (!aiHasConfiguredKey()) {
        result.skippedForMissingKey = true;
        question.answerStatus = "pending";
        question.answerSource = "configuration";
        question.fillError = "AI 尚未配置，可手动作答；需要自动解题时请填写 API Key。";
        aiLogMissingKey(handler.addLog, "questions", handler._document || handler);
        return;
      }
      const context = createAiQuestionContext(question, batchContext, snapshot.stamp, snapshot.controls, {monitor: false});
      contexts.add(context);
      context.signal.addEventListener("abort", abortBatch, {once: true});
      try {
        if (!context.isCurrent()) {abortBatch(); return;}
        question.answerStatus = "searching";
        const answerData = await requestAnswer(question, context);
        if (!context.isCurrent()) {abortBatch(); return;}
        if (keepExisting(question, index)) return;
        const values = getAnswerValues(answerData, question);
        if (!values?.length) {
          question.answerStatus = "error";
          question.answer = [answerData?.error?.message || "模型未返回可用答案"];
          handler.addLog(`第 ${index + 1} 道题未完成，请到「解题」页签查看原因`, "warning");
          return;
        }
        question.answer = values;
        question.aiExplanation = answerData.meta?.explanation || "";
        const fill = fillTail.then(async () => {
          // Keep this synchronous for every write and every click inside the
          // answer applicator: a sibling changing in the same call stack must
          // still stop the remaining mutations, without waiting for a timer.
          const writeIsCurrent = () => result.isCurrent() && context.isCurrent();
          if (!writeIsCurrent()) {abortBatch(); return;}
          if (keepExisting(question, index)) return;
          if (concurrentEnabled && aiReadExistingAnswer(question, handler._window)?.state !== initialStates[index]) {
            question.answerStatus = "error";
            question.fillError = "等待期间页面作答发生变化，已保留你的填写，请手动核对。";
            handler.addLog(`第 ${index + 1} 道题作答已变化，未覆盖页面填写`, "warning");
            return;
          }
          let filled = false;
          try {filled = await handler.fillQuestion(question, writeIsCurrent);} catch {filled = false;}
          if (!writeIsCurrent()) {abortBatch(); return;}
          const receipt = aiFilledAnswerReceipts.get(question);
          filled = filled && !!receipt;
          question.answerSource = "ai";
          question.answerStatus = filled ? "success" : "error";
          question.fillError = filled ? "" : "AI 已给出答案，但无法确认页面填写结果，请手动核对。";
          handler.addLog(`第 ${index + 1} 道题 ${filled ? "已填写，请核对" : "需手动填写"}`, filled ? "success" : "warning");
          handler.addLog(`模型：${answerData.meta?.model || "AI"}；本题用量：${answerData.meta?.usage?.total_tokens ?? "未知"} tokens`, "primary");
          if (filled) verifications.push({question, receipt});
        });
        fillTail = fill.catch(() => {});
        await fill;
      } catch (error) {
        if (!context.isCurrent()) abortBatch();
        else if (keepExisting(question, index)) return;
        else {
          question.answerStatus = "error";
          question.answer = [error?.message || "模型请求失败，请重试"];
          handler.addLog(`第 ${index + 1} 道题未完成，请到「解题」页签查看原因`, "warning");
        }
      } finally {
        context.signal.removeEventListener("abort", abortBatch);
        context.dispose();
        contexts.delete(context);
      }
    };
    const monitor = setInterval(() => {if (!result.isCurrent()) abortBatch();}, 250);
    parentContext.signal?.addEventListener("abort", abortBatch, {once: true});
    try {
      // Register/inspect all initial rows before any model request can change the page.
      const initiallyComplete = rows.map((question, index) => keepExisting(question, index));
      if (!result.isCurrent()) return cancelled();
      const pending = [];
      snapshots.forEach((_, index) => {if (!initiallyComplete[index]) pending.push(index);});
      const solvePending = async () => {
        let first = true;
        while (!batchController.signal.aborted && nextIndex < pending.length) {
          // The initial workers share the initial fence above. Queued work
          // starts only after another full check following an asynchronous gap.
          if (!first && !result.isCurrent()) {abortBatch(); break;}
          first = false;
          await solveOne(pending[nextIndex++]);
        }
      };
      const workerCount = Math.min(limit, pending.length);
      await Promise.allSettled(Array.from({length: workerCount}, solvePending));
      await fillTail;
      if (!result.isCurrent()) return cancelled();
      result.refreshVerification();
      // Navigation is a single batch action after every request and fill has settled.
      if (zhsBatch && result.complete && useConfigStore().platformParams.zhs.parts[0].params[0].value) {
        if (!await aiWaitForDelay(Number(useConfigStore().otherParams.params[0].value) || 0, {
          signal: batchController.signal,
          isCurrent: () => result.isCurrent() && !!useConfigStore().platformParams.zhs.parts[0].params[0].value
        })) {
          if (!result.isCurrent()) return cancelled();
          result.refreshVerification();
          return result.rate;
        }
        if (!result.isCurrent()) return cancelled();
        if (result.verifyFilled()) handler._document.querySelectorAll(".switch-btn-box > button")[1]?.click();
      }
      return result.rate;
    } finally {
      clearInterval(monitor);
      parentContext.signal?.removeEventListener("abort", abortBatch);
      contexts.forEach((context) => context.dispose());
      if (result.cancelled) {
        rows.forEach((question) => {
          question.answerStatus = "error";
          question.fillError = "页面或题目已切换，本批解答已取消，请核对填写状态";
        });
        result.refreshVerification();
      }
    }
  };
