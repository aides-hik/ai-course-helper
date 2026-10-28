'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chapter-logic.js'), 'utf8');

// A small DOM tree keeps task ownership and iframe document boundaries real:
// queries search descendants in one document, never a frame's contentDocument.
class Element {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.style = {};
    this.clicks = 0;
    this.classList = { contains: (value) => this.className.split(/\s+/).includes(value) };
  }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get id() { return this.attributes.id || ''; }
  get src() { return this.attributes.src || ''; }
  set src(value) { this.attributes.src = value; }
  get isConnected() { return this.ownerDocument?.isConnected !== false; }
  get parentNode() { return this.parentElement || this.ownerDocument; }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      const adopt = (node) => {
        node.ownerDocument = this.ownerDocument;
        for (const descendant of node.children) adopt(descendant);
      };
      adopt(child);
      this.children.push(child);
    }
    return children.at(-1);
  }
  contains(other) { return other === this || this.children.some((child) => child.contains(other)); }
  matches(selector) {
    return selector.split(',').some((branch) => {
      const value = branch.trim();
      if (!value || value === ':disabled' || value.includes(':scope')) return false;
      const tag = value.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = value.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      for (const [, name] of value.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, quote, expected] of value.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g)) {
        if (this.getAttribute(name) === null || expected !== undefined && this.getAttribute(name) !== expected) return false;
      }
      return !!tag || !!id || value.startsWith('.') || value.startsWith('[');
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const direct = selector.match(/^:scope\s*>\s*(.+)$/);
    if (direct) return this.children.filter((child) => child.matches(direct[1]));
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return [{}]; }
  addEventListener() {}
  removeEventListener() {}
  click() { this.clicks += 1; }
}

function documentFor(url, frameElement = null) {
  const doc = {
    URL: url, readyState: 'complete', isConnected: true,
    defaultView: { frameElement, getComputedStyle: (node) => node.style },
    querySelector(selector) { return this.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  };
  doc.documentElement = new Element('html');
  doc.documentElement.ownerDocument = doc;
  doc.body = doc.documentElement.append(new Element('body'));
  return doc;
}

function addFrame(parent, src) {
  const frame = parent.append(new Element('iframe', { src }));
  frame.contentDocument = documentFor(src || 'about:blank', frame);
  frame.contentWindow = { document: frame.contentDocument };
  return frame;
}

function addVideo(parent, { finished = false } = {}) {
  const wrapper = parent.append(new Element('div', { class: 'ans-attach-ct' }));
  const icon = wrapper.append(new Element('div', { class: 'ans-job-icon' + (finished ? ' ans-job-finished' : '') }));
  const video = addFrame(wrapper, 'https://course.test/ananas/modules/video/index.html?id=video-' + parent.children.length);
  const media = video.contentDocument.body.append(new Element('video'));
  media.ended = true;
  return { wrapper, icon, video, media };
}

function harness({ wait } = {}) {
  const outer = documentFor('https://course.test/mycourse/studentstudy?courseid=1&mooc2=1');
  const rootFrame = addFrame(outer.body, 'https://course.test/mooc-ans/knowledge/cards?knowledgeid=1&courseid=1');
  const next = outer.body.append(new Element('button', { class: 'jb_btn jb_btn_92 fr fs14 nextChapter' }));
  const focus = outer.body.append(new Element('button', { id: 'prevNextFocusNext' }));
  next.textContent = '下一章';
  focus.textContent = '下一节';
  let now = 0;
  const logs = [];
  const config = { platformParams: { cx: { parts: [{ params: [{ value: false }, { value: true }, { value: true }] }] } }, otherParams: { params: [{ value: 0 }] } };
  const sandbox = {
    URL, AbortController, Date: { now: () => now },
    document: outer, window: { location: { href: outer.URL } },
    useLogStore: () => ({ addLog: (message) => logs.push(message) }),
    useQuestionStore: () => ({ clearQuestion() {} }),
    useConfigStore: () => config,
    aiWaitForDelay: async (_seconds, context) => { await wait?.(); return context.isCurrent(); }
  };
  const exports = '    globalThis.chapter = { isFinishedTask, canAdvanceChapter, collectChapterFrames, checkChapterCompletion, inspectChapterCompletion, logChapterDiagnostics, getChapterPage, chapterSnapshot };\n    return;\n    init();';
  vm.runInNewContext(source.replace('    init();', exports) + '\nuseCxChapterLogic();', sandbox);
  now = 2000;
  const context = { signal: new AbortController().signal, isCurrent: () => true };
  return {
    ...sandbox.chapter, root: outer.documentElement, outer, rootFrame,
    chapterBody: rootFrame.contentDocument.body, next, focus, logs, config,
    advanceTime: (milliseconds) => { now += milliseconds; },
    complete: () => sandbox.chapter.checkChapterCompletion(outer.documentElement, context, 0)
  };
}

const navigationClicks = (h) => h.next.clicks + h.focus.clicks;

test('a finished sibling task icon confirms its own video without an ancestor completion class', async () => {
  const h = harness();
  const { video, wrapper } = addVideo(h.chapterBody, { finished: true });
  assert.equal(wrapper.classList.contains('ans-job-finished'), false);
  assert.equal(h.isFinishedTask(video), true);
  assert.equal(h.canAdvanceChapter(h.root), true);
  await h.complete();
  assert.equal(navigationClicks(h), 1);
  assert.ok(h.logs.includes('平台已确认本页任务完成'));
  assert.ok(!h.logs.includes('本页仍有未确认完成的任务，请核对平台状态'));
});

test('a completed task icon never completes a neighboring unfinished task', () => {
  const h = harness();
  const group = h.chapterBody.append(new Element('section'));
  const done = addVideo(group, { finished: true });
  const pending = addVideo(group);
  assert.equal(h.isFinishedTask(done.video), true);
  assert.equal(h.isFinishedTask(pending.video), false);
  assert.equal(h.canAdvanceChapter(h.root), false);
});

test('a finished video ignores its own blank helper iframe', () => {
  const h = harness();
  const { video } = addVideo(h.chapterBody, { finished: true });
  addFrame(video.contentDocument.body, 'about:blank');
  assert.equal(h.canAdvanceChapter(h.root), true);
});

test('a finished video ignores its own inaccessible helper iframe', () => {
  const h = harness();
  const { video } = addVideo(h.chapterBody, { finished: true });
  const helper = addFrame(video.contentDocument.body, 'https://other.test/player-helper');
  Object.defineProperty(helper, 'contentDocument', { get() { throw new Error('Cross-origin document'); } });
  assert.equal(h.canAdvanceChapter(h.root), true);
});

test('the platform completion marker is sufficient when the finished video document is inaccessible or still loading', () => {
  for (const state of ['loading', 'blank', 'inaccessible']) {
    const h = harness();
    const { video } = addVideo(h.chapterBody, { finished: true });
    if (state === 'loading') video.contentDocument.readyState = 'loading';
    if (state === 'blank') video.contentDocument.URL = 'about:blank';
    if (state === 'inaccessible') Object.defineProperty(video, 'contentDocument', { get() { throw new Error('Cross-origin video'); } });
    assert.equal(h.canAdvanceChapter(h.root), true, state);
  }
});

test('an unrelated unloaded chapter container still prevents advance beside a completed video', () => {
  for (const state of ['loading', 'blank', 'inaccessible']) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    const container = addFrame(h.chapterBody, 'https://course.test/another-task-container');
    if (state === 'loading') container.contentDocument.readyState = 'loading';
    if (state === 'blank') container.contentDocument.URL = 'about:blank';
    if (state === 'inaccessible') container.contentDocument = null;
    assert.equal(h.canAdvanceChapter(h.root), false, state);
  }
});

test('media ended alone does not confirm a task whose platform marker remains unfinished', () => {
  const h = harness();
  const { media, video } = addVideo(h.chapterBody);
  assert.equal(media.ended, true);
  assert.equal(h.isFinishedTask(video), false);
  assert.equal(h.canAdvanceChapter(h.root), false);
});

test('removing a completion marker immediately blocks subsequent chapter checks', () => {
  const h = harness();
  const { icon } = addVideo(h.chapterBody, { finished: true });
  assert.equal(h.canAdvanceChapter(h.root), true);
  icon.className = 'ans-job-icon';
  assert.equal(h.canAdvanceChapter(h.root), false);
});

test('revoking completion during the chapter delay prevents navigation', async () => {
  let release;
  const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
  const { icon } = addVideo(h.chapterBody, { finished: true });
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  icon.className = 'ans-job-icon';
  release();
  await pending;
  assert.equal(navigationClicks(h), 0);
});

test('diagnostics explain an ended video without a platform completion marker and identify its icon ownership', () => {
  const h = harness();
  const { video, media, wrapper, icon } = addVideo(h.chapterBody);
  video.className = 'ans-player player-debug';
  wrapper.className += ' video-wrapper';
  icon.className += ' waiting-check';
  media.currentTime = 123.8;
  media.duration = 456.9;
  media.paused = true;
  const report = h.inspectChapterCompletion(h.root);
  const row = report.frames.find((entry) => entry.iframe === video);
  assert.equal(report.complete, false);
  assert.match(row.blocked, /播放已结束.*未识别到平台完成标记/);
  assert.equal(row.marker, '无');
  assert.equal(row.iconCount, 1);
  assert.equal(row.resourceCount, 1);
  assert.equal(row.media.current, 123);
  assert.equal(row.media.duration, 456);
  h.logChapterDiagnostics(h.root);
  const line = h.logs.find((entry) => entry.startsWith('[章节诊断] 页面#' + row.number + ' '));
  assert.match(line, /视频/);
  assert.match(line, /iframe类=ans-player player-debug/);
  assert.match(line, /容器类=ans-attach-ct video-wrapper/);
  assert.match(line, /图标类=ans-job-icon waiting-check/);
  assert.match(line, /直属图标=1，容器内资源=1/);
  assert.match(line, /播放=123\/456秒，结束=是，暂停=是/);
  assert.match(line, /阻塞=播放已结束.*未识别到平台完成标记/);
  assert.ok(h.logs.some((entry) => /当前原因：.*播放已结束.*完成标记/.test(entry)));
});

test('diagnostics retain useful route names while omitting URL credentials, query values, fragments and executable payloads', () => {
  const h = harness();
  const { video } = addVideo(h.chapterBody);
  video.src = 'https://diagnostic-user:diagnostic-password@course.test/ananas/modules/video/index.html?token=secret-query-value#secret-fragment';
  h.rootFrame.src += '&student=secret-student-id#secret-root-fragment';
  addFrame(h.chapterBody, 'data:text/html,<html>secret-data-payload</html>');
  addFrame(h.chapterBody, 'javascript:alert("secret-script-payload")');
  addFrame(h.chapterBody, 'file:///C:/private/secret-local-path.html');
  h.logChapterDiagnostics(h.root);
  const text = h.logs.join('\n');
  assert.match(text, /https:\/\/course\.test\/ananas\/modules\/video\/index\.html/);
  assert.match(text, /data:（地址已省略）/);
  assert.match(text, /file:（地址已省略）/);
  for (const secret of ['diagnostic-user', 'diagnostic-password', 'secret-query-value', 'secret-fragment',
    'secret-student-id', 'secret-root-fragment', 'secret-data-payload', 'secret-script-payload', 'secret-local-path']) {
    assert.ok(!text.includes(secret), 'Diagnostic leaked ' + secret);
  }
  const report = h.inspectChapterCompletion(h.root);
  for (const { address } of report.frames) assert.ok(!/[?#@]/.test(address), address);
});

test('playback progress does not flood diagnostics at 500ms, the same state refreshes at 30s, and marker changes log immediately', () => {
  const h = harness();
  const { icon, media } = addVideo(h.chapterBody);
  media.ended = false;
  media.paused = false;
  media.currentTime = 1;
  media.duration = 300;
  h.logChapterDiagnostics(h.root);
  const firstCount = h.logs.length;
  assert.ok(firstCount > 0);
  for (let index = 1; index < 60; index += 1) {
    h.advanceTime(500);
    media.currentTime += 0.5;
    h.logChapterDiagnostics(h.root);
    assert.equal(h.logs.length, firstCount, 'Unchanged progress state emitted logs at ' + index * 500 + 'ms');
  }
  h.advanceTime(500);
  media.currentTime += 0.5;
  h.logChapterDiagnostics(h.root);
  assert.equal(h.logs.length, firstCount * 2, 'An unchanged state should refresh once at 30 seconds');
  assert.ok(h.logs.slice(firstCount).some((entry) => /播放=31\/300秒/.test(entry)), 'Periodic refresh must include the current playback position');
  const beforeMarker = h.logs.length;
  icon.className = 'ans-job-icon ans-job-finished';
  h.logChapterDiagnostics(h.root);
  assert.ok(h.logs.length > beforeMarker, 'Completion changes should log without waiting another 30 seconds');
  assert.ok(h.logs.slice(beforeMarker).some((entry) => /完成依据=所属任务图标完成标记/.test(entry)));
});

test('diagnostics identify a disabled automatic chapter switch separately from incomplete tasks', async () => {
  const h = harness();
  addVideo(h.chapterBody, { finished: true });
  h.config.platformParams.cx.parts[0].params[1].value = false;
  await h.complete();
  assert.equal(navigationClicks(h), 0);
  assert.ok(h.logs.some((entry) => /自动跳章=关/.test(entry)));
  assert.ok(h.logs.some((entry) => /当前原因：平台任务已完成，自动跳章开关关闭/.test(entry)));
  assert.ok(!h.logs.some((entry) => /当前原因：.*未识别到平台完成标记/.test(entry)));
});

test('diagnostics report unavailable navigation only when both modern and legacy controls are unavailable', async () => {
  for (const mode of ['missing', 'hidden', 'disabled']) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    for (const button of [h.focus, h.next]) {
      if (mode === 'missing') button.remove();
      if (mode === 'hidden') button.style.display = 'none';
      if (mode === 'disabled') button.disabled = true;
    }
    await h.complete();
    assert.equal(navigationClicks(h), 0);
    const text = h.logs.join('\n');
    assert.match(text, /当前原因：平台任务已完成，下一步按钮不可用/);
    assert.match(text, mode === 'missing' ? /任务下一步=未找到/ : /任务下一步=隐藏或禁用/);
    assert.match(text, mode === 'missing' ? /章节下一章=未找到/ : /章节下一章=隐藏或禁用/);
  }
});

test('large task trees log at most 20 frame rows and show blocked tasks before completed tasks', () => {
  const h = harness();
  for (let index = 0; index < 24; index += 1) addVideo(h.chapterBody, { finished: true });
  for (let index = 0; index < 3; index += 1) addVideo(h.chapterBody);
  const report = h.inspectChapterCompletion(h.root);
  const blocked = report.frames.filter((frame) => frame.blocked);
  assert.equal(blocked.length, 3);
  assert.equal(report.frames.length, 28);
  h.logChapterDiagnostics(h.root);
  const rows = h.logs.filter((entry) => entry.startsWith('[章节诊断] 页面#'));
  assert.equal(rows.length, 20);
  for (let index = 0; index < blocked.length; index += 1) {
    assert.ok(rows[index].startsWith('[章节诊断] 页面#' + blocked[index].number + ' '));
    assert.match(rows[index], /阻塞=/);
  }
  assert.ok(h.logs.some((entry) => /仅列出 20\/28 个页面，优先显示阻塞项/.test(entry)));
  assert.equal(new Set(rows.map((entry) => entry.match(/页面#(\d+)/)[1])).size, 20);
});

function addOuterBlankHelper(h, { editor = false, first = false } = {}) {
  const helper = addFrame(h.outer.body, editor ? 'about:blank' : '');
  if (editor) helper.className = 'edui-default';
  else {
    // This reproduces browsers exposing the current page as iframe.src for
    // an empty raw src while its actual document is still about:blank.
    Object.defineProperty(helper, 'src', { get: () => h.outer.URL });
  }
  if (first) {
    h.outer.body.children.splice(h.outer.body.children.indexOf(helper), 1);
    h.outer.body.children.unshift(helper);
  }
  return helper;
}

test('the reported completed chapter video advances despite five unrelated outer blank helper frames', async () => {
  const h = harness();
  const { wrapper, icon, video } = addVideo(h.chapterBody);
  wrapper.className = 'ans-attach-ct ans-job-finished';
  icon.className = 'ans-job-icon';
  for (let index = 0; index < 4; index += 1) addOuterBlankHelper(h);
  addOuterBlankHelper(h, { editor: true });
  assert.equal(h.outer.documentElement.querySelectorAll('iframe').length, 6);
  assert.equal(video.contentDocument.readyState, 'complete');
  assert.equal(h.canAdvanceChapter(h.root), true);
  const report = h.inspectChapterCompletion(h.root);
  assert.equal(report.frames.length, 2, 'Only the chapter root and its video belong to the task tree');
  assert.equal(report.tasks.length, 1);
  assert.ok(report.tasks[0].confirmed);
  await h.complete();
  assert.equal(navigationClicks(h), 1);
  assert.ok(h.logs.includes('平台已确认本页任务完成'));
  assert.ok(!h.logs.includes('本页仍有未确认完成的任务，请核对平台状态'));
});

test('an outer editor or blank helper appearing first does not become the chapter root', async () => {
  for (const editor of [false, true]) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    const helper = addOuterBlankHelper(h, { editor, first: true });
    assert.ok(h.outer.documentElement.querySelector('iframe') === helper);
    assert.ok(h.getChapterPage().iframe === h.rootFrame, 'The chapter cards iframe must be selected instead of the first auxiliary iframe');
    assert.ok(h.getChapterPage().document === h.rootFrame.contentDocument);
    assert.equal(h.canAdvanceChapter(h.root), true);
    await h.complete();
    assert.equal(navigationClicks(h), 1);
  }
});

test('blank containers inside the chapter remain blockers even when outer blank helpers are excluded', () => {
  const h = harness();
  addVideo(h.chapterBody, { finished: true });
  addOuterBlankHelper(h, { first: true });
  const internal = addFrame(h.chapterBody, 'https://course.test/possibly-new-task-container');
  internal.contentDocument.URL = 'about:blank';
  assert.equal(h.canAdvanceChapter(h.root), false);
  const report = h.inspectChapterCompletion(h.root);
  assert.ok(report.frames.some((frame) => frame.iframe === internal && frame.blocked));
});

test('a second explicit chapter cards frame that has not loaded prevents advancing an old completed chapter', async () => {
  for (const state of ['loading', 'blank', 'inaccessible']) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    const incoming = addFrame(h.outer.body, 'https://course.test/mooc-ans/knowledge/cards?knowledgeid=2&courseid=1');
    if (state === 'loading') incoming.contentDocument.readyState = 'loading';
    if (state === 'blank') incoming.contentDocument.URL = 'about:blank';
    if (state === 'inaccessible') incoming.contentDocument = null;
    assert.equal(h.canAdvanceChapter(h.root), false, state);
    await h.complete();
    assert.equal(navigationClicks(h), 0, state);
  }
});

test('outer blank helper changes during the jump delay do not invalidate the chapter snapshot', async () => {
  let release;
  const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
  addVideo(h.chapterBody, { finished: true });
  const before = h.chapterSnapshot(h.root);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  addOuterBlankHelper(h, { first: true });
  addOuterBlankHelper(h, { editor: true });
  const after = h.chapterSnapshot(h.root);
  assert.equal(after.length, before.length);
  assert.ok(after.every((frame, index) => frame.iframe === before[index].iframe));
  release();
  await pending;
  assert.equal(navigationClicks(h), 1);
});

test('the reported visible next-section button works while the legacy next-chapter button is hidden', async () => {
  const h = harness();
  addVideo(h.chapterBody, { finished: true });
  h.next.style.display = 'none';
  await h.complete();
  await h.complete();
  assert.equal(h.focus.clicks, 1, 'Use the visible next-section control exactly once');
  assert.equal(h.next.clicks, 0, 'The hidden legacy control must receive no click');
  assert.equal(h.next.style.display, 'none', 'Navigation must not unhide the legacy control');
  assert.ok(!h.logs.some((entry) => /当前原因：平台任务已完成，下一步按钮不可用/.test(entry)));
});

test('when both controls are visible the next-section route is selected without a second legacy click', async () => {
  const h = harness();
  addVideo(h.chapterBody, { finished: true });
  await h.complete();
  assert.equal(h.focus.clicks, 1);
  assert.equal(h.next.clicks, 0);
});

test('a visible legacy next-chapter button remains usable without an available next-section control', async () => {
  for (const mode of ['missing', 'hidden', 'disabled', 'unclickable']) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    if (mode === 'missing') h.focus.remove();
    if (mode === 'hidden') h.focus.style.display = 'none';
    if (mode === 'disabled') h.focus.disabled = true;
    if (mode === 'unclickable') h.focus.click = undefined;
    await h.complete();
    assert.equal(h.next.clicks, 1, mode);
    assert.equal(h.focus.clicks, 0, mode);
  }
});

test('a modern control replaced or hidden during the delay cannot redirect the pending navigation to another route', async () => {
  for (const mode of ['replaced', 'hidden', 'disabled', 'parent-hidden']) {
    let release;
    const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
    addVideo(h.chapterBody, { finished: true });
    const pending = h.complete();
    assert.equal(typeof release, 'function', mode);
    let replacement;
    if (mode === 'replaced') {
      h.focus.remove();
      replacement = h.outer.body.append(new Element('button', { id: 'prevNextFocusNext' }));
      replacement.textContent = '下一节';
    }
    if (mode === 'hidden') h.focus.style.display = 'none';
    if (mode === 'disabled') h.focus.disabled = true;
    if (mode === 'parent-hidden') {
      const wrapper = h.outer.body.append(new Element('div'));
      h.focus.remove();
      wrapper.append(h.focus);
      wrapper.style.display = 'none';
    }
    release();
    await pending;
    assert.equal(navigationClicks(h), 0, mode);
    assert.equal(replacement?.clicks || 0, 0, mode);
  }
});

test('modern next-section navigation still stops when automatic navigation is disabled during its delay', async () => {
  let release;
  const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
  addVideo(h.chapterBody, { finished: true });
  h.next.style.display = 'none';
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.config.platformParams.cx.parts[0].params[1].value = false;
  release();
  await pending;
  assert.equal(navigationClicks(h), 0);
});

test('modern next-section navigation still waits for all tasks to remain complete', async () => {
  let release;
  const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
  addVideo(h.chapterBody, { finished: true });
  h.next.style.display = 'none';
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  addVideo(h.chapterBody);
  release();
  await pending;
  assert.equal(navigationClicks(h), 0);
});

test('a reused next-section button cannot change its destination or handler while navigation is waiting', async () => {
  for (const mode of ['href', 'onclick-attribute', 'onclick-handler', 'data-url']) {
    let release;
    const h = harness({ wait: () => new Promise((resolve) => { release = resolve; }) });
    addVideo(h.chapterBody, { finished: true });
    const attribute = mode === 'onclick-attribute' ? 'onclick' : mode;
    if (mode === 'onclick-handler') h.focus.onclick = () => {};
    else h.focus.setAttribute(attribute, 'original-private-target');
    const pending = h.complete();
    assert.equal(typeof release, 'function', mode);
    if (mode === 'onclick-handler') h.focus.onclick = () => {};
    else h.focus.setAttribute(attribute, 'replacement-private-target');
    release();
    await pending;
    assert.equal(navigationClicks(h), 0, mode);
    assert.ok(h.logs.some((entry) => /跳转目标改变/.test(entry)), mode);
    assert.ok(!h.logs.some((entry) => /original-private-target|replacement-private-target/.test(entry)), 'Targets must remain out of diagnostic logs');
  }
});

test('a disabled ancestor prevents using the modern route and allows only a separately available legacy route', async () => {
  for (const mode of ['aria-disabled', 'disabled-attribute', 'disabled-class', 'is-disabled-class']) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    const parent = h.outer.body.append(new Element('div'));
    h.focus.remove();
    parent.append(h.focus);
    if (mode === 'aria-disabled') parent.setAttribute('aria-disabled', 'true');
    if (mode === 'disabled-attribute') parent.setAttribute('disabled', '');
    if (mode === 'disabled-class') parent.className = 'disabled';
    if (mode === 'is-disabled-class') parent.className = 'is-disabled';
    await h.complete();
    assert.equal(h.focus.clicks, 0, mode);
    assert.equal(h.next.clicks, 1, mode);
  }
});

test('duplicate available modern controls block ambiguous navigation while a hidden duplicate does not', async () => {
  for (const duplicateVisible of [true, false]) {
    const h = harness();
    addVideo(h.chapterBody, { finished: true });
    const duplicate = h.outer.body.append(new Element('button', { id: 'prevNextFocusNext' }));
    duplicate.textContent = '下一节';
    if (!duplicateVisible) duplicate.style.display = 'none';
    await h.complete();
    assert.equal(h.focus.clicks, duplicateVisible ? 0 : 1);
    assert.equal(h.next.clicks, 0, 'An ambiguous modern target must not silently fall back to the legacy route');
    assert.equal(duplicate.clicks, 0);
    if (duplicateVisible) assert.ok(h.logs.some((entry) => /多个可用的下一节按钮/.test(entry)));
  }
});
