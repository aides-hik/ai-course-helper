'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {URL};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'ai-endpoints.js'), 'utf8') + '\nglobalThis.resolve = aiResolveEndpoints;', context);
const resolve = (provider, ai = {}) => JSON.parse(JSON.stringify(context.resolve(provider, ai)));

test('missing and empty request settings retain each provider official endpoints', () => {
  assert.deepEqual(resolve('openai'), {requestUrl:'https://api.openai.com/v1/responses',modelsUrl:'https://api.openai.com/v1/models'});
  assert.deepEqual(resolve('deepseek'), {requestUrl:'https://api.deepseek.com/chat/completions',modelsUrl:'https://api.deepseek.com/models'});
  assert.equal(resolve('openai',{apiUrl:'  '}).requestUrl,'https://api.openai.com/v1/responses');
});
test('custom request prefixes and query parameters also apply to automatic model listing', () => {
  assert.deepEqual(resolve('openai',{apiUrl:' HTTPS://GATEWAY.EXAMPLE:443/prefix/v1/responses?region=x '}),{requestUrl:'https://gateway.example/prefix/v1/responses?region=x',modelsUrl:'https://gateway.example/prefix/v1/models?region=x'});
  assert.deepEqual(resolve('deepseek',{deepseekApiUrl:'https://gateway.example/team/chat/completions/'}),{requestUrl:'https://gateway.example/team/chat/completions/',modelsUrl:'https://gateway.example/team/models'});
});
test('complete local HTTP URLs and IPv6 are supported', () => {
  assert.equal(resolve('openai',{apiUrl:'http://127.0.0.1:1234/v1/responses'}).modelsUrl,'http://127.0.0.1:1234/v1/models');
  assert.equal(resolve('deepseek',{deepseekApiUrl:'http://[::1]:8000/v1/chat/completions'}).modelsUrl,'http://[::1]:8000/v1/models');
});
test('explicit model-list URL takes precedence without altering answer routing', () => {
  assert.deepEqual(resolve('openai',{apiUrl:'https://gateway.example/solve',modelsUrl:'https://catalog.example/list?region=x'}),{requestUrl:'https://gateway.example/solve',modelsUrl:'https://catalog.example/list?region=x'});
});
test('an unknown inference route requires only a manual model-list address', () => {
  const result=resolve('openai',{apiUrl:'https://gateway.example/infer'});
  assert.equal(result.requestUrl,'https://gateway.example/infer');
  assert.ok(result.modelsError);
  assert.equal(result.error,undefined);
});
test('provider address fields remain independent', () => {
  const ai={apiUrl:'https://openai.example/v1/responses',modelsUrl:'https://openai.example/catalog',deepseekApiUrl:'https://deepseek.example/v1/chat/completions',deepseekModelsUrl:'https://deepseek.example/catalog'};
  assert.equal(resolve('openai',ai).modelsUrl,'https://openai.example/catalog');
  assert.equal(resolve('deepseek',ai).modelsUrl,'https://deepseek.example/catalog');
});
test('unsafe or malformed inference addresses fail locally without echoing input', () => {
  for (const apiUrl of ['javascript:sentinel-secret','data:sentinel-secret','ftp://sentinel-secret.invalid/a','/sentinel-secret','https:/sentinel-secret.invalid','https://sentinel-secret:password@example.com/v1/responses','https://example.com/#sentinel-secret','https://example.com/a\\sentinel-secret','https://example.com/a\nsentinel-secret','https://example.com/a sentinel-secret',null,{},'https://example.com/'+ 'x'.repeat(8192)]) {
    const result=resolve('openai',{apiUrl});
    assert.ok(result.error, String(apiUrl));
    assert.doesNotMatch(result.error,/sentinel-secret|password|example\.com/);
    assert.equal(result.requestUrl,undefined);
  }
});
test('invalid explicit models address leaves inference valid and refuses listing', () => {
  for(const modelsUrl of ['javascript:sentinel-secret','https://user:password@example.com/list',null]){
    const result=resolve('openai',{modelsUrl});
    assert.equal(result.requestUrl,'https://api.openai.com/v1/responses');
    assert.ok(result.modelsError);
    assert.equal(result.modelsUrl,undefined);
    assert.doesNotMatch(result.modelsError,/sentinel-secret|password|example\.com/);
  }
});
test('only a complete endpoint is accepted, with no silent suffix guessing for inference', () => {
  assert.equal(resolve('openai',{apiUrl:'https://gateway.example/v1'}).requestUrl,'https://gateway.example/v1');
  assert.ok(resolve('openai',{apiUrl:'https://gateway.example/v1'}).modelsError);
  assert.ok(resolve('other').error);
});
