'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const chapterSource = fs.readFileSync(path.join(root, 'chapter-logic.js'), 'utf8');
const examSource = fs.readFileSync(path.join(root, 'exam-logic.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function frame(src, options = {}) {
  const nested = [];
  const wrapper = {
    className: options.finished ? 'ans-job-finished' : '', parentElement: null,
    querySelector: () => options.task ? {} : null
  };
  const doc = {
    URL: src, readyState: 'complete',
    querySelector: () => null,
    documentElement: { innerText: '未完成题目', querySelectorAll: () => nested, querySelector: () => null }
  };
  const window = {
    document: doc,
    saves: 0, submissions: 0, confirms: 0,
    async noSubmit() { this.saves += 1; },
    async btnBlueSubmit() { this.submissions += 1; },
    async submitCheckTimes() { this.confirms += 1; }
  };
  return { src, isConnected: true, parentElement: wrapper, contentDocument: doc, contentWindow: window, nested, addEventListener() {}, removeEventListener() {} };
}

function chapterHarness(options = {}) {
  const rootFrame = frame('https://course.test/root');
  const next = { style: { display: '' }, clicks: 0, click() { this.clicks += 1; } };
  const pageRoot = { querySelectorAll: (selector) => selector === 'iframe' ? [rootFrame] : [], querySelector: (selector) => selector === 'iframe' ? rootFrame : null };
  const logs = [];
  const timers = new Map();
  const cleanups = [];
  let nextTimer = 1;
  let now = 0;
  let inferences = 0;
  const solveState = { total: 1, filled: 0, complete: false, cancelled: false, current: true, ...options.solveState };
  const config = { platformParams: { cx: { parts: [{ params: [{ value: !!options.submit }, { value: true }, { value: false }] }] } }, otherParams: { params: [{ value: 0 }, { value: 100 }] } };
  const sandbox = {
    URL, AbortController,
    Date: { now: () => now },
    document: { documentElement: pageRoot, querySelector: (selector) => selector.includes('nextChapter') ? next : pageRoot.querySelector(selector) },
    window: { location: { href: 'https://course.test/mycourse/studentstudy?mooc2=1' } },
    useLogStore: () => ({ addLog: (message) => logs.push(message) }),
    useQuestionStore: () => ({ clearQuestion() {} }),
    useConfigStore: () => config,
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id),
    MutationObserver: class { observe() {} disconnect() {} },
    vue: { onBeforeUnmount: (callback) => cleanups.push(callback) },
    decrypt() {},
    sleep: options.sleep || (async () => {}),
    aiWaitForDelay: async (seconds, context) => { await (options.sleep || (async () => {}))(seconds); return context.isCurrent(); },
    CxQuestionHandler: class {
      async init(isCurrent) {
        inferences += 1;
        this.lastSolveResult = { ...solveState, isCurrent: () => solveState.current && isCurrent(),
          refreshVerification() { Object.assign(this, solveState); this.rate = solveState.total ? solveState.filled / solveState.total * 100 : 0; return this; } };
        return solveState.total ? solveState.filled / solveState.total * 100 : 0;
      }
    },
    concatMap: (callback) => callback,
    rxjs: { from(items) { return { pipe(mapper) { return { subscribe(callbacks) {
      Promise.resolve().then(async () => { for (const item of items) await mapper(item); await callbacks.complete(); }).catch(callbacks.error);
    } }; } }; } }
  };
  const exports = '    globalThis.chapter = { processIframeTask, runIframeDocumentTask, processWork, canAdvanceChapter, collectChapterFrames };\n    init();';
  vm.runInNewContext(chapterSource.replace('    init();', exports) + '\nuseCxChapterLogic();', sandbox);
  return { ...sandbox.chapter, config, logs, next, rootFrame, pageRoot, solveState, timers,
    inferences: () => inferences,
    advanceTime(milliseconds) { now += milliseconds; },
    dispose() { cleanups.forEach((callback) => callback()); }
  };
}

test('R07: nested tasks added after the root document loads are discovered without changing the root', async () => {
  const h = chapterHarness();
  await tick();
  const task = frame('https://course.test/api/work/new-task', { task: true });
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1);
  assert.equal(task.contentWindow.saves, 1);
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1, 'a stable saved attempt must not create repeated paid requests');
  h.dispose();
});

test('R07: later accessible nested documents are rescanned and in-flight scans do not overlap', async () => {
  let release;
  const h = chapterHarness({ submit: true, solveState: { filled: 1, complete: true }, sleep: () => new Promise((resolve) => { release = resolve; }) });
  await tick();
  const task = frame('https://course.test/api/work/deferred', { task: true });
  const doc = task.contentDocument;
  task.contentDocument = null;
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 0);
  task.contentDocument = doc;
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1);
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1);
  assert.equal(task.contentWindow.submissions, 1);
  release();
  await tick();
  h.dispose();
});

test('R08: zero-answer save-only tasks never become completed or advance a chapter', async () => {
  const h = chapterHarness();
  await tick();
  const task = frame('https://course.test/api/work/pending', { task: true });
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  h.advanceTime(10000);
  h.processIframeTask();
  await tick();
  assert.equal(task.contentWindow.saves, 1);
  assert.equal(h.next.clicks, 0);
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  assert.ok(!h.logs.some((message) => message.includes('全部完成')));
  h.dispose();
});

test('R08: issuing submit calls alone is insufficient to mark the work complete', async () => {
  const h = chapterHarness({ submit: true, solveState: { filled: 1, complete: true } });
  await tick();
  const task = frame('https://course.test/api/work/submitted', { task: true });
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  h.advanceTime(10000);
  h.processIframeTask();
  await tick();
  assert.equal(task.contentWindow.submissions, 1);
  assert.equal(task.contentWindow.confirms, 1);
  assert.equal(h.next.clicks, 0);
  assert.ok(!h.logs.includes('提交成功'));
  h.dispose();
});

test('a platform completion marker permits one advance after the task tree settles', async () => {
  const h = chapterHarness();
  await tick();
  const task = frame('https://course.test/api/work/done', { task: true, finished: true });
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  assert.equal(h.next.clicks, 0);
  h.advanceTime(2000);
  h.processIframeTask();
  await tick();
  assert.equal(h.next.clicks, 1);
  h.processIframeTask();
  await tick();
  assert.equal(h.next.clicks, 1);
  h.dispose();
});

test('a new unfinished task appearing during the navigation delay prevents advance', async () => {
  let release;
  const h = chapterHarness({ sleep: () => new Promise((resolve) => { release = resolve; }) });
  await tick();
  h.rootFrame.nested.push(frame('https://course.test/api/work/done', { task: true, finished: true }));
  h.processIframeTask();
  await tick();
  h.advanceTime(2000);
  h.processIframeTask();
  await tick();
  assert.equal(typeof release, 'function');
  h.rootFrame.nested.push(frame('https://course.test/api/work/new', { task: true }));
  release();
  await tick();
  assert.equal(h.next.clicks, 0);
  h.dispose();
});

test('empty task lists and inaccessible unfinished tasks cannot prove completion', async () => {
  const h = chapterHarness();
  await tick();
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  const task = frame('https://foreign.test/api/work/hidden', { task: true });
  task.contentDocument = null;
  h.rootFrame.nested.push(task);
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  h.dispose();
});

test('a slow nested container blocks navigation even when all currently visible task markers are finished', async () => {
  const h = chapterHarness();
  await tick();
  h.rootFrame.nested.push(frame('https://course.test/api/work/done', { task: true, finished: true }));
  const container = frame('https://course.test/container');
  container.contentDocument.readyState = 'loading';
  h.rootFrame.nested.push(container);
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  container.contentDocument.readyState = 'complete';
  assert.equal(h.canAdvanceChapter(h.pageRoot), true);
  container.contentDocument.URL = 'about:blank';
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  container.contentDocument = null;
  assert.equal(h.canAdvanceChapter(h.pageRoot), false);
  h.dispose();
});

test('attempt deduplication records saved state separately and allows retry after a question identity change', async () => {
  const h = chapterHarness();
  await tick();
  const doc = {};
  let current = true;
  let attempts = 0;
  const task = async () => { attempts += 1; return { state: 'saved', isCurrent: () => current }; };
  assert.equal((await h.runIframeDocumentTask(doc, task)).state, 'saved');
  await h.runIframeDocumentTask(doc, task);
  assert.equal(attempts, 1);
  current = false;
  await h.runIframeDocumentTask(doc, task);
  assert.equal(attempts, 2);
  h.dispose();
});

test('a document that had no actionable task is eligible again after controls appear', async () => {
  const h = chapterHarness();
  await tick();
  const doc = {};
  let attempts = 0;
  assert.equal((await h.runIframeDocumentTask(doc, async () => { attempts += 1; })).state, 'waiting');
  assert.equal((await h.runIframeDocumentTask(doc, async () => { attempts += 1; return { state: 'attempted' }; })).state, 'attempted');
  assert.equal(attempts, 2);
  h.dispose();
});

test('a cancelled solve performs neither save nor submission', async () => {
  const h = chapterHarness({ submit: true, solveState: { cancelled: true, filled: 1, complete: true } });
  await tick();
  const task = frame('https://course.test/api/work/cancelled', { task: true });
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  assert.equal(task.contentWindow.saves, 0);
  assert.equal(task.contentWindow.submissions, 0);
  h.dispose();
});

test('platform save failures do not repeat paid inference on every scan', async () => {
  const h = chapterHarness();
  await tick();
  const task = frame('https://course.test/api/work/save-error', { task: true });
  task.contentWindow.noSubmit = async () => { throw new Error('Platform save is unavailable'); };
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1);
  assert.equal(h.next.clicks, 0);
  assert.ok(h.logs.some((message) => message.includes('保存或提交失败')));
  h.dispose();
});

test('V02: an answer cleared during the submit delay prevents final confirmation without repeated inference', async () => {
  let release;
  const h = chapterHarness({ submit: true, solveState: {filled: 1, complete: true}, sleep: () => new Promise((resolve) => { release = resolve; }) });
  await tick();
  const task = frame('https://course.test/api/work/answer-cleared', {task: true});
  h.rootFrame.nested.push(task);
  h.processIframeTask();
  await tick();
  assert.equal(task.contentWindow.submissions, 1);
  h.solveState.filled = 0;
  h.solveState.complete = false;
  release();
  await tick();
  assert.equal(task.contentWindow.confirms, 0);
  h.processIframeTask();
  await tick();
  assert.equal(h.inferences(), 1);
  h.dispose();
});

test('V05: disabling navigation during the delay cancels it and allows a later deliberate re-enable', async () => {
  let release;
  const h = chapterHarness({sleep: () => new Promise((resolve) => { release = resolve; })});
  await tick();
  h.rootFrame.nested.push(frame('https://course.test/api/work/done', {task: true, finished: true}));
  h.processIframeTask();
  await tick();
  h.advanceTime(2000);
  h.processIframeTask();
  await tick();
  h.config.platformParams.cx.parts[0].params[1].value = false;
  release();
  await tick();
  assert.equal(h.next.clicks, 0);
  h.config.platformParams.cx.parts[0].params[1].value = true;
  h.processIframeTask();
  await tick();
  release();
  await tick();
  assert.equal(h.next.clicks, 1);
  h.dispose();
});

async function exam(options = {}) {
  const events = [];
  const state = { total: 1, filled: 1, complete: true, cancelled: false, current: true, ...options.state };
  const config = { platformParams: { cx: { parts: [{}, { params: [{ value: true }] }] } }, otherParams: { params: [{ value: 0 }] } };
  const sandbox = {
    useLogStore: () => ({ addLog() {} }), useQuestionStore: () => ({ clearQuestion() {} }), useConfigStore: () => config,
    CxQuestionHandler: class { async init() { this.lastSolveResult = options.noResult ? undefined : { ...state, isCurrent: () => state.current,
      verifyFilled() { this.rate = options.rate ?? (state.total ? state.filled / state.total * 100 : 0); return state.complete && state.current; } }; return options.rate ?? (state.total ? state.filled / state.total * 100 : 0); } },
    sleep: async () => { options.afterWait?.(state, config); },
    aiWaitForDelay: async (_seconds, context) => { options.afterWait?.(state, config); return context.isCurrent(); },
    clickNextStepButton: () => { events.push('next-step-check'); return !!options.nextStep; },
    _unsafeWindow: { getTheNextQuestion() { events.push('next-question'); } }
  };
  vm.runInNewContext(examSource + '\nglobalThis.run=useCxExamLogic;', sandbox);
  await sandbox.run();
  return events;
}

test('R01: zero, partial, cancelled, stale and unverified exam solves cannot navigate', async () => {
  for (const options of [
    { rate: 0, state: { filled: 0, complete: false } },
    { rate: 50, state: { total: 2, filled: 1, complete: false } },
    { state: { cancelled: true } }, { state: { current: false } }, { noResult: true }
  ]) assert.deepEqual(await exam(options), []);
});

test('R01: a page change or disabling navigation during the delay prevents all exam navigation', async () => {
  assert.deepEqual(await exam({ afterWait: (state) => { state.current = false; } }), []);
  assert.deepEqual(await exam({ afterWait: (_state, config) => { config.platformParams.cx.parts[1].params[0].value = false; } }), []);
  assert.deepEqual(await exam({ afterWait: (state) => { state.filled = 0; state.complete = false; } }), []);
});

test('a fully filled, current exam question uses exactly one next action', async () => {
  assert.deepEqual(await exam(), ['next-step-check', 'next-question']);
  assert.deepEqual(await exam({ nextStep: true }), ['next-step-check']);
});
