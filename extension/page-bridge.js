// Embedded into the isolated application's closure. No secrets cross this bridge.
const extensionPageBridge = (() => {
  const REQUEST = "ai-course-extension-page-request";
  const RESPONSE = "ai-course-extension-page-response";
  const REF = "data-ai-course-extension-ref";
  const nodeIds = new WeakMap();
  const editorFacades = new WeakMap();
  let sequence = 0;
  const id = () => `isolated-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2, 10)}`;
  const documentUrl = (view) => String(view.document.URL || view.location.href);
  const frameDescription = (view) => {
    const path = [];
    for (let depth = 0; view !== window; depth++) {
      if (depth >= 16 || view === view.parent) throw new Error("不支持访问此页面框架");
      const parent = view.parent;
      const index = Array.from(parent.document.querySelectorAll("iframe,frame")).indexOf(view.frameElement);
      if (index < 0) throw new Error("题目页面已切换");
      path.unshift({index, url: documentUrl(view)});
      view = parent;
    }
    return {path, url: documentUrl(window)};
  };
  const resolveBody = (description) => {
    if (!description || description.url !== documentUrl(window) || !Array.isArray(description.path)) return null;
    let view = window;
    for (const entry of description.path) {
      const frame = view.document.querySelectorAll("iframe,frame")[entry.index];
      if (!frame?.contentDocument || documentUrl(frame.contentWindow) !== entry.url) return null;
      view = frame.contentWindow;
    }
    if (typeof description.token !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(description.token)) return null;
    const nodes = view.document.querySelectorAll(`[${REF}="${description.token}"]`);
    return nodes.length === 1 && nodes[0].isConnected ? nodes[0] : null;
  };
  const targetDescription = (node) => {
    if (!node?.isConnected || node.nodeType !== 1) throw new Error("题目元素已变化");
    let token = nodeIds.get(node);
    if (!token) {token = id(); nodeIds.set(node, token);}
    node.setAttribute(REF, token);
    return {frame: frameDescription(node.ownerDocument.defaultView), target: token};
  };
  const begin = (action, description) => {
    const request = {v: 1, id: id(), action, ...description};
    const channel = document.createElement("span");
    channel.hidden = true;
    channel.setAttribute("data-ai-request", JSON.stringify(request));
    document.documentElement.appendChild(channel);
    const read = () => {
      const text = channel.getAttribute("data-ai-response");
      if (!text) throw new Error("页面适配尚未就绪，请刷新学习页面");
      const result = JSON.parse(text);
      if (result?.v !== 1 || result.id !== request.id || result.ok !== true) throw new Error(result?.error || "页面操作失败，请手动核对");
      return result;
    };
    return {channel, read, dispatch: () => channel.dispatchEvent(new CustomEvent(REQUEST, {bubbles: true}))};
  };
  const sync = (action, description) => {
    const operation = begin(action, description);
    try {
      operation.dispatch();
      const result = operation.read();
      if (result.pending) throw new Error("页面操作尚未完成");
      return result.value;
    } finally {operation.channel.remove();}
  };
  const async = (action, description) => new Promise((resolve, reject) => {
    let operation;
    try {operation = begin(action, description);} catch (error) {reject(error); return;}
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.channel.removeEventListener(RESPONSE, receive);
      operation.channel.remove();
      if (error) reject(error); else resolve(value);
    };
    const receive = () => {
      try {const result = operation.read(); if (!result.pending) finish(null, result.value);} catch (error) {finish(error);}
    };
    const timer = setTimeout(() => finish(new Error("平台操作超时，请手动核对保存状态")), 30000);
    operation.channel.addEventListener(RESPONSE, receive);
    try {operation.dispatch(); receive();} catch (error) {finish(error);}
  });
  const editorForField = (field) => {
    try {
      const target = targetDescription(field);
      const info = sync("editorInfo", target);
      if (!info || typeof info.id !== "string") return null;
      const body = resolveBody(info.body);
      if (!body) return null;
      const cached = editorFacades.get(field);
      if (cached?.id === info.id && cached.facade.body === body) return cached.facade;
      const facade = {
        body,
        setContent(html) {if (sync("editorSet", {...target, editor: info.id, html}) !== true) throw new Error("富文本编辑器已切换");},
        getContentTxt() {const text = sync("editorRead", {...target, editor: info.id}); if (typeof text !== "string") throw new Error("富文本编辑器已切换"); return text;}
      };
      editorFacades.set(field, {id: info.id, facade});
      return facade;
    } catch {return null;}
  };
  return {
    call(view, method, args = []) {return async("call", {frame: frameDescription(view), method, args});},
    book(view) {return async("book", {frame: frameDescription(view)});},
    nextQuestion() {try {return sync("nextQuestion", {frame: frameDescription(window)}) === true;} catch {return false;}},
    editorForField,
    shadow(node) {
      try {
        // Only Wisdom Tree stores rendered question content in Vue expandos.
        // Avoid DOM round trips for every ordinary Chaoxing text node.
        if (!isZhsHost(node?.ownerDocument?.defaultView?.location)) return null;
        const value = sync("shadow", targetDescription(node));
        if (!value || typeof value.html !== "string") return null;
        const template = node.ownerDocument.createElement("template");
        template.innerHTML = value.html;
        return template.content;
      } catch {return null;}
    }
  };
})();
// Page-wide hooks are installed independently in MAIN at document_start.
const hookError = () => () => {};
const hookWebpack = () => () => {};
const isZhsHost = (location) => {
  try {const hostname = String(location.hostname || "").toLowerCase().replace(/\.$/, ""); return hostname === "zhihuishu.com" || hostname.endsWith(".zhihuishu.com");} catch {return false;}
};
class XMLHttpRequestInterceptor {
  constructor(parts, callback) {
    let active = typeof callback === "function" && Array.isArray(parts) && parts.includes("gateway/t/v1/answer/hasAnswer");
    let suspended = false;
    const receive = (event) => {
      if (!active || suspended || typeof event.detail !== "string" || event.detail.length > 200) return;
      try {const value = JSON.parse(event.detail); if (value.v === 1 && ["start", "load", "resume"].includes(value.phase)) callback(null, value.phase);} catch {}
    };
    const hide = (event) => {
      if (!active) return;
      if (!event.persisted) {this.dispose(); return;}
      suspended = true;
      try {callback(null, "start");} catch {}
    };
    const show = (event) => {
      if (!active || !suspended || !event.persisted) return;
      suspended = false;
      try {callback(null, "resume");} catch {}
    };
    this.dispose = () => {
      active = false;
      document.removeEventListener("ai-course-extension-page-activity", receive);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
    document.addEventListener("ai-course-extension-page-activity", receive);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
  }
}
