// Regression checks for adapter findings R03/R06/R12. No network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const answer = (overrides = {}) => ({
  answerable: true, choice_indices: [0], text_answers: [], judgement: 'unknown', explanation: 'review fixture', ...overrides
});
const response = (value) => ({
  status: 200,
  responseText: JSON.stringify({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}]})
});
const question = (overrides = {}) => ({
  title: 'review question', searchText: {stem: 'review question'}, type: '0', optionsText: ['甲', '乙'], ...overrides
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const requests = [];
  const config = {ai: {apiKey: 'review-fixture-key', model: 'review-fixture-model'}, otherParams: {params: [{value: 100}]}};
  const sandbox = {
    AbortController, URL, setTimeout, clearTimeout,
    useConfigStore: () => config,
    sleep: async () => {},
    isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    apiError: message => ({success: false, data: null, error: {message}, meta: null}),
    // Angle brackets have been escaped by aiReadableText before this callback.
    // Decode entities once, matching the browser helper for the fixtures below.
    extractRawTextFromHtml: text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    _GM_xmlhttpRequest: request => {
      requests.push(request);
      queueMicrotask(() => request.onload(response(options.answer || answer())));
      return {abort: () => request.onabort?.()};
    }
  };
  vm.runInNewContext(source + '\nglobalThis.adapter = {getAnswer, aiReadableText, aiPrepareQuestion};', sandbox);
  return {api: sandbox.adapter, requests, config};
}

(async () => {
  const h = harness();
  const cases = ['当 x<b 且 b>0 时', '若 a<i 且 i>1，比较大小', 'HTML 的 <div> 元素是什么？'];
  for (const stem of cases) {
    const result = await h.api.getAnswer(question({searchText: {stem}}), {skipDelay: true});
    assert.equal(result.success, true);
    const actual = JSON.parse(JSON.parse(h.requests.at(-1).data).input).stem;
    assert.equal(actual, stem);
  }
  console.log('PASS R03: literal DOM text remains intact in model input');

  // Unknown inherited keys must never bypass the supported-type whitelist.
  const unknown = harness({answer: answer({choice_indices: [], text_answers: ['unsupported type accepted']})});
  const unknownResult = await unknown.api.getAnswer(question({type: 'toString', optionsText: []}), {skipDelay: true});
  assert.equal(unknown.requests.length, 0);
  assert.equal(unknownResult.success, false);
  console.log('PASS type whitelist: inherited object keys are rejected');

  // Abort must interrupt the actual pre-request wait, without resolving that
  // wait or invoking any server callback, and immediately free the queue.
  const delayed = harness();
  const controller = new AbortController();
  let oldSettled = false;
  const old = delayed.api.getAnswer(question(), {signal: controller.signal}).then(value => {oldSettled = true; return value;});
  await tick();
  assert.equal(delayed.requests.length, 0);
  controller.abort();
  const next = delayed.api.getAnswer(question(), {skipDelay: true});
  await tick();
  assert.equal(oldSettled, true);
  assert.equal((await old).success, false);
  assert.equal((await next).success, true);
  assert.equal(delayed.requests.length, 1);
  console.log('PASS R12: cancellation interrupts a 100-second interval and releases the queue');

  const fields = [{tagName: 'INPUT', getAttribute: () => 'text'}];
  const blank = harness({answer: answer({choice_indices: [], text_answers: ['甲']})});
  const q = question({type: '2', optionsText: [], element: {querySelectorAll: () => fields}});
  assert.equal((await blank.api.getAnswer(q, {skipDelay: true})).success, true);
  assert.equal(JSON.parse(JSON.parse(blank.requests[0].data).input).blank_count, 1);
  console.log('PASS R06: Chaoxing native text inputs are counted and accepted');
})().catch(error => {console.error(error); process.exitCode = 1;});
