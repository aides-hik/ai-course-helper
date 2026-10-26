'use strict';
// Real adapter with local transport/timers; no requests to model services.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.resolve(__dirname, '..', 'ai-adapter.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const answer = {answerable: true, choice_indices: [1], text_answers: [], judgement: 'unknown', explanation: '本地依据'};
const marker = '\uFFFC[ai-image:0]\uFFFC';
const imageUrl = 'data:image/png;base64,local-image-fixture';
const question = (id = 0, image = false) => ({title: '题目' + id, type: '0', optionsText: ['甲', '乙'], searchText: {stem: image ? marker : '题目' + id, options: ['甲', '乙'], images: image ? [{marker, label: '题干'}] : []}});
const field = provider => provider === 'deepseek' ? 'deepseekReasoningEffort' : 'reasoningEffort';

function harness(ai = {}, options = {}) {
  const config = {ai: {provider: 'openai', apiKey: 'local-openai-key', model: 'any-configured-model', deepseekApiKey: 'local-deepseek-key', deepseekModel: 'deepseek-flash', timeoutSeconds: 120, maxOutputTokens: 8192, ...ai}, otherParams: {params: [{value: 0}]}};
  const calls = [], timers = new Map();
  let timerId = 0;
  const sandbox = {
    AbortController, URL,
    setTimeout(callback, delay) {const id = ++timerId; timers.set(id, {callback, delay}); return id;},
    clearTimeout: id => timers.delete(id),
    useConfigStore: () => config,
    isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    extractRawTextFromHtml: value => String(value),
    apiError: (message, status) => ({success: false, data: null, error: {message, status}}),
    aiQuestionImageDescriptors: q => ({images: q.searchText?.images || []}),
    aiCollectQuestionImages: options.collectImages || (async q => ({images: q.searchText.images.map(entry => ({...entry, url: imageUrl}))})),
    _GM_xmlhttpRequest(request) {
      const call = {request, aborted: false};
      calls.push(call);
      call.load = (content = JSON.stringify(answer), status = 200, extra = {}) => {
        const payload = status === 400 ? extra : request.url.includes('deepseek')
          ? {choices: [{finish_reason: 'stop', message: {content, reasoning_content: options.reasoning || ''}}]}
          : {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: content}]}]};
        request.onload({status, responseText: JSON.stringify(payload)});
      };
      if (!options.manual) queueMicrotask(() => call.load(options.content || JSON.stringify(answer), options.status || 200, options.payload));
      return {abort() {call.aborted = true; request.onabort?.();}};
    }
  };
  vm.runInNewContext(source + '\nglobalThis.api={getAnswer,snapshot:aiProviderSnapshot};', sandbox);
  return {config, calls, timers, ...sandbox.api,
    poll() {for (const [id, timer] of [...timers]) if (timers.has(id)) {timers.delete(id); timer.callback();}},
    start(id = 0, context = {}, image = false) {return sandbox.api.getAnswer(question(id, image), {skipDelay: true, ...context});}
  };
}

const bodyOf = (h, index = 0) => JSON.parse(h.calls[index].request.data);

test('missing and explicit default effort preserve the complete previous request body', async () => {
  for (const provider of ['openai', 'deepseek']) for (const image of [false, true]) {
    const absent = harness({provider});
    const explicit = harness({provider, [field(provider)]: 'default'});
    assert.equal((await absent.start(0, {}, image)).success, true);
    assert.equal((await explicit.start(0, {}, image)).success, true);
    assert.equal(absent.calls[0].request.data, explicit.calls[0].request.data);
    const body = bodyOf(absent);
    assert.equal('reasoning' in body, false);
    assert.equal('reasoning_effort' in body, false);
    assert.equal('thinking' in body, false);
    assert.equal(absent.snapshot().reasoningEffort, 'default');
    assert.equal(absent.timers.size, 0);
  }
});

test('all explicit OpenAI effort values use only Responses reasoning.effort', async () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const h = harness({provider: 'openai', reasoningEffort: effort});
    const result = await h.start();
    assert.equal(result.success, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].request.url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(bodyOf(h).reasoning, {effort});
    assert.equal('reasoning_effort' in bodyOf(h), false);
    assert.equal('thinking' in bodyOf(h), false);
    assert.equal(bodyOf(h).model, 'any-configured-model');
    assert.equal(bodyOf(h).text.format.strict, true);
    assert.equal(bodyOf(h).store, false);
  }
});

test('DeepSeek none disables thinking and sends no reasoning_effort', async () => {
  const h = harness({provider: 'deepseek', deepseekReasoningEffort: 'none'});
  assert.equal((await h.start()).success, true);
  assert.deepEqual(bodyOf(h).thinking, {type: 'disabled'});
  assert.equal('reasoning_effort' in bodyOf(h), false);
  assert.equal('reasoning' in bodyOf(h), false);
  assert.deepEqual(bodyOf(h).response_format, {type: 'json_object'});
});

test('DeepSeek low high and max enable thinking with the selected reasoning_effort', async () => {
  for (const effort of ['low', 'high', 'max']) {
    const h = harness({provider: 'deepseek', deepseekReasoningEffort: effort});
    assert.equal((await h.start()).success, true);
    assert.deepEqual(bodyOf(h).thinking, {type: 'enabled'});
    assert.equal(bodyOf(h).reasoning_effort, effort);
    assert.equal('reasoning' in bodyOf(h), false);
    assert.equal(h.calls[0].request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(h.calls[0].request.headers.Authorization, 'Bearer local-deepseek-key');
    assert.equal(h.calls.length, 1);
  }
});

test('provider effort settings stay independent and invalid unused settings are ignored', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const other = provider === 'openai' ? 'deepseek' : 'openai';
    const h = harness({provider, [field(provider)]: 'high', [field(other)]: 'invalid-unused-private-value'});
    assert.equal((await h.start()).success, true);
    assert.equal(h.snapshot().reasoningEffort, 'high');
    if (provider === 'openai') assert.deepEqual(bodyOf(h).reasoning, {effort: 'high'});
    else assert.equal(bodyOf(h).reasoning_effort, 'high');
  }
});

test('invalid selected effort fails locally without transport, image reading, or raw value disclosure', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const invalid = [null, false, true, 0, 1, {}, [], '', ' HIGH ', 'High', 'automatic', 'sk-private-invalid'];
    if (provider === 'deepseek') invalid.push('minimal', 'medium', 'xhigh');
    for (const effort of invalid) {
      let collected = 0;
      const h = harness({provider, [field(provider)]: effort}, {collectImages: async () => {collected++; return {images: []};}});
      const result = await h.start(0, {}, true);
      assert.equal(result.success, false);
      assert.match(result.error.message, /思考程度无效/);
      assert.equal(h.calls.length, 0);
      assert.equal(collected, 0);
      assert.doesNotMatch(result.error.message, /sk-private-invalid|HIGH|automatic/);
      assert.equal(h.timers.size, 0);
    }
  }
});

test('effort changes cancel active and queued snapshots, and the next request captures the new setting', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const h = harness({provider, [field(provider)]: 'low', concurrentEnabled: true, concurrency: 2}, {manual: true});
    const old = [h.start(0), h.start(1), h.start(2), h.start(3)];
    await tick();
    assert.equal(h.calls.length, 2);
    h.config.ai[field(provider)] = 'high';
    const next = h.start(4);
    h.poll();
    assert.deepEqual((await Promise.all(old)).map(result => result.success), [false, false, false, false]);
    await tick();
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.slice(0, 2).every(call => call.aborted));
    const body = bodyOf(h, 2);
    assert.equal(provider === 'openai' ? body.reasoning.effort : body.reasoning_effort, 'high');
    h.calls[0].load(); h.calls[1].load();
    assert.equal(h.calls.length, 3, 'late stale callbacks must not retry or dispatch duplicate work');
    h.calls[2].load();
    const result = await next;
    assert.equal(result.success, true);
    assert.equal(result.data.items[0].stem, '题目4');
    assert.equal(h.timers.size, 0);
  }
});

test('changing the other provider effort leaves current active and queued work valid', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const other = provider === 'openai' ? 'deepseek' : 'openai';
    const h = harness({provider, [field(provider)]: 'low', [field(other)]: 'default'}, {manual: true});
    const first = h.start(0), queued = h.start(1);
    await tick();
    h.config.ai[field(other)] = 'invalid-other-provider';
    h.poll();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].aborted, false);
    h.calls[0].load(); assert.equal((await first).success, true);
    await tick(); assert.equal(h.calls.length, 2);
    h.calls[1].load(); assert.equal((await queued).success, true);
    assert.equal(h.timers.size, 0);
  }
});

test('changing to an invalid selected effort cancels old work and sends no replacement', async () => {
  const h = harness({reasoningEffort: 'low'}, {manual: true});
  const active = h.start(0), queued = h.start(1);
  await tick();
  h.config.ai.reasoningEffort = 'unrecognized';
  const invalid = await h.start(2);
  assert.match(invalid.error.message, /思考程度无效/);
  h.poll();
  assert.deepEqual((await Promise.all([active, queued])).map(result => result.success), [false, false]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].aborted, true);
  assert.equal(h.timers.size, 0);
});

test('effort changes during image preparation abort its collector before a model request', async () => {
  for (const provider of ['openai', 'deepseek']) {
    let collectedContext;
    const h = harness({provider, [field(provider)]: 'low'}, {collectImages: async (_q, context) => {collectedContext = context; return new Promise(() => {});}});
    const pending = h.start(0, {}, true);
    await tick();
    assert.equal(h.calls.length, 0);
    h.config.ai[field(provider)] = 'max';
    h.poll();
    assert.equal((await pending).success, false);
    assert.equal(collectedContext.signal.aborted, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('explicit effort preserves provider multimodal bodies, schema and exact option mapping', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const h = harness({provider, [field(provider)]: 'high'});
    const result = await h.start(0, {}, true), body = bodyOf(h);
    assert.equal(result.success, true);
    assert.deepEqual(plain(result.data.items[0].answer.values), ['乙']);
    const content = provider === 'openai' ? body.input[0].content : body.messages[1].content;
    assert.deepEqual(content.map(part => part.type), provider === 'openai' ? ['input_text', 'input_image'] : ['text', 'image_url']);
    assert.equal(provider === 'openai' ? content[1].image_url : content[1].image_url.url, imageUrl);
    assert.equal(JSON.parse(provider === 'openai' ? content[0].text : content[0].text).image_labels[0].marker, marker);
    if (provider === 'openai') assert.equal(body.text.format.strict, true);
    else assert.equal(body.response_format.type, 'json_object');
  }
});

test('unsupported thinking parameters receive a safe default-setting hint and never retry', async () => {
  const secret = 'sk-private-fixture';
  const url = 'https://private.invalid/image?token=' + secret;
  for (const provider of ['openai', 'deepseek']) for (const param of ['reasoning.effort', 'reasoning_effort', 'thinking', 'thinking.type', 'reasoning']) {
    const h = harness({provider, [field(provider)]: 'high'}, {status: 400, payload: {error: {code: 'unsupported_parameter', type: 'invalid_request_error', param, message: 'Unsupported parameter ' + param + ' ' + secret + ' ' + url}}});
    const result = await h.start();
    assert.equal(result.success, false);
    assert.match(result.error.message, /思考程度设置.*恢复为默认/);
    assert.equal(h.calls.length, 1);
    assert.doesNotMatch(result.error.message, /sk-private-fixture|private\.invalid|reasoning\.effort|reasoning_effort|thinking/);
    assert.equal(h.timers.size, 0);
  }
});

test('reasoning effort does not use reasoning_content or relax JSON and index validation', async () => {
  const good = JSON.stringify(answer);
  for (const content of ['', good + '\n' + good, good.replace('本地依据', '\\sqrt{x}'), JSON.stringify({...answer, choice_indices: [9]})]) {
    const h = harness({provider: 'deepseek', deepseekReasoningEffort: 'high'}, {manual: true, reasoning: good});
    const pending = h.start(); await tick(); h.calls[0].load(content);
    assert.equal((await pending).success, false);
    assert.equal(h.calls.length, 1);
  }
});
