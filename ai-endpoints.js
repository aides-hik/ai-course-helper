  // Resolve both request targets before using credentials. This module never
  // contacts a service or changes the user's saved addresses.
  const AI_ENDPOINT_DEFAULTS = {
    openai: "https://api.openai.com/v1/responses",
    deepseek: "https://api.deepseek.com/chat/completions"
  };
  const aiParseEndpointUrl = (raw, label) => {
    if (typeof raw !== "string") return {error: `${label}无效，请填写完整的 HTTP 或 HTTPS 地址`};
    const text = raw.trim();
    if (!/^https?:\/\//i.test(text) || text.length > 8192 || /[\u0000-\u0020\u007f-\u009f\\#]/.test(text))
      return {error: `${label}无效，请填写完整的 HTTP 或 HTTPS 地址，且不要包含账号、密码或 #`};
    try {
      const url = new URL(text);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash)
        return {error: `${label}无效，请填写完整的 HTTP 或 HTTPS 地址，且不要包含账号、密码或 #`};
      return {url: url.href};
    } catch {
      return {error: `${label}无效，请检查地址格式`};
    }
  };
  const aiResolveEndpoints = (provider, ai = {}) => {
    if (provider !== "openai" && provider !== "deepseek") return {error: "请选择 OpenAI 或 DeepSeek 后配置请求地址"};
    const rawRequest = ai[provider === "deepseek" ? "deepseekApiUrl" : "apiUrl"];
    const request = aiParseEndpointUrl(rawRequest === undefined || typeof rawRequest === "string" && !rawRequest.trim() ? AI_ENDPOINT_DEFAULTS[provider] : rawRequest, "解题请求 URL ");
    if (request.error) return request;
    const rawModels = ai[provider === "deepseek" ? "deepseekModelsUrl" : "modelsUrl"];
    if (rawModels !== undefined && !(typeof rawModels === "string" && !rawModels.trim())) {
      const models = aiParseEndpointUrl(rawModels, "模型列表 URL ");
      return models.error ? {requestUrl: request.url, modelsError: models.error} : {requestUrl: request.url, modelsUrl: models.url};
    }
    const models = new URL(request.url);
    if (!/\/(?:responses|chat\/completions)\/?$/.test(models.pathname))
      return {requestUrl: request.url, modelsError: "无法自动推算模型列表地址，请填写完整的模型列表 URL"};
    models.pathname = models.pathname.replace(/\/(?:responses|chat\/completions)\/?$/, "/models");
    return {requestUrl: request.url, modelsUrl: models.href};
  };
