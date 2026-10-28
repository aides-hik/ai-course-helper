const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {setTimeout: wait} = require('node:timers/promises');
const policy = require('../extension/network-policy.js');
const extension = path.resolve(__dirname, '..', 'extension');
const stored = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [policy.CONFIG_KEY + ':field:' + JSON.stringify(['ai', key]), JSON.stringify({v: 1, value})]));
const auth = {'Authorization': 'Bearer FAKE-UNIT-KEY'};
const storage = stored({provider: 'openai', apiKey: ' FAKE-UNIT-KEY '});
const post = overrides => ({url: 'https://api.openai.com/v1/responses', method: 'POST', headers: {...auth, 'Content-Type': 'application/json'}, data: '{"model":"test","input":[]}', timeout: 120000, ...overrides});
const get = overrides => ({url: 'https://api.openai.com/v1/models', method: 'GET', headers: auth, ...overrides});

test('network policy permits only actual top-level course content-script senders', () => {
  const sender = {id: 'extension-id', tab: {id: 3}, frameId: 0, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?x=1#tab'};
  assert.equal(policy.trustedSender(sender, 'extension-id'), true);
  assert.equal(policy.supportedUrl('https://exam.zhihuishu.com/stuExamWeb.html#/paper'), true);
  for (const changed of [{id: 'other-extension'}, {frameId: 1}, {tab: undefined}, {url: 'https://chaoxing.com.evil.test/'}, {url: 'https://notchaoxing.com/'}, {url: 'file:///chaoxing.com'}, {url: 'https://user:password@chaoxing.com/'}]) {
    assert.equal(policy.trustedSender({...sender, ...changed}, 'extension-id'), false, JSON.stringify(changed));
  }
});

test('network policy honors independently stored provider endpoints and key', () => {
  assert.equal(policy.validate(post(), storage).ok, true);
  assert.equal(policy.validate(get(), storage).ok, true);
  const configured = stored({provider: 'deepseek', deepseekApiKey: 'FAKE-UNIT-KEY', deepseekApiUrl: 'http://localhost:7777/gateway/chat/completions?tenant=fixture'});
  assert.equal(policy.validate(post({url: 'http://localhost:7777/gateway/chat/completions?tenant=fixture'}), configured).ok, true);
  assert.equal(policy.validate(get({url: 'http://localhost:7777/gateway/models?tenant=fixture'}), configured).ok, true);
  assert.equal(policy.validate(post(), configured).code, 'ENDPOINT_NOT_CONFIGURED');
  assert.equal(policy.validate(post({url: 'http://localhost:7777/gateway/chat/completions?tenant=other'}), configured).code, 'ENDPOINT_NOT_CONFIGURED');
  const explicit = {...configured, ...stored({deepseekModelsUrl: 'http://localhost:7777/custom-list'})};
  assert.equal(policy.validate(get({url: 'http://localhost:7777/custom-list'}), explicit).ok, true);
});

test('legacy config is read but a valid per-field value wins', () => {
  const legacy = {[policy.CONFIG_KEY]: JSON.stringify({ai: {provider: 'openai', apiKey: 'FAKE-UNIT-KEY', apiUrl: 'https://gateway.test/v1/responses'}})};
  assert.equal(policy.validate(post({url: 'https://gateway.test/v1/responses'}), legacy).ok, true);
  assert.equal(policy.validate(post(), {...legacy, ...stored({apiUrl: ''})}).ok, true);
  assert.equal(policy.validate(post(), stored({provider: 'unknown', apiKey: 'FAKE-UNIT-KEY'})).code, 'INVALID_CONFIGURATION');
});

test('network policy rejects redirects to other endpoints, URL credentials and foreign headers', () => {
  for (const url of ['https://attacker.test/', 'https://api.openai.com/v1/responses?leak=1', 'https://api.openai.com/v1/responses#fragment', 'https://user:password@api.openai.com/v1/responses', 'file:///etc/passwd', 'https://api.openai.com\\@evil.test/responses', 'https://api.openai.com/v1/responses\n']) {
    assert.equal(policy.validate(post({url}), storage).ok, false, url);
  }
  for (const headers of [{...auth, Cookie: 'session=fake'}, {...auth, Referer: 'https://course.test'}, {...auth, authorization: auth.Authorization}, {...auth, 'X-Proxy-Target': 'https://evil.test'}, {Authorization: 'Bearer CHANGED-KEY'}]) {
    assert.equal(policy.validate(post({headers}), storage).ok, false);
  }
  assert.equal(policy.validate(get({method: 'DELETE'}), storage).ok, false);
  assert.equal(policy.validate(post({headers: auth}), storage).ok, false);
});

test('network policy rejects invalid or oversized payloads and clamps transport timeouts', () => {
  for (const data of ['', 'null', '[]', '{', 1, {model: 'invalid'}]) assert.equal(policy.validate(post({data}), storage).code, 'INVALID_BODY');
  assert.equal(policy.validate(get({data: '{}'}), storage).code, 'INVALID_BODY');
  assert.equal(policy.validate(post({data: ' '.repeat(policy.REQUEST_LIMIT + 1)}), storage).code, 'REQUEST_TOO_LARGE');
  assert.equal(policy.validate(post({data: JSON.stringify({text: '图'.repeat(Math.floor(policy.REQUEST_LIMIT / 3))})}), storage).code, 'REQUEST_TOO_LARGE');
  assert.equal(policy.validate(post({timeout: 1}), storage).request.timeout, 15000);
  assert.equal(policy.validate(post({timeout: 99999999}), storage).request.timeout, 300000);
  assert.equal(policy.validate(get({timeout: 99999999}), storage).request.timeout, 20000);
});

function workerHarness(fetchImpl, clock = {}) {
  const messages = [];
  const callbacks = new Map();
  let nextTimer = 0;
  const self = {postMessage: value => messages.push(value)};
  const context = {self, fetch: fetchImpl, AbortController, TextDecoder, Error, Map, Math,
    setTimeout: clock.fake ? callback => {callbacks.set(++nextTimer, callback); return nextTimer;} : setTimeout,
    clearTimeout: clock.fake ? id => callbacks.delete(id) : clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(extension, 'network-worker.js'), 'utf8'), context);
  return {messages, callbacks, send: value => self.onmessage({data: value})};
}
const eventually = async predicate => {
  for (let index = 0; index < 100; index++) {if (predicate()) return; await wait(1);}
  assert.ok(predicate(), 'worker completed');
};

test('network Worker omits cookies, blocks redirects and reads a bounded streamed response', async () => {
  let sent;
  const worker = workerHarness(async (url, init) => {sent = {url, init}; return new Response('{"ok":true}', {status: 200});});
  worker.send({type: 'request', id: 'one', request: policy.validate(post(), storage).request});
  await eventually(() => worker.messages.length);
  assert.equal(sent.init.credentials, 'omit');
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.init.referrerPolicy, 'no-referrer');
  assert.equal(sent.init.cache, 'no-store');
  assert.equal(worker.messages[0].type, 'response');
  assert.equal(worker.messages[0].response.responseText, '{"ok":true}');
  assert.equal(worker.messages[0].response.finalUrl, post().url);
});

test('network Worker refuses excessive content length and excessive chunked responses', async () => {
  const requests = [
    () => new Response('small', {headers: {'content-length': String(policy.RESPONSE_LIMIT + 1)}}),
    () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(policy.RESPONSE_LIMIT + 1)); controller.close();}}))
  ];
  for (const make of requests) {
    const worker = workerHarness(async () => make());
    worker.send({type: 'request', id: 'large', request: policy.validate(get(), storage).request});
    await eventually(() => worker.messages.length);
    assert.equal(worker.messages[0].type, 'error');
    assert.equal(worker.messages[0].code, 'RESPONSE_TOO_LARGE');
  }
});

test('network Worker produces distinct timeout and explicit abort outcomes without credential-bearing errors', async () => {
  for (const timedOut of [false, true]) {
    let started = false;
    const worker = workerHarness((_url, {signal}) => new Promise((_resolve, reject) => {started = true; signal.addEventListener('abort', () => reject(new Error('sensitive request details FAKE-UNIT-KEY')));}), {fake: true});
    worker.send({type: 'request', id: 'cancelled', request: policy.validate(post(), storage).request});
    assert.equal(started, true);
    if (timedOut) [...worker.callbacks.values()][0]();
    else worker.send({type: 'abort', id: 'cancelled'});
    await eventually(() => worker.messages.length);
    assert.equal(worker.messages[0].type, timedOut ? 'timeout' : 'abort');
    assert.equal(JSON.stringify(worker.messages).includes('FAKE-UNIT-KEY'), false);
  }
});

test('network Worker rejects an unexpected redirected response instead of forwarding it', async () => {
  const worker = workerHarness(async () => ({redirected: true, url: 'https://attacker.test/'}));
  worker.send({type: 'request', id: 'redirect', request: policy.validate(post(), storage).request});
  await eventually(() => worker.messages.length);
  assert.equal(worker.messages[0].code, 'REDIRECT_BLOCKED');
});

function eventSource() {const listeners = []; return {listeners, addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(listener => listener(...args))};}
function offscreenHarness() {
  const onConnect = eventSource();
  const workers = [];
  const validations = [];
  const chrome = {runtime: {id: 'extension-id', onConnect, sendMessage: message => new Promise(resolve => validations.push({message, resolve}))}};
  class Worker {
    constructor(url) {this.url = url; this.messages = []; workers.push(this);}
    postMessage(value) {this.messages.push(value);}
    terminate() {this.terminated = true;}
  }
  vm.runInNewContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8'), {chrome, Worker, AiHelperNetworkPolicy: policy, Map, String});
  const connect = (overrides = {}) => {
    const port = {name: 'ai-helper:network', sender: {id: 'extension-id', tab: {id: 7}, frameId: 0, url: 'https://mooc1.chaoxing.com/mooc2/work/dowork'}, onMessage: eventSource(), onDisconnect: eventSource(), messages: [],
      postMessage(message) {this.messages.push(message);}, disconnect() {this.disconnected = true; this.onDisconnect.emit();}, ...overrides};
    onConnect.emit(port); return port;
  };
  return {connect, validations, workers};
}

test('offscreen document rejects foreign ports before creating a network Worker', () => {
  const harness = offscreenHarness();
  const port = harness.connect({sender: {id: 'extension-id', tab: {id: 7}, frameId: 0, url: 'https://attacker.test/'}});
  assert.equal(port.disconnected, true);
  assert.equal(harness.workers.length, 0);
  assert.equal(harness.validations.length, 0);
});

test('offscreen validates every request and isolates equal request ids from different tabs', async () => {
  const harness = offscreenHarness();
  const first = harness.connect(), second = harness.connect();
  first.onMessage.emit({type: 'request', id: 'one', request: get()});
  second.onMessage.emit({type: 'request', id: 'one', request: get()});
  assert.equal(harness.workers.length, 0);
  harness.validations.forEach(({resolve}) => resolve(policy.validate(get(), storage)));
  await eventually(() => harness.workers[0]?.messages.length === 2);
  const worker = harness.workers[0];
  assert.notEqual(worker.messages[0].id, worker.messages[1].id);
  worker.onmessage({data: {type: 'response', id: worker.messages[1].id, response: {status: 200, responseText: 'second'}}});
  assert.equal(second.messages.at(-1).response.responseText, 'second');
  assert.equal(first.messages.at(-1).type, 'ready');
});

test('offscreen cancels pending validation, active fetches and disconnected tabs', async () => {
  const harness = offscreenHarness();
  const port = harness.connect();
  port.onMessage.emit({type: 'request', id: 'first', request: get()});
  port.onMessage.emit({type: 'abort', id: 'first'});
  harness.validations[0].resolve(policy.validate(get(), storage));
  await wait(0);
  assert.equal(harness.workers.length, 0);
  assert.equal(port.messages.at(-1).type, 'abort');
  port.onMessage.emit({type: 'request', id: 'second', request: get()});
  harness.validations[1].resolve(policy.validate(get(), storage));
  await eventually(() => harness.workers.length);
  const worker = harness.workers[0];
  const taskId = worker.messages[0].id;
  port.disconnect();
  assert.equal(worker.messages.at(-1).type, 'abort');
  assert.equal(worker.messages.at(-1).id, taskId);
  const before = port.messages.length;
  worker.onmessage({data: {type: 'response', id: taskId, response: {status: 200}}});
  assert.equal(port.messages.length, before);
});

test('offscreen does not reuse worker ids when a caller repeats a cancelled external id', async () => {
  const harness = offscreenHarness();
  const port = harness.connect();
  port.onMessage.emit({type: 'request', id: 'reused', request: get()});
  harness.validations[0].resolve(policy.validate(get(), storage));
  await eventually(() => harness.workers.length);
  const worker = harness.workers[0];
  const oldTaskId = worker.messages[0].id;
  port.onMessage.emit({type: 'abort', id: 'reused'});
  port.onMessage.emit({type: 'request', id: 'reused', request: get()});
  harness.validations[1].resolve(policy.validate(get(), storage));
  await eventually(() => worker.messages.filter(message => message.type === 'request').length === 2);
  assert.notEqual(worker.messages.at(-1).id, oldTaskId);
  const before = port.messages.length;
  worker.onmessage({data: {type: 'abort', id: oldTaskId}});
  assert.equal(port.messages.length, before);
});

test('offscreen explicitly cancels active work before locally disconnecting a duplicate-id client', async () => {
  const harness = offscreenHarness();
  const port = harness.connect({disconnect() {this.disconnected = true;}});
  port.onMessage.emit({type: 'request', id: 'duplicate', request: get()});
  harness.validations[0].resolve(policy.validate(get(), storage));
  await eventually(() => harness.workers.length);
  const worker = harness.workers[0];
  port.onMessage.emit({type: 'request', id: 'duplicate', request: get()});
  assert.equal(port.disconnected, true);
  assert.equal(worker.messages.at(-1).type, 'abort');
  const before = harness.validations.length;
  port.onMessage.emit({type: 'request', id: 'after-disconnect', request: get()});
  assert.equal(harness.validations.length, before);
});

test('offscreen returns policy failures and reports worker crashes before allowing a fresh Worker', async () => {
  const harness = offscreenHarness();
  const port = harness.connect();
  port.onMessage.emit({type: 'request', id: 'bad', request: get()});
  harness.validations[0].resolve({ok: false, code: 'ENDPOINT_NOT_CONFIGURED'});
  await eventually(() => port.messages.some(message => message.id === 'bad'));
  assert.equal(port.messages.at(-1).code, 'ENDPOINT_NOT_CONFIGURED');
  port.onMessage.emit({type: 'request', id: 'crash', request: get()});
  harness.validations[1].resolve(policy.validate(get(), storage));
  await eventually(() => harness.workers.length);
  harness.workers[0].onerror({preventDefault() {}});
  assert.equal(port.messages.at(-1).code, 'NETWORK_WORKER_UNAVAILABLE');
  port.onMessage.emit({type: 'request', id: 'retry', request: get()});
  harness.validations[2].resolve(policy.validate(get(), storage));
  await eventually(() => harness.workers.length === 2);
});

test('background only accepts network validation from its own offscreen document and deduplicates creation', async () => {
  const onMessage = eventSource();
  let creations = 0;
  const chrome = {runtime: {id: 'extension-id', onMessage, getURL: value => 'chrome-extension://extension-id/' + value, getContexts: async () => []},
    offscreen: {createDocument: async details => {assert.equal(details.reasons[0], 'WORKERS'); creations++; await wait(2);}},
    storage: {local: {get: async () => storage}}};
  vm.runInNewContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), {chrome, importScripts() {}, AiHelperNetworkPolicy: policy});
  const send = (message, sender) => new Promise(resolve => onMessage.listeners[0](message, sender, resolve));
  const course = {id: 'extension-id', tab: {id: 7}, frameId: 0, url: 'https://mooc1.chaoxing.com/mooc2/work/dowork'};
  const results = await Promise.all([send({type: 'ai-helper:network-ready'}, course), send({type: 'ai-helper:network-ready'}, course)]);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(creations, 1);
  const payload = {type: 'ai-helper:validate-network', sender: course, request: get()};
  assert.equal((await send(payload, course)).code, 'UNTRUSTED_SENDER');
  assert.equal((await send(payload, {id: 'extension-id', url: chrome.runtime.getURL('offscreen.html')})).ok, true);
});
