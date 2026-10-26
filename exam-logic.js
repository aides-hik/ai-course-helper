  const useCxExamLogic = async () => {
    const logStore = useLogStore();
    const configStore = useConfigStore();
    const questionStore = useQuestionStore();
    questionStore.clearQuestion();
    logStore.addLog("进入新版考试页面，开始准备答题", "primary");
    logStore.addLog("正在解析题目，请稍等", "warning");
    const handler = new CxQuestionHandler("ks");
    await handler.init();
    const result = handler.lastSolveResult;
    const readyToAdvance = () => !!result && typeof result.verifyFilled === "function" && result.verifyFilled() && result.rate === 100 && !result.cancelled && result.isCurrent();
    if (configStore.platformParams.cx.parts[1].params[0].value) {
      if (!readyToAdvance()) {
        logStore.addLog("题目未全部确认填写，或页面已切换，已停止自动翻题", "warning");
        return;
      }
      logStore.addLog("自动切换已开启，正在前往下一题", "success");
      if (!await aiWaitForDelay(Number(configStore.otherParams.params[0].value) || 0, {
        isCurrent: () => !!configStore.platformParams.cx.parts[1].params[0].value && readyToAdvance()
      })) return;
      if (!configStore.platformParams.cx.parts[1].params[0].value || !readyToAdvance()) return;
      if (clickNextStepButton()) {
        logStore.addLog("已经到最后一题，正在点击下一步", "success");
        return;
      }
      if (typeof _unsafeWindow.getTheNextQuestion === "function") _unsafeWindow.getTheNextQuestion(1);
      else logStore.addLog("未找到下一题入口，请手动切换", "warning");
    } else {
      logStore.addLog("已经关闭自动切换，在设置里可更改", "danger");
    }
  };
