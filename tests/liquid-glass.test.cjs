"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../liquid-glass.js'),'utf8');
function harness(options={}) {
 const listeners=new Map(),documentListeners=new Map(),timers=new Map(),frames=new Map(),decoders=[],observers=[],canvases=[];
 let timerId=0,canvasCount=0;
 const style=()=>{const values=new Map();return {writes:[],setProperty(k,v){this.writes.push([k,v]);values.set(k,v);},removeProperty(k){this.writes.push([k,null]);values.delete(k);},getPropertyValue:k=>values.get(k)||''};};
 class Node {
  constructor(tag){this.tagName=tag;this.attributes=new Map();this.attributeWrites=[];this.style=style();this.children=[];this.parentElement=null;this.isConnected=true;}
  setAttribute(name,value){this.attributeWrites.push([name,value]);this.attributes.set(name,value);}
  getAttribute(name){return this.attributes.get(name)??null;}
  append(...items){for(const item of items)this.appendChild(item);}
  appendChild(node){node.parentElement=this;node.isConnected=true;this.children.push(node);return node;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(v=>v!==this);this.parentElement=null;this.isConnected=false;}
 }
 const root=new Node('root'),mount=new Node('mount'),panel=new Node('panel');root.appendChild(mount);mount.appendChild(panel);panel.setAttribute('class','main-page');
 let card,surface;
 const makeCard=()=>{card=new Node('card');panel.appendChild(card);card.closest=()=>panel;if(options.surface){surface=new Node('surface');surface.closest=()=>panel;card.appendChild(surface);}else surface=card;};makeCard();
 mount.getRootNode=()=>root;mount.querySelector=selector=>selector==='.ai-glass-surface'?(options.surface&&surface.isConnected?surface:null):card.isConnected?card:null;
 class Mutation {
  constructor(fn){this.fn=fn;this.targets=[];this.active=true;observers.push(this);}
  observe(target,settings){this.active=true;this.targets.push({target,settings});}
  disconnect(){this.active=false;this.targets=[];}
  trigger(){if(this.active)this.fn([]);}
 }
 const query={matches:!!options.reduced,addEventListener:(_name,fn)=>query.listener=fn,removeEventListener:()=>query.listener=null};
 const document={hidden:!!options.hidden,createElementNS:(_ns,name)=>new Node(name),createElement(name){
  assert.equal(name,'canvas');const canvas=new Node(name);canvases.push(canvas);
  canvas.getContext=()=>({createLinearGradient:()=>({addColorStop(){}}),fillRect(){},beginPath(){},roundRect(){},fill(){}});
  canvas.toDataURL=()=>{canvasCount++;return 'data:image/png;base64,fixture-'+canvasCount;};return canvas;
 },addEventListener:(name,fn)=>documentListeners.set(name,fn),removeEventListener:name=>documentListeners.delete(name)};
 class Image {decode(){return new Promise((resolve,reject)=>decoders.push({resolve,reject}));}}
 const window={Image,requestAnimationFrame(fn){frames.set(++timerId,fn);return timerId;},cancelAnimationFrame:id=>frames.delete(id),matchMedia:()=>query,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const context=vm.createContext({window,document,navigator:{userAgent:options.safari?'Version/17 Safari':'Chrome'},CSS:{supports:()=>options.supported!==false},MutationObserver:Mutation,
 setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source+'\nglobalThis.attach=attachLiquidGlass;',context);const dispose=context.attach(mount);
 const nodes=tag=>{const visit=node=>[...(node.tagName===tag?[node]:[]),...node.children.flatMap(visit)];return visit(root);};
 const flush=()=>{let turns=0;while(timers.size){if(++turns>10)throw Error('Timer loop');const current=[...timers.values()];timers.clear();current.forEach(fn=>fn());}};
 return {root,mount,panel,document,window,query,observers,timers,frames,decoders,canvases,dispose,flush,nodes,get card(){return card;},get surface(){return surface;},draws:()=>canvasCount,
 async decode(){decoders.shift()?.resolve();await Promise.resolve();await Promise.resolve();},
 async reject(){decoders.shift()?.reject(Error('decode failed'));await Promise.resolve();await Promise.resolve();},
 frame(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());},
 async ready(){this.flush();await this.decode();this.frame();this.frame();},
 busy(name,value){panel.setAttribute(name,value?'true':'false');for(const observer of observers)if(observer.targets.some(v=>v.target===panel&&v.settings.attributes))observer.trigger();},
 resize(width,height){card.offsetWidth=width;card.offsetHeight=height;surface.offsetWidth=width;surface.offsetHeight=height;},
 visibility(hidden){document.hidden=hidden;documentListeners.get('visibilitychange')?.();},
 pagehide(persisted){listeners.get('pagehide')?.({persisted});},pageshow(){listeners.get('pageshow')?.({persisted:true});},
 replace(){const previous=surface;surface.isConnected=false;card.remove();makeCard();for(const observer of [...observers])if(observer.targets.some(v=>v.settings.childList))observer.trigger();return previous;}
 };
}
const value=h=>h.surface.style.getPropertyValue('--ai-glass-edge-filter');
test('optical image is decoded and warmed before the CSS filter is exposed',async()=>{
 const h=harness({surface:true});h.flush();assert.equal(h.draws(),1);assert.equal(value(h),'');assert.equal(h.nodes('svg').length,0);
 assert.equal(h.canvases[0].width,384);assert.equal(h.canvases[0].height,384);
 await h.decode();assert.equal(value(h),'');assert.equal(h.nodes('feDisplacementMap').length,1);assert.equal(h.nodes('feColorMatrix').length,0);assert.equal(h.nodes('feBlend').length,0);
 const image=h.nodes('feImage')[0];assert.equal(image.getAttribute('width'),'100%');assert.equal(image.getAttribute('height'),'100%');
 h.frame();assert.equal(value(h),'');h.frame();assert.match(value(h),/url\(#course-helper-glass-/);assert.equal(h.card.style.getPropertyValue('--ai-glass-edge-filter'),'');
 assert.ok(h.observers.every(observer=>observer.targets.every(target=>!target.settings.subtree)));
});
test('hundreds of tab, drag and resize changes keep the loaded map and filter graph unchanged',async()=>{
 const h=harness();await h.ready();const image=h.nodes('feImage')[0],svg=h.nodes('svg')[0],initial=value(h);
 const writes=image.attributeWrites.length,styleWrites=h.surface.style.writes.length;
 for(let i=0;i<200;i++){h.busy('data-ai-motion',true);h.resize(304+i%92,110+i*3);h.busy('data-ai-dragging',true);h.busy('data-ai-motion',false);h.busy('data-ai-dragging',false);h.flush();}
 assert.equal(h.draws(),1);assert.equal(h.nodes('feImage')[0],image);assert.equal(h.nodes('svg')[0],svg);
 assert.equal(image.attributeWrites.length,writes);assert.equal(h.surface.style.writes.length,styleWrites);assert.equal(value(h),initial);assert.equal(h.timers.size,0);assert.equal(h.frames.size,0);
});
test('first map work waits until interaction settles and loading while busy remains safe',async()=>{
 const h=harness();h.busy('data-ai-motion',true);h.flush();assert.equal(h.draws(),0);
 h.busy('data-ai-motion',false);h.flush();assert.equal(h.draws(),1);h.busy('data-ai-dragging',true);await h.decode();assert.equal(value(h),'');assert.equal(h.nodes('svg').length,0);
 h.busy('data-ai-dragging',false);h.flush();await Promise.resolve();h.frame();h.frame();assert.match(value(h),/url\(#course-helper-glass-/);assert.equal(h.draws(),1);
});
test('visibility and BFCache preserve the prepared graph and CSS reference on recovery',async()=>{
 const h=harness();await h.ready();const image=h.nodes('feImage')[0],svg=h.nodes('svg')[0],initial=value(h),writes=h.surface.style.writes.length;
 h.visibility(true);h.resize(300,110);h.flush();h.visibility(false);h.flush();h.pagehide(true);h.resize(396,720);h.pageshow();h.flush();
 assert.equal(h.draws(),1);assert.equal(h.nodes('feImage')[0],image);assert.equal(h.nodes('svg')[0],svg);assert.equal(value(h),initial);assert.equal(h.surface.style.writes.length,writes);
 assert.ok(h.observers.every(observer=>observer.targets.every(target=>!target.settings.subtree)));
});
test('reduced transparency defers initial work and toggling it never rebuilds an existing graph',async()=>{
 const h=harness({reduced:true});h.flush();assert.equal(h.draws(),0);assert.equal(h.nodes('svg').length,0);
 h.query.matches=false;h.query.listener();await h.ready();assert.equal(h.draws(),1);
 const image=h.nodes('feImage')[0],initial=value(h);h.query.matches=true;h.query.listener();h.resize(300,100);h.flush();h.query.matches=false;h.query.listener();h.flush();
 assert.equal(h.nodes('feImage')[0],image);assert.equal(h.draws(),1);assert.equal(value(h),initial);
 const hidden=harness({hidden:true});hidden.flush();assert.equal(hidden.draws(),0);hidden.visibility(false);await hidden.ready();assert.equal(hidden.draws(),1);
});
test('surface or legacy card replacement reuses the decoded map and rebinds only direct observers',async()=>{
 for(const surface of [false,true]){const h=harness({surface});await h.ready();const image=h.nodes('feImage')[0],old=h.replace();h.flush();
 assert.equal(h.draws(),1);assert.equal(old.style.getPropertyValue('--ai-glass-edge-filter'),'');assert.match(value(h),/url\(#course-helper-glass-/);assert.equal(h.nodes('feImage')[0],image);
 assert.ok(h.observers.some(observer=>observer.targets.some(target=>target.target===h.panel&&target.settings.childList)));
 assert.ok(h.observers.every(observer=>observer.targets.every(target=>!target.settings.subtree)));}
});
test('decode failure keeps the CSS fallback and disposal prevents late async graph creation',async()=>{
 const failed=harness();failed.flush();await failed.reject();assert.equal(value(failed),'');assert.equal(failed.nodes('svg').length,0);failed.busy('data-ai-motion',false);failed.flush();assert.equal(failed.draws(),1);
 const h=harness();h.flush();h.pagehide(false);await h.decode();assert.equal(value(h),'');assert.equal(h.nodes('svg').length,0);assert.equal(h.timers.size,0);assert.equal(h.query.listener,null);
 assert.ok(h.observers.every(observer=>!observer.active));h.dispose();h.flush();assert.equal(h.draws(),1);
});
test('pause during warmup restarts the bounded warmup and final disposal cancels pending frames',async()=>{
 const h=harness();h.flush();await h.decode();h.frame();assert.equal(h.frames.size,1);h.pagehide(true);assert.equal(h.frames.size,0);assert.equal(value(h),'');h.pageshow();h.frame();h.frame();assert.match(value(h),/url\(#course-helper-glass-/);
 h.dispose();assert.equal(h.nodes('svg').length,0);assert.equal(h.frames.size,0);assert.equal(value(h),'');
});
test('unsupported browsers and disposal before idle preparation allocate no optical map',()=>{
 for(const option of [{supported:false},{safari:true}]){const h=harness(option);h.flush();assert.equal(h.draws(),0);assert.equal(h.nodes('svg').length,0);}
 const h=harness();assert.equal(h.timers.size,1);h.dispose();h.flush();assert.equal(h.draws(),0);assert.equal(h.timers.size,0);
});
