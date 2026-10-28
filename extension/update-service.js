/* GitHub release discovery only. Installing an unpacked update stays explicit. */
(function (root) {
  "use strict";
  const STORAGE_KEY = "ai-course-helper:updates:v1";
  const ALARM_NAME = "ai-helper:check-updates";
  const RELEASE_API = "https://api.github.com/repos/aides-hik/ai-course-helper/releases/latest";
  const REPOSITORY = "https://github.com/aides-hik/ai-course-helper";
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  const MANUAL_COOLDOWN_MS = 30000;
  const MAX_BYTES = 256 * 1024;
  let inFlight;
  const currentVersion = () => chrome.runtime.getManifest().version;
  const versionParts = version => {
    if (typeof version !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(version)) return null;
    const parts = version.split(".").map(Number);
    return parts.every(value => value <= 65535) ? parts.concat(Array(4 - parts.length).fill(0)) : null;
  };
  const compareVersions = (left, right) => {
    const a = versionParts(left), b = versionParts(right);
    if (!a || !b) throw new Error("INVALID_VERSION");
    for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    return 0;
  };
  const releaseUrlFor = version => REPOSITORY + "/releases/tag/v" + version;
  const downloadUrlFor = version => REPOSITORY + "/releases/download/v" + version + "/ai-course-helper-extension-" + version + ".zip";
  const baseState = () => ({status: "unknown", currentVersion: currentVersion(), latestVersion: "", checkedAt: 0, downloadUrl: "", releaseUrl: ""});
  const knownCodes = new Set(["NO_RELEASE", "RELEASE_NOT_READY", "NETWORK_ERROR", "CHECK_TIMEOUT", "RATE_LIMITED", "HTTP_ERROR", "INVALID_RELEASE", "RESPONSE_TOO_LARGE", "STORAGE_UNAVAILABLE"]);
  const fromStored = value => {
    const result = baseState();
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    if (value.latestVersion && (!versionParts(value.latestVersion) || value.releaseUrl !== releaseUrlFor(value.latestVersion))) return result;
    if (Number.isFinite(value.checkedAt) && value.checkedAt >= 0 && value.checkedAt <= Date.now()) result.checkedAt = value.checkedAt;
    if (versionParts(value.latestVersion) && value.releaseUrl === releaseUrlFor(value.latestVersion)) {
      result.latestVersion = value.latestVersion;
      result.releaseUrl = value.releaseUrl;
      if (value.downloadUrl === downloadUrlFor(value.latestVersion)) result.downloadUrl = value.downloadUrl;
      result.status = compareVersions(value.latestVersion, result.currentVersion) > 0
        ? result.downloadUrl ? "available" : "unknown" : "current";
    }
    if (knownCodes.has(value.errorCode)) result.errorCode = value.errorCode;
    if (value.status === "error" && result.errorCode && !["NO_RELEASE", "RELEASE_NOT_READY"].includes(result.errorCode)) result.status = "error";
    return result;
  };
  const readState = async () => {
    const saved = await chrome.storage.local.get(STORAGE_KEY);
    return fromStored(saved[STORAGE_KEY]);
  };
  const validateRelease = value => {
    if (!value || typeof value !== "object" || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")) throw new Error("INVALID_RELEASE");
    const version = value.tag_name.slice(1);
    if (!versionParts(version) || value.html_url !== releaseUrlFor(version) || !Array.isArray(value.assets)) throw new Error("INVALID_RELEASE");
    const expectedName = "ai-course-helper-extension-" + version + ".zip";
    const matches = value.assets.filter(asset => asset?.name === expectedName);
    if (matches.length > 1) throw new Error("INVALID_RELEASE");
    let downloadUrl = "";
    if (matches.length) {
      const asset = matches[0];
      if (asset.state !== "uploaded" || !Number.isFinite(asset.size) || asset.size <= 0 || asset.size > 25 * 1024 * 1024 || asset.browser_download_url !== downloadUrlFor(version)) throw new Error("INVALID_RELEASE");
      downloadUrl = asset.browser_download_url;
    }
    return {latestVersion: version, releaseUrl: releaseUrlFor(version), downloadUrl};
  };
  const readJson = async response => {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("RESPONSE_TOO_LARGE");
    if (!response.body) throw new Error("INVALID_RELEASE");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = "", size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error("RESPONSE_TOO_LARGE");
        text += decoder.decode(part.value, {stream: true});
      }
      try {return JSON.parse(text + decoder.decode());} catch {throw new Error("INVALID_RELEASE");}
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {reader.releaseLock();}
  };
  const setBadge = async state => {
    const available = !!state.downloadUrl && !!state.latestVersion && compareVersions(state.latestVersion, currentVersion()) > 0;
    try {
      await chrome.action?.setBadgeText?.({text: available ? "NEW" : ""});
      if (available) await chrome.action?.setBadgeBackgroundColor?.({color: "#465bea"});
      await chrome.action?.setTitle?.({title: available ? "AI 学习助手 · 发现新版 " + state.latestVersion : "AI 学习助手"});
    } catch { /* Closing a browser window need not fail a successful check. */ }
  };
  const runCheck = async force => {
    let previous;
    try {previous = await readState();}
    catch {return {...baseState(), status: "error", errorCode: "STORAGE_UNAVAILABLE"};}
    if (previous.checkedAt && Date.now() - previous.checkedAt < (force ? MANUAL_COOLDOWN_MS : INTERVAL_MS)) {await setBadge(previous); return previous;}
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, 15000);
    let result;
    try {
      const response = await fetch(RELEASE_API, {method: "GET", headers: {Accept: "application/vnd.github+json"}, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal});
      if (response.redirected || response.url && response.url !== RELEASE_API) throw new Error("INVALID_RELEASE");
      if (response.status === 404) result = {...baseState(), errorCode: "NO_RELEASE"};
      else {
        if (response.status === 403 || response.status === 429) throw new Error("RATE_LIMITED");
        if (response.status < 200 || response.status >= 300) throw new Error("HTTP_ERROR");
        const release = validateRelease(await readJson(response));
        result = {...baseState(), ...release};
        const newer = compareVersions(release.latestVersion, currentVersion()) > 0;
        result.status = !newer ? "current" : release.downloadUrl ? "available" : "unknown";
        if (newer && !release.downloadUrl) result.errorCode = "RELEASE_NOT_READY";
      }
    } catch (error) {
      result = {...previous, status: "error", errorCode: timedOut ? "CHECK_TIMEOUT" : knownCodes.has(error?.message) ? error.message : "NETWORK_ERROR"};
    } finally {clearTimeout(timer);}
    result.currentVersion = currentVersion();
    result.checkedAt = Date.now();
    try {await chrome.storage.local.set({[STORAGE_KEY]: result});}
    catch {result = {...result, status: "error", errorCode: "STORAGE_UNAVAILABLE"};}
    await setBadge(result);
    return result;
  };
  const check = force => {
    if (inFlight) return inFlight;
    inFlight = runCheck(force).finally(() => {inFlight = undefined;});
    return inFlight;
  };
  const ensureAlarm = async () => {
    if (!chrome.alarms?.create) return;
    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (!alarm || alarm.periodInMinutes !== 360) await chrome.alarms.create(ALARM_NAME, {delayInMinutes: 360, periodInMinutes: 360});
  };
  const trustedPopup = sender => sender?.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL("popup.html");
  const open = async action => {
    if (!["download", "release"].includes(action)) return {ok: false, code: "INVALID_ACTION"};
    const update = await readState();
    const url = action === "download" ? update.downloadUrl : update.releaseUrl;
    if (!url) return {ok: false, code: "UPDATE_NOT_AVAILABLE"};
    if (action === "download" && compareVersions(update.latestVersion, currentVersion()) <= 0) return {ok: false, code: "UPDATE_NOT_AVAILABLE"};
    await chrome.tabs.create({url});
    return {ok: true, update};
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!["ai-helper:updates-get", "ai-helper:updates-check", "ai-helper:updates-open"].includes(message?.type)) return;
    if (!trustedPopup(sender)) {respond({ok: false, code: "UNTRUSTED_SENDER"}); return;}
    const task = message.type === "ai-helper:updates-check" ? check(true).then(update => ({ok: true, update}))
      : message.type === "ai-helper:updates-open" ? open(message.action) : readState().then(async update => {await setBadge(update); return {ok: true, update};});
    task.then(respond, () => respond({ok: false, code: "UPDATE_SERVICE_UNAVAILABLE"}));
    return true;
  });
  const wake = () => {void ensureAlarm().then(() => check(false)).catch(() => {});};
  chrome.runtime.onInstalled?.addListener(wake);
  chrome.runtime.onStartup?.addListener(wake);
  chrome.alarms?.onAlarm?.addListener(alarm => {if (alarm?.name === ALARM_NAME) void check(false).catch(() => {});});
  void ensureAlarm().catch(() => {});
  root.AiHelperUpdates = Object.freeze({STORAGE_KEY, ALARM_NAME, RELEASE_API, compareVersions, validateRelease, fromStored, check, readState});
})(globalThis);
