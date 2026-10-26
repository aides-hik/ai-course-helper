'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'config-storage.js'), 'utf8');
const defaults = () => ({ai: {apiKey: '', model: '', provider: 'openai', deepseekApiKey: '', deepseekModel: 'deepseek-flash'}, menuIndex: '0', position: {x: '32px', y: '80px'}, platformParams: {cx: {parts: [{name: '章节设置', params: [{name: '自动提交', value: false}, {name: '自动跳章', value: false}]}]}}});
function storageHarness() {
  const values = new Map();
  const subscriptions = new Map();
  const writes = [];
  let nextId = 1;
  function instance(options = {}) {
    const owner = {};
    const context = vm.createContext({
      CONFIG_STORAGE_KEY: 'test-config',
      isPlainObject: (value) => Object.prototype.toString.call(value) === '[object Object]',
      getItemName: (value) => value && typeof value.name === 'string' ? value.name : null,
      _GM_getValue: (key) => values.get(key),
      _GM_setValue(key, value) {
        const old = values.get(key);
        values.set(key, value);
        writes.push({key, value});
        for (const subscription of [...subscriptions.values()]) {
          if (subscription.key === key) subscription.callback(key, old, value, subscription.owner !== owner);
        }
      },
      _GM_addValueChangeListener: options.noListeners ? undefined : (key, callback) => {
        const id = nextId++;
        subscriptions.set(id, {key, callback, owner});
        return id;
      },
      _GM_removeValueChangeListener: (id) => subscriptions.delete(id)
    });
    vm.runInContext(moduleSource + '\nglobalThis.storage={initializeConfigStorage,persistConfig,watchConfigStorage};', context);
    const config = defaults();
    context.storage.initializeConfigStorage(config);
    const stop = context.storage.watchConfigStorage(config);
    return {config, save: () => context.storage.persistConfig(config), stop};
  }
  return {values, writes, instance, subscriptions};
}

test('V04: an old tab changing its menu cannot overwrite another tab credentials even without listeners', () => {
  const h = storageHarness();
  const first = h.instance({noListeners: true}), second = h.instance({noListeners: true});
  first.config.ai.apiKey = 'NEW-USER-KEY';
  first.config.ai.model = 'new-model';
  first.save();
  second.config.menuIndex = '2';
  second.save();
  const reloaded = h.instance();
  assert.equal(reloaded.config.ai.apiKey, 'NEW-USER-KEY');
  assert.equal(reloaded.config.ai.model, 'new-model');
  assert.equal(reloaded.config.menuIndex, '2');
  assert.equal(h.writes.filter(({key}) => key.includes('apiKey')).length, 1);
});

test('V04: remote credential and automation changes update existing tabs without an echo write', () => {
  const h = storageHarness(), first = h.instance(), second = h.instance();
  first.config.ai.apiKey = 'NEW-USER-KEY';
  first.config.ai.provider = 'deepseek';
  first.config.platformParams.cx.parts[0].params[0].value = true;
  first.save();
  assert.equal(second.config.ai.apiKey, 'NEW-USER-KEY');
  assert.equal(second.config.ai.provider, 'deepseek');
  assert.equal(second.config.platformParams.cx.parts[0].params[0].value, true);
  const count = h.writes.length;
  second.save();
  assert.equal(h.writes.length, count);
  first.config.platformParams.cx.parts[0].params[0].value = false;
  first.save();
  assert.equal(second.config.platformParams.cx.parts[0].params[0].value, false);
});

test('pending local edits survive a remote update and win when explicitly saved', () => {
  const h = storageHarness(), first = h.instance(), second = h.instance();
  second.config.ai.apiKey = 'LOCAL-PENDING';
  first.config.ai.apiKey = 'REMOTE-NEW';
  first.save();
  assert.equal(second.config.ai.apiKey, 'LOCAL-PENDING');
  second.save();
  assert.equal(first.config.ai.apiKey, 'LOCAL-PENDING');
  assert.equal(h.instance().config.ai.apiKey, 'LOCAL-PENDING');
});

test('independent provider fields, named settings and view state survive alternating stale writes', () => {
  const h = storageHarness(), first = h.instance({noListeners: true}), second = h.instance({noListeners: true});
  first.config.ai.apiKey = 'OPENAI-KEY';
  first.config.platformParams.cx.parts[0].params[0].value = true;
  first.save();
  second.config.ai.deepseekApiKey = 'DEEPSEEK-KEY';
  second.config.position.x = '99px';
  second.save();
  const saved = h.instance().config;
  assert.equal(saved.ai.apiKey, 'OPENAI-KEY');
  assert.equal(saved.ai.deepseekApiKey, 'DEEPSEEK-KEY');
  assert.equal(saved.position.x, '99px');
  assert.equal(saved.platformParams.cx.parts[0].params[0].value, true);
});

test('malformed or incorrectly typed field values do not enable automation or replace credentials', () => {
  const h = storageHarness(), first = h.instance();
  first.config.ai.apiKey = 'ORIGINAL';
  first.save();
  h.values.set('test-config:field:["ai","apiKey"]', '{');
  h.values.set('test-config:field:["platformParams","cx","parts","@章节设置","params","@自动提交","value"]', JSON.stringify({v: 1, value: 'true'}));
  const restored = h.instance().config;
  assert.equal(restored.ai.apiKey, '');
  assert.equal(restored.platformParams.cx.parts[0].params[0].value, false);
});

test('disposing synchronization removes the instance listeners', () => {
  const h = storageHarness(), first = h.instance();
  assert.ok(h.subscriptions.size > 0);
  first.stop();
  assert.equal(h.subscriptions.size, 0);
});
