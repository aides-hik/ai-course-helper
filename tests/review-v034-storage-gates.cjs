'use strict';
// Independent verification with the bundled Vue/Pinia runtimes and current sources.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'userscript.template.js.in'), 'utf8');
const storageSource = fs.readFileSync(path.join(root, 'config-storage.js'), 'utf8');
const chapterSource = fs.readFileSync(path.join(root, 'chapter-logic.js'), 'utf8');
const examSource = fs.readFileSync(path.join(root, 'exam-logic.js'), 'utf8');
const dependencies = [0, 1, 3].map(index => fs.readFileSync(path.join(root, 'tests', 'browser-fixture', 'mooc2', 'work', `dependency-${index}.js`), 'utf8'));
const key = 'openai-course-helper:config:v1';
const fieldKey = parts => key + ':field:' + JSON.stringify(parts);
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const configSource = section(template, '  const CONFIG_STORAGE_KEY = ', '  const formatDateTime = ').replace('/* @ai-helper:CONFIG_STORAGE@ */', storageSource);
function realStores(seed = {}) {
  const values = new Map(Object.entries(seed));
  const subscriptions = new Map();
  const writes = [];
  let nextId = 1;
  const instance = () => {
    const owner = {};
    const context = vm.createContext({console,
      VIDEO_QUIZ_SETTING: '视频弹题自动处理',
      getScriptInfo: () => ({version: 'review-0.3.4'}),
      _GM_getValue: name => values.get(name),
      _GM_setValue(name, value) {
        const old = values.get(name); values.set(name, value); writes.push({name, value});
        for (const subscription of subscriptions.values()) if (subscription.name === name) subscription.callback(name, old, value, subscription.owner !== owner);
      },
      _GM_addValueChangeListener(name, callback) {const id = nextId++; subscriptions.set(id, {owner, name, callback}); return id;},
      _GM_removeValueChangeListener(id) {subscriptions.delete(id);}
    });
    dependencies.forEach(dependency => vm.runInContext(dependency, context));
    vm.runInContext('const pinia=Pinia;Pinia.setActivePinia(Pinia.createPinia());\n' + configSource + `
      const store=useConfigStore();
      const stop=watchConfigStorage(store);
      const unwatch=Vue.watch(store,persistConfig,{deep:true});
      globalThis.review={store,save:()=>persistConfig(store),nextTick:Vue.nextTick,raw:()=>Vue.toRaw(store.$state),dispose(){stop();unwatch();}};`, context);
    return context.review;
  };
  return {instance, values, writes};
}

test('real Pinia proxy saves the first key from its raw initialization baseline and restores it', async () => {
  const h = realStores(), first = h.instance();
  assert.notEqual(first.store.$state, first.raw());
  first.store.ai.apiKey = 'FIRST-KEY'; first.store.ai.model = 'FIRST-MODEL';
  first.store.ai.concurrentEnabled = true; first.store.ai.concurrency = 2500;
  await first.nextTick();
  assert.equal(JSON.parse(h.values.get(fieldKey(['ai', 'apiKey']))).value, 'FIRST-KEY');
  const reloaded = h.instance();
  assert.equal(reloaded.store.ai.apiKey, 'FIRST-KEY');
  assert.equal(reloaded.store.ai.model, 'FIRST-MODEL');
  assert.equal(reloaded.store.ai.concurrentEnabled, true);
  assert.equal(reloaded.store.ai.concurrency, 2500);
  assert.equal(h.values.has(key), false);
  first.dispose(); reloaded.dispose();
});

test('real reactive stores migrate the legacy full record, overlay fields and sync without echo writes', async () => {
  const legacy = {version: '0.2.0',ai:{apiKey:'LEGACY-KEY',model:'legacy-model',timeoutSeconds:180},platformParams:{cx:{parts:[{name:'章节设置',params:[{name:'视频弹题自动处理（AI 解题）',value:true}]}]}}};
  const h = realStores({[key]: JSON.stringify(legacy), [fieldKey(['ai','apiKey'])]: JSON.stringify({v:1,value:'NEWER-KEY'})});
  const first = h.instance(), second = h.instance();
  assert.equal(first.store.ai.apiKey, 'NEWER-KEY');
  assert.equal(first.store.ai.model, 'legacy-model');
  assert.equal(first.store.ai.timeoutSeconds, 180);
  assert.equal(first.store.ai.deepseekApiKey, '');
  assert.equal(first.store.ai.concurrentEnabled, false);
  assert.equal(first.store.ai.concurrency, 3);
  assert.equal(first.store.platformParams.cx.parts[0].params.find(entry=>entry.name==='视频弹题自动处理').value, true);
  assert.equal(h.writes.length, 0);
  first.store.ai.apiKey = 'REMOTE-KEY';
  second.store.position.x = '123px';
  await Promise.all([first.nextTick(), second.nextTick()]);
  assert.equal(second.store.ai.apiKey, 'REMOTE-KEY');
  assert.equal(first.store.position.x, '123px');
  assert.equal(h.writes.length, 2);
  second.save(); first.save();
  await Promise.all([first.nextTick(), second.nextTick()]);
  assert.equal(h.writes.length, 2);
  const restored = h.instance();
  assert.equal(restored.store.ai.apiKey, 'REMOTE-KEY');
  assert.equal(restored.store.ai.model, 'legacy-model');
  assert.equal(restored.store.position.x, '123px');
  first.dispose(); second.dispose(); restored.dispose();
});

const processSource = chapterSource.slice(0, chapterSource.indexOf('  const useCxChapterLogic = ')) + section(chapterSource, '    const processWork = ', '    const processPpt = ');
async function workGate(options) {
  const events = [];
  const state = {filled: options.filled ?? 2, total: 2};
  const config = {platformParams:{cx:{parts:[{params:[{value:true}]}]}},otherParams:{params:[{value:0},{value:options.threshold ?? 100}]}};
  let refreshes = 0;
  const context = vm.createContext({configStore:config,ANSWER_TAB_NAME2:'1',logStore:{addLog(){}},decrypt(){},isWorkConfirmed:()=>false,
    CxQuestionHandler:class {async init(){this.lastSolveResult={total:2,filled:2,rate:100,cancelled:false,isCurrent:()=>true,refreshVerification(){refreshes++;options.onRefresh?.(state,refreshes);this.filled=state.filled;this.rate=state.filled/2*100;return this;}};}},
    aiWaitForDelay:async(_seconds,context)=>{options.afterWait?.(config,state);return context.isCurrent();}
  });
  vm.runInContext(processSource+'\nglobalThis.run=processWork;',context);
  const outcome = await context.run({}, {}, {async noSubmit(){events.push('save');},async btnBlueSubmit(){events.push('open-submit');},async submitCheckTimes(){events.push('confirm');}}, {isCurrent:()=>true});
  return {events,outcome,refreshes};
}

test('chapter submission reads refreshed answers and the latest threshold at each stage', async () => {
  const initiallyChanged=await workGate({onRefresh(state,count){if(count===1)state.filled=1;}});
  assert.deepEqual(initiallyChanged.events,['save']);
  const raised=await workGate({filled:1,threshold:50,afterWait(config){config.otherParams.params[1].value=100;}});
  assert.deepEqual(raised.events,['open-submit']);
  assert.equal(raised.refreshes,2);
  const withdrawn=await workGate({afterWait(_config,state){state.filled=0;}});
  assert.deepEqual(withdrawn.events,['open-submit']);
  assert.equal(withdrawn.refreshes,2);
  const unchanged=await workGate({});
  assert.deepEqual(unchanged.events,['open-submit','confirm']);
  assert.equal(unchanged.refreshes,2);
});

test('exam navigation stops when answer verification changes during the delay', async () => {
  const events=[]; let valid=true, checks=0;
  const context=vm.createContext({useLogStore:()=>({addLog(){}}),useQuestionStore:()=>({clearQuestion(){}}),useConfigStore:()=>({platformParams:{cx:{parts:[{}, {params:[{value:true}]}]}},otherParams:{params:[{value:0}]}}),
    CxQuestionHandler:class{async init(){this.lastSolveResult={rate:100,cancelled:false,isCurrent:()=>true,verifyFilled(){checks++;return valid;}};}},
    aiWaitForDelay:async(_seconds,context)=>{valid=false;return context.isCurrent();},
    clickNextStepButton(){events.push('step');return false;},_unsafeWindow:{getTheNextQuestion(){events.push('question');}}
  });
  vm.runInContext(examSource+'\nglobalThis.run=useCxExamLogic;',context);
  await context.run();
  assert.deepEqual(events,[]);
  assert.equal(checks,2);
});
