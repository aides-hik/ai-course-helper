'use strict';
// Exercise the real adapter and mocked transport; no model calls or paid retries.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.resolve(__dirname, '..', 'ai-adapter.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const answer = (overrides = {}) => ({answerable: true, choice_indices: [1], text_answers: [], judgement: 'unknown', explanation: '本地测试依据', ...overrides});
const json = JSON.stringify(answer());
const question = stem => ({title: stem || '选择正确答案', type: '0', optionsText: ['甲', '乙', '丙'], searchText: {stem: stem || '选择正确答案', options: ['甲', '乙', '丙']}, options: {}});

function harness(contents, options = {}) {
  const calls = [];
  const config = {ai: {provider: options.provider || 'deepseek', apiKey: 'local-openai-key', model: 'local-openai-model', deepseekApiKey: 'local-deepseek-key', deepseekModel: 'deepseek-flash', maxOutputTokens: 8192, timeoutSeconds: 120, concurrentEnabled: !!options.concurrent, concurrency: 3}, otherParams: {params: [{value: 0}]}};
  const sandbox = {
    AbortController, URL, setTimeout, clearTimeout,
    useConfigStore: () => config,
    isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    extractRawTextFromHtml: value => String(value),
    apiError: message => ({success: false, data: null, error: {code: 'CLIENT_ERROR', message, details: null}, meta: null}),
    _GM_xmlhttpRequest(request) {
      const index = calls.length;
      calls.push(request);
      queueMicrotask(() => {
        const content = contents[index];
        const payload = config.ai.provider === 'deepseek'
          ? {choices: [{finish_reason: options.finishReason || 'stop', message: {content, reasoning_content: options.reasoning || ''}}]}
          : {status: options.status || 'completed', output: [{type: 'reasoning', summary: [{type: 'summary_text', text: options.reasoning || ''}]}, {type: 'message', content: [{type: 'output_text', text: content}]}]};
        request.onload({status: 200, responseText: JSON.stringify(payload)});
      });
      return {abort() {request.onabort?.();}};
    }
  };
  vm.runInNewContext(source + '\nglobalThis.api={getAnswer,parse:aiParseAnswerText};', sandbox);
  return {...sandbox.api, config, calls};
}

async function solve(content, options = {}) {
  const h = harness([content], options);
  const result = await h.getAnswer(question(), {skipDelay: true});
  assert.equal(h.calls.length, 1, 'failed output must not trigger a model retry');
  return {result, h};
}

async function accepted(content, expected = answer(), options = {}) {
  const {result, h} = await solve(content, options);
  assert.equal(result.success, true, result.error?.message);
  assert.deepEqual(plain(result.data.items[0].answer.values), ['乙']);
  assert.equal(result.meta.explanation, expected.explanation);
  assert.deepEqual(plain(h.parse(content).answer), expected);
}

async function rejected(content, message, options = {}) {
  const {result} = await solve(content, options);
  assert.equal(result.success, false);
  assert.equal(result.data, null);
  if (message) assert.match(result.error.message, message);
  return result.error.message;
}

test('both provider paths accept plain JSON, BOM, complete fences and final-answer labels', async () => {
  const forms = [json, '\uFEFF \n' + json, '```json\n' + json + '\n```', '```\r\n' + json + '\r\n```', '答案如下：\n' + json + '\n以上为最终答案。', '最终答案：\n' + json + '\n请核对。', 'Here is the answer:\n' + json + '\nPlease check.'];
  for (const provider of ['deepseek', 'openai']) {
    for (const form of forms) await accepted(form, answer(), {provider});
  }
});

test('escaped string contents remain exact and do not create candidate boundaries', async () => {
  const explanations = ['字符 { [ ] } 和 "引号"、反斜杠 \\sqrt{x}。', '换行\n制表\t退格\b回车\r与 emoji 🧪', '内容可含 example、思考过程、错误答案、```json 和 {"x":[0]} 字面量'];
  for (const explanation of explanations) {
    const value = answer({explanation});
    await accepted('答案如下：\n' + JSON.stringify(value) + '\n请核对。', value);
    await accepted('```json\n' + JSON.stringify(value) + '\n```', value);
  }
  const escapedUnicode = json.replace('本地测试依据', '\\u672c\\u5730\\u6d4b\\u8bd5\\u4f9d\\u636e');
  await accepted('答案如下：' + escapedUnicode);
});

test('invalid JSON string escapes receive a fixed diagnosis without repair', async () => {
  for (const escape of ['\\sqrt{x}', '\\q', '\\u12G4', '\\u123']) {
    const content = json.replace('本地测试依据', escape);
    await rejected(content, /JSON 字符串转义错误/);
  }
});

test('truncation remains distinct from absence of an object and malformed punctuation', async () => {
  await rejected(json.slice(0, -1), /JSON 输出不完整/);
  await rejected('```json\n' + json, /JSON 输出不完整/);
  await rejected(json + '\n{', /JSON 输出不完整/);
  await rejected(json + '\n[', /JSON 输出不完整/);
  await rejected('只有普通说明文字', /未返回 JSON 对象/);
  await rejected(json.slice(0, -1) + ',}', /JSON 格式错误/);
});

test('multiple complete candidates are rejected even when only one matches the answer schema', async () => {
  for (const content of [json + '\n' + json, '{"sample":1}\n' + json, json + '\n[]', '```json\n' + json + '\n```\n```json\n' + json + '\n```']) {
    await rejected(content, /多个候选 JSON 对象/);
  }
});

test('arrays, nested objects and serialized JSON strings never supply a nested answer', async () => {
  for (const content of ['[' + json + ']', JSON.stringify({answer: answer()}), JSON.stringify(json), '答案如下：[' + json + ']', 'true', 'null', '0']) {
    await rejected(content);
  }
});

test('only explicit final-answer wrappers are accepted', async () => {
  for (const prefix of ['错误答案：', '示例：', '例如：', '分析：', '推理过程：', '思路：', '参考格式：', '输出格式示范：', 'For example:\n', 'callback(', '<think>']) {
    await rejected(prefix + json + (prefix === 'callback(' ? ')' : prefix === '<think>' ? '</think>' : ''));
  }
  await accepted('经过分析，最终答案如下：' + json);
  await rejected('```javascript\n' + json + '\n```');
  await rejected('```jsonc\n' + json + '\n```');
  await rejected('```json\n' + json + '\n```\n这只是示例。');
});

test('strict fields, types and option-index checks remain in force after wrapper removal', async () => {
  const missing = answer(); delete missing.explanation;
  for (const value of [missing, answer({extra: 'x'}), answer({answerable: 'true'}), answer({choice_indices: ['1']}), answer({choice_indices: [1.5]}), answer({text_answers: [1]}), answer({judgement: 'yes'}), answer({explanation: null})]) {
    await rejected('```json\n' + JSON.stringify(value) + '\n```', /格式不符合约定/);
  }
  for (const value of [answer({choice_indices: [-1]}), answer({choice_indices: [3]}), answer({choice_indices: [1, 1]}), answer({text_answers: ['乙']}), answer({judgement: 'true'})]) {
    await rejected('答案如下：' + JSON.stringify(value), /选项编号无效/);
  }
});

test('provider incomplete flags and reasoning never provide a fallback final answer', async () => {
  await rejected(json, /输出未完成/, {finishReason: 'length'});
  await rejected(json, /输出未完成/, {provider: 'openai', status: 'incomplete'});
  for (const content of [undefined, '', '没有给出 JSON', '{']) {
    await rejected(content, undefined, {reasoning: json});
  }
  await accepted(json, answer(), {reasoning: JSON.stringify(answer({choice_indices: [0]}))});
});

test('fixed errors do not disclose model content, credentials, or image URLs', async () => {
  const secret = 'sk-local-fixture-private';
  const url = 'https://private.invalid/image?token=' + secret;
  for (const content of [url, '{"secret":"' + secret + '","unfinished":', json.replace('本地测试依据', '\\q ' + url), json + '\n{"secret":"' + secret + '"}']) {
    const message = await rejected(content);
    assert.ok(!message.includes(secret));
    assert.ok(!message.includes(url));
    assert.ok(!message.includes('local-deepseek-key'));
  }
});

test('serial and concurrent mixed failures leave other questions running with no retries', async () => {
  const forms = ['\uFEFF' + json, '```json\n' + json + '\n```', '答案如下：\n' + json + '\n以上为最终答案。', json.replace('本地测试依据', '\\sqrt{x}'), json + '\n' + json, json];
  for (const concurrent of [false, true]) {
    const h = harness(forms, {concurrent});
    const results = await Promise.all(forms.map((_, index) => h.getAnswer(question('题目' + index), {skipDelay: true})));
    assert.deepEqual(results.map(result => result.success), [true, true, true, false, false, true]);
    assert.equal(h.calls.length, forms.length);
  }
});

test('prompts request a complete five-field object and escaped math while thinking stays unchanged', async () => {
  for (const provider of ['deepseek', 'openai']) {
    const {result, h} = await solve(json, {provider});
    assert.equal(result.success, true);
    const body = JSON.parse(h.calls[0].data);
    const prompt = provider === 'deepseek' ? body.messages[0].content : body.instructions;
    assert.match(prompt, /一个完整的 JSON 对象/);
    assert.match(prompt, /五个字段/);
    assert.match(prompt, /反斜杠必须双写/);
    assert.match(prompt, /普通数学文字/);
    assert.equal('thinking' in body, false);
    assert.equal('reasoning' in body, false);
    assert.equal(body.stream, false);
    if (provider === 'deepseek') assert.equal(body.response_format.type, 'json_object');
    else assert.equal(body.text.format.strict, true);
  }
});
