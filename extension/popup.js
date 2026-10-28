"use strict";
document.getElementById("version").textContent = "浏览器扩展 · " + chrome.runtime.getManifest().version;
const status = document.getElementById("status");
const supported = value => {
  try {const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && ["chaoxing.com", "zhihuishu.com", "edu.cn", "nbdlib.cn", "hnsyu.net", "gdhkmooc.com"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));}
  catch {return false;}
};
const activeCourse = async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !supported(tab.url)) throw new Error("请先打开超星或智慧树课程页面。");
  return tab;
};
document.getElementById("show").addEventListener("click", async () => {
  try {
    const tab = await activeCourse();
    const response = await chrome.tabs.sendMessage(tab.id, {type: "ai-helper:show-panel"}, {frameId: 0});
    status.textContent = response?.ok ? "面板已展开。" : "请进入章节、作业或答题页面，面板会自动显示。";
  } catch (error) {status.textContent = error.message.includes("请先") ? error.message : "请刷新课程页后重试。";}
});
document.getElementById("refresh").addEventListener("click", async () => {
  try {const tab = await activeCourse(); await chrome.tabs.reload(tab.id); window.close();}
  catch {status.textContent = "请先打开超星或智慧树课程页面。";}
});

const updateStatus = document.getElementById("update-status");
const updateTime = document.getElementById("update-time");
const updateActions = document.getElementById("update-actions");
const checkUpdates = document.getElementById("check-updates");
const downloadUpdate = document.getElementById("download-update");
const updateMessages = {
  NO_RELEASE: "暂未发布可下载版本，稍后会自动检查。",
  RELEASE_NOT_READY: "新版安装包尚未就绪，请稍后检查。",
  RATE_LIMITED: "GitHub 检查次数受限，稍后会自动重试。",
  NETWORK_ERROR: "暂时无法连接 GitHub，稍后会自动重试。",
  INVALID_RELEASE: "新版信息未通过校验，请稍后重试。"
};
const updateIsNewer = (candidate, current) => {
  const parse = value => typeof value === "string" && /^\d+(?:\.\d+){0,3}$/.test(value) ? value.split(".").map(Number) : null;
  const next = parse(candidate), installed = parse(current);
  if (!next || !installed || [...next, ...installed].some(part => part > 65535)) return false;
  for (let index = 0; index < 4; index++) {
    if ((next[index] || 0) !== (installed[index] || 0)) return (next[index] || 0) > (installed[index] || 0);
  }
  return false;
};
const renderUpdate = update => {
  if (!update) {updateStatus.textContent = "无法读取更新状态，请点击检查更新。"; return;}
  updateStatus.dataset.state = update.status;
  const available = !!update.downloadUrl && updateIsNewer(update.latestVersion, update.currentVersion);
  updateActions.hidden = !available && !(update.errorCode === "RELEASE_NOT_READY" && update.releaseUrl);
  downloadUpdate.hidden = !available;
  downloadUpdate.textContent = available ? `下载 v${update.latestVersion}` : "下载新版";
  if (update.status === "available") updateStatus.textContent = `发现新版 v${update.latestVersion}`;
  else if (update.status === "current") updateStatus.textContent = "当前已是最新版本。";
  else if (update.status === "error") updateStatus.textContent = available ? `发现过新版 v${update.latestVersion}；本次检查未成功。` : updateMessages[update.errorCode] || "更新检查未成功，稍后会自动重试。";
  else updateStatus.textContent = updateMessages[update.errorCode] || "等待首次自动检查，也可点击立即检查。";
  const checked = Number(update.checkedAt);
  updateTime.textContent = checked > 0 && Number.isFinite(checked) ? "上次检查：" + new Date(checked).toLocaleString() : "";
};
const loadUpdate = async forced => {
  checkUpdates.disabled = true;
  checkUpdates.textContent = forced ? "正在检查…" : "检查更新";
  try {
    const result = await chrome.runtime.sendMessage({type: forced ? "ai-helper:updates-check" : "ai-helper:updates-get"});
    if (!result?.ok) throw new Error("Update service unavailable");
    renderUpdate(result.update);
  } catch {updateStatus.textContent = "更新服务暂不可用，请重新打开弹窗。";}
  finally {checkUpdates.disabled = false; checkUpdates.textContent = "检查更新";}
};
checkUpdates.addEventListener("click", () => {void loadUpdate(true);});
for (const [id, action] of [["download-update", "download"], ["view-release", "release"]]) {
  document.getElementById(id).addEventListener("click", async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({type: "ai-helper:updates-open", action});
      if (!response?.ok) throw new Error("Link unavailable");
      if (action === "download") updateStatus.textContent = "下载已打开。替换原目录后，请重新加载扩展。";
    } catch {updateStatus.textContent = "下载信息不可用，请先检查更新。";}
    finally {button.disabled = false;}
  });
}
void loadUpdate(false);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.prototype.hasOwnProperty.call(changes, "ai-course-helper:updates:v1") && !checkUpdates.disabled) void loadUpdate(false);
});
