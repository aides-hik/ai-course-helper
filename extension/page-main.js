// This file runs in MAIN. It has no extension API, storage or network bridge.
// Requests intentionally expose only operations that the course page can do.
const PAGE_REQUEST = "ai-course-extension-page-request";
const PAGE_RESPONSE = "ai-course-extension-page-response";
const PAGE_ACTIVITY = "ai-course-extension-page-activity";
const PAGE_REF = "data-ai-course-extension-ref";
const mainNodeIds = new WeakMap();
const mainEditorIds = new WeakMap();
let mainSequence = 0;
const mainId = () => `main-${Date.now().toString(36)}-${++mainSequence}`;
const mainDocumentUrl = (view) => String(view.document.URL || view.location.href);
const mainPath = (view) => {
  const path = [];
  for (let depth = 0; view !== window; depth++) {
    if (depth >= 16 || view === view.parent) throw new Error("frame unavailable");
    const parent = view.parent;
    const frames = Array.from(parent.document.querySelectorAll("iframe,frame"));
    const index = frames.indexOf(view.frameElement);
    if (index < 0) throw new Error("frame detached");
    path.unshift({index, url: mainDocumentUrl(view)});
    view = parent;
  }
  return {path, url: mainDocumentUrl(window)};
};
const mainResolveWindow = (description) => {
  if (!description || description.url !== mainDocumentUrl(window) || !Array.isArray(description.path) || description.path.length > 16) throw new Error("page changed");
  let view = window;
  for (const entry of description.path) {
    if (!Number.isInteger(entry?.index) || entry.index < 0 || entry.index > 10000 || typeof entry.url !== "string") throw new Error("invalid frame");
    const frame = view.document.querySelectorAll("iframe,frame")[entry.index];
    if (!frame?.isConnected || !frame.contentWindow || !frame.contentDocument) throw new Error("frame unavailable");
    view = frame.contentWindow;
    if (mainDocumentUrl(view) !== entry.url) throw new Error("frame changed");
  }
  return view;
};
const mainMarkNode = (node) => {
  if (!node?.isConnected || node.nodeType !== 1) throw new Error("element unavailable");
  let token = mainNodeIds.get(node);
  if (!token) {token = mainId(); mainNodeIds.set(node, token);}
  node.setAttribute(PAGE_REF, token);
  return {...mainPath(node.ownerDocument.defaultView), token};
};
const mainResolveNode = (view, token) => {
  if (typeof token !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(token)) throw new Error("invalid element");
  const matches = view.document.querySelectorAll(`[${PAGE_REF}="${token}"]`);
  if (matches.length !== 1 || !matches[0].isConnected) throw new Error("element changed");
  return matches[0];
};
const mainVisible = (node) => {
  if (!node?.isConnected || !node.getClientRects?.().length) return false;
  for (let current = node; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView.getComputedStyle(current);
    if (current.hidden || current.getAttribute("aria-hidden") === "true" || style.display === "none" || ["hidden", "collapse"].includes(style.visibility)) return false;
  }
  const parentFrame = node.ownerDocument.defaultView.frameElement;
  return !parentFrame || mainVisible(parentFrame);
};
const mainEditor = (field, view) => {
  if (!field || String(field.tagName).toLowerCase() !== "textarea" || field.disabled || field.readOnly || field.matches(":disabled")) return null;
  const identifiers = [field.id, field.name].filter(Boolean);
  const candidates = new Set();
  for (const registry of [view.UE?.instants, view.UE?.instances]) {
    if (!registry || typeof registry !== "object") continue;
    for (const [key, editor] of Object.entries(registry)) {
      if (!editor || typeof editor !== "object") continue;
      if (editor.textarea === field || editor._textarea === field || identifiers.some((id) => [key, editor.key, editor.id, editor.options?.textarea].includes(id))) candidates.add(editor);
    }
  }
  if (candidates.size !== 1) return null;
  const editor = Array.from(candidates)[0];
  const body = editor.body || editor.document?.body || editor.iframe?.contentDocument?.body;
  if (editor.isReady === false || typeof editor.setContent !== "function" || typeof editor.getContentTxt !== "function" || !mainVisible(body)) return null;
  let id = mainEditorIds.get(editor);
  if (!id) {id = mainId(); mainEditorIds.set(editor, id);}
  return {editor, body, id};
};
const mainShadowHtml = (shadow, view) => {
  if (typeof shadow === "string") return shadow;
  if (!shadow || typeof shadow !== "object") return null;
  if (typeof shadow.innerHTML === "string") return shadow.innerHTML;
  if (shadow.nodeType && shadow.childNodes) {
    const holder = view.document.createElement("template");
    for (const child of shadow.childNodes) holder.content.appendChild(child.cloneNode(true));
    return holder.innerHTML;
  }
  return null;
};
const mainOperation = (request) => {
  const view = mainResolveWindow(request.frame);
  if (request.action === "call") {
    if (!["noSubmit", "btnBlueSubmit", "submitCheckTimes"].includes(request.method) || request.args?.length) throw new Error("operation not allowed");
    if (typeof view[request.method] !== "function") throw new Error("page operation unavailable");
    return Reflect.apply(view[request.method], view, []);
  }
  if (request.action === "book") {
    if (typeof view.getFrameAttr !== "function" || typeof window.top.onchangepage !== "function") throw new Error("book control unavailable");
    const end = view.getFrameAttr("end");
    if (!["string", "number"].includes(typeof end) || String(end).length > 1000) throw new Error("book page invalid");
    return window.top.onchangepage(end);
  }
  if (request.action === "nextQuestion") {
    if (view !== window || typeof view.getTheNextQuestion !== "function") return false;
    view.getTheNextQuestion(1);
    return true;
  }
  if (!["editorInfo", "editorSet", "editorRead", "shadow"].includes(request.action)) throw new Error("operation not allowed");
  const node = mainResolveNode(view, request.target);
  if (request.action === "shadow") {
    const html = mainShadowHtml(node.__Ivue__?._data?.shadowDom, view);
    if (html !== null && html.length > 1024 * 1024) throw new Error("question content too long");
    return html === null ? null : {html};
  }
  const found = mainEditor(node, view);
  if (!found) return null;
  if (request.action === "editorInfo") return {id: found.id, body: mainMarkNode(found.body)};
  if (request.editor !== found.id) throw new Error("editor changed");
  if (request.action === "editorRead") {
    const value = found.editor.getContentTxt();
    if (typeof value !== "string" || value.length > 1024 * 1024) throw new Error("editor content invalid");
    return value;
  }
  if (typeof request.html !== "string" || request.html.length > 1024 * 1024) throw new Error("editor content invalid");
  // The isolated adapter passes escaped plain text with BR line breaks only.
  if (/<(?!br\s*\/?>)/i.test(request.html)) throw new Error("editor markup not allowed");
  found.editor.setContent(request.html);
  return true;
};
const mainPageRequest = (event) => {
  const channel = event.target;
  if (!channel || channel.ownerDocument !== document || channel.tagName !== "SPAN" || !channel.hidden || !channel.isConnected) return;
  let request;
  try {
    const raw = channel.getAttribute("data-ai-request");
    if (!raw || raw.length > 1100000) return;
    request = JSON.parse(raw);
    if (request?.v !== 1 || typeof request.id !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(request.id)) return;
  } catch {return;}
  const respond = (result) => {
    if (!channel.isConnected) return;
    // Never serialize arbitrary page return values or errors.
    channel.setAttribute("data-ai-response", JSON.stringify({v: 1, id: request.id, ...result}));
    channel.dispatchEvent(new CustomEvent(PAGE_RESPONSE));
  };
  try {
    const value = mainOperation(request);
    if (["call", "book"].includes(request.action)) {
      if (value && typeof value.then === "function") {
        respond({ok: true, pending: true});
        Promise.resolve(value).then(() => respond({ok: true, value: true}), () => respond({ok: false, error: "平台操作未完成"}));
      } else respond({ok: true, value: true});
    } else respond({ok: true, value: value ?? null});
  } catch {respond({ok: false, error: "页面已变化或平台操作不可用"});}
};
document.addEventListener(PAGE_REQUEST, mainPageRequest, true);
if (isZhsHost(window.location)) {
  hookWebpack();
  hookError();
  new XMLHttpRequestInterceptor(["gateway/t/v1/answer/hasAnswer"], (_response, phase) => {
    if (["start", "load", "resume"].includes(phase)) document.dispatchEvent(new CustomEvent(PAGE_ACTIVITY, {detail: JSON.stringify({v: 1, phase})}));
  });
}
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) document.removeEventListener(PAGE_REQUEST, mainPageRequest, true);
});
