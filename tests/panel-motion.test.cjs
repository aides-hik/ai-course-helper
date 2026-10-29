'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../panel-motion.js'),'utf8');
function fixture(geometry=false){
 const animations=[],listeners=new Map(),mediaListeners=new Map();let styleReads=0;
 const media={matches:false,addEventListener:(name,fn)=>mediaListeners.set(name,fn),removeEventListener:name=>mediaListeners.delete(name)};
 const target={style:{willChange:''},animate(frames,timing){const a={frames,timing,cancelled:false,cancel(){this.cancelled=true;this.oncancel?.();}};animations.push(a);return a;}};
 const root={dataset:{},querySelector:()=>target};
 const nodes={};let tick=()=>{};
 if(geometry){
  for(const name of ['surface','body','inner'])nodes[name]={style:{},height:0,getBoundingClientRect(){return {height:this.height};},animate:target.animate};
  nodes.surface.height=600;nodes.body.height=530;nodes.inner.height=513;
  root.querySelector=selector=>({'.ai-glass-surface':nodes.surface,'.el-card__body':nodes.body,'.ai-body-content':nodes.inner}[selector]||target);
 }
 const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const sandbox=vm.createContext({window:{matchMedia:()=>media},document,getComputedStyle:()=>{styleReads++;return {opacity:'.9',transform:'matrix(1,0,0,1,2,0)'};}});
 vm.runInContext(source+'\nglobalThis.create=createPanelMotion;',sandbox);
 const api=sandbox.create({element:()=>root,nextTick:async()=>tick()});
 return {api,root,target,nodes,animations,media,document,listeners,mediaListeners,styleReads:()=>styleReads,onTick:fn=>tick=fn};
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
test('collapse uses a single clipped height source without scaling the shell or text',async()=>{
 const h=fixture(true);h.onTick(()=>{h.nodes.surface.height=100;h.nodes.body.height=30;});
 await h.api.resize('.note',{duration:180});
 assert.equal(h.animations.length,2);
 assert.equal(h.animations[0].frames[0].height,'530px');assert.equal(h.animations[0].frames[1].height,'30px');
 assert.equal(h.nodes.body.style.overflow,'hidden');
 for(const [index,animation] of h.animations.entries()){
  const allowed=index===0?['height']:['offset','transform','opacity'];
  assert.ok(animation.frames.every(f=>Object.keys(f).every(k=>allowed.includes(k))));
  animation.onfinish();
 }
 assert.equal(h.nodes.surface.style.willChange,undefined);assert.equal(h.nodes.inner.style.willChange,undefined);
 assert.equal(h.nodes.body.style.overflow,'');assert.equal(h.root.dataset.aiMotion,undefined);
});
test('reverse transitions capture the current visible size and stale callbacks cannot clear the new group',async()=>{
 const h=fixture(true);h.onTick(()=>{h.nodes.surface.height=100;h.nodes.body.height=30;});
 await h.api.resize('.note');const old=[...h.animations];
 h.nodes.surface.height=350;h.nodes.body.height=280;
 h.onTick(()=>{h.nodes.surface.height=600;h.nodes.body.height=530;});
 await h.api.resize('.content',{duration:220});
 assert.equal(h.animations[2].frames[0].height,'280px');assert.equal(h.animations[2].frames[1].height,'530px');
 assert.ok(old.every(a=>a.cancelled));old.forEach(a=>a.onfinish());
 assert.equal(h.root.dataset.aiMotion,'true');assert.equal(h.nodes.body.style.overflow,'hidden');
 h.api.cancel();assert.equal(h.nodes.body.style.overflow,'');assert.equal(h.nodes.inner.style.transformOrigin,undefined);
});
test('reduced-motion shell changes use opacity only and pending state changes are coalesced',async()=>{
 const h=fixture(true);h.media.matches=true;h.onTick(()=>{h.nodes.surface.height=100;h.nodes.body.height=30;});
 await h.api.resize('.note');assert.equal(h.animations.length,1);assert.equal(h.animations[0].timing.duration,80);
 assert.ok(h.animations[0].frames.every(f=>!('transform' in f)));assert.equal(h.nodes.body.style.overflow,undefined);
 h.api.cancel();h.media.matches=false;
 const a=h.api.resize('.content');const b=h.api.resize('.note');await Promise.all([a,b]);
 assert.equal(h.animations.length,2,'Only the most recent pending change should animate');
});
