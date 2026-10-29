'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../panel-motion.js'),'utf8');
function fixture(){
 const animations=[],listeners=new Map(),mediaListeners=new Map();let styleReads=0;
 const media={matches:false,addEventListener:(name,fn)=>mediaListeners.set(name,fn),removeEventListener:name=>mediaListeners.delete(name)};
 const target={style:{willChange:''},animate(frames,timing){const a={frames,timing,cancelled:false,cancel(){this.cancelled=true;this.oncancel?.();}};animations.push(a);return a;}};
 const root={dataset:{},querySelector:()=>target};
 const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const sandbox=vm.createContext({window:{matchMedia:()=>media},document,getComputedStyle:()=>{styleReads++;return {opacity:'.9',transform:'matrix(1,0,0,1,2,0)'};}});
 vm.runInContext(source+'\nglobalThis.create=createPanelMotion;',sandbox);
 const api=sandbox.create({element:()=>root,nextTick:async()=>{}});
 return {api,root,target,animations,media,document,listeners,mediaListeners,styleReads:()=>styleReads};
}
test('content reveal uses compositor properties and releases temporary layer hints',async()=>{
 const h=fixture();await h.api.reveal('.content',{axis:'X',offset:4,duration:140});
 assert.equal(h.styleReads(),0);assert.equal(h.animations[0].timing.duration,140);assert.equal(h.root.dataset.aiMotion,'true');
 assert.equal(h.target.style.willChange,'transform, opacity');
 for(const frame of h.animations[0].frames)assert.ok(Object.keys(frame).every(key=>['transform','opacity'].includes(key)));
 h.animations[0].onfinish();assert.equal(h.target.style.willChange,'');assert.equal(h.root.dataset.aiMotion,undefined);
});
test('rapid reveal retargets from the current state and keeps only one live animation',async()=>{
 const h=fixture();await h.api.reveal('.content');await h.api.reveal('.content',{offset:-4});
 assert.equal(h.styleReads(),1);assert.equal(h.animations[0].cancelled,true);assert.equal(h.animations[1].frames[0].opacity,'.9');
 assert.equal(h.target.style.willChange,'transform, opacity');h.api.cancel();assert.equal(h.animations[1].cancelled,true);assert.equal(h.target.style.willChange,'');
});
test('reduced motion uses a restrained fade and responds to media changes',async()=>{
 const h=fixture();h.media.matches=true;await h.api.reveal('.content');
 assert.equal(h.animations[0].timing.duration,80);assert.ok(h.animations[0].frames.every(frame=>!('transform' in frame)));
 h.mediaListeners.get('change')();assert.equal(h.target.style.willChange,'');assert.equal(h.root.dataset.aiMotion,undefined);
});
test('dragging, hidden pages and disposed views do not start decorative motion',async()=>{
 const h=fixture();h.root.dataset.aiDragging='true';await h.api.reveal('.content');assert.equal(h.animations.length,0);
 delete h.root.dataset.aiDragging;await h.api.reveal('.content');h.document.visibilityState='hidden';h.listeners.get('visibilitychange')();assert.equal(h.animations[0].cancelled,true);
 await h.api.reveal('.content');assert.equal(h.animations.length,1);h.api.dispose();assert.equal(h.listeners.size,0);assert.equal(h.mediaListeners.size,0);
 h.document.visibilityState='visible';await h.api.reveal('.content');assert.equal(h.animations.length,1);
});
