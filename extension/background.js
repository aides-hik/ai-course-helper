"use strict";
importScripts("network-policy.js");
importScripts("update-service.js");
const policy = AiHelperNetworkPolicy;
const OFFSCREEN_PATH = "offscreen.html";
let creatingNetworkDocument;
const isOffscreenSender = sender => sender?.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
const ensureNetworkDocument = async () => {
  if (creatingNetworkDocument) return creatingNetworkDocument;
  creatingNetworkDocument = (async () => {
    const contexts = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]});
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH, reasons: ["WORKERS"],
      justification: "Run a packaged network Worker for cancellable model requests that may take up to five minutes."
    });
  })();
  try { await creatingNetworkDocument; }
  finally { creatingNetworkDocument = undefined; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "ai-helper:network-ready") {
    if (!policy.trustedSender(sender, chrome.runtime.id)) {respond({ok: false, code: "UNTRUSTED_SENDER"}); return;}
    ensureNetworkDocument().then(() => respond({ok: true}), () => respond({ok: false, code: "NETWORK_DOCUMENT_UNAVAILABLE"}));
    return true;
  }
  if (message?.type === "ai-helper:validate-network") {
    if (!isOffscreenSender(sender) || !policy.trustedSender(message.sender, chrome.runtime.id)) {respond({ok: false, code: "UNTRUSTED_SENDER"}); return;}
    chrome.storage.local.get(null).then(storage => respond(policy.validate(message.request, storage)), () => respond({ok: false, code: "STORAGE_UNAVAILABLE"}));
    return true;
  }
});
