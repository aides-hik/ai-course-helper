// Offline regressions; no platform or API requests occur.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','page-hooks.js'),'utf8');
function fixture(overrides={}) {
  const events=new Map(),nativeTimers=[];
  const sandbox={
    setTimeout(...args){nativeTimers.push({method:'timeout',args,self:this});return 301;},
    setInterval(...args){nativeTimers.push({method:'interval',args,self:this});return 302;},
    addEventListener(type,callback){if(!events.has(type))events.set(type,new Set());events.get(type).add(callback);},
    removeEventListener(type,callback){events.get(type)?.delete(callback);},...overrides
  };
  const context=vm.createContext(sandbox);
  vm.runInContext('globalThis._unsafeWindow=globalThis;\n'+source+'\nglobalThis.hooks={hookWebpack,hookError,XMLHttpRequestInterceptor,isZhsHost};',context);
  return {context,sandbox,hooks:sandbox.hooks,nativeTimers,run:text=>vm.runInContext(text,context),hide(){for(const callback of [...(events.get('pagehide')||[])])callback();}};
}

test('ordinary Function.call preserves return, this, arguments, and native exceptions',()=>{
  const h=fixture();h.run('globalThis.restore=hooks.hookWebpack();');
  assert.equal(h.run('(function(){return 123;}).call({a:{version:"2.5.0"}})'),123);
  assert.equal(h.run('(function(a,b){return this.value+a+b;}).call({value:4},5,6)'),15);
  assert.equal(h.run('const sentinel={};try{(function(){throw sentinel;}).call(null);}catch(e){globalThis.sameError=e===sentinel;}sameError;'),true);
  h.run('restore();');
});

test('probe reads export getters only for validated modules and isolates failures',()=>{
  const h=fixture();h.run('hooks.hookWebpack();globalThis.getterCount=0;');
  assert.equal(h.run(`const exp={};Object.defineProperty(exp,'a',{get(){getterCount++;throw Error('getter');}});(function(){return 7;}).call(exp,{exports:{}});`),7);
  assert.equal(h.run('getterCount'),0);
  assert.equal(h.run(`(function(){return 9;}).call(exp,{exports:exp});`),9);
  assert.equal(h.run('getterCount'),1);
  assert.equal(h.run(`const badModule=new Proxy({},{getOwnPropertyDescriptor(){throw Error('trap');}});(function(){return 8;}).call({},badModule);`),8);
  h.hide();
});

test('target module gets one mixin, restores global call immediately, and supports disposal',()=>{
  const h=fixture();
  const result=h.run(`
    const nativeCall=Function.prototype.call;
    let installCalls=0,correctThis=true,mixinCalls=0;
    const plugin={version:'2.5.0',install(framework,value){installCalls++;correctThis=correctThis&&this===plugin;return value;}};
    const nativeInstall=plugin.install,exports={},module={exports};
    const framework={mixin(value){mixinCalls++;this.mixinObject=value;}};
    const restore=hooks.hookWebpack(),firstWrapper=Function.prototype.call;
    const idempotent=hooks.hookWebpack()===restore&&Function.prototype.call===firstWrapper;
    const factoryResult=(function(mod){mod.exports.a=plugin;return 91;}).call(exports,module);
    const restoredCall=Function.prototype.call===nativeCall,wrappedInstall=plugin.install!==nativeInstall;
    const installResult=plugin.install(framework,42);plugin.install(framework,43);
    const component={$el:{}};framework.mixinObject.mounted.call(component);
    const componentExposed=component.$el.__Ivue__===component;
    restore();restore();
    JSON.stringify({idempotent,factoryResult,restoredCall,wrappedInstall,installResult,installCalls,mixinCalls,correctThis,componentExposed,restoredInstall:plugin.install===nativeInstall});
  `);
  assert.deepEqual(JSON.parse(result),{idempotent:true,factoryResult:91,restoredCall:true,wrappedInstall:true,installResult:42,installCalls:2,mixinCalls:1,correctThis:true,componentExposed:true,restoredInstall:true});
});

test('target probing ignores frozen, missing, and mismatched install structures',()=>{
  const h=fixture();h.run('const restore=hooks.hookWebpack();');
  assert.equal(h.run(`(function(){return 1;}).call({a:{version:'2.5.0'}},{exports:{a:{install(){}}}});`),1);
  assert.equal(h.run(`const exp2={a:Object.freeze({version:'2.5.0',install(){}})};(function(){return 2;}).call(exp2,{exports:exp2});`),2);
  assert.equal(h.run(`const exp3={a:{version:'2.5.0'}};(function(){return 3;}).call(exp3,{exports:exp3});`),3);
  h.run('restore();');
});

test('failing optional mixin does not alter plugin install result',()=>{
  const h=fixture();
  assert.equal(h.run(`const restore=hooks.hookWebpack();const plugin={version:'2.5.0',install(){return 77;}},exp={a:plugin};(function(){}).call(exp,{exports:exp});const result=plugin.install({mixin(){throw Error('optional failure');}});restore();result;`),77);
});

test('pagehide restores hooks without overwriting later third-party replacements',()=>{
  const h=fixture();h.run('globalThis.nativeCall=Function.prototype.call;globalThis.nativeTimeout=setTimeout;hooks.hookWebpack();hooks.hookError();');
  h.hide();assert.equal(h.run('Function.prototype.call===nativeCall&&setTimeout===nativeTimeout'),true);
  h.run('globalThis.thirdParty=function(){return 9;};hooks.hookWebpack();Function.prototype.call=thirdParty;');
  h.hide();assert.equal(h.run('Function.prototype.call===thirdParty'),true);
});

test('timer hook is idempotent and preserves native parameters, result and restore',()=>{
  const h=fixture();h.run('globalThis.nativeTimeout=setTimeout;globalThis.nativeInterval=setInterval;globalThis.restore=hooks.hookError();globalThis.timeoutWrapper=setTimeout;');
  assert.equal(h.run('hooks.hookError()===restore&&timeoutWrapper===setTimeout'),true);
  assert.equal(h.run('setTimeout(function(){},12,"argument")'),301);
  assert.equal(h.run('setInterval("sample()",13,"argument")'),302);
  assert.equal(h.nativeTimers[0].args[1],12);assert.equal(h.nativeTimers[0].args[2],'argument');assert.equal(h.nativeTimers[1].args[0],'sample()');
  h.run('restore();restore();');assert.equal(h.run('setTimeout===nativeTimeout&&setInterval===nativeInterval'),true);
});

function xhrFixture(){
  let nextResult=0;
  class FakeXhr{
    constructor(){this.status=200;this.responseType='json';this.events=new Map();this.responseTextReads=0;this.openCalls=[];}
    open(...args){if(args[1]==='throw-native')throw this.nativeError;String(args[1]);this.openCalls.push(args);return ++nextResult;}
    addEventListener(type,callback){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(callback);}
    removeEventListener(type,callback){this.events.get(type)?.delete(callback);}
    dispatch(type){for(const callback of [...(this.events.get(type)||[])])callback();}
    get responseText(){this.responseTextReads++;throw new DOMException('responseText cannot be read for json','InvalidStateError');}
    listenerCount(){return [...this.events.values()].reduce((sum,set)=>sum+set.size,0);}
  }
  const original=FakeXhr.prototype.open,h=fixture({XMLHttpRequest:FakeXhr});return {...h,FakeXhr,original};
}

test('JSON XHR response triggers phases without reading responseText and keeps all open arguments',()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(body,phase)=>phases.push([body,phase]));
  const xhr=new h.FakeXhr();assert.equal(xhr.open('GET','/hasAnswer',true,'user','password'),1);
  assert.deepEqual(xhr.openCalls[0],['GET','/hasAnswer',true,'user','password']);xhr.dispatch('load');
  assert.deepEqual(phases,[[null,'start'],[null,'load']]);assert.equal(xhr.responseTextReads,0);assert.equal(xhr.listenerCount(),0);
  interceptor.dispose();assert.equal(h.FakeXhr.prototype.open,h.original);
});

test('reusing an XHR removes old listeners and handles latest request once',()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases.push(phase));
  const xhr=new h.FakeXhr();xhr.open('GET','/hasAnswer?id=1');xhr.open('GET','/hasAnswer?id=2');xhr.dispatch('load');xhr.dispatch('load');
  assert.deepEqual(phases,['start','start','load']);assert.equal(xhr.listenerCount(),0);interceptor.dispose();
});

test('only latest matching request handles load when separate requests race',()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases.push(phase));
  const first=new h.FakeXhr(),second=new h.FakeXhr();first.open('GET','/hasAnswer?id=1');second.open('GET','/hasAnswer?id=2');first.dispatch('load');second.dispatch('load');
  assert.deepEqual(phases,['start','start','load']);interceptor.dispose();
});

test('shared XHR wrapper permits independent disposal without stacking patches',()=>{
  const h=xhrFixture(),phases1=[],phases2=[];
  const first=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases1.push(phase)),wrapper=h.FakeXhr.prototype.open;
  const second=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases2.push(phase));assert.equal(h.FakeXhr.prototype.open,wrapper);
  const xhr=new h.FakeXhr();xhr.open('GET','/hasAnswer');first.dispose();xhr.dispatch('load');
  assert.deepEqual(phases1,['start']);assert.deepEqual(phases2,['start','load']);assert.equal(h.FakeXhr.prototype.open,wrapper);
  second.dispose();second.dispose();assert.equal(h.FakeXhr.prototype.open,h.original);
});

test('XHR callback errors preserve native return and never throw into load handlers',()=>{
  const h=xhrFixture(),interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],()=>{throw Error('callback failure');});
  const xhr=new h.FakeXhr();assert.equal(xhr.open('GET','/hasAnswer'),1);assert.doesNotThrow(()=>xhr.dispatch('load'));interceptor.dispose();
});

test('XHR native exceptions and URL-object conversions retain native semantics',()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases.push(phase));
  const xhr=new h.FakeXhr(),sentinel={};xhr.nativeError=sentinel;assert.throws(()=>xhr.open('GET','throw-native'),error=>error===sentinel);assert.deepEqual(phases,[]);
  let conversions=0;const url={toString(){conversions++;return '/hasAnswer';}};assert.equal(xhr.open('GET',url),1);assert.equal(conversions,1);assert.deepEqual(phases,[]);interceptor.dispose();
});

for(const event of ['abort','error','timeout','loadend'])test(`XHR ${event} and disposal clean pending listeners`,()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases.push(phase));
  const xhr=new h.FakeXhr();xhr.open('GET','/hasAnswer');xhr.dispatch(event);xhr.dispatch('load');assert.deepEqual(phases,['start']);assert.equal(xhr.listenerCount(),0);
  xhr.open('GET','/hasAnswer');interceptor.dispose();xhr.dispatch('load');assert.deepEqual(phases,['start','start']);assert.equal(xhr.listenerCount(),0);
});

test('nonmatching and HTTP error requests never trigger successful load',()=>{
  const h=xhrFixture(),phases=[],interceptor=new h.hooks.XMLHttpRequestInterceptor(['hasAnswer'],(_body,phase)=>phases.push(phase));
  const xhr=new h.FakeXhr();xhr.open('GET','/unrelated');xhr.dispatch('load');xhr.open('GET','/hasAnswer');xhr.status=500;xhr.dispatch('load');
  assert.deepEqual(phases,['start']);assert.equal(xhr.listenerCount(),0);interceptor.dispose();
});

test('hostname check respects domain boundaries and ignores redirects and userinfo',()=>{
  const h=fixture(),check=h.hooks.isZhsHost;
  for(const hostname of ['zhihuishu.com','www.zhihuishu.com','exam.zhihuishu.com','WWW.ZHIHUISHU.COM.'])assert.equal(check({hostname}),true,hostname);
  for(const hostname of ['evilzhihuishu.com','zhihuishu.com.evil.test','evil.test','zhihuishu.com@evil.test',''])assert.equal(check({hostname}),false,hostname);
  assert.equal(check(new URL('https://portal.example.edu.cn/login?redirect=https://www.zhihuishu.com/')),false);
  assert.equal(check(new URL('https://www.zhihuishu.com@evil.test/')),false);assert.equal(check(null),false);assert.equal(check({get hostname(){throw Error('getter');}}),false);
});
