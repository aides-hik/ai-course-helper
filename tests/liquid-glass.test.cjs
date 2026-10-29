'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../liquid-glass.js'),'utf8');
function harness(options={}) {
  const listeners=new Map(),documentListeners=new Map(),timers=new Map(),observers=[],resizers=[],canvases=[];
  let timerId=0,canvasCount=0;
  const style=()=>{const values=new Map();return {setProperty:(k,v)=>values.set(k,v),removeProperty:k=>values.delete(k),getPropertyValue:k=>values.get(k)||''};};
  class Node {
    constructor(tag){this.tagName=tag;this.attributes=new Map();this.style=style();this.children=[];this.parentElement=null;this.isConnected=true;}
    setAttribute(name,value){this.attributes.set(name,value);}
    getAttribute(name){return this.attributes.get(name)??null;}
    append(...items){for(const item of items)this.appendChild(item);}
    appendChild(node){node.parentElement=this;node.isConnected=true;this.children.push(node);return node;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(v=>v!==this);this.parentElement=null;this.isConnected=false;}
  }
  const root=new Node('root'),mount=new Node('mount'),panel=new Node('panel');root.appendChild(mount);mount.appendChild(panel);
  panel.setAttribute('class','main-page');
  let card=new Node('card');card.offsetWidth=396;card.offsetHeight=700;panel.appendChild(card);
  const lookup=()=>card?.isConnected?card:null;
  mount.getRootNode=()=>root;mount.querySelector=lookup;
  card.closest=()=>panel;
  class Mutation {
    constructor(fn){this.fn=fn;this.targets=[];this.active=true;observers.push(this);}
    observe(target,settings){this.active=true;this.targets.push({target,settings});}
    disconnect(){this.active=false;this.targets=[];}
    trigger(){if(this.active)this.fn([]);}
  }
  class Resize {
    constructor(fn){this.fn=fn;this.active=true;resizers.push(this);}
    observe(target){this.active=true;this.target=target;}
    disconnect(){this.active=false;}
    trigger(){if(this.active)this.fn([]);}
  }
  const query={matches:!!options.reduced,addEventListener:(_name,fn)=>query.listener=fn,removeEventListener:()=>query.listener=null};
  const document={hidden:!!options.hidden,createElementNS:(_ns,name)=>new Node(name),createElement(name){
    assert.equal(name,'canvas');const canvas=new Node(name);canvases.push(canvas);
    canvas.getContext=()=>({createLinearGradient:()=>({addColorStop(){}}),fillRect(){},beginPath(){},roundRect(){},fill(){}});
    canvas.toDataURL=()=>{canvasCount++;return 'data:image/png;base64,fixture-'+canvasCount;};return canvas;
  },addEventListener:(name,fn)=>documentListeners.set(name,fn),removeEventListener:name=>documentListeners.delete(name)};
  const window={matchMedia:()=>query,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const context=vm.createContext({window,document,navigator:{userAgent:options.safari?'Version/17 Safari':'Chrome'},CSS:{supports:()=>options.supported!==false},MutationObserver:Mutation,ResizeObserver:Resize,getComputedStyle:()=>({borderTopLeftRadius:'26px'}),
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source+'\nglobalThis.attach=attachLiquidGlass;',context);
  const dispose=context.attach(mount);
  const flush=()=>{let turns=0;while(timers.size){if(++turns>10)throw Error('Timer loop');const current=[...timers.values()];timers.clear();current.forEach(fn=>fn());}};
  return {root,mount,panel,document,window,query,observers,resizers,timers,canvases,dispose,flush,get card(){return card;},draws:()=>canvasCount,
    busy(name,value){panel.setAttribute(name,value?'true':'false');for(const observer of observers)if(observer.targets.some(v=>v.target===panel&&v.settings.attributes))observer.trigger();},
    resize(width,height){card.offsetWidth=width;card.offsetHeight=height;resizers.forEach(observer=>observer.trigger());},
    visibility(hidden){document.hidden=hidden;documentListeners.get('visibilitychange')?.();},
    pagehide(persisted){listeners.get('pagehide')?.({persisted});},pageshow(){listeners.get('pageshow')?.({persisted:true});},
    replace(){const previous=card;previous.remove();card=new Node('card');card.offsetWidth=396;card.offsetHeight=700;card.closest=()=>panel;panel.appendChild(card);for(const observer of [...observers])if(observer.targets.some(v=>v.settings.childList))observer.trigger();return previous;},
    nodes(tag){const visit=node=>[...(node.tagName===tag?[node]:[]),...node.children.flatMap(visit)];return visit(root);}
  };
}
test('glass uses one bounded displacement pass prepared after the initial interaction frame',()=>{
  const h=harness();assert.equal(h.draws(),0);h.flush();assert.equal(h.draws(),1);
  assert.equal(h.nodes('feDisplacementMap').length,1);assert.equal(h.nodes('feColorMatrix').length,0);assert.equal(h.nodes('feBlend').length,0);
  assert.ok(h.canvases[0].width<=384&&h.canvases[0].height<=384);
  assert.match(h.card.style.getPropertyValue('--ai-glass-edge-filter'),/url\(#course-helper-glass-/);
  assert.ok(h.observers.every(observer=>observer.targets.every(target=>!target.settings.subtree)),'Once mounted, no observer watches every UI descendant');
});
test('resize storms during drag and content motion do not regenerate maps',()=>{
  const h=harness();h.flush();h.busy('data-ai-dragging',true);
  for(let i=0;i<100;i++)h.resize(396,600+i);h.flush();assert.equal(h.draws(),1);assert.equal(h.timers.size,0);
  h.busy('data-ai-motion',true);h.busy('data-ai-dragging',false);h.flush();assert.equal(h.draws(),1);
  h.busy('data-ai-motion',false);h.flush();assert.equal(h.draws(),2);
  h.resize(396,699);h.flush();assert.equal(h.draws(),2);
});
test('same sizes reuse bounded LRU maps while old dimensions may be regenerated',()=>{
  const h=harness();h.flush();
  for(const height of [600,700,600]){h.resize(396,height);h.flush();}
  assert.equal(h.draws(),2);
  for(const height of [610,620,630,640,650]){h.resize(396,height);h.flush();}
  const before=h.draws();h.resize(396,600);h.flush();assert.equal(h.draws(),before+1);
  assert.ok(h.canvases.every(canvas=>Math.max(canvas.width,canvas.height)<=384));
});
test('document visibility and transparency preference suspend heavy work and recover without losing glass',()=>{
  const h=harness({hidden:true});h.flush();assert.equal(h.draws(),0);
  h.visibility(false);h.flush();assert.equal(h.draws(),1);h.visibility(true);h.resize(396,500);h.flush();assert.equal(h.draws(),1);
  h.visibility(false);h.flush();assert.equal(h.draws(),2);
  h.query.matches=true;h.query.listener();assert.equal(h.nodes('svg').length,0);assert.equal(h.card.style.getPropertyValue('--ai-glass-edge-filter'),'');
  h.resize(396,500);h.flush();assert.equal(h.draws(),2);h.query.matches=false;h.query.listener();h.flush();assert.equal(h.draws(),2);assert.equal(h.nodes('svg').length,1);
});
test('replacement card rebinds direct observers and reuses the existing dimension cache',()=>{
  const h=harness();h.flush();const old=h.replace();h.flush();assert.equal(h.draws(),1);
  assert.equal(old.style.getPropertyValue('--ai-glass-edge-filter'),'');assert.ok(h.card.style.getPropertyValue('--ai-glass-edge-filter'));
  assert.ok(h.observers.every(observer=>observer.targets.every(target=>!target.settings.subtree)));
});
test('BFCache pause can resume and final disposal clears all observers, callbacks and filter nodes',()=>{
  const h=harness();h.flush();h.pagehide(true);h.resize(396,600);h.flush();assert.equal(h.draws(),1);
  assert.ok(h.resizers.every(observer=>!observer.active));h.pageshow();h.flush();assert.equal(h.draws(),2);
  h.resize(396,610);assert.ok(h.timers.size);h.pagehide(false);assert.equal(h.timers.size,0);assert.equal(h.nodes('svg').length,0);
  assert.ok(h.observers.every(observer=>!observer.active));assert.ok(h.resizers.every(observer=>!observer.active));
  assert.equal(h.query.listener,null);h.dispose();h.flush();assert.equal(h.draws(),2);
});
test('unsupported filter and initially reduced transparency never allocate the expensive filter',()=>{
  const unsupported=harness({supported:false});unsupported.flush();assert.equal(unsupported.draws(),0);assert.equal(unsupported.nodes('svg').length,0);
  const reduced=harness({reduced:true});reduced.flush();assert.equal(reduced.draws(),0);assert.equal(reduced.nodes('svg').length,0);
});
