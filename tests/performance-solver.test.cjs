'use strict';
// Count real identity traversals rather than relying on noisy wall-clock limits.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {setMaxListeners} = require('node:events');
const root = path.resolve(__dirname, '..');
const currentSource = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const baselineRef = 'v0.9.2';
let baselineSource;
try {baselineSource = execFileSync('git', ['show', baselineRef + ':ai-integration.js'], {cwd: root, encoding: 'utf8', stdio:['ignore','pipe','ignore']});}
catch { /* Source archives and shallow CI clones may not contain old tags. */ }
const adapter = fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const controls = adapter.slice(adapter.indexOf('  const aiControlVisible = '), adapter.indexOf('  const aiBlankCount = '));
const fieldSelector = 'input, textarea, [contenteditable="true"]';
const turn = () => new Promise(resolve => setImmediate(resolve));
class FixtureAbortController extends AbortController {
  constructor() {super(); setMaxListeners(0, this.signal);}
}
function textQuestion(index, answered = false) {
  const titleNode = {tagName:'H3', childNodes:[{nodeType:3,nodeValue:`Question ${index}`}], getAttribute:()=>null};
  const field = {tagName:'INPUT', name:`field-${index}`, value:answered ? `answer-${index}` : '', isConnected:true,
    getAttribute:name=>name === 'type' ? 'text' : null, matches:()=>false, dispatchEvent(){}};
  const element = {isConnected:true, getAttribute:()=>null, querySelector:()=>titleNode,
    querySelectorAll:selector=>selector === fieldSelector ? [field] : []};
  return {title:`Question ${index}`, titleNode, type:'2', answer:[], options:{}, element, field};
}
function harness(source, entries, overrides={}) {
  const metrics={stamps:0, identities:0}, timers=new Map(), rows=[], requests=[];
  const config={ai:{provider:'openai',apiKey:'FAKE-PERFORMANCE-KEY',concurrentEnabled:true,concurrency:entries.length},
    otherParams:{params:[{value:0}]},platformParams:{zhs:{parts:[{params:[{value:false}]}]}}};
  let timerId=0;
  const instrumented=source
    .replace('const aiQuestionStamp = (question) => {','const aiQuestionStamp = (question) => { __metrics.stamps++;')
    .replace('const aiQuestionControlIdentity = (question, pageWindow = question.element?.ownerDocument?.defaultView) => {','const aiQuestionControlIdentity = (question, pageWindow = question.element?.ownerDocument?.defaultView) => { __metrics.identities++;');
  const pageWindow={Event:class {constructor(type){this.type=type;}}};
  const sandbox=vm.createContext({__metrics:metrics,AbortController:FixtureAbortController,
    window:{location:{href:'https://fixture.chaoxing.com/mooc2/work/dowork'}},
    setInterval(fn){timers.set(++timerId,fn);return timerId;},clearInterval:id=>timers.delete(id),
    vue:{reactive:value=>value},useConfigStore:()=>config,aiConcurrencyLimit:()=>config.ai.concurrency,
    sleep:async()=>{},aiWaitForDelay:async(_seconds,current)=>current.isCurrent(),
    getAnswer:(question,context)=>{requests.push({question,context});return new Promise(()=>{});},
    getAnswerValues:answer=>answer.values,...overrides});
  vm.runInContext(controls+instrumented+'\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers};',sandbox);
  const handler={_window:pageWindow,parseHtml(){this.questions=entries;},addQuestion:row=>rows.push(row),addLog(){},
    fillQuestion:(question,isCurrent)=>sandbox.api.apply(question,pageWindow,'zy',(options,value)=>options[value],isCurrent)};
  return {metrics,timers,rows,requests,config,handler,solve:sandbox.api.solve,
    tick(){for(const fn of [...timers.values()])fn();}};
}
async function pendingMetrics(source,count) {
  const entries=Array.from({length:count},(_,index)=>textQuestion(index));
  const h=harness(source,entries), parent=new FixtureAbortController();
  const pending=h.solve(h.handler,{signal:parent.signal});
  assert.equal(h.requests.length,count);
  const startup={...h.metrics}, timerCount=h.timers.size;
  h.metrics.stamps=0;h.metrics.identities=0;h.tick();
  const polling={...h.metrics};
  parent.abort();assert.equal(await pending,0);assert.equal(h.timers.size,0);
  return {startup,timerCount,polling};
}
for(const count of [100,250])test(`${count} waiting questions use one monitor and a linear identity scan per poll`,async()=>{
  const before=baselineSource ? await pendingMetrics(baselineSource,count) : null,after=await pendingMetrics(currentSource,count);
  assert.equal(after.timerCount,1);
  assert.equal(after.polling.stamps,count);
  assert.ok(after.startup.stamps<=10*count,'Startup identity work must stay within a linear budget');
  if(before) {
    assert.equal(before.timerCount,count+1);
    assert.ok(before.polling.stamps>=count*count);
    assert.ok(after.startup.stamps<before.startup.stamps/10);
  }
  console.log('SOLVER_PERFORMANCE',JSON.stringify({count,baselineRef,before,after}));
});
test('a sibling mutation inside the first choice click stops the next click synchronously',async()=>{
  const sibling=textQuestion(1);
  let clicks=0;
  const options={};
  for(const label of ['first','second']) {
    const input={tagName:'INPUT',type:'checkbox',checked:false,isConnected:true,getAttribute:name=>name==='type'?'checkbox':null,matches:()=>false};
    options[label]={tagName:'LABEL',isConnected:true,childNodes:[{nodeType:3,nodeValue:label}],getAttribute:()=>null,
      matches:()=>false,querySelector:()=>input,querySelectorAll:()=>[input],click(){clicks++;input.checked=true;if(label==='first')sibling.titleNode.childNodes[0].nodeValue='A different sibling question';}};
  }
  const first={...textQuestion(0),type:'1',options,answer:[]};
  const h=harness(currentSource,[first,sibling],{getAnswer:async()=>({values:['first','second']})});
  h.config.ai.concurrency=1;
  assert.equal(await h.solve(h.handler),0);
  assert.equal(clicks,1);
  assert.equal(h.handler.lastSolveResult.cancelled,true);
  assert.equal(h.timers.size,0);
});
test('completed batches retain live full validation after all monitor timers are disposed',async()=>{
  const entries=Array.from({length:30},(_,index)=>textQuestion(index,true));
  const h=harness(currentSource,entries);
  assert.equal(await h.solve(h.handler),100);assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);
  assert.equal(h.handler.lastSolveResult.verifyFilled(),true);
  entries[29].titleNode.childNodes[0].nodeValue='Replaced last question';
  assert.equal(h.handler.lastSolveResult.isCurrent(),false);
  assert.equal(h.handler.lastSolveResult.verifyFilled(),false);
});
