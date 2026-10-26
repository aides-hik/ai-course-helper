'use strict';
// Independent malformed-output cases; model text is data and is never executed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'..','ai-endpoints.js'),'utf8')+'\n'+fs.readFileSync(path.resolve(__dirname,'..','ai-adapter.js'),'utf8');
const sandbox={URL,isObject:value=>value!==null&&typeof value==='object'&&!Array.isArray(value)};
vm.runInNewContext(source+'\nglobalThis.api={parse:aiParseAnswerText,read:aiReadDeepSeekOutput};',sandbox);
const answer={answerable:true,choice_indices:[0],text_answers:[],judgement:'unknown',explanation:'fixture'};
const json=JSON.stringify(answer);

test('only the one complete final answer object can be recovered from surrounding prose',()=>{
  for(const value of [json,'\uFEFF'+json,'```json\n'+json+'\n```','答案如下：\n'+json+'\n请核对。']){
    const parsed=sandbox.api.parse(value);
    assert.equal(parsed.error,undefined,value.slice(0,50));
    assert.equal(parsed.answer.choice_indices[0],0);
  }
});

test('multiple objects, wrapped arrays and truncated surrounding structures never select a plausible object',()=>{
  for(const value of [
    json+'\n'+json,'['+json+']','答案如下：['+json+']','示例：'+json+'\n最终：'+json,
    json+'\n最终输出：{"answerable":','{"unfinished":'+json,
    '前文包含[未完成的列表 '+json,'["prefix",'+json+',"suffix"]',
    '```json\n'+json+'\n```\n```json\n'+json+'\n```',
    JSON.stringify({result:answer}),json+'\n[',json+'\n"unfinished','callback('+json+')'
  ])assert.ok(sandbox.api.parse(value).error,value.slice(0,70));
});

test('a complete schema inside examples or explicit thinking tags is never treated as the answer',()=>{
  for(const value of [
    '例如：'+json,'示例格式：'+json,'For example:\n'+json,
    '<think>'+json+'</think>','<analysis>reasoning '+json+'</analysis>',
    '<think>这里给出一个候选。</think>\n'+json,
    '思考过程：'+json,'分析：'+json,'推理过程：'+json,'思路：'+json,'参考格式：'+json,'输出格式示范：'+json,'错误答案：'+json,'Reasoning example: '+json,
    '```javascript\n'+json+'\n```','```jsonc\n'+json+'\n```'
  ])assert.ok(sandbox.api.parse(value).error,value.slice(0,70));
});

test('JSON strings containing escaped quotes and bracket literals remain unchanged',()=>{
  const data={...answer,explanation:'literal } { [ ] and \\"quote\\"; code: return {x: 1};'};
  const parsed=sandbox.api.parse('答案如下：\n'+JSON.stringify(data)+'\n请核对。');
  assert.equal(parsed.error,undefined);
  assert.equal(parsed.answer.explanation,data.explanation);
});

test('invalid outputs return fixed messages without keys, URLs or source excerpts',()=>{
  const secret='sk-fixture-DO-NOT-ECHO';
  const url='https://private.example/image?token='+secret;
  for(const value of [url,'{"api_key":"'+secret+'",'+json,secret+' '+json+' {truncated']){
    const result=sandbox.api.parse(value);
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(url));
  }
});

test('DeepSeek reasoning fields cannot supply an answer when content is missing or invalid',()=>{
  for(const content of [null,'','plain text','<think>'+json+'</think>']){
    const result=sandbox.api.read({choices:[{finish_reason:'stop',message:{content,reasoning_content:json}}]});
    assert.ok(result.error);
  }
});

test('oversized and deeply nested malformed text is rejected in bounded time',()=>{
  const started=performance.now();
  assert.ok(sandbox.api.parse('x'.repeat(2*1024*1024)+json).error);
  assert.ok(sandbox.api.parse('['.repeat(10000)+json+']'.repeat(10000)).error);
  assert.ok(performance.now()-started<1000);
});
