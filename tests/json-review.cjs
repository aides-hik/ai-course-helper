'use strict';
// Independent parser review. The actual adapter runs locally with no network.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.resolve(__dirname, '..', 'ai-adapter.js'), 'utf8');
const sandbox = {
  URL,
  isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value)
};
vm.runInNewContext(source + '\nglobalThis.review={parse:aiParseAnswerText,deepseek:aiReadDeepSeekOutput,openai:aiReadOutput,map:aiMapAnswer};', sandbox);
const api = sandbox.review;
const plain = value => JSON.parse(JSON.stringify(value));
const answer = (overrides = {}) => ({
  answerable: true, choice_indices: [1], text_answers: [],
  judgement: 'unknown', explanation: '独立本地检查', ...overrides
});
const json = JSON.stringify(answer());
const deepseek = (content, extra = {}, choice = {}) => ({choices: [{finish_reason: 'stop', message: {content, ...extra}, ...choice}]});
const openai = text => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text}]}]});
function accepted(text, expected = answer()) {
  const result = api.parse(text);
  assert.equal(result.error, undefined, String(result.error));
  assert.deepEqual(plain(result.answer), expected);
}
function rejected(text) {
  const result = api.parse(text);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.equal(result.answer, undefined);
  return result.error;
}

test('plain JSON, whitespace, BOM and complete JSON fences preserve the exact answer', () => {
  for (const text of [json, ' \n\t' + json + '\r\n', '\uFEFF' + json, '\uFEFF  \n' + json,
    '```json\n' + json + '\n```', '```JSON\r\n' + json + '\r\n```', '```\n' + json + '\n```']) accepted(text);
});

test('one complete object with short surrounding explanation is accepted', () => {
  for (const text of ['答案如下：\n' + json, json + '\n请核对。', '答案如下：\n' + json + '\n请核对。']) accepted(text);
});

test('nested brackets, escaped quotes and backslashes inside JSON strings are not candidate boundaries', () => {
  const explanations = [
    '括号：{ [ ] }，嵌套 {"key":[1,{"x":2}]}',
    '他说："选第二项"，再看 { 并不结束字符串。',
    '反斜杠 \\ 后面有 } ] 与 "引号"',
    '连续反斜杠 \\\\ 与反斜杠加引号 \\" 然后 {',
    '换行\n制表\t回车\r和 emoji 🧪',
    '代码围栏字面量 ```json {"x":0} ```'
  ];
  for (const explanation of explanations) {
    const value = answer({explanation});
    const text = JSON.stringify(value);
    accepted(text, value);
    accepted('答案如下：\n' + text + '\n请核对。', value);
    accepted('```json\n' + text + '\n```', value);
  }
});

test('two complete candidates are always rejected without choosing by schema or position', () => {
  for (const text of [json + '\n' + json,
    '示例：\n' + json + '\n最终答案：\n' + JSON.stringify(answer({choice_indices:[0]})),
    '{"example":1}\n' + json, json + '\n{"extra":1}',
    '```json\n' + json + '\n```\n```json\n' + json + '\n```']) rejected(text);
});

test('an answer nested in an object, array or JSON string is never extracted as the top-level answer', () => {
  for (const text of [JSON.stringify({answer:answer()}), '[' + json + ']', JSON.stringify(json),
    '答案如下：\n[' + json + ']\n请核对。', '答案如下：\n{"answer":' + json + '}']) rejected(text);
});

test('truncated or malformed content is not repaired', () => {
  for (const text of [json.slice(0,-1), json.replace('"choice_indices":[1]', '"choice_indices":[1,]'),
    json.replace('"answerable":true', '"answerable":True'), json.replace('"answerable"', "'answerable'"),
    json.slice(0,-1) + ',}', json.slice(0,-1) + ']',
    '```json\n' + json, json + '\n```',
    json + '\n{', '{\n' + json, json + '\n[', '[' + json]) rejected(text);
});

test('all incomplete suffixes of an ordinary object are rejected', () => {
  for (let length=1;length<json.length;length++) rejected(json.slice(0,length));
});

test('missing, extra or mistyped answer fields retain the strict schema', () => {
  const missing = answer(); delete missing.explanation;
  for (const value of [null, [], true, 1, 'A', missing, answer({extra:'x'}), answer({answerable:1}),
    answer({choice_indices:['1']}), answer({choice_indices:[1.1]}), answer({text_answers:[1]}),
    answer({judgement:true}), answer({judgement:'yes'}), answer({explanation:null})]) {
    const text = JSON.stringify(value);
    rejected(text);
    rejected('```json\n' + text + '\n```');
  }
});

test('DeepSeek and OpenAI use the same normalization', () => {
  const text = '\uFEFF```json\n' + json + '\n```';
  assert.deepEqual(plain(api.deepseek(deepseek(text)).answer), answer());
  assert.deepEqual(plain(api.openai(openai(text)).answer), answer());
});

test('DeepSeek reasoning, refusal and tool calls cannot supply an answer', () => {
  for (const payload of [deepseek(undefined, {reasoning_content:json}),
    deepseek('', {reasoning_content:'```json\n' + json + '\n```'}),
    deepseek('{', {reasoning_content:json}),
    deepseek(json, {refusal:'cannot answer'}), deepseek(json, {tool_calls:[{id:'local'}]})]) {
    assert.equal(typeof api.deepseek(payload).error, 'string');
  }
  const different = answer({choice_indices:[0]});
  assert.deepEqual(plain(api.deepseek(deepseek(json, {reasoning_content:JSON.stringify(different)})).answer), answer());
});

test('provider truncation flags override apparently complete JSON', () => {
  for (const finish_reason of ['length','content_filter','tool_calls',null]) {
    assert.equal(typeof api.deepseek(deepseek(json, {}, {finish_reason})).error, 'string');
  }
  assert.equal(typeof api.openai({...openai(json),status:'incomplete'}).error,'string');
  assert.equal(typeof api.deepseek(deepseek(json.slice(0,-1))).error,'string');
});

test('fenced answers still use exact option indices and reject ambiguous mapping', () => {
  const prepared = {type:'single',rawOptions:['【图片选项1】','【图片选项2】']};
  const parsed = api.parse('```json\n' + json + '\n```');
  assert.equal(parsed.error, undefined);
  assert.deepEqual(plain(api.map(parsed.answer,prepared)),{values:['【图片选项2】']});
  for (const overrides of [{choice_indices:[-1]},{choice_indices:[2]},{choice_indices:[0,1]},
    {choice_indices:[1,1]},{text_answers:['第二项']},{judgement:'true'},{answerable:false}]) {
    const result = api.parse('```json\n' + JSON.stringify(answer(overrides)) + '\n```');
    assert.equal(result.error,undefined);
    assert.equal(typeof api.map(result.answer,prepared).error,'string');
  }
});

test('invalid-answer messages never echo response text or secrets', () => {
  const secret = 'local-fixture-secret-key-98317';
  for (const text of [secret, '```json\n' + secret + '\n```', '{"secret":"' + secret + '"}',
    '答案如下：' + json + '\n' + '{"secret":"' + secret + '"}']) {
    const error = rejected(text);
    assert.ok(!error.includes(secret));
    assert.ok(!error.includes('"answerable"'));
  }
});
