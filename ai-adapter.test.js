const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, 'ai-adapter.js');
const endpointsSource = fs.readFileSync(path.join(__dirname, 'ai-endpoints.js'), 'utf8');
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));

function structuredAnswer(overrides = {}) {
  return {
    answerable: true,
    choice_indices: [],
    text_answers: [],
    judgement: 'unknown',
    explanation: '示例解析',
    ...overrides
  };
}

function responsePayload(answer, overrides = {}) {
  return {
    status: 'completed',
    model: 'test-model',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }
    ],
    ...overrides
  };
}

function question(overrides = {}) {
  return {
    title: '选择正确的表达式',
    searchText: { stem: '选择正确的表达式', options: ['x>0', 'x<0', 'x=0'] },
    type: '0',
    optionsText: ['x>0', 'x<0', 'x=0'],
    options: {},
    ...overrides
  };
}

function textFields(count) {
  const fields = Array.from({ length: count }, (_, i) => ({
    tagName: 'TEXTAREA', nodeName: 'TEXTAREA', name: `blank_${i}`,
    disabled: false, hidden: false, getAttribute: () => null
  }));
  return {
    querySelectorAll(selector) {
      return /textarea|contenteditable/.test(selector) ? fields : [];
    }
  };
}

function harness(options = {}) {
  const calls = [];
  const config = {
    ai: { apiKey: 'fake-test-key', model: 'test-model', timeoutSeconds: 120, maxOutputTokens: 8192 },
    otherParams: { params: [{ value: 0 }] },
    ...options.config
  };
  const sandbox = {
    AbortController,
    URL,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    console,
    useConfigStore: () => config,
    sleep: async () => {},
    isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    apiError: (message, status) => ({
      success: false, data: null,
      error: { code: status && status >= 400 ? `HTTP_${status}` : 'CLIENT_ERROR', message, details: null },
      meta: null
    }),
    extractRawTextFromHtml: (value) => String(value).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    _GM_xmlhttpRequest(request) {
      const call = { request, aborted: false };
      calls.push(call);
      if (options.onRequest) {
        options.onRequest(call, calls.length);
      } else {
        queueMicrotask(() => {
          if (options.mode === 'timeout') return request.ontimeout();
          if (options.mode === 'network-error') return request.onerror();
          const payload = options.payload ?? responsePayload(structuredAnswer({ choice_indices: [1] }));
          request.onload({
            status: options.status ?? 200,
            responseText: options.raw ?? JSON.stringify(payload)
          });
        });
      }
      return {
        abort() {
          call.aborted = true;
          request.onabort?.();
        }
      };
    }
  };
  vm.runInNewContext(endpointsSource + '\n' + fs.readFileSync(sourcePath, 'utf8') + '\nglobalThis.__getAnswer = getAnswer; globalThis.__fields = aiAnswerFields; globalThis.__editor = aiExistingEditorForField;', sandbox, {
    filename: sourcePath
  });
  return { getAnswer: sandbox.__getAnswer, fields: sandbox.__fields, editor: sandbox.__editor, calls, config };
}

const answerValues = (result) => jsonCopy(result.data.items[0].answer.values);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('single choice maps the model index to the original option and uses Responses structured output', async () => {
  const h = harness();
  const result = await h.getAnswer(question(), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['x<0']);
  assert.equal(result.data.items[0].stem, '选择正确的表达式');
  assert.equal(result.meta.provider, 'openai');
  assert.equal(result.meta.explanation, '示例解析');
  const request = h.calls[0].request;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer fake-test-key');
  assert.equal(request.anonymous, true);
  const body = JSON.parse(request.data);
  assert.equal(body.model, 'test-model');
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal('temperature' in body, false);
  assert.equal(JSON.stringify(body).includes('fake-test-key'), false);
});

test('multiple choice preserves all selected original option texts', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ choice_indices: [2, 0] })) });
  const result = await h.getAnswer(question({ type: '多选题' }), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result).sort(), ['x=0', 'x>0'].sort());
});

test('false judgement becomes 错 for the existing page handler', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ judgement: 'false' })) });
  const result = await h.getAnswer(question({ type: '3', optionsText: ['对', '错'] }), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['错']);
});

test('fill blanks returns one answer per field', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ text_answers: ['甲', '乙'] })) });
  const result = await h.getAnswer(question({ type: '2', optionsText: [], element: textFields(2) }), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['甲', '乙']);
});

test('short answer maps to the original result shape', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ text_answers: ['简短回答'] })) });
  const result = await h.getAnswer(question({ type: '简答题', optionsText: [] }), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['简短回答']);
});

for (const [name, overrides] of [
  ['out of range index', { choice_indices: [3] }],
  ['negative index', { choice_indices: [-1] }],
  ['fractional index', { choice_indices: [0.5] }],
  ['duplicate index', { choice_indices: [1, 1] }],
  ['multiple selections for a single choice', { choice_indices: [0, 1] }],
  ['empty selections', { choice_indices: [] }],
  ['model reports uncertainty', { answerable: false, choice_indices: [1] }],
  ['incorrect field type', { answerable: 'true', choice_indices: [1] }]
]) {
  test(`rejects ${name}`, async () => {
    const h = harness({ payload: responsePayload(structuredAnswer(overrides)) });
    assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  });
}

test('rejects unknown judgement instead of guessing true', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ judgement: 'unknown' })) });
  assert.equal((await h.getAnswer(question({ type: '判断题', optionsText: ['对', '错'] }), { skipDelay: true })).success, false);
});

test('rejects incomplete fill blank answers', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ text_answers: ['甲'] })) });
  assert.equal((await h.getAnswer(question({ type: '2', optionsText: [], element: textFields(2) }), { skipDelay: true })).success, false);
});

for (const status of [401, 429, 500]) {
  test(`handles HTTP ${status} without leaking the API key`, async () => {
    const h = harness({ status, payload: { error: { message: 'Service error' } } });
    const result = await h.getAnswer(question(), { skipDelay: true });
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('fake-test-key'), false);
  });
}

for (const mode of ['timeout', 'network-error']) {
  test(`handles ${mode}`, async () => {
    const h = harness({ mode });
    assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  });
}

test('handles non JSON HTTP response', async () => {
  const h = harness({ raw: '<html>bad gateway</html>' });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
});

test('handles malformed model JSON', async () => {
  const h = harness({ payload: responsePayload(null, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad json' }] }] }) });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
});

test('detects model refusal', async () => {
  const h = harness({ payload: responsePayload(null, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer' }] }] }) });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
});

test('does not accept an incomplete response even if its text looks usable', async () => {
  const h = harness({ payload: responsePayload(structuredAnswer({ choice_indices: [1] }), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
});

for (const [name, changeConfig, q] of [
  ['empty API key', (config) => { config.ai.apiKey = ''; }, question()],
  ['empty model', (config) => { config.ai.model = ''; }, question()],
  ['empty question stem', () => {}, question({ title: '', searchText: { stem: '', options: [] } })],
  ['image question', () => {}, question({ searchText: { stem: '<img src="https://example.invalid/a.png">', options: [] } })],
  ['unknown question type', () => {}, question({ type: '8' })]
]) {
  test(`rejects ${name} before making a request`, async () => {
    const h = harness();
    changeConfig(h.config);
    assert.equal((await h.getAnswer(q, { skipDelay: true })).success, false);
    assert.equal(h.calls.length, 0);
  });
}

test('falls back to the title when searchText stem is empty', async () => {
  const h = harness();
  const result = await h.getAnswer(question({ searchText: { stem: '', options: [] } }), { skipDelay: true });
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].stem, '选择正确的表达式');
});

test('preserves extracted mathematical text and decodes fallback HTML options', async () => {
  const h = harness();
  const q = question({
    searchText: { stem: '已知x<y，比较x>z与x&lt;z', options: [] },
    optionsText: ['x<sup>2</sup>>0', 'x<sub>1</sub><y']
  });
  assert.equal((await h.getAnswer(q, { skipDelay: true })).success, true);
  const input = JSON.parse(JSON.parse(h.calls[0].request.data).input);
  assert.equal(input.stem, '已知x<y，比较x>z与x&lt;z');
  assert.deepEqual(input.options, ['x^(2)>0', 'x_(1)<y']);
});

test('keeps fallback HTML title for exact response matching while cleaning only model input', async () => {
  const h = harness();
  const original = '  <b>判断x&lt;y</b>  ';
  const q = question({ title: original, searchText: { stem: '', options: [] } });
  const result = await h.getAnswer(q, { skipDelay: true });
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].stem, original);
  const input = JSON.parse(JSON.parse(h.calls[0].request.data).input);
  assert.equal(input.stem, '判断x<y');
});

test('a cancelled or stale call never sends a request', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await h.getAnswer(question(), { signal: controller.signal, skipDelay: true })).success, false);
  assert.equal((await h.getAnswer(question(), { isCurrent: () => false, skipDelay: true })).success, false);
  assert.equal(h.calls.length, 0);
});

test('cancellation aborts an in flight request and ignores a late success callback', async () => {
  const h = harness({ onRequest: () => {} });
  const controller = new AbortController();
  const pending = h.getAnswer(question(), { signal: controller.signal, skipDelay: true });
  await tick();
  assert.equal(h.calls.length, 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(h.calls[0].aborted, true);
  h.calls[0].request.onload({ status: 200, responseText: JSON.stringify(responsePayload(structuredAnswer({ choice_indices: [1] }))) });
  assert.equal(result.success, false);
});

test('a response for a stale page is discarded', async () => {
  let current = true;
  const h = harness({ onRequest: () => {} });
  const pending = h.getAnswer(question(), { isCurrent: () => current, skipDelay: true });
  await tick();
  current = false;
  h.calls[0].request.onload({ status: 200, responseText: JSON.stringify(responsePayload(structuredAnswer({ choice_indices: [1] }))) });
  assert.equal((await pending).success, false);
});

test('concurrent calls use one request at a time and cancel queued stale work', async () => {
  const h = harness({ onRequest: () => {} });
  const queuedController = new AbortController();
  const first = h.getAnswer(question(), { skipDelay: true });
  const cancelled = h.getAnswer(question(), { signal: queuedController.signal, skipDelay: true });
  const third = h.getAnswer(question(), { skipDelay: true });
  await tick();
  assert.equal(h.calls.length, 1);
  queuedController.abort();
  h.calls[0].request.onload({ status: 200, responseText: JSON.stringify(responsePayload(structuredAnswer({ choice_indices: [1] }))) });
  assert.equal((await first).success, true);
  assert.equal((await cancelled).success, false);
  await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].request.onload({ status: 200, responseText: JSON.stringify(responsePayload(structuredAnswer({ choice_indices: [1] }))) });
  assert.equal((await third).success, true);
});

function deepseekPayload(answer = structuredAnswer({ choice_indices: [1] }), overrides = {}) {
  return {
    id: 'deepseek-test-response',
    model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides
  };
}

function deepseekHarness(options = {}, aiOverrides = {}) {
  return harness({
    payload: deepseekPayload(),
    ...options,
    config: {
      ai: {
        provider: 'deepseek',
        apiKey: 'openai-key-must-not-be-sent',
        model: 'openai-model-must-not-be-sent',
        deepseekApiKey: 'fake-deepseek-key',
        deepseekModel: 'deepseek-flash',
        timeoutSeconds: 120,
        maxOutputTokens: 8192,
        ...aiOverrides
      },
      otherParams: { params: [{ value: 0 }] }
    }
  });
}

test('DeepSeek sends its own key and model to Chat Completions with JSON mode', async () => {
  const h = deepseekHarness();
  const result = await h.getAnswer(question(), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['x<0']);
  assert.equal(result.meta.provider, 'deepseek');
  assert.equal(result.meta.explanation, '示例解析');
  const request = h.calls[0].request;
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer fake-deepseek-key');
  assert.equal(request.anonymous, true);
  const body = JSON.parse(request.data);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 8192);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(Array.isArray(body.messages), true);
  assert.equal(body.messages.some((message) => message.role === 'system'), true);
  assert.equal(body.messages.some((message) => message.role === 'user'), true);
  assert.match(JSON.stringify(body.messages), /JSON/);
  assert.match(JSON.stringify(body.messages), /choice_indices/);
  assert.equal('text' in body, false);
  assert.equal('store' in body, false);
  assert.equal(JSON.stringify(request).includes('openai-key-must-not-be-sent'), false);
  assert.equal(JSON.stringify(body).includes('openai-model-must-not-be-sent'), false);
  assert.equal(JSON.stringify(body).includes('fake-deepseek-key'), false);
});

test('DeepSeek uses its default model when none is configured', async () => {
  const h = deepseekHarness({}, { deepseekModel: '' });
  const result = await h.getAnswer(question(), { skipDelay: true });
  assert.equal(result.success, true);
  assert.equal(JSON.parse(h.calls[0].request.data).model, 'deepseek-flash');
});

for (const [name, q, answer, expected] of [
  ['multiple choice', question({ type: '1' }), structuredAnswer({ choice_indices: [0, 2] }), ['x>0', 'x=0']],
  ['true judgement', question({ type: '判断题', optionsText: ['对', '错'] }), structuredAnswer({ judgement: 'true' }), ['对']],
  ['false judgement', question({ type: '3', optionsText: ['对', '错'] }), structuredAnswer({ judgement: 'false' }), ['错']],
  ['fill blanks', question({ type: '填空题', optionsText: [], element: textFields(2) }), structuredAnswer({ text_answers: ['甲', '乙'] }), ['甲', '乙']],
  ['short answer', question({ type: '4', optionsText: [] }), structuredAnswer({ text_answers: ['这是简答题答案'] }), ['这是简答题答案']]
]) {
  test(`DeepSeek maps ${name} through the existing answer adapter`, async () => {
    const h = deepseekHarness({ payload: deepseekPayload(answer) });
    const result = await h.getAnswer(q, { skipDelay: true });
    assert.equal(result.success, true);
    assert.equal(result.meta.provider, 'deepseek');
    assert.deepEqual(answerValues(result), expected);
  });
}

for (const reason of ['length', 'content_filter', 'tool_calls', 'aborted', null]) {
  test(`DeepSeek rejects finish_reason ${String(reason)} even with usable content`, async () => {
    const h = deepseekHarness({
      payload: deepseekPayload(undefined, {
        choices: [{ finish_reason: reason, message: { content: JSON.stringify(structuredAnswer({ choice_indices: [1] })) } }]
      })
    });
    assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  });
}

for (const [name, payload] of [
  ['missing choices', {}],
  ['empty choices', deepseekPayload(undefined, { choices: [] })],
  ['null message', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: null }] })],
  ['empty content', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: { content: '' } }] })],
  ['null content', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: { content: null } }] })],
  ['array content', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: '{}' }] } }] })],
  ['malformed content', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: { content: '{invalid json' } }] })],
  ['reasoning without final answer', deepseekPayload(undefined, { choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: JSON.stringify(structuredAnswer({ choice_indices: [1] })) } }] })]
]) {
  test(`DeepSeek rejects ${name}`, async () => {
    const h = deepseekHarness({ payload });
    assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  });
}

test('DeepSeek ignores reasoning_content and uses only the final message content', async () => {
  const h = deepseekHarness({
    payload: deepseekPayload(undefined, {
      choices: [{
        finish_reason: 'stop',
        message: {
          reasoning_content: JSON.stringify(structuredAnswer({ choice_indices: [0] })),
          content: JSON.stringify(structuredAnswer({ choice_indices: [2] }))
        }
      }]
    })
  });
  const result = await h.getAnswer(question(), { skipDelay: true });
  assert.equal(result.success, true);
  assert.deepEqual(answerValues(result), ['x=0']);
});

for (const [name, answer] of [
  ['out of range selection', structuredAnswer({ choice_indices: [8] })],
  ['duplicate selection', structuredAnswer({ choice_indices: [1, 1] })],
  ['unknown schema field', { ...structuredAnswer({ choice_indices: [1] }), confidence: 1 }],
  ['wrong schema type', structuredAnswer({ answerable: 'yes', choice_indices: [1] })],
  ['unanswerable model result', structuredAnswer({ answerable: false })]
]) {
  test(`DeepSeek validates ${name}`, async () => {
    const h = deepseekHarness({ payload: deepseekPayload(answer) });
    assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  });
}

for (const status of [401, 429]) {
  test(`DeepSeek handles HTTP ${status} without exposing either provider key`, async () => {
    const h = deepseekHarness({ status, payload: { error: { message: 'fake-deepseek-key openai-key-must-not-be-sent' } } });
    const result = await h.getAnswer(question(), { skipDelay: true });
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('fake-deepseek-key'), false);
    assert.equal(JSON.stringify(result).includes('openai-key-must-not-be-sent'), false);
  });
}

test('DeepSeek never falls back to the OpenAI key when its own key is missing', async () => {
  const h = deepseekHarness({}, { deepseekApiKey: '' });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  assert.equal(h.calls.length, 0);
});

test('OpenAI never falls back to the DeepSeek key when its own key is missing', async () => {
  const h = deepseekHarness({}, { provider: 'openai', apiKey: '' });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  assert.equal(h.calls.length, 0);
});

test('OpenAI explicitly selected still sends only its own key to its own endpoint', async () => {
  const h = deepseekHarness({ payload: responsePayload(structuredAnswer({ choice_indices: [1] })) }, {
    provider: 'openai', model: 'test-openai-model'
  });
  const result = await h.getAnswer(question(), { skipDelay: true });
  assert.equal(result.success, true);
  assert.equal(result.meta.provider, 'openai');
  assert.equal(h.calls[0].request.url, 'https://api.openai.com/v1/responses');
  assert.equal(h.calls[0].request.headers.Authorization, 'Bearer openai-key-must-not-be-sent');
  assert.equal(JSON.parse(h.calls[0].request.data).model, 'test-openai-model');
  assert.equal(JSON.stringify(h.calls[0].request).includes('fake-deepseek-key'), false);
});

test('an unknown provider fails before any network request', async () => {
  const h = deepseekHarness({}, { provider: 'unsupported-service' });
  assert.equal((await h.getAnswer(question(), { skipDelay: true })).success, false);
  assert.equal(h.calls.length, 0);
});

for (const [name, initialProvider, mutate] of [
  ['provider changes', 'openai', (ai) => { ai.provider = 'deepseek'; }],
  ['OpenAI key changes', 'openai', (ai) => { ai.apiKey = 'new-openai-key'; }],
  ['OpenAI model changes', 'openai', (ai) => { ai.model = 'new-openai-model'; }],
  ['DeepSeek key changes', 'deepseek', (ai) => { ai.deepseekApiKey = 'new-deepseek-key'; }],
  ['DeepSeek model changes', 'deepseek', (ai) => { ai.deepseekModel = 'new-deepseek-model'; }]
]) {
  test(`active and queued work become stale when ${name}`, async () => {
    const h = deepseekHarness({ onRequest: () => {} }, { provider: initialProvider });
    const first = h.getAnswer(question(), { skipDelay: true });
    const queued = h.getAnswer(question(), { skipDelay: true });
    await tick();
    assert.equal(h.calls.length, 1);
    mutate(h.config.ai);
    const payload = initialProvider === 'openai'
      ? responsePayload(structuredAnswer({ choice_indices: [1] }))
      : deepseekPayload();
    h.calls[0].request.onload({ status: 200, responseText: JSON.stringify(payload) });
    assert.equal((await first).success, false);
    assert.equal((await queued).success, false);
    assert.equal(h.calls.length, 1, 'queued questions must not be sent with replacement credentials or to a replacement provider');
  });
}

test('a provider switch actively aborts a silent old request and releases the queue for the new provider', async () => {
  const timers = new Map();
  let timerId = 0;
  const h = deepseekHarness({
    onRequest: () => {},
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  }, { provider: 'openai' });
  const first = h.getAnswer(question(), { skipDelay: true });
  const oldQueued = h.getAnswer(question(), { skipDelay: true });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(timers.size, 1);
  h.config.ai.provider = 'deepseek';
  const next = h.getAnswer(question(), { skipDelay: true });
  const [id, timer] = [...timers.entries()][0];
  assert.equal(timer.delay, 250);
  timers.delete(id);
  timer.callback();
  assert.equal((await first).success, false);
  assert.equal(h.calls[0].aborted, true, 'configuration changes must abort even when the server sends no callbacks');
  assert.equal((await oldQueued).success, false);
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(h.calls[1].request.headers.Authorization, 'Bearer fake-deepseek-key');
  h.calls[1].request.onload({ status: 200, responseText: JSON.stringify(deepseekPayload()) });
  assert.equal((await next).success, true);
  assert.equal(timers.size, 0, 'normal completion must remove the lifecycle timer');
});

for (const callback of ['onerror', 'ontimeout', 'onabort']) {
  test(`clears the lifecycle timer after ${callback}`, async () => {
    const timers = new Map();
    let timerId = 0;
    const h = harness({
      onRequest: () => {},
      setTimeout: (handler, delay) => { const id = ++timerId; timers.set(id, { handler, delay }); return id; },
      clearTimeout: (id) => timers.delete(id)
    });
    const pending = h.getAnswer(question(), { skipDelay: true });
    await tick();
    assert.equal(timers.size, 1);
    h.calls[0].request[callback]();
    assert.equal((await pending).success, false);
    assert.equal(timers.size, 0);
  });
}

test('plain DOM text keeps inequalities and literal HTML names while extracted options map to raw page text', async () => {
  const h = harness();
  const stem = '当 x<b 且 b>0 时，HTML 的 <div> 元素与 <i> 元素有什么区别？';
  const q = question({
    searchText: {stem, options: ['x<b 且 b>0', 'x^(2)<b']},
    optionsText: ['x&lt;b 且 b&gt;0', 'x<sup>2</sup>&lt;b']
  });
  const result = await h.getAnswer(q, {skipDelay: true});
  assert.equal(result.success, true);
  const input = JSON.parse(JSON.parse(h.calls[0].request.data).input);
  assert.equal(input.stem, stem);
  assert.deepEqual(input.options, ['x<b 且 b>0', 'x^(2)<b']);
  assert.deepEqual(answerValues(result), ['x<sup>2</sup>&lt;b']);
});

for (const type of ['toString', 'constructor', '__proto__']) {
  test(`inherited type name ${type} is rejected before sending a request`, async () => {
    const h = harness();
    assert.equal((await h.getAnswer(question({type}), {skipDelay: true})).success, false);
    assert.equal(h.calls.length, 0);
  });
}

const answerField = (tagName = 'INPUT', options = {}) => ({
  tagName, isConnected: true, disabled: false, hidden: false, readOnly: false,
  getAttribute: name => name === 'type' ? 'text' : null,
  ...options
});
const fieldQuestion = fields => question({type: '2', optionsText: [], searchText: {stem: '填写两个空', options: []},
  element: {querySelectorAll: () => fields}});

test('Chaoxing native text inputs are counted and answered as fill blanks', async () => {
  const h = harness({payload: responsePayload(structuredAnswer({text_answers: ['甲', '乙']}))});
  const q = fieldQuestion([answerField(), answerField()]);
  const result = await h.getAnswer(q, {skipDelay: true});
  assert.equal(result.success, true);
  assert.equal(JSON.parse(JSON.parse(h.calls[0].request.data).input).blank_count, 2);
  assert.deepEqual(answerValues(result), ['甲', '乙']);
});

test('shared answer fields exclude disabled readonly hidden and hidden ancestor controls', () => {
  const h = harness();
  const visible = answerField();
  const disabled = answerField('TEXTAREA', {disabled: true});
  const readonly = answerField('INPUT', {readOnly: true});
  const hidden = answerField('TEXTAREA', {hidden: true});
  const hiddenParent = answerField('INPUT', {parentElement: {hidden: true}});
  const cssHidden = answerField('TEXTAREA', {ownerDocument: {defaultView: {getComputedStyle: () => ({display: 'none'})}}});
  assert.deepEqual(Array.from(h.fields(fieldQuestion([visible, disabled, readonly, hidden, hiddenParent, cssHidden]))), [visible]);
});

test('inherited disabled controls are rejected while the enabled first-legend control is preserved', async () => {
  const h = harness();
  const inherited = answerField('INPUT', {matches: selector => selector === ':disabled'});
  const legend = answerField('INPUT', {matches: () => false});
  assert.equal(inherited.disabled, false);
  assert.deepEqual(Array.from(h.fields(fieldQuestion([inherited, legend]))), [legend]);
  const result = await h.getAnswer(fieldQuestion([inherited]), {skipDelay: true});
  assert.equal(result.success, false);
  assert.equal(h.calls.length, 0);
});

test('UEditor lookup and answer-field enumeration reject the same inherited disabled source', () => {
  const h = harness();
  const source = answerField('TEXTAREA', {id: 'disabled-editor', hidden: true, matches: selector => selector === ':disabled'});
  const body = answerField('DIV');
  const editor = {id: 'disabled-editor', isReady: true, body, setContent() {}, getContentTxt() {return '';}};
  const view = {UE: {instants: {existing: editor}}};
  assert.equal(h.editor(source, view), null);
  assert.deepEqual(Array.from(h.fields(fieldQuestion([source]), view)), []);
});

for (const tag of ['svg', 'canvas', 'video', 'audio', 'object', 'embed', 'iframe', 'math']) {
  for (const part of ['stem', 'option']) {
    test(`real ${tag} ${part} markers reject a question before requesting a model`, async () => {
      const h = harness();
      const marker = `\uFFFC[ai-visual:${tag}]\uFFFC`;
      const q = question({searchText: part === 'stem'
        ? {stem: `请读图${marker}`, options: ['甲', '乙', '丙']}
        : {stem: '选择正确选项', options: [`甲${marker}`, '乙', '丙']}});
      assert.equal((await h.getAnswer(q, {skipDelay: true})).success, false);
      assert.equal(h.calls.length, 0);
    });
  }
}

test('plain literal svg and canvas tag names remain ordinary model input', async () => {
  const h = harness();
  const stem = 'HTML 的 <svg> 和 <canvas> 标签有什么区别？当 x<b 且 b>0 时求 x^(2)。';
  const options = ['<svg> 是字面文本', '<canvas> 也是字面文本', '第三项'];
  const q = question({searchText: {stem, options}, optionsText: options});
  assert.equal((await h.getAnswer(q, {skipDelay: true})).success, true);
  const input = JSON.parse(JSON.parse(h.calls[0].request.data).input);
  assert.equal(input.stem, stem);
  assert.deepEqual(input.options, options);
});

test('shared fields preserve only a ready existing visible editor source and deduplicate its editable body', () => {
  const h = harness();
  const source = answerField('TEXTAREA', {id: 'answer-editor', hidden: true});
  const body = answerField('DIV', {getAttribute: name => name === 'contenteditable' ? 'true' : null});
  const editor = {id: 'answer-editor', isReady: true, body, setContent() {}, getContentTxt() {return '';}};
  const pageWindow = {UE: {instants: {existing: editor}, getEditor() {throw new Error('must not create an editor');}}};
  assert.equal(h.editor(source, pageWindow), editor);
  assert.deepEqual(Array.from(h.fields(fieldQuestion([source, body]), pageWindow)), [source]);
  editor.isReady = false;
  assert.equal(h.editor(source, pageWindow), null);
  assert.deepEqual(Array.from(h.fields(fieldQuestion([source]), pageWindow)), []);
});

test('hidden source without an existing editor does not create one or count as a fill blank', async () => {
  let getEditorCalls = 0;
  const view = {UE: {getEditor() {getEditorCalls++; return {};}}};
  const field = answerField('TEXTAREA', {hidden: true, id: 'missing-editor', ownerDocument: {defaultView: view}});
  const h = harness();
  const q = fieldQuestion([field]);
  q.element.ownerDocument = {defaultView: view};
  assert.equal((await h.getAnswer(q, {skipDelay: true})).success, false);
  assert.equal(h.calls.length, 0);
  assert.equal(getEditorCalls, 0);
});

test('AbortSignal cancels a long pre-request interval immediately and releases the queue', async () => {
  const timers = new Map();
  let nextTimer = 0;
  const h = harness({setTimeout: (handler, delay) => {const id = ++nextTimer; timers.set(id, {handler, delay}); return id;}, clearTimeout: id => timers.delete(id)});
  h.config.otherParams.params[0].value = 100;
  const controller = new AbortController();
  const old = h.getAnswer(question(), {signal: controller.signal});
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(timers.size, 1);
  controller.abort();
  const next = h.getAnswer(question(), {skipDelay: true});
  assert.equal((await old).success, false);
  assert.equal((await next).success, true);
  assert.equal(h.calls.length, 1);
  assert.equal(timers.size, 0);
});

test('configuration changes cancel a long pre-request interval at the next short check', async () => {
  const timers = new Map();
  let nextTimer = 0;
  const h = deepseekHarness({setTimeout: (handler, delay) => {const id = ++nextTimer; timers.set(id, {handler, delay}); return id;}, clearTimeout: id => timers.delete(id)}, {provider: 'openai'});
  h.config.otherParams.params[0].value = 100;
  const old = h.getAnswer(question());
  await tick();
  assert.equal(h.calls.length, 0);
  const [id, timer] = [...timers.entries()][0];
  assert.equal(timer.delay, 250);
  h.config.ai.provider = 'deepseek';
  const next = h.getAnswer(question(), {skipDelay: true});
  timers.delete(id);
  timer.handler();
  assert.equal((await old).success, false);
  assert.equal((await next).success, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(timers.size, 0);
});
