// Independent 0.3.3 review reproductions. This file does not change production code.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path');
const root=path.join(__dirname,'..');
const hooksSource=fs.readFileSync(path.join(root,'page-hooks.js'),'utf8');
const template=fs.readFileSync(path.join(root,'userscript.template.js.in'),'utf8').replace('/* @ai-helper:CONFIG_STORAGE@ */',fs.readFileSync(path.join(root,'config-storage.js'),'utf8'));

function hooksFixture(){
  const listeners=new Map();
  const sandbox={
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    setTimeout(){return 1;},setInterval(){return 2;}
  };
  const context=vm.createContext(sandbox);
  vm.runInContext('globalThis._unsafeWindow=globalThis;\n'+hooksSource+'\nglobalThis.reviewHooks={hookWebpack,XMLHttpRequestInterceptor};',context);
  return {sandbox,context,run:source=>vm.runInContext(source,context),dispatch(type,event){for(const fn of [...(listeners.get(type)||[])])fn(event);}};
}

test('getter-based webpack export receives one mixin and restores the global probe',()=>{
  const h=hooksFixture();
  const observed=JSON.parse(h.run(`
    const nativeCall=Function.prototype.call;
    const restore=reviewHooks.hookWebpack();
    let mixins=0,installs=0;
    const plugin={version:'2.5.0',install(){installs++;return 7;}},originalInstall=plugin.install;
    const exports={},module={exports};
    function moduleFactory(module,exports){
      Object.defineProperty(exports,'a',{enumerable:true,get:function(){return plugin;}});
    }
    moduleFactory.call(exports,module,exports);
    const matchesOriginalDetector=exports.a.version==='2.5.0';
    const callStillWrapped=Function.prototype.call!==nativeCall;
    const installWasWrapped=plugin.install!==originalInstall;
    const framework={mixin(){mixins++;}};
    plugin.install(framework);plugin.install(framework);
    restore();
    JSON.stringify({matchesOriginalDetector,callStillWrapped,installWasWrapped,mixins,installs,restoredInstall:plugin.install===originalInstall});
  `));
  assert.deepEqual(observed,{matchesOriginalDetector:true,callStillWrapped:false,installWasWrapped:true,mixins:1,installs:2,restoredInstall:true});
});

test('BFCache suspends old XHR work, rescans on return, and keeps the live interceptor',()=>{
  const h=hooksFixture(),phases=[];
  class Xhr{
    constructor(){this.status=200;this.listeners=new Map();}
    open(){}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    load(){for(const fn of [...(this.listeners.get('load')||[])])fn();}
  }
  h.sandbox.XMLHttpRequest=Xhr;
  h.sandbox.onPhase=(_body,phase)=>phases.push(phase);
  h.run('globalThis.interceptor=new reviewHooks.XMLHttpRequestInterceptor(["hasAnswer"],onPhase);');
  const before=new Xhr();before.open('GET','/hasAnswer');before.load();
  assert.deepEqual(phases,['start','load']);
  const stale=new Xhr();stale.open('GET','/hasAnswer');
  assert.deepEqual(phases,['start','load','start']);
  h.dispatch('pagehide',{persisted:true});
  assert.deepEqual(phases,['start','load','start','start']);
  stale.load();
  const hidden=new Xhr();hidden.open('GET','/hasAnswer');hidden.load();
  assert.deepEqual(phases,['start','load','start','start']);
  h.dispatch('pageshow',{persisted:true});
  assert.deepEqual(phases,['start','load','start','start','resume']);
  stale.load();
  const after=new Xhr();after.open('GET','/hasAnswer');after.load();
  assert.deepEqual(phases,['start','load','start','start','resume','start','load']);
  h.dispatch('pagehide',{persisted:false});
  h.dispatch('pageshow',{persisted:true});
  const disposed=new Xhr();disposed.open('GET','/hasAnswer');disposed.load();
  assert.deepEqual(phases,['start','load','start','start','resume','start','load']);
});

test('regression: a stale frame changing views preserves credentials saved in another frame',()=>{
  const storage=new Map(),definitions=[];
  const configSource=template.slice(template.indexOf('  const CONFIG_STORAGE_KEY = '),template.indexOf('  const formatDateTime = '));
  function makeStore(){
    const sandbox={
      VIDEO_QUIZ_SETTING:'视频弹题自动处理',console,
      getScriptInfo:()=>({version:'0.3.3'}),
      _GM_getValue:key=>storage.get(key),_GM_setValue:(key,value)=>storage.set(key,value),
      pinia:{defineStore(_name,definition){definitions.push(definition);return definition;}},
    };
    vm.runInNewContext(configSource+'\nglobalThis.createStore=()=>useConfigStore.state();globalThis.save=persistConfig;',sandbox);
    return {store:sandbox.createStore(),save:sandbox.save};
  }
  const first=makeStore(),second=makeStore();
  first.store.ai.apiKey='NEW-USER-KEY';first.store.ai.model='account-model';first.save(first.store);
  assert.equal(makeStore().store.ai.apiKey,'NEW-USER-KEY');
  second.store.menuIndex='2';second.save(second.store);
  const saved=makeStore().store;
  assert.equal(saved.ai.apiKey,'NEW-USER-KEY');
  assert.equal(saved.ai.model,'account-model');
  assert.equal(saved.menuIndex,'2');
  console.log('STALE_CONFIG_REGRESSION',JSON.stringify({credentialsPreserved:true,secondFrameMenu:saved.menuIndex}));
});

test('control: data-based webpack exports can be captured across separate JavaScript realms',()=>{
  const page=vm.createContext({});
  const unsafeWindow=vm.runInContext('globalThis',page);
  unsafeWindow.addEventListener=()=>{};unsafeWindow.removeEventListener=()=>{};
  const sandbox=vm.createContext({_unsafeWindow:unsafeWindow});
  vm.runInContext(hooksSource+'\nglobalThis.restore=hookWebpack();',sandbox);
  const observed=JSON.parse(vm.runInContext(`
    let mixins=0;
    const plugin={version:'2.5.0',install(){return 3;}},exports={},module={exports};
    (function(module){module.exports.a=plugin;}).call(exports,module);
    const value=plugin.install({mixin(){mixins++;}});
    JSON.stringify({value,mixins});
  `,page));
  assert.deepEqual(observed,{value:3,mixins:1});
  vm.runInContext('restore();',sandbox);
});

test('getter-based export capture works across realms and a throwing getter leaves normal calls intact',()=>{
  const page=vm.createContext({});
  const unsafeWindow=vm.runInContext('globalThis',page);
  unsafeWindow.addEventListener=()=>{};unsafeWindow.removeEventListener=()=>{};
  const sandbox=vm.createContext({_unsafeWindow:unsafeWindow});
  vm.runInContext(hooksSource+'\nglobalThis.restore=hookWebpack();',sandbox);
  const observed=JSON.parse(vm.runInContext(`
    let getterCalls=0,mixins=0;
    const broken={};Object.defineProperty(broken,'a',{get(){getterCalls++;throw Error('bad export');}});
    const normalValue=(function(){return 82;}).call(broken,{exports:broken});
    const sentinel={};let sameException=false;try{(function(){throw sentinel;}).call(broken,{exports:broken});}catch(error){sameException=error===sentinel;}
    const plugin={version:'2.5.0',install(){return 5;}},exports={},module={exports};
    (function(module,exports){Object.defineProperty(exports,'a',{get(){return plugin;}});}).call(exports,module,exports);
    const value=plugin.install({mixin(){mixins++;}});
    JSON.stringify({normalValue,getterCalls,sameException,value,mixins});
  `,page));
  assert.deepEqual(observed,{normalValue:82,getterCalls:1,sameException:true,value:5,mixins:1});
  vm.runInContext('restore();',sandbox);
});

test('BFCache retains timer and call probes, then a real departure restores both',()=>{
  const h=hooksFixture();
  h.run('globalThis.nativeCall=Function.prototype.call;globalThis.nativeTimeout=setTimeout;globalThis.restoreCall=reviewHooks.hookWebpack();globalThis.restoreTimers=hookError();');
  h.dispatch('pagehide',{persisted:true});
  assert.equal(h.run('Function.prototype.call!==nativeCall&&setTimeout!==nativeTimeout'),true);
  h.dispatch('pageshow',{persisted:true});
  assert.equal(h.run('Function.prototype.call!==nativeCall&&setTimeout!==nativeTimeout'),true);
  h.dispatch('pagehide',{persisted:false});
  assert.equal(h.run('Function.prototype.call===nativeCall&&setTimeout===nativeTimeout'),true);
});
