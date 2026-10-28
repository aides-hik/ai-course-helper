/* Shared request validation for the extension background and network document. */
(function (root) {
  "use strict";
  const CONFIG_KEY = "openai-course-helper:config:v1";
  const REQUEST_LIMIT = 32 * 1024 * 1024;
  const RESPONSE_LIMIT = 4 * 1024 * 1024;
  const COURSE_DOMAINS = ["chaoxing.com", "edu.cn", "nbdlib.cn", "hnsyu.net", "gdhkmooc.com", "zhihuishu.com"];
  const DEFAULTS = {openai: "https://api.openai.com/v1/responses", deepseek: "https://api.deepseek.com/chat/completions"};
  const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
  const parseUrl = value => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value) || value.length > 8192 || /[\u0000-\u0020\u007f-\u009f\\#]/.test(value)) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.hash ? url.href : null;
    } catch { return null; }
  };
  const supportedUrl = value => {
    // Course SPAs legitimately use hash routes; endpoint restrictions above do
    // not apply to the browser-supplied URL of a content-script sender.
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      return COURSE_DOMAINS.some(domain => host === domain || host.endsWith("." + domain));
    } catch {return false;}
  };
  const trustedSender = (sender, extensionId) => !!sender && sender.id === extensionId &&
    Number.isInteger(sender.tab?.id) && sender.frameId === 0 && supportedUrl(sender.url);
  const readAi = storage => {
    let legacy = {};
    try {
      const config = JSON.parse(storage?.[CONFIG_KEY] || "null");
      if (plain(config?.ai)) legacy = config.ai;
    } catch { /* New installs have only per-field settings. */ }
    const ai = {...legacy};
    for (const name of ["provider", "apiKey", "apiUrl", "modelsUrl", "deepseekApiKey", "deepseekApiUrl", "deepseekModelsUrl"]) {
      try {
        const record = JSON.parse(storage?.[CONFIG_KEY + ":field:" + JSON.stringify(["ai", name])] || "null");
        if (record?.v === 1 && typeof record.value === "string") ai[name] = record.value;
      } catch { /* Malformed records do not replace an earlier valid value. */ }
    }
    return ai;
  };
  const endpoints = ai => {
    const provider = ai.provider === undefined ? "openai" : ai.provider;
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, provider)) return null;
    const deepseek = provider === "deepseek";
    const rawRequest = ai[deepseek ? "deepseekApiUrl" : "apiUrl"];
    const requestUrl = parseUrl(rawRequest === undefined || typeof rawRequest === "string" && !rawRequest.trim() ? DEFAULTS[provider] : typeof rawRequest === "string" ? rawRequest.trim() : rawRequest);
    if (!requestUrl) return null;
    const rawModels = ai[deepseek ? "deepseekModelsUrl" : "modelsUrl"];
    let modelsUrl;
    if (rawModels !== undefined && !(typeof rawModels === "string" && !rawModels.trim())) modelsUrl = parseUrl(typeof rawModels === "string" ? rawModels.trim() : rawModels);
    else {
      const derived = new URL(requestUrl);
      if (/\/(?:responses|chat\/completions)\/?$/.test(derived.pathname)) {
        derived.pathname = derived.pathname.replace(/\/(?:responses|chat\/completions)\/?$/, "/models");
        modelsUrl = derived.href;
      }
    }
    const rawKey = ai[deepseek ? "deepseekApiKey" : "apiKey"];
    const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
    return {requestUrl, modelsUrl, apiKey};
  };
  const validate = (request, storage) => {
    const reject = code => ({ok: false, code});
    if (!plain(request) || !["GET", "POST"].includes(request.method)) return reject("INVALID_REQUEST");
    const url = parseUrl(request.url);
    if (!url || url !== request.url) return reject("INVALID_URL");
    const configured = endpoints(readAi(storage));
    if (!configured || !configured.apiKey || /[\r\n\u0000]/.test(configured.apiKey)) return reject("INVALID_CONFIGURATION");
    if (url !== (request.method === "GET" ? configured.modelsUrl : configured.requestUrl)) return reject("ENDPOINT_NOT_CONFIGURED");
    if (!plain(request.headers)) return reject("INVALID_HEADERS");
    const entries = Object.entries(request.headers);
    const headers = {};
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      if (!["authorization", "content-type"].includes(lower) || typeof value !== "string" || headers[lower] !== undefined) return reject("INVALID_HEADERS");
      headers[lower] = value;
    }
    if (headers.authorization !== "Bearer " + configured.apiKey) return reject("CREDENTIALS_CHANGED");
    if (headers["content-type"] !== undefined && headers["content-type"] !== "application/json") return reject("INVALID_HEADERS");
    if (request.method === "GET" && request.data !== undefined && request.data !== null && request.data !== "") return reject("INVALID_BODY");
    if (request.method === "POST") {
      if (headers["content-type"] !== "application/json" || typeof request.data !== "string") return reject("INVALID_BODY");
      if (request.data.length > REQUEST_LIMIT || new TextEncoder().encode(request.data).byteLength > REQUEST_LIMIT) return reject("REQUEST_TOO_LARGE");
      try { if (!plain(JSON.parse(request.data))) return reject("INVALID_BODY"); }
      catch { return reject("INVALID_BODY"); }
    }
    const timeout = request.method === "GET" ? 20000 : Math.min(300000, Math.max(15000, Math.trunc(Number(request.timeout) || 120000)));
    return {ok: true, request: {url, method: request.method, headers,
      ...(request.method === "POST" ? {data: request.data} : {}), timeout, responseLimit: RESPONSE_LIMIT}};
  };
  const api = Object.freeze({CONFIG_KEY, REQUEST_LIMIT, RESPONSE_LIMIT, COURSE_DOMAINS, parseUrl, supportedUrl, trustedSender, readAi, endpoints, validate});
  root.AiHelperNetworkPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
