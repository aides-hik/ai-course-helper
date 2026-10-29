'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const directory=__dirname;
const root=path.resolve(directory,'..');
const optimized=fs.readFileSync(path.join(root,'chapter-logic.js'),'utf8');
// Keep the baseline tied to the published 0.9.2 commit, not a moving HEAD.
let baseline=null;
try {
  baseline=execFileSync('git',['show','e4530aaa5759ffca96cea46c5d597431c96c15ce:chapter-logic.js'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
} catch { /* Source ZIPs and shallow checkouts can still verify the new bounds. */ }
const fixtureFile=fs.readFileSync(path.join(directory,'chapter-completion.test.cjs'),'utf8');
const fixtures=fixtureFile.slice(0,fixtureFile.indexOf('\ntest('))
  .replace(/^const source = .*;$/m,'const source = globalThis.__performanceChapterSource;')
  .replace('globalThis.chapter = { isFinishedTask,','globalThis.chapter = { processIframeTask, pauseForBenchmark: () => {currentPage = getChapterPage(); activeScan = {};}, isFinishedTask,');
function fixture(source){
  const sandbox={require,URL,AbortController,__dirname:directory,__performanceChapterSource:source};
  vm.runInNewContext(fixtures+'\nglobalThis.perf={harness,addVideo,addFrame,documentFor,Element};',sandbox);
  const {Element,...api}=sandbox.perf;
  let treeQueries=0;
  const query=Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll=function(selector){if(selector==='iframe'&&this.tagName==='HTML')treeQueries++;return query.call(this,selector);};
  return {...api,queries:()=>treeQueries,reset:()=>{treeQueries=0;}};
}
function pollingCount(source,count){
  const api=fixture(source),h=api.harness();
  for(let index=0;index<count;index++)api.addVideo(h.chapterBody,{finished:true});
  h.pauseForBenchmark();api.reset();
  for(let index=0;index<100;index++)h.processIframeTask();
  return api.queries();
}
test('chapter polling walks a 100-task frame tree once per synchronous scan instead of three times',()=>{
  const before=baseline?pollingCount(baseline,100):null,after=pollingCount(optimized,100);
  assert.equal(after,200);
  if(before!==null)assert.equal(before,600);
  console.log(JSON.stringify({benchmark:'chapter-polling-frame-tree-queries',tasks:100,polls:100,before,after,baselineAvailable:!!baseline,reductionPercent:before===null?null:100*(before-after)/before}));
});
test('completion and diagnostics share one inspection while post-delay checks remain fresh',async()=>{
  async function measured(source){
    const api=fixture(source),h=api.harness();api.addVideo(h.chapterBody,{finished:true});api.reset();
    await h.complete();return {queries:api.queries(),clicks:h.focus.clicks+h.next.clicks};
  }
  const before=baseline?await measured(baseline):null,after=await measured(optimized);
  assert.equal(after.clicks,1);assert.ok(after.queries<=5);
  if(before){assert.equal(before.clicks,1);assert.ok(after.queries<before.queries);}
  const api=fixture(optimized);let task;
  const h=api.harness({wait:async()=>{task.icon.className='ans-job-icon';}});
  task=api.addVideo(h.chapterBody,{finished:true});await h.complete();
  assert.equal(h.focus.clicks+h.next.clicks,0,'revoked platform completion must invalidate the fresh post-delay read');
  console.log(JSON.stringify({benchmark:'chapter-completion-frame-tree-queries',before:before?.queries??null,after:after.queries,baselineAvailable:!!baseline}));
});
function observerHarness(source){
  const api=fixture(source),outer=api.documentFor('https://course.test/mycourse/studentstudy?mooc2=1');
  api.addFrame(outer.body,'https://course.test/mooc-ans/knowledge/cards?id=1');
  const intervals=new Map(),timeouts=new Map(),cleanups=[];let nextId=0,notify,disconnected=false;
  const config={platformParams:{cx:{parts:[{params:[{value:false},{value:false},{value:true}]}]}},otherParams:{params:[{value:0}]}};
  const sandbox={URL,AbortController,document:outer,window:{location:{href:outer.URL}},Date:{now:()=>2000},
    useConfigStore:()=>config,useLogStore:()=>({addLog(){}}),useQuestionStore:()=>({clearQuestion(){}}),
    setInterval:(fn,delay)=>{const id=++nextId;intervals.set(id,{fn,delay});return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,delay)=>{const id=++nextId;timeouts.set(id,{fn,delay});return id;},clearTimeout:id=>timeouts.delete(id),
    MutationObserver:class{constructor(fn){notify=fn;}observe(){}disconnect(){disconnected=true;}},
    vue:{onBeforeUnmount:fn=>cleanups.push(fn)},concatMap:fn=>fn,rxjs:{from:()=>({pipe:()=>({subscribe(){}})})}};
  vm.runInNewContext(source+'\nuseCxChapterLogic();',sandbox);api.reset();
  return {...api,notify:()=>notify([]),intervals,timeouts,dispose:()=>cleanups.forEach(fn=>fn()),disconnected:()=>disconnected,
    flush(){for(const [id,timer] of [...timeouts]){timeouts.delete(id);timer.fn();}}};
}
test('one hundred mutation notifications schedule one scan and retain the 500ms fallback',()=>{
  const before=baseline?observerHarness(baseline):null,after=observerHarness(optimized);
  for(let index=0;index<100;index++){before?.notify();after.notify();}
  if(before)assert.equal(before.queries(),600);
  assert.equal(after.queries(),0);assert.equal(after.timeouts.size,1);
  assert.deepEqual([...after.timeouts.values()].map(timer=>timer.delay),[25]);
  after.flush();assert.equal(after.queries(),2);
  assert.deepEqual([...after.intervals.values()].map(timer=>timer.delay),[500]);
  before?.dispose();after.dispose();
  console.log(JSON.stringify({benchmark:'chapter-mutation-frame-tree-queries',notifications:100,before:before?600:null,after:2,baselineAvailable:!!baseline}));
});
test('a poll cancels redundant queued mutation work and unmount prevents delayed scans',()=>{
  const h=observerHarness(optimized);h.notify();assert.equal(h.timeouts.size,1);
  [...h.intervals.values()][0].fn();assert.equal(h.timeouts.size,0);assert.equal(h.queries(),2);
  h.notify();const deferred=[...h.timeouts.values()][0].fn;
  h.dispose();assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);assert.equal(h.disconnected(),true);
  const before=h.queries();deferred();h.notify();assert.equal(h.queries(),before);assert.equal(h.timeouts.size,0);
});
