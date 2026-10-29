'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../panel-interactions.js'),'utf8');
function events(){const map=new Map();return {addEventListener(name,fn){if(!map.has(name))map.set(name,new Set());map.get(name).add(fn);},removeEventListener(name,fn){map.get(name)?.delete(fn);},emit(name,event={}){for(const fn of [...map.get(name)||[]])fn(event);},count:()=>[...map.values()].reduce((count,entries)=>count+entries.size,0)};}
function fixture({mounted=true,raf=true,beforeDrag=()=>{}}={}){
  const frames=new Map(),screen=events(),doc=events(),capture=events(),commits=[],states=[],shields=[];
  let frameId=0,paints=0,transform='',x=32,y=80;
  const style={left:'32px',top:'80px',willChange:'',userSelect:''};
  Object.defineProperty(style,'transform',{get:()=>transform,set:value=>{transform=value;paints++;}});
  const card={style:{height:''},getBoundingClientRect:()=>({height:500})};
  const root={appendChild(node){shields.push(node);}};
  const attrs=new Map();
  const node={isConnected:true,style,getRootNode:()=>root,querySelector:()=>card,getBoundingClientRect:()=>({left:x,top:y,height:500,width:396}),setAttribute:(name,value)=>attrs.set(name,value),removeAttribute:name=>attrs.delete(name)};
  const pointers=new Set();Object.assign(capture,{setPointerCapture:id=>pointers.add(id),hasPointerCapture:id=>pointers.has(id),releasePointerCapture:id=>{pointers.delete(id);capture.emit('lostpointercapture',{pointerId:id});}});
  Object.assign(screen,{innerWidth:1280,innerHeight:900,setTimeout:fn=>{frames.set(++frameId,fn);return frameId;},clearTimeout:id=>frames.delete(id)});
  if(raf)Object.assign(screen,{requestAnimationFrame:screen.setTimeout,cancelAnimationFrame:screen.clearTimeout});
  Object.assign(doc,{createElement:()=>({style:{},setAttribute(){},remove(){this.removed=true;}})});
  const sandbox=vm.createContext({window:screen,document:doc});
  vm.runInContext(source+'\nglobalThis.create=createPanelInteractions;',sandbox);
  let visible=mounted;
  const controller=sandbox.create({element:()=>visible?node:null,initialPosition:()=>({x:x+'px',y:y+'px'}),onCommit:(left,top)=>{commits.push({left,top});x=parseFloat(left);y=parseFloat(top);},onBeforeDrag:()=>beforeDrag({node,card}),onDragState:value=>states.push(value)});
  const mouse=(clientX=70,clientY=110,extra={})=>({clientX,clientY,button:0,currentTarget:capture,...extra});
  const pointer=(pointerId=1,clientX=70,clientY=110,extra={})=>mouse(clientX,clientY,{pointerId,isPrimary:true,...extra});
  return {controller,node,card,attrs,frames,screen,doc,capture,commits,states,shields,pointers,mouse,pointer,paints:()=>paints,
    flush(){const queued=[...frames.values()];frames.clear();for(const fn of queued)fn();},mount(){visible=true;},position:()=>({x,y})};
}
test('a burst of 100 movements paints once per frame without reactive position commits',()=>{
  const h=fixture();h.controller.fit();h.commits.length=0;
  assert.equal(h.controller.startMouseDrag(h.mouse()),true);
  for(let index=1;index<=100;index++)h.doc.emit('mousemove',h.mouse(70+index,110+index));
  assert.equal(h.frames.size,1);assert.equal(h.paints(),0);assert.equal(h.commits.length,0);assert.equal(h.node.style.left,'32px');assert.equal(h.node.style.top,'80px');
  h.flush();assert.equal(h.paints(),1);assert.equal(h.node.style.transform,'translate3d(100px,100px,0)');assert.equal(h.commits.length,0);
  h.doc.emit('mouseup',h.mouse());assert.equal(h.node.style.left,'132px');assert.equal(h.node.style.top,'180px');assert.equal(h.node.style.transform,'');assert.equal(h.node.style.willChange,'');
  assert.deepEqual(h.commits,[{left:'132px',top:'180px'}]);assert.equal(h.doc.count(),0);assert.equal(h.shields[0].removed,true);assert.equal(h.card.style.height,'');assert.equal(h.attrs.has('data-ai-dragging'),false);
});
test('release commits the last queued point even before the next animation frame',()=>{
  const h=fixture();h.controller.startMouseDrag(h.mouse());h.doc.emit('mousemove',h.mouse(300,400));
  h.doc.emit('mouseup',h.mouse());assert.equal(h.frames.size,0);assert.equal(h.node.style.left,'262px');assert.equal(h.node.style.top,'370px');assert.equal(h.node.style.transform,'');assert.equal(h.commits.length,1);
});
test('pointer capture retains one pointer and ignores synthetic mouse compatibility events',()=>{
  const h=fixture();assert.equal(h.controller.startPointerDrag(h.pointer(4)),true);assert.equal(h.pointers.has(4),true);
  assert.equal(h.controller.startMouseDrag(h.mouse()),false);assert.equal(h.controller.startPointerDrag(h.pointer(5)),false);
  h.doc.emit('pointermove',h.pointer(5,900,900));assert.equal(h.frames.size,0);
  h.doc.emit('pointermove',h.pointer(4,120,170));h.flush();assert.equal(h.node.style.transform,'translate3d(50px,60px,0)');
  h.doc.emit('pointerup',h.pointer(5));assert.equal(h.commits.length,0);
  h.doc.emit('pointerup',h.pointer(4));assert.equal(h.commits.length,1);assert.equal(h.pointers.size,0);assert.equal(h.capture.count(),0);
});
test('cancellation, lost capture, blur and pagehide all flush and release resources',()=>{
  for(const mode of ['pointercancel','lostpointercapture','blur','pagehide']){
    const h=fixture();h.controller.startPointerDrag(h.pointer(7));h.doc.emit('pointermove',h.pointer(7,120,150));
    if(mode==='lostpointercapture')h.capture.emit(mode,{pointerId:7});else if(mode==='pointercancel')h.doc.emit(mode,{pointerId:7});else h.screen.emit(mode);
    assert.equal(h.commits.length,1,mode);assert.equal(h.frames.size,0,mode);assert.equal(h.doc.count(),0,mode);assert.equal(h.attrs.has('data-ai-dragging'),false,mode);
  }
});
test('fitting works before mount and resize during a drag clamps the final position',()=>{
  const h=fixture({mounted:false});h.screen.innerWidth=320;h.screen.innerHeight=400;h.controller.fit();assert.deepEqual(h.commits,[{left:'8px',top:'80px'}]);
  h.mount();h.controller.startMouseDrag(h.mouse());h.doc.emit('mousemove',h.mouse(9999,9999));h.screen.innerHeight=300;h.screen.emit('resize');
  assert.equal(h.node.style.left,'8px');assert.equal(h.node.style.top,'212px');assert.equal(h.commits.length,2);assert.equal(h.frames.size,0);
});
test('right clicks, secondary pointers, interactive controls and detached panels cannot start a drag',()=>{
  const h=fixture();assert.equal(h.controller.startMouseDrag(h.mouse(70,110,{button:2})),false);assert.equal(h.controller.startPointerDrag(h.pointer(3,70,110,{isPrimary:false})),false);
  assert.equal(h.controller.startMouseDrag(h.mouse(70,110,{target:{closest:()=>({})}})),false);h.node.isConnected=false;assert.equal(h.controller.startMouseDrag(h.mouse()),false);assert.equal(h.shields.length,0);
});
test('the pointer grip stays in place at start and disposal is idempotent',()=>{
  const h=fixture({raf:false});h.controller.startMouseDrag(h.mouse());assert.equal(h.node.style.left,'32px');assert.equal(h.node.style.top,'80px');assert.equal(h.paints(),0);
  h.doc.emit('mousemove',h.mouse(80,120));h.controller.dispose();h.controller.dispose();assert.equal(h.commits.length,1);assert.equal(h.screen.count(),0);assert.equal(h.doc.count(),0);assert.equal(h.frames.size,0);assert.equal(h.controller.startMouseDrag(h.mouse()),false);
});
test('a size transition finishes before the drag freezes its geometry',()=>{
  let beforeCalls=0;
  const h=fixture({beforeDrag:({card})=>{beforeCalls++;card.getBoundingClientRect=()=>({height:600});}});
  h.card.getBoundingClientRect=()=>({height:200});
  h.controller.startMouseDrag(h.mouse(70,110,{target:{closest:()=>({})}}));assert.equal(beforeCalls,0,'Interactive controls do not cancel an unrelated transition');
  h.controller.startMouseDrag(h.mouse());assert.equal(beforeCalls,1);assert.equal(h.card.style.height,'600px');
  h.controller.endDrag();assert.equal(h.card.style.height,'');
});
