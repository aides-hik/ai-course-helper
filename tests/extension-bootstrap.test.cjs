'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../extension/bootstrap.js'), 'utf8');
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;});return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = () => {const callbacks=[];return {addListener:fn=>callbacks.push(fn),fire:(...args)=>callbacks.forEach(fn=>fn(...args))};};
async function setup(options={}) {
  const changed=event(), received=event(), disconnected=event();
  const writes=[], network=[], lifecycle={};
  const port={onMessage:received,onDisconnect:disconnected,postMessage:m=>network.push(m),disconnect(){this.closed=true;disconnected.fire();}};
  let connects=0;
  const chrome={storage:{onChanged:changed,local:{get:options.get || (async()=>({})),set:async updates=>{
    writes.push({...updates});
    if (options.set) await options.set(updates,writes.length);
    changed.fire(Object.fromEntries(Object.entries(updates).map(([key,newValue])=>[key,{newValue}])),'local');
  }}},runtime:{id:'fixture-extension',getManifest:()=>({name:'Test',version:'0.9.0'}),sendMessage:options.ready || (async()=>({ok:true})),connect:()=>{connects++;return port;},onMessage:event()}};
  const sandbox={chrome,Vue:{nextTick:async()=>{}},extensionResources:{},document:{body:null},window:{addEventListener:(name,fn)=>lifecycle[name]=fn},console:{error(){}},queueMicrotask,setTimeout,clearTimeout};
  vm.createContext(sandbox);
  const loading=vm.runInContext(`(async()=>{${source}\nreturn {get:GM_getValue,set:GM_setValue,listen:GM_addValueChangeListener,remove:GM_removeValueChangeListener,flush:extensionFlushStorage,request:GM_xmlhttpRequest};})()`,sandbox);
  return {api:await loading,chrome,changed,writes,network,lifecycle,port,received,disconnected,sandbox,connects:()=>connects};
}
test('extension storage preserves newer cached edits when an earlier write echoes back',async()=>{
  const gate=deferred();
  const h=await setup({set:async(_value,index)=>{if(index===1)await gate.promise;}});
  const notices=[];h.api.listen('field',(...args)=>notices.push(args));
  h.api.set('field','first');await tick();h.api.set('field','second');await tick();gate.resolve();
  await h.api.flush();
  assert.equal(h.api.get('field'),'second');assert.equal(notices.length,0);
  assert.deepEqual(h.writes.map(v=>v.field),['first','second']);
  h.changed.fire({field:{newValue:'remote'}},'local');assert.equal(h.api.get('field'),'remote');assert.equal(notices.length,1);
  assert.equal(h.sandbox.GM_getValue,undefined);assert.equal(h.sandbox.GM_setValue,undefined);
});
test('save barrier includes writes queued while an earlier write is still pending',async()=>{
  const first=deferred(),second=deferred();
  const h=await setup({set:async(_value,index)=>{await(index===1?first:second).promise;}});
  h.api.set('model','one');await tick();let complete=false;const saved=h.api.flush().then(()=>complete=true);
  await tick();h.api.set('key','two');await tick();first.resolve();await tick();assert.equal(complete,false);
  second.resolve();await saved;assert.equal(complete,true);assert.equal(h.writes.length,2);
});
test('an earlier remote change does not replace a local write waiting to commit',async()=>{
  const gate=deferred();const h=await setup({set:async()=>gate.promise});let notices=0;h.api.listen('key',()=>notices++);
  h.api.set('key','local-newer');await tick();h.changed.fire({key:{newValue:'remote-older'}},'local');
  assert.equal(h.api.get('key'),'local-newer');assert.equal(notices,0);gate.resolve();await h.api.flush();
  h.changed.fire({key:{newValue:'remote-after-save'}},'local');assert.equal(h.api.get('key'),'remote-after-save');assert.equal(notices,1);
});
test('failed configuration writes reject the save barrier and can be retried',async()=>{
  const h=await setup({set:async(_value,index)=>{if(index===1)throw Error('quota fixture');}});
  h.api.set('model','unsaved');await assert.rejects(h.api.flush(),/配置尚未保存/);
  assert.equal(h.api.get('model'),'unsaved');await h.api.flush();assert.equal(h.writes.length,2);
});
test('request cancelled during network startup never starts a remote request',async()=>{
  const gate=deferred();const h=await setup({ready:()=>gate.promise});let aborted=0;
  const request=h.api.request({url:'https://fixture.test/models',timeout:5000,onabort:()=>aborted++});await tick();request.abort();gate.resolve({ok:true});await tick();
  assert.equal(aborted,1);assert.equal(h.network.length,0);
});
test('requests reuse the native port, route responses by id, and cancel on BFCache entry',async()=>{
  const h=await setup();const loaded=[];let aborts=0;
  h.api.request({url:'https://fixture.test/a',timeout:5000,onload:r=>loaded.push(r.status)});
  h.api.request({url:'https://fixture.test/b',timeout:5000,onabort:()=>aborts++});await tick();
  assert.equal(h.connects(),1);const sent=h.network.filter(m=>m.type==='request');assert.equal(sent.length,2);
  h.received.fire({type:'response',id:sent[0].id,response:{status:200}});assert.deepEqual(loaded,[200]);
  h.lifecycle.pagehide({persisted:true});assert.equal(aborts,1);assert.equal(h.port.closed,true);
  assert.ok(h.network.some(m=>m.type==='abort'&&m.id===sent[1].id));
});
