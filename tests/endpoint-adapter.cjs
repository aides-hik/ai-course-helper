'use strict';
// Exercise configured request URLs through the actual adapter, with no network.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const requestField = provider => provider === 'deepseek' ? 'deepseekApiUrl' : 'apiUrl';
const modelsField = provider => provider === 'deepseek' ? 'deepseekModelsUrl' : 'modelsUrl';
const officialUrl = provider => provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/responses';
const marker = '\uFFFC[ai-image:0]\uFFFC';
const imageUrl = 'data:image/png;base64,local-test-image';
const question = (id = 0, images = false) => ({title: '题目' + id, type: '0', optionsText: ['甲', '乙'], searchText: {stem: images ? marker : '题目' + id, options: ['甲', '乙'], images: images ? [{marker, label: '题干'}] : []}});
const answer = {answerable: true, choice_indices: [1], text_answers: [], judgement: 'unknown', explanation: '本地测试依据'};

function harness(ai = {}, options = {}) {
  const config = {ai: {provider: 'openai', apiKey: 'local-openai-key', model: 'chosen-model', deepseekApiKey: 'local-deepseek-key', deepseekModel: 'chosen-deepseek-model', ...ai}, otherParams: {params: [{value: 0}]}};
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
    aiQuestionImageDescriptors: q => ({images: q.searchText.images}),
    aiCollectQuestionImages: options.collectImages || (async q => ({images: q.searchText.images.map(entry => ({...entry, url: imageUrl}))})),
    _GM_xmlhttpRequest(request) {
      const call = {request, aborted: false};
      calls.push(call);
      call.load = (status = options.status || 200, content = options.content || JSON.stringify(answer)) => {
        const isDeepSeek = Array.isArray(JSON.parse(request.data).messages);
        const payload = isDeepSeek ? {choices: [{finish_reason: 'stop', message: {content}}]} : {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: content}]}]};
        request.onload({status, responseText: JSON.stringify(payload)});
      };
      if (!options.manual) queueMicrotask(() => call.load());
      return {abort() {call.aborted = true; request.onabort?.();}};
    }
  };
  vm.runInNewContext(source + '\nglobalThis.api={getAnswer,snapshot:aiProviderSnapshot};', sandbox);
  return {config, calls, timers, ...sandbox.api,
    poll() {for (const [id, timer] of [...timers]) if (timers.has(id)) {timers.delete(id); timer.callback();}},
    start(id = 0, context = {}, images = false) {return sandbox.api.getAnswer(question(id, images), {skipDelay: true, ...context});}
  };
}

test('missing, empty and explicit official URLs retain the original endpoint and transport options', async () => {
  for (const provider of ['openai', 'deepseek']) {
    let original;
    for (const value of [undefined, '', '  ', officialUrl(provider)]) {
      const h = harness({provider, [requestField(provider)]: value});
      assert.equal((await h.start()).success, true);
      const request = h.calls[0].request;
      assert.equal(request.url, officialUrl(provider));
      assert.equal(h.snapshot().requestUrl, officialUrl(provider));
      assert.equal('redirect' in request, false);
      assert.equal(request.method, 'POST');
      assert.equal(request.anonymous, true);
      if (original === undefined) original = request.data;
      else assert.equal(request.data, original);
      assert.equal(h.timers.size, 0);
    }
  }
});

test('configured normalized URLs receive the selected provider protocol and its own credential', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const configured = '  HTTPS://Gateway.Example:443/proxy/custom-' + provider + '?route=a%2Fb&version=1  ';
    const h = harness({provider, [requestField(provider)]: configured});
    const result = await h.start();
    assert.equal(result.success, true);
    assert.equal(h.calls.length, 1);
    const request = h.calls[0].request, body = JSON.parse(request.data);
    assert.equal(request.url, 'https://gateway.example/proxy/custom-' + provider + '?route=a%2Fb&version=1');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, provider === 'openai' ? 'Bearer local-openai-key' : 'Bearer local-deepseek-key');
    assert.equal(body.model, provider === 'openai' ? 'chosen-model' : 'chosen-deepseek-model');
    if (provider === 'openai') assert.equal(body.text.format.strict, true);
    else assert.equal(body.response_format.type, 'json_object');
    assert.deepEqual(plain(result.data.items[0].answer.values), ['乙']);
    assert.doesNotMatch(JSON.stringify(body), /gateway\.example|local-openai-key|local-deepseek-key/);
  }
});

test('HTTP endpoints, ports and custom paths are accepted with redirect forwarding disabled', async () => {
  for (const value of ['http://127.0.0.1:8123/v1/responses', 'http://localhost:9876/chat/completions', 'https://api.openai.com/custom/responses', 'https://api.openai.com/v1/responses?deployment=local']) {
    const h = harness({apiUrl: value});
    assert.equal((await h.start()).success, true);
    assert.equal(h.calls[0].request.url, value);
    assert.equal(h.calls[0].request.redirect, 'error');
  }
});

test('invalid selected URLs fail before paid requests or image collection without echoing the URL', async () => {
  const invalid = ['relative/responses', '//proxy.invalid/v1/responses', 'ftp://proxy.invalid/responses', 'javascript:alert(1)', 'https://user:private@proxy.invalid/responses', 'https://proxy.invalid/responses#private', 'https://proxy.invalid/\nprivate', 'https://proxy.invalid/\\private'];
  for (const provider of ['openai', 'deepseek']) for (const value of invalid) {
    let collected = 0;
    const h = harness({provider, [requestField(provider)]: value}, {collectImages: async () => {collected++; return {images: []};}});
    const result = await h.start(0, {}, true);
    assert.equal(result.success, false);
    assert.equal(h.calls.length, 0);
    assert.equal(collected, 0);
    assert.doesNotMatch(result.error.message, /private|proxy\.invalid|javascript|relative\/responses/);
    assert.equal(h.timers.size, 0);
  }
});

test('provider request URLs remain independent even when the unused setting is invalid', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const other = provider === 'openai' ? 'deepseek' : 'openai';
    const h = harness({provider, [requestField(provider)]: 'https://chosen-gateway.example/custom', [requestField(other)]: 'javascript:private'});
    assert.equal((await h.start()).success, true);
    assert.equal(h.calls[0].request.url, 'https://chosen-gateway.example/custom');
  }
});

test('changing the selected request URL cancels active and queued jobs and new jobs capture the replacement', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const h = harness({provider, [requestField(provider)]: 'https://old-gateway.example/responses', concurrentEnabled: true, concurrency: 2}, {manual: true});
    const old = [h.start(0), h.start(1), h.start(2), h.start(3)];
    await tick(); assert.equal(h.calls.length, 2);
    h.config.ai[requestField(provider)] = 'https://new-gateway.example/responses';
    const next = h.start(4);
    h.poll();
    assert.deepEqual((await Promise.all(old)).map(result => result.success), [false, false, false, false]);
    assert.ok(h.calls.slice(0, 2).every(call => call.aborted));
    await tick(); assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].request.url, 'https://new-gateway.example/responses');
    h.calls[0].load(); h.calls[1].load();
    assert.equal(h.calls.length, 3);
    h.calls[2].load();
    const result = await next;
    assert.equal(result.success, true);
    assert.equal(result.data.items[0].stem, '题目4');
    assert.equal(h.timers.size, 0);
  }
});

test('canonical equivalent URL edits do not cancel active or queued requests', async () => {
  const h = harness({apiUrl: 'https://gateway.example/v1/responses'}, {manual: true});
  const first = h.start(0), queued = h.start(1);
  await tick();
  h.config.ai.apiUrl = '  HTTPS://GATEWAY.EXAMPLE:443/v1/responses  ';
  h.poll(); assert.equal(h.calls[0].aborted, false);
  h.calls[0].load(); assert.equal((await first).success, true);
  await tick(); assert.equal(h.calls.length, 2);
  h.calls[1].load(); assert.equal((await queued).success, true);
  assert.equal(h.timers.size, 0);
});

test('other-provider URL and models-only edits do not cancel current answer requests', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const other = provider === 'openai' ? 'deepseek' : 'openai';
    const h = harness({provider}, {manual: true});
    const first = h.start(0), queued = h.start(1);
    await tick();
    h.config.ai[requestField(other)] = 'javascript:invalid-unused';
    h.config.ai[modelsField(provider)] = 'javascript:invalid-models-only';
    h.poll(); assert.equal(h.calls[0].aborted, false);
    h.calls[0].load(); assert.equal((await first).success, true);
    await tick(); assert.equal(h.calls.length, 2);
    h.calls[1].load(); assert.equal((await queued).success, true);
    assert.equal(h.timers.size, 0);
  }
});

test('unknown request paths or invalid models URLs do not prevent answering', async () => {
  for (const provider of ['openai', 'deepseek']) for (const listUrl of ['', 'javascript:invalid-models-only']) {
    const h = harness({provider, [requestField(provider)]: 'https://gateway.example/proprietary/solve?private=1', [modelsField(provider)]: listUrl});
    const result = await h.start();
    assert.equal(result.success, true);
    assert.equal(h.calls[0].request.url, 'https://gateway.example/proprietary/solve?private=1');
  }
});

test('URL changes while images load cancel the collector before an answer request is sent', async () => {
  for (const provider of ['openai', 'deepseek']) {
    let imageContext;
    const h = harness({provider}, {collectImages: async (_q, context) => {imageContext = context; return new Promise(() => {});}});
    const pending = h.start(0, {}, true);
    await tick(); assert.equal(h.calls.length, 0);
    h.config.ai[requestField(provider)] = 'https://replacement.example/responses';
    h.poll();
    assert.equal((await pending).success, false);
    assert.equal(imageContext.signal.aborted, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('custom URLs retain multimodal and reasoning request bodies without protocol conversion', async () => {
  for (const provider of ['openai', 'deepseek']) {
    const effort = provider === 'openai' ? 'reasoningEffort' : 'deepseekReasoningEffort';
    const baseline = harness({provider, [effort]: 'high'});
    const custom = harness({provider, [effort]: 'high', [requestField(provider)]: 'https://gateway.example/custom'});
    assert.equal((await baseline.start(0, {}, true)).success, true);
    assert.equal((await custom.start(0, {}, true)).success, true);
    assert.equal(custom.calls[0].request.data, baseline.calls[0].request.data);
    assert.deepEqual(plain(custom.calls[0].request.headers), plain(baseline.calls[0].request.headers));
    assert.equal(custom.calls[0].request.redirect, 'error');
  }
});

test('custom URL HTTP failures and redirect responses remain isolated and do not trigger retries', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 429, 500]) {
    const h = harness({apiUrl: 'https://gateway.example/v1/responses?private=fixture-secret'}, {status});
    const result = await h.start();
    assert.equal(result.success, false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].request.redirect, 'error');
    assert.doesNotMatch(result.error.message, /gateway\.example|fixture-secret|local-openai-key/);
    assert.equal(h.timers.size, 0);
  }
});
