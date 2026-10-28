'use strict';
// Correctness regressions for the chapter switches reviewed in 0.3.3.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'chapter-logic.js'), 'utf8');
const chapterHelpers = source.slice(0, source.indexOf('  const useCxChapterLogic = '));
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

(async () => {
  let clicks = 0;
  let release;
  const config = { platformParams: { cx: { parts: [{ params: [{ value: false }, { value: true }] }] } }, otherParams: { params: [{ value: 100 }] } };
  const context = vm.createContext({
    configStore: config,
    navigationPending: false,
    lastFrameChange: 0,
    lastCompletionMessage: '',
    currentWatchIframeTaskId: 1,
    Date: { now: () => 2000 },
    canAdvanceChapter: () => true,
    chapterSnapshot: () => [],
    sameFrameSnapshot: () => true,
    logStore: { addLog() {} },
    logChapterDiagnostics() {},
    logChapterNavigation() {},
    document: { querySelector: () => ({ click() { clicks += 1; } }) },
    aiWaitForDelay: (_seconds, context) => new Promise((resolve) => { release = () => resolve(context.isCurrent()); })
  });
  vm.runInContext(chapterHelpers + section('    const checkChapterCompletion = ', '    const onRootIframeLoad = ') + '\nglobalThis.complete=checkChapterCompletion;', context);
  const pending = context.complete({ querySelector: () => ({ style: { display: '' } }) }, { isCurrent: () => true }, 1);
  assert.equal(typeof release, 'function');
  config.platformParams.cx.parts[0].params[1].value = false;
  release();
  await pending;
  assert.equal(clicks, 0);
  console.log('PASS: disabling automatic chapter navigation during its delay prevents the chapter click.');

  let confirms = 0;
  let submits = 0;
  let submitRelease;
  config.platformParams.cx.parts[0].params[0].value = true;
  config.otherParams.params = [{ value: 100 }, { value: 100 }];
  const workContext = vm.createContext({
    configStore: config,
    ANSWER_TAB_NAME2: '1',
    logStore: { addLog() {} },
    isWorkConfirmed: () => false,
    decrypt() {},
    CxQuestionHandler: class {
      async init() {
        this.lastSolveResult = { total: 1, filled: 1, rate: 100, complete: true, cancelled: false, isCurrent: () => true, refreshVerification() { return this; } };
        return 100;
      }
    },
    aiWaitForDelay: (_seconds, context) => new Promise((resolve) => { submitRelease = () => resolve(context.isCurrent()); })
  });
  vm.runInContext(chapterHelpers + section('    const processWork = ', '    const processPpt = ') + '\nglobalThis.process=processWork;', workContext);
  const submitting = workContext.process({}, {}, {
    async btnBlueSubmit() { submits += 1; },
    async submitCheckTimes() { confirms += 1; }
  }, { isCurrent: () => true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof submitRelease, 'function');
  config.platformParams.cx.parts[0].params[0].value = false;
  submitRelease();
  await submitting;
  assert.equal(submits, 1);
  assert.equal(confirms, 0);
  console.log('PASS: disabling automatic submission during its delay prevents the final submission confirmation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
