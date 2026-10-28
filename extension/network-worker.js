"use strict";
// Requests run outside the service worker, so a long model response does not
// depend on the service worker's 30 second fetch-response lifecycle limit.
const active = new Map();
const responseText = async (response, maximum) => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error("RESPONSE_TOO_LARGE");
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {reader.releaseLock();}
};
self.onmessage = event => {
  const message = event.data;
  if (!message || typeof message.id !== "string") return;
  if (message.type === "abort") {active.get(message.id)?.controller.abort(); return;}
  if (message.type !== "request" || active.has(message.id)) return;
  const {request, id} = message;
  if (!request || typeof request.url !== "string" || !["GET", "POST"].includes(request.method)) return;
  const controller = new AbortController();
  const record = {controller, timedOut: false};
  active.set(id, record);
  const timeout = setTimeout(() => {record.timedOut = true; controller.abort();}, request.timeout);
  void (async () => {
    try {
      const response = await fetch(request.url, {
        method: request.method, headers: request.headers,
        ...(request.method === "POST" ? {body: request.data} : {}),
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (response.redirected || response.url && response.url !== request.url) throw new Error("REDIRECT_BLOCKED");
      const text = await responseText(response, Math.min(4 * 1024 * 1024, request.responseLimit || 4 * 1024 * 1024));
      if (controller.signal.aborted) throw new Error("REQUEST_ABORTED");
      self.postMessage({type: "response", id, response: {status: response.status, responseText: text, finalUrl: response.url || request.url}});
    } catch (error) {
      const type = record.timedOut ? "timeout" : controller.signal.aborted ? "abort" : "error";
      const code = type === "timeout" ? "REQUEST_TIMEOUT" : type === "abort" ? "REQUEST_ABORTED" :
        error?.message === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : error?.message === "REDIRECT_BLOCKED" ? "REDIRECT_BLOCKED" : "NETWORK_ERROR";
      self.postMessage({type, id, code});
    } finally {clearTimeout(timeout); active.delete(id);}
  })();
};
