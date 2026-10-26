  // Model lists are requested only by the configuration button. Nothing here
  // writes credentials, model choices or returned lists to persistent storage.
  const aiModelListSnapshot = () => {
    const ai = useConfigStore().ai || {};
    const provider = ai.provider ?? "openai";
    if (provider !== "openai" && provider !== "deepseek") return {error: "请先选择 OpenAI 或 DeepSeek"};
    const value = provider === "deepseek" ? ai.deepseekApiKey : ai.apiKey;
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (!apiKey) return {error: "请先填写当前服务的 API Key"};
    if (apiKey.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/.test(apiKey)) return {error: "API Key 格式不正确，请检查后重试"};
    if (typeof aiResolveEndpoints !== "function") return {error: "请求地址配置不可用，请刷新页面后重试"};
    const endpoints = aiResolveEndpoints(provider, ai);
    if (endpoints.error) return {error: "请求 URL 格式不正确，请检查当前服务的地址"};
    if (endpoints.modelsError || !endpoints.modelsUrl) return {error: "无法自动确定模型列表地址，请填写模型列表 URL"};
    return {provider, apiKey, requestUrl: endpoints.requestUrl, modelsUrl: endpoints.modelsUrl};
  };
  const aiModelListCurrent = (snapshot, context) => {
    try {
      if (context.signal?.aborted || !(context.isCurrent?.() ?? true)) return false;
      const current = aiModelListSnapshot();
      return !current.error && current.provider === snapshot.provider && current.apiKey === snapshot.apiKey && current.requestUrl === snapshot.requestUrl && current.modelsUrl === snapshot.modelsUrl;
    } catch { return false; }
  };
  const aiModelListTextFits = (text) => {
    const maximum = 1024 * 1024;
    if (typeof text !== "string" || text.length > maximum) return false;
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const value = text.charCodeAt(index);
      if (value <= 0x7f) bytes += 1;
      else if (value <= 0x7ff) bytes += 2;
      else if (value >= 0xd800 && value <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {bytes += 4; index += 1;}
      else bytes += 3;
      if (bytes > maximum) return false;
    }
    return true;
  };
  const aiModelListContainsSecret = (text, snapshot) => /^sk[-_]|^bearer\b/i.test(text) || text === snapshot.apiKey || snapshot.apiKey.length >= 8 && text.toLowerCase().includes(snapshot.apiKey.toLowerCase());
  const aiReadModelList = (text, snapshot) => {
    if (!aiModelListTextFits(text)) return {success: false, error: "模型列表响应过大，请稍后重试或手动填写模型名称"};
    let payload;
    try { payload = JSON.parse(text); }
    catch { return {success: false, error: "模型列表格式无法解析，请稍后重试"}; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.data)) return {success: false, error: "服务未返回有效的模型列表，请稍后重试"};
    if (payload.data.length > 2000) return {success: false, error: "模型列表数量过多，请手动填写模型名称"};
    const models = new Map();
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    const modalities = ["text", "image", "audio", "video"];
    const listed = (values, known) => Array.isArray(values) ? known.filter((value) => values.includes(value)) : [];
    for (const entry of payload.data) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string") continue;
      const id = entry.id;
      if (!/^[a-z0-9][a-z0-9._:/+\-]{0,199}$/i.test(id) || id.includes("://") || /^(?:https?|ftp|file|data|blob|javascript):/i.test(id) || aiModelListContainsSecret(id, snapshot) || models.has(id)) continue;
      const model = {id};
      if (snapshot.provider === "deepseek") {
        if (typeof entry.name === "string") {
          const name = entry.name.trim();
          if (name && name.length <= 200 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]|[a-z][a-z0-9+.-]*:\/\/|(?:https?|data|file):/i.test(name) && !aiModelListContainsSecret(name, snapshot)) model.name = name;
        }
        const effortLevels = listed(entry.effort?.supported_levels, levels);
        const inputModalities = listed(entry.input_modalities, modalities);
        if (effortLevels.length) model.effortLevels = effortLevels;
        if (inputModalities.length) model.inputModalities = inputModalities;
      }
      models.set(id, model);
    }
    if (!models.size) return {success: false, error: "当前账号未返回可用模型，请检查权限或手动填写模型名称"};
    return {success: true, models: [...models.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)};
  };
  const aiFetchModels = (context = {}) => {
    let snapshot;
    try { snapshot = aiModelListSnapshot(); }
    catch { return Promise.resolve({success: false, error: "读取模型服务配置失败，请检查设置"}); }
    if (snapshot.error) return Promise.resolve({success: false, error: snapshot.error});
    if (!aiModelListCurrent(snapshot, context)) return Promise.resolve({success: false, error: "模型列表请求已取消，请重新获取"});
    return new Promise((resolve) => {
      const deadline = Date.now() + 20000;
      let settled = false, request, timer, abortRequested = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", cancel);
        resolve(result);
      };
      const abortTransport = () => {
        abortRequested = true;
        try { request?.abort(); } catch { /* The promise is already settled. */ }
      };
      const cancel = () => {finish({success: false, error: "模型列表请求已取消，请重新获取"}); abortTransport();};
      const timeout = () => {finish({success: false, error: "获取模型列表超时，请稍后重试"}); abortTransport();};
      const poll = () => {
        if (settled) return;
        if (!aiModelListCurrent(snapshot, context)) return cancel();
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeout();
        timer = setTimeout(poll, Math.min(250, remaining));
      };
      context.signal?.addEventListener("abort", cancel, {once: true});
      if (!aiModelListCurrent(snapshot, context)) return cancel();
      poll();
      if (settled) return;
      try {
        request = _GM_xmlhttpRequest({
          url: snapshot.modelsUrl,
          method: "GET", anonymous: true, redirect: "error",
          headers: {Authorization: `Bearer ${snapshot.apiKey}`}, timeout: 20000,
          onload: (response) => {
            if (settled) return;
            if (!aiModelListCurrent(snapshot, context)) return cancel();
            if (Date.now() >= deadline) return timeout();
            if (typeof response.finalUrl === "string" && response.finalUrl && response.finalUrl !== snapshot.modelsUrl) return finish({success: false, error: "模型列表地址发生跳转，已停止读取，请检查请求地址"});
            const status = Number(response.status);
            const messages = {
              401: "API Key 无效或已过期，请检查当前服务的密钥",
              403: "当前账号无权查看模型列表，请检查服务权限",
              429: "获取模型列表过于频繁或账号受限，请稍后重试"
            };
            if (!(status >= 200 && status < 300)) return finish({success: false, error: messages[status] || (status >= 500 ? "模型服务暂时不可用，请稍后重试" : "获取模型列表失败，请检查服务和账号设置")});
            try { finish(aiReadModelList(response.responseText, snapshot)); }
            catch { finish({success: false, error: "模型列表格式无法解析，请稍后重试"}); }
          },
          onerror: () => {if (!settled) finish({success: false, error: "无法连接模型服务，请检查网络后重试"});},
          ontimeout: () => {if (!settled) timeout();},
          onabort: () => {if (!settled) finish({success: false, error: "模型列表请求已取消，请重新获取"});}
        });
        if (abortRequested) abortTransport();
      } catch { finish({success: false, error: "模型列表请求发送失败，请检查脚本网络权限"}); }
    });
  };
