"use strict";
// Only this extension document creates the Worker. No webpage message handler
// exposes it, and each request is checked against extension-owned settings.
const policy = AiHelperNetworkPolicy;
const records = new Map();
let networkWorker;
let nextPortId = 0;
const post = (port, message) => {try {port.postMessage(message);} catch { /* A navigation may already have disconnected it. */ }};
const createWorker = () => {
  if (networkWorker) return networkWorker;
  const worker = new Worker("network-worker.js");
  networkWorker = worker;
  worker.onmessage = event => {
    const message = event.data;
    const record = records.get(message?.id);
    if (!record || record.state !== "running") return;
    records.delete(message.id);
    record.owner.requests.delete(record.id);
    const result = {type: message.type, id: record.id};
    if (message.type === "response") result.response = message.response;
    else result.code = message.code || "NETWORK_ERROR";
    post(record.owner.port, result);
  };
  worker.onerror = event => {
    event.preventDefault();
    if (networkWorker !== worker) return;
    worker.terminate();
    networkWorker = undefined;
    for (const [taskId, record] of records) {
      if (record.state !== "running") continue;
      records.delete(taskId);
      record.owner.requests.delete(record.id);
      post(record.owner.port, {type: "error", id: record.id, code: "NETWORK_WORKER_UNAVAILABLE"});
    }
  };
  return worker;
};
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "ai-helper:network") return;
  if (!policy.trustedSender(port.sender, chrome.runtime.id)) {port.disconnect(); return;}
  const owner = {port, requests: new Map(), connected: true, prefix: String(++nextPortId) + ":", nextRequestId: 0};
  const cancel = id => {
    const taskId = owner.requests.get(id);
    const record = records.get(taskId);
    if (!record) return;
    records.delete(taskId);
    owner.requests.delete(id);
    if (record.state === "running") networkWorker?.postMessage({type: "abort", id: taskId});
    post(port, {type: "abort", id, code: "REQUEST_ABORTED"});
  };
  const dispose = () => {
    if (!owner.connected) return;
    owner.connected = false;
    for (const id of [...owner.requests.keys()]) cancel(id);
  };
  port.onMessage.addListener(async message => {
    if (!owner.connected || !message || typeof message.id !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(message.id)) return;
    if (message.type === "abort") {cancel(message.id); return;}
    if (message.type !== "request") return;
    if (owner.requests.has(message.id)) {
      // A local disconnect need not fire this endpoint's onDisconnect event.
      dispose(); port.disconnect(); return;
    }
    if (owner.requests.size >= 2500 || records.size >= 5000) {post(port, {type: "error", id: message.id, code: "TOO_MANY_REQUESTS"}); return;}
    if (!message.request || typeof message.request !== "object" || typeof message.request.data === "string" && message.request.data.length > policy.REQUEST_LIMIT) {
      post(port, {type: "error", id: message.id, code: "INVALID_REQUEST"}); return;
    }
    // Keep worker task ids unique even when a client reuses its external id
    // immediately after cancellation; a late abort must not settle a new task.
    const taskId = owner.prefix + String(++owner.nextRequestId);
    const record = {owner, id: message.id, state: "validating"};
    records.set(taskId, record);
    owner.requests.set(message.id, taskId);
    try {
      const sender = {id: port.sender.id, url: port.sender.url, frameId: port.sender.frameId, tab: {id: port.sender.tab.id}};
      const validated = await chrome.runtime.sendMessage({type: "ai-helper:validate-network", sender, request: message.request});
      if (!owner.connected || records.get(taskId) !== record) return;
      if (!validated?.ok) {
        records.delete(taskId); owner.requests.delete(message.id);
        post(port, {type: "error", id: message.id, code: validated?.code || "INVALID_REQUEST"}); return;
      }
      record.state = "running";
      createWorker().postMessage({type: "request", id: taskId, request: validated.request});
    } catch {
      if (records.get(taskId) !== record) return;
      records.delete(taskId); owner.requests.delete(message.id);
      post(port, {type: "error", id: message.id, code: "NETWORK_UNAVAILABLE"});
    }
  });
  port.onDisconnect.addListener(dispose);
  post(port, {type: "ready"});
});
