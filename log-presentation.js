  // Presentation only: source diagnostics and exported messages stay intact.
  const logMessage = (entry) => String(entry?.message ?? "");
  const logCleanDiagnostic = (message) => String(message || "").replace(/（(?:#prevNextFocusNext|\.nextChapter)）/g, "");
  const logDetailOnly = (entry) => {
    const message = logMessage(entry);
    if (message.startsWith("[章节诊断]")) {
      if (!/^\[章节诊断\] (?:当前原因：|跳章：)/.test(message) || /等待页面稳定/.test(message)) return true;
      // The overview already explains ordinary in-progress/loading states.
      // Keep their internal completion-marker diagnostics in the full view.
      if (/^\[章节诊断\] 当前原因：/.test(message) && /未识别到平台完成标记|空白页|尚未加载/.test(message) && !/不可访问|失败|无法确定|多个|已停止/.test(message)) return true;
      return false;
    }
    return /^(?:用户悉知：|脚本加载成功，正在解析网页|请不要多个脚本同时使用|如果脚本出现异常|正在解析任务点，请稍等|检测到用户进入到章节学习页面|成功解析到 \d+ 个题目|模型：)/.test(message);
  };
  const logReminder = (entry) => {
    if (logDetailOnly(entry)) return false;
    const message = logMessage(entry);
    if (["danger", "error"].includes(entry.type)) return true;
    // A missing completion flag while a task is in progress is not an error.
    const normalProgress = /^\[章节诊断\] 当前原因：.*(?:未识别到平台完成标记|空白页|文档尚未|等待页面|等待平台)/.test(message) && !/不可访问|失败|无法确定|多个|已停止/.test(message);
    if (normalProgress || /^(?:AI 未配置：|发现一个|正在解析|正在尝试播放)/.test(message)) return false;
    return entry.type === "warning" || /失败|异常|超时|不可访问|无法确定|无法连接|需手动|请手动|未完成|已停止|已取消|请核对平台|无法确认|按钮不可用|请检查|发生变化/.test(message);
  };
  const logDisplayMessage = (entry, mode) => {
    const message = logMessage(entry);
    if (mode === "detail") return message;
    if (/^\[章节诊断\] (?:当前原因：|跳章：)/.test(message)) return logCleanDiagnostic(message).replace(/^\[章节诊断\] (?:当前原因：|跳章：)/, "").split("；")[0];
    return message.replace(/^发现一个(video|audio)，正在解析$/, (_, type) => type === "video" ? "已找到视频任务，准备播放。" : "已找到音频任务，准备播放。")
      .replace(/^正在尝试播放(video|audio)，请稍等5s$/, (_, type) => type === "video" ? "正在启动视频播放。" : "正在启动音频播放。")
      .replace(/^(video|audio)已播放完成$/, (_, type) => (type === "video" ? "视频" : "音频") + "已播放结束，等待平台确认。")
      .replace(/^(video|audio)任务点已完成，跳过$/, (_, type) => (type === "video" ? "视频" : "音频") + "任务已完成，已跳过。");
  };
  const logClock = (text) => {
    const match = String(text || "").match(/^(\d{2}):(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
  };
  const logVisibleRows = (logs, mode = "brief") => {
    const rows = [];
    for (const entry of logs || []) {
      if (mode !== "detail" && (logDetailOnly(entry) || mode === "reminders" && !logReminder(entry))) continue;
      const displayMessage = logDisplayMessage(entry, mode);
      const type = mode !== "detail" && /^\[章节诊断\] 当前原因：/.test(logMessage(entry)) && !logReminder(entry) ? "info" : entry.type;
      const previous = rows[rows.length - 1];
      const before = logClock(previous?.lastTime), now = logClock(entry.time);
      const elapsed = before === null || now === null ? Infinity : (now - before + 86400) % 86400;
      if (mode !== "detail" && previous?.displayMessage === displayMessage && previous.type === type && elapsed <= 60) {
        previous.repeat += 1; previous.lastTime = entry.time;
      } else rows.push({...entry, type, displayMessage, repeat: 1, lastTime: entry.time});
    }
    return rows;
  };
  const logOverview = (logs, questions = []) => {
    let snapshot = null, snapshotIndex = -1;
    for (let index = logs.length - 1; index >= 0; index--) {
      const match = logMessage(logs[index]).match(/^\[章节诊断\].*?：(\d+) 个页面，(\d+) 个任务，(\d+) 个已确认/);
      if (match) {snapshot = {total: Number(match[2]), completed: Number(match[3])}; snapshotIndex = index; break;}
    }
    const recent = logs.slice(Math.max(0, snapshotIndex));
    const reasonEntry = [...recent].reverse().find(entry => logMessage(entry).startsWith("[章节诊断] 当前原因："));
    const jumpEntry = [...recent].reverse().find(entry => logMessage(entry).startsWith("[章节诊断] 跳章："));
    const reasonText = reasonEntry ? logCleanDiagnostic(reasonEntry.message).replace(/^\[章节诊断\] 当前原因：/, "").split("；任务下一步=")[0] : "";
    const reason = reasonText.split("；")[0];
    const jump = jumpEntry ? logCleanDiagnostic(jumpEntry.message).replace(/^\[章节诊断\] 跳章：/, "") : "";
    const total = snapshot?.total || 0, completed = Math.min(total, snapshot?.completed || 0);
    if (total) {
      const complete = completed === total;
      const media = recent.filter(entry => /^\[章节诊断\] 页面#.*(?:视频|音频)/.test(logMessage(entry)));
      const unfinished = media.filter(entry => /阻塞=未识别到平台完成标记/.test(logMessage(entry)));
      const ended = unfinished.some(entry => /结束=是/.test(logMessage(entry)));
      const playing = unfinished.some(entry => /暂停=否/.test(logMessage(entry)));
      const attention = /不可访问|无法确认|已停止|暂停自动|无法确定|失败|多个|按钮不可用/.test(reasonText) || /已取消|已停止/.test(jump);
      const loading = !complete && /空白页|文档尚未|尚未加载|加载中|未加载/.test(reason);
      const state = attention ? "attention" : complete ? "complete" : ended || loading ? "waiting" : "running";
      return {state, total, completed,
        badge: attention ? "待核对" : complete ? "已完成" : ended ? "等待平台确认" : loading ? "加载中" : "进行中",
        title: complete ? "本页任务已完成" : attention ? "有任务需要查看" : ended ? "视频已结束，等待同步" : loading ? "正在加载章节任务" : "正在处理学习任务",
        note: jump || (playing ? "视频正在播放，完成状态由平台确认。" : ended ? "等待平台显示完成标记后再切换章节。" : loading ? "页面加载后会继续处理任务。" : !attention && /未识别到平台完成标记/.test(reasonText) ? "任务正在处理中，完成状态由平台确认。" : reason) || "视频、文档和章节任务正在正常处理。",
        progress: `${completed} / ${total}`};
    }
    if (questions.length) {
      const filled = questions.filter(question => question.answerStatus === "success").length;
      const requesting = questions.some(question => question.answerStatus === "searching");
      const missing = questions.some(question => question.answerSource === "configuration");
      const failed = questions.some(question => question.answerStatus === "error");
      const complete = filled === questions.length;
      return {state: complete ? "complete" : failed ? "attention" : requesting ? "running" : "waiting",
        total: questions.length, completed: filled,
        badge: complete ? "已填写" : failed ? "待核对" : requesting ? "解题中" : missing ? "可手动作答" : "等待解题",
        title: complete ? "本页题目已填写" : failed ? "有题目需要核对" : requesting ? "正在解答本页题目" : missing ? "题目等待作答" : "已识别本页题目",
        note: complete ? "已保留或填写页面答案，请核对后提交。" : missing ? "AI 未配置，可手动作答；视频和文档不受影响。" : failed ? "请到「解题」查看具体原因并核对填写。" : "答案与填写状态会显示在「解题」中。",
        progress: `${filled} / ${questions.length}`};
    }
    return {state: "waiting", total: 0, completed: 0, badge: "等待任务", title: "准备好开始学习",
      note: "视频和文档无需 API Key；需要 AI 解题时再配置。", progress: "等待识别"};
  };
