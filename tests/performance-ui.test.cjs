'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const current=fs.readFileSync(path.join(root,'userscript.template.js.in'),'utf8');
let baseline=null;
try {baseline=execFileSync('git',['show','v0.9.2:userscript.template.js.in'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});} catch { /* Shallow clones still verify the optimized behavior. */ }
function dragHarness(source){
  let writes=0;const position={};let x='32px',y='80px';
  Object.defineProperties(position,{x:{get:()=>x,set:value=>{writes++;x=value;}},y:{get:()=>y,set:value=>{writes++;y=value;}}});
  const events=new Map();
  const context=vm.createContext({configStore:{position},vue:{ref:value=>({value})},WINDOW_EDGE_OFFSET:11,PANEL_WIDTH:396,MINIMIZED_PANEL_HEIGHT:88,
    window:{innerWidth:1280,innerHeight:900,addEventListener:(name,fn)=>events.set(name,fn)},document:{addEventListener(){},removeEventListener(){}}});
  const start=source.indexOf('      const isDragging = vue.ref(false);');
  const end=source.indexOf('      vue.onBeforeUnmount(() => {',start);
  assert.ok(start>=0&&end>start);
  vm.runInContext(source.slice(start,end)+'\nglobalThis.dragApi={startDrag,drag,endDrag,moveStyle};',context);
  writes=0;
  return {api:context.dragApi,writes:()=>writes,position,events};
}
test('100 drag updates keep movement immediate but commit position only at release',()=>{
  const run=source=>{const h=dragHarness(source);h.api.startDrag({clientX:40,clientY:90,currentTarget:{getBoundingClientRect:()=>({left:32,top:80})}});for(let i=0;i<100;i++)h.api.drag({clientX:100+i,clientY:150+i});const during=h.writes();h.api.endDrag();return {during,total:h.writes(),position:h.position,style:h.api.moveStyle.value};};
  const before=baseline?run(baseline):null,after=run(current);
  if(before){assert.equal(before.during,200);assert.equal(after.position.x,before.position.x);assert.equal(after.position.y,before.position.y);}
  assert.equal(after.during,0);assert.equal(after.total,2);
  assert.equal(after.style.left,after.position.x);assert.equal(after.style.top,after.position.y);
});
test('losing window focus commits the final drag position and stops movement',()=>{
  const h=dragHarness(current);h.api.startDrag({clientX:0,clientY:0,currentTarget:{getBoundingClientRect:()=>({left:0,top:0})}});h.api.drag({clientX:250,clientY:200});h.events.get('blur')();
  assert.equal(h.writes(),2);const saved=h.position.x;h.api.drag({clientX:400,clientY:200});assert.equal(h.position.x,saved);assert.equal(h.writes(),2);
});
const logs=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'log-presentation.js'),'utf8')+'\nglobalThis.rows=logVisibleRows;',logs);
test('unchanged 500-entry history reuses row projections and immediately invalidates edited entries',()=>{
  const history=Array.from({length:500},(_,index)=>({message:'Event '+index,type:'info',time:'10:00:00'}));
  const first=logs.rows(history,'detail'),second=logs.rows(history,'detail');
  assert.equal(second.filter((row,index)=>row===first[index]).length,500);
  history[250].message='Updated event';const third=logs.rows(history,'detail');
  assert.equal(third.filter((row,index)=>row===second[index]).length,499);assert.equal(third[250].displayMessage,'Updated event');
  assert.equal(third[250].key,second[250].key);
  history.shift();history.push({message:'Newest event',type:'info',time:'10:00:01'});
  const shifted=logs.rows(history,'detail');assert.equal(shifted[0].key,third[1].key);assert.notEqual(shifted.at(-1).key,third.at(-1).key);
});
test('merging repeated brief logs never changes a row already shown by an earlier view',()=>{
  const history=[{message:'event',type:'info',time:'10:00:00'}];const first=logs.rows(history);
  history.push({message:'event',type:'info',time:'10:00:01'});const merged=logs.rows(history);
  assert.equal(first[0].repeat,1);assert.equal(merged[0].repeat,2);assert.equal(logs.rows(history,'detail').length,2);
});
