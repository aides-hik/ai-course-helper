// Kept inside an async isolated-world closure by build_extension.py.
// GM names are private adapters for the shared application, not a userscript dependency.
const extensionListeners = new Map();
const extensionCache = Object.create(null);
const extensionChangesDuringLoad = Object.create(null);
let extensionLoading = true;
let extensionListenerId = 0;
let extensionPending = Object.create(null);
let extensionWriteQueue = Promise.resolve();
let extensionWriteError = null;
let extensionWriteScheduled = false;
const extensionOwnWrites = new Map();
let extensionPanelController = null;
const extensionStorageChanged = (changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    const own = extensionOwnWrites.get(key);
    const echoIndex = own?.findIndex(record => Object.is(record.value, change.newValue)) ?? -1;
    if (echoIndex >= 0) {
      own.splice(0, echoIndex + 1);
      if (!own.length) extensionOwnWrites.delete(key);
      continue;
    }
    // A local edit that is still queued must not be replaced by an earlier
    // change from another tab before our own write reaches storage.
    if (Object.prototype.hasOwnProperty.call(extensionPending, key) || own?.length) continue;
    if (extensionLoading) extensionChangesDuringLoad[key] = change.newValue;
    const previous = extensionCache[key];
    if (change.newValue === undefined) delete extensionCache[key];
    else extensionCache[key] = change.newValue;
    if (Object.is(previous, change.newValue)) continue;
    for (const {name, callback} of extensionListeners.values()) {
      if (name === key) {try {callback(key, previous, change.newValue, true);} catch {}}
    }
  }
};
chrome.storage.onChanged.addListener(extensionStorageChanged);
Object.assign(extensionCache, await chrome.storage.local.get(null), extensionChangesDuringLoad);
extensionLoading = false;
const extensionReportError = (text) => {
  // Use fixed messages only; never put configuration values into diagnostics.
  console.error("[AI 学习助手] " + text);
  if (!document.body) return;
  let note = document.getElementById("ai-course-extension-error");
  if (!note) {
    note = document.createElement("div"); note.id = "ai-course-extension-error";
    note.setAttribute("role", "alert");
    note.style.cssText = "position:fixed;z-index:2147483647;bottom:16px;right:16px;max-width:340px;padding:12px 16px;border-radius:12px;background:#fff5ed;color:#8a3e1b;box-shadow:0 6px 30px #0002;font:13px/1.6 sans-serif";
    document.body.append(note);
  }
  note.textContent = text;
};
const extensionCommitPending = () => {
  extensionWriteScheduled = false;
  const updates = extensionPending;
  extensionPending = Object.create(null);
  if (!Object.keys(updates).length) return;
  extensionWriteQueue = extensionWriteQueue.then(async () => {
    const echoes = Object.entries(updates).map(([key, value]) => {
      const record = {value};
      if (!extensionOwnWrites.has(key)) extensionOwnWrites.set(key, []);
      extensionOwnWrites.get(key).push(record);
      return {key, record};
    });
    try {await chrome.storage.local.set(updates); extensionWriteError = null;}
    catch (error) {
      for (const {key, record} of echoes) {
        const own = extensionOwnWrites.get(key);
        if (own) {
          const index = own.indexOf(record);
          if (index >= 0) own.splice(index, 1);
          if (!own.length) extensionOwnWrites.delete(key);
        }
      }
      // Retain failed writes so Save can retry them without losing the cache.
      for (const [key, value] of Object.entries(updates)) {
        if (!(key in extensionPending) && extensionCache[key] === value) extensionPending[key] = value;
      }
      extensionWriteError = error;
      extensionReportError("配置保存失败，请检查扩展是否仍启用，然后点击保存重试。");
    }
  });
};
const extensionFlushStorage = async () => {
  await Promise.resolve();
  if (typeof Vue !== "undefined") await Vue.nextTick();
  do {
    extensionCommitPending();
    const waiting = extensionWriteQueue;
    await waiting;
    if (extensionWriteError) throw new Error("配置尚未保存");
    if (typeof Vue !== "undefined") await Vue.nextTick();
    if (waiting === extensionWriteQueue && !Object.keys(extensionPending).length) return;
  } while (true);
};
const GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(extensionCache, key) ? extensionCache[key] : fallback;
const GM_setValue = (key, value) => {
  if (Object.prototype.hasOwnProperty.call(extensionCache, key) && Object.is(extensionCache[key], value)) return;
  extensionCache[key] = value;
  extensionPending[key] = value;
  if (!extensionWriteScheduled) {extensionWriteScheduled = true; queueMicrotask(extensionCommitPending);}
};
const GM_addValueChangeListener = (name, callback) => {
  const id = ++extensionListenerId; extensionListeners.set(id, {name, callback}); return id;
};
const GM_removeValueChangeListener = id => extensionListeners.delete(id);
const GM_getResourceText = name => extensionResources[name] || "";
const GM_addStyle = text => {
  const node = document.createElement("style"); node.textContent = text;
  (document.head || document.documentElement).append(node); return node;
};
const GM_info = {script: {
  name: chrome.runtime.getManifest().name, namespace: "local.ai.course-helper.extension",
  version: chrome.runtime.getManifest().version, description: chrome.runtime.getManifest().description
}};
const unsafeWindow = window;
let extensionNetworkPort = null;
let extensionNetworkStarting = null;
let extensionRequestSequence = 0;
const extensionRequests = new Map();
const extensionNetworkFinish = (id, type, response) => {
  const entry = extensionRequests.get(id);
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  extensionRequests.delete(id);
  const callback = entry.options[type === "response" ? "onload" : type === "timeout" ? "ontimeout" : type === "abort" ? "onabort" : "onerror"];
  try {callback?.(response || {});} catch {console.error("[AI 学习助手] 模型请求回调失败");}
};
const extensionGetNetworkPort = async () => {
  if (extensionNetworkPort) return extensionNetworkPort;
  if (extensionNetworkStarting) return extensionNetworkStarting;
  extensionNetworkStarting = (async () => {
    const ready = await chrome.runtime.sendMessage({type: "ai-helper:network-ready"});
    if (!ready?.ok) throw new Error("网络进程无法启动");
    const port = chrome.runtime.connect({name: "ai-helper:network"});
    extensionNetworkPort = port;
    port.onMessage.addListener(message => {
      if (["response", "error", "timeout", "abort"].includes(message?.type)) extensionNetworkFinish(message.id, message.type, message.response);
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError suppresses Chrome's otherwise unhandled port warning.
      void chrome.runtime.lastError;
      if (extensionNetworkPort === port) extensionNetworkPort = null;
      for (const [id, entry] of extensionRequests) if (entry.port === port) extensionNetworkFinish(id, "error");
    });
    return port;
  })();
  try {return await extensionNetworkStarting;}
  finally {extensionNetworkStarting = null;}
};
const GM_xmlhttpRequest = options => {
  const id = "request-" + ++extensionRequestSequence;
  const entry = {options, settled: false, port: null, timer: null};
  extensionRequests.set(id, entry);
  const abort = () => {
    if (entry.settled) return;
    try {entry.port?.postMessage({type: "abort", id});} catch {}
    extensionNetworkFinish(id, "abort");
  };
  // The content-side timer also covers Worker startup and policy validation.
  entry.timer = setTimeout(() => {
    try {entry.port?.postMessage({type: "abort", id});} catch {}
    extensionNetworkFinish(id, "timeout");
  }, Math.max(1, Number(options.timeout) || 120000));
  void (async () => {
    try {
      await extensionFlushStorage();
      if (entry.settled) return;
      const port = await extensionGetNetworkPort();
      if (entry.settled) return;
      entry.port = port;
      port.postMessage({type: "request", id, request: {
        url: options.url, method: options.method || "GET", headers: options.headers || {},
        ...(options.data === undefined ? {} : {data: options.data}), timeout: options.timeout
      }});
    } catch {extensionNetworkFinish(id, "error");}
  })();
  return {abort};
};
window.addEventListener("pagehide", event => {
  for (const [id, entry] of extensionRequests) {
    try {entry.port?.postMessage({type: "abort", id});} catch {}
    extensionNetworkFinish(id, "abort");
  }
  try {extensionNetworkPort?.disconnect();} catch {}
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "ai-helper:show-panel") return;
  const shown = extensionPanelController?.() === true;
  respond({ok: shown});
});
