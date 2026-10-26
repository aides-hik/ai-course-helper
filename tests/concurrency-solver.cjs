'use strict';
// Offline behavioral tests for bounded inference, serialized writes and cancellation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const integration = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const helpers = adapter.slice(adapter.indexOf('  const aiControlVisible = '), adapter.indexOf('  const aiBlankCount = '));
const fieldSelector = 'input, textarea, [contenteditable="true"]';
const pageWindow = {Event: class {constructor(type) {this.type = type;}}};
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function flush() {await turn(); await turn();}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function field(name, value = '') {
  return {tagName:'INPUT', name, value, isConnected:true,
    getAttribute:(attribute)=>attribute === 'type' ? 'text' : null,
    matches:()=>false, dispatchEvent(){}};
}
function question(index, values = ['']) {
  const title = `Question ${index}`, fields = values.map((value, slot)=>field(`${index}-${slot}`,value));
  const titleNode = {tagName:'H3', childNodes:[{nodeType:3,nodeValue:title}], getAttribute:()=>null};
  const entry = {title, fields, type:'2', answer:[], options:{}, expected:fields.map((_, slot)=>`answer:${index}-${slot}`)};
  entry.element = {isConnected:true,getAttribute:()=>null,querySelector:()=>titleNode,
    querySelectorAll:(selector)=>selector === fieldSelector ? entry.fields : []};
  return entry;
}
const answer = (entry) => ({values:entry.expected,meta:{model:'offline',usage:{total_tokens:0}}});
function harness(entries, overrides = {}) {
  const config = {ai:{concurrentEnabled:true,concurrency:3},otherParams:{params:[{value:0}]},
    platformParams:{zhs:{parts:[{params:[{value:false}]}]}}};
  const intervals = new Map(), rows = [], logs = [];
  let nextTimer = 1;
  const context = vm.createContext({AbortController,
    window:{location:{href:'https://example.chaoxing.com/work'}},
    setInterval(callback){const id=nextTimer++;intervals.set(id,callback);return id;},
    clearInterval:(id)=>intervals.delete(id),
    vue:{reactive:(entry)=>entry},useConfigStore:()=>config,
    aiConcurrencyLimit:()=>config.ai.concurrentEnabled ? config.ai.concurrency : 1,
    sleep:async()=>{},aiWaitForDelay:async(_seconds,current)=>current.isCurrent(),
    getAnswer:async(entry)=>answer(entry),getAnswerValues:(response)=>response.values,
    ...overrides});
  vm.runInContext(helpers + integration + '\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers,read:aiReadExistingAnswer};',context);
  const handler = {_window:pageWindow,parseHtml(){this.questions=entries;},
    addQuestion:(entry)=>rows.push(entry),addLog:(message)=>logs.push(message),
    fillQuestion:(entry,current)=>context.api.apply(entry,pageWindow,'zy',(options,value)=>options[value],current)};
  return {...context.api,handler,config,rows,logs,intervals,
    tick(){for (const callback of [...intervals.values()]) callback();}};
}

test('bounded requests overlap, out-of-order replies stay on their own row, and writes stay serial',async()=>{
  const entries=Array.from({length:5},(_,index)=>question(index));
  const pending=new Map(),requests=[];
  let activeRequests=0,peakRequests=0,activeFills=0,peakFills=0,finished=false;
  const api=harness(entries,{getAnswer:(entry)=>{
    requests.push(entry.title);activeRequests++;peakRequests=Math.max(peakRequests,activeRequests);
    const gate=deferred();pending.set(entry.title,gate);
    return gate.promise.finally(()=>{activeRequests--;});
  }});
  api.config.ai.concurrency=2;
  const fill=api.handler.fillQuestion;
  api.handler.fillQuestion=async(...args)=>{
    activeFills++;peakFills=Math.max(peakFills,activeFills);
    await turn();
    try{return await fill(...args);}finally{activeFills--;}
  };
  const result=api.solve(api.handler).then((rate)=>{finished=true;return rate;});
  assert.deepEqual(requests,['Question 0','Question 1']);
  assert.deepEqual(api.rows.map((entry)=>entry.title),entries.map((entry)=>entry.title));
  pending.get('Question 1').resolve(answer(entries[1]));await flush();
  assert.equal(entries[1].fields[0].value,'answer:1-0');
  assert.equal(requests.length,3);
  pending.get('Question 2').resolve(answer(entries[2]));await flush();
  pending.get('Question 0').resolve(answer(entries[0]));await flush();
  assert.equal(requests.length,5);
  pending.get('Question 4').resolve(answer(entries[4]));await flush();
  assert.equal(finished,false,'the unresolved last request must keep solve pending');
  pending.get('Question 3').resolve(answer(entries[3]));
  assert.equal(await result,100);
  assert.equal(peakRequests,2);assert.equal(peakFills,1);
  assert.equal(activeRequests,0);assert.equal(activeFills,0);
  assert.ok(entries.every((entry)=>entry.fields[0].value===entry.expected[0]));
  assert.equal(api.handler.lastSolveResult.verifyFilled(),true);
  assert.equal(api.intervals.size,0);
});

test('fill promises are included in solve completion even after every reply has arrived',async()=>{
  const entries=[question(0),question(1)],gates=[deferred(),deferred()];
  const api=harness(entries);
  let fills=0,settled=false;
  const apply=api.handler.fillQuestion;
  api.handler.fillQuestion=async(...args)=>{const index=fills++;await gates[index].promise;return apply(...args);};
  const result=api.solve(api.handler).then((rate)=>{settled=true;return rate;});
  await flush();assert.equal(fills,1);assert.equal(settled,false);
  gates[0].resolve();await flush();assert.equal(fills,2);assert.equal(settled,false);
  gates[1].resolve();assert.equal(await result,100);assert.equal(api.intervals.size,0);
});

test('disabling concurrent mode keeps one request active and retains the serial overwrite behavior',async()=>{
  const entries=[question(0,['old answer']),question(1)];
  const first=deferred(),calls=[];
  const api=harness(entries,{getAnswer:(entry)=>{calls.push(entry.title);return calls.length===1 ? first.promise : Promise.resolve(answer(entry));}});
  api.config.ai.concurrentEnabled=false;
  const result=api.solve(api.handler);
  assert.deepEqual(calls,['Question 0']);
  first.resolve(answer(entries[0]));
  assert.equal(await result,100);assert.equal(calls.length,2);
  assert.equal(entries[0].fields[0].value,'answer:0-0');
});

test('legacy harnesses without the concurrency helper fall back to serial requests',async()=>{
  const entries=[question(0),question(1)],gate=deferred(),calls=[];
  const api=harness(entries,{aiConcurrencyLimit:undefined,useConfigStore:undefined,
    getAnswer:(entry)=>{calls.push(entry.title);return calls.length===1 ? gate.promise : Promise.resolve(answer(entry));}});
  const result=api.solve(api.handler);assert.equal(calls.length,1);
  gate.resolve(answer(entries[0]));assert.equal(await result,100);assert.equal(calls.length,2);
});

test('one rejected model request does not stop valid siblings or leak an unhandled rejection',async()=>{
  const entries=[question(0),question(1),question(2)];
  const api=harness(entries,{getAnswer:async(entry)=>{if(entry.title==='Question 1')throw new Error('offline failure');return answer(entry);}});
  assert.equal(await api.solve(api.handler),2/3*100);
  assert.equal(api.rows[1].answerStatus,'error');
  assert.equal(entries[1].fields[0].value,'');
  assert.equal(api.handler.lastSolveResult.cancelled,false);
  assert.equal(api.handler.lastSolveResult.filled,2);assert.equal(api.intervals.size,0);
});

test('parent cancellation settles even non-cooperative requests and consumes their late rejection',async()=>{
  const entries=Array.from({length:5},(_,index)=>question(index)),gates=[],signals=[];
  const api=harness(entries,{getAnswer:(_entry,current)=>{const gate=deferred();gates.push(gate);signals.push(current.signal);return gate.promise;}});
  const parent=new AbortController();const result=api.solve(api.handler,{signal:parent.signal});
  assert.equal(gates.length,3);parent.abort();
  assert.equal(await result,0);
  assert.ok(signals.every((signal)=>signal.aborted));
  assert.equal(gates.length,3,'queued questions must never start after cancellation');
  assert.equal(api.intervals.size,0);
  gates.forEach((gate)=>gate.reject(new Error('late transport rejection')));await flush();
  assert.ok(entries.every((entry)=>entry.fields[0].value===''));
  assert.equal(api.handler.lastSolveResult.cancelled,true);
});

test('a title change cancels all active siblings and drops queued fills before they start',async()=>{
  const entries=Array.from({length:4},(_,index)=>question(index)),gates=[],signals=[];
  const api=harness(entries,{getAnswer:(_entry,current)=>{const gate=deferred();gates.push(gate);signals.push(current.signal);return gate.promise;}});
  const result=api.solve(api.handler);
  entries[3].element.querySelector().childNodes[0].nodeValue='replacement question';api.tick();
  assert.equal(await result,0);assert.equal(gates.length,3);
  assert.ok(signals.every((signal)=>signal.aborted));assert.equal(api.intervals.size,0);
  gates.forEach((gate,index)=>gate.resolve(answer(entries[index])));await flush();
  assert.ok(entries.every((entry)=>entry.fields[0].value===''));
});

test('a question filled while waiting for its worker is skipped before any model request',async()=>{
  const entries=[question(0),question(1)],gate=deferred(),calls=[];
  const api=harness(entries,{getAnswer:(entry)=>{calls.push(entry.title);return gate.promise;}});
  api.config.ai.concurrency=1;
  const result=api.solve(api.handler);entries[1].fields[0].value='my later answer';
  gate.resolve(answer(entries[0]));
  assert.equal(await result,100);assert.deepEqual(calls,['Question 0']);
  assert.equal(entries[1].fields[0].value,'my later answer');assert.equal(api.rows[1].answerSource,'existing');
});

test('partial manual changes during inference are preserved without being counted complete',async()=>{
  const entry=question(0,['','']),gate=deferred();
  const api=harness([entry],{getAnswer:()=>gate.promise});
  const result=api.solve(api.handler);entry.fields[0].value='my partial answer';
  gate.resolve(answer(entry));assert.equal(await result,0);
  assert.deepEqual(entry.fields.map((item)=>item.value),['my partial answer','']);
  assert.equal(api.rows[0].answerStatus,'error');assert.match(api.rows[0].fillError,/已保留/);
  assert.equal(api.handler.lastSolveResult.cancelled,false);
});

for(const failure of ['unusable','rejection'])test(`a manually completed answer is retained even after model ${failure}`,async()=>{
  const entry=question(0),gate=deferred();const api=harness([entry],{getAnswer:()=>gate.promise});
  const result=api.solve(api.handler);entry.fields[0].value='my complete answer';
  if(failure==='rejection')gate.reject(new Error('offline failure'));else gate.resolve({values:[],error:{message:'unavailable'}});
  assert.equal(await result,100);assert.equal(entry.fields[0].value,'my complete answer');
  assert.equal(api.rows[0].answerSource,'existing');assert.equal(api.handler.lastSolveResult.verifyFilled(),true);
});

test('existing-answer receipts ignore panel edits and detect any later page value change',async()=>{
  const entry=question(0,['existing']);let requests=0;
  const api=harness([entry],{getAnswer:async()=>{requests++;throw new Error('must skip');}});
  assert.equal(await api.solve(api.handler),100);assert.equal(requests,0);
  api.rows[0].answer[0]='edited display';assert.equal(api.handler.lastSolveResult.verifyFilled(),true);
  entry.fields[0].value='changed';assert.equal(api.handler.lastSolveResult.verifyFilled(),false);
  assert.equal(api.handler.lastSolveResult.isCurrent(),true);
  entry.fields[0].value='existing';assert.equal(api.handler.lastSolveResult.verifyFilled(),true);
  assert.equal(requests,0);
});

for(const condition of ['disabled','readOnly','hidden'])test(`${condition} answer controls cannot make a partially available question count as already answered`,async()=>{
  const entry=question(0,['existing','unavailable']);entry.fields[1][condition]=true;
  let requests=0;const api=harness([entry],{getAnswer:async()=>{requests++;return{values:[]};}});
  assert.equal(await api.solve(api.handler),0);assert.equal(requests,1);
  assert.equal(api.handler.lastSolveResult.filled,0);
});

test('rich-editor existing answers require matching visible and editor text and remain live',async()=>{
  const entry=question(0);const source=entry.fields[0];source.tagName='TEXTAREA';source.id='rich';source.getClientRects=()=>[];
  const body={isConnected:true,textContent:'existing rich answer'};
  const editor={body,setContent(){},getContentTxt:()=>body.textContent};
  const editorWindow={...pageWindow,UE:{instants:{rich:editor}}};
  source.ownerDocument={defaultView:editorWindow};entry.element.ownerDocument={defaultView:editorWindow};
  let requests=0;const api=harness([entry],{getAnswer:async()=>{requests++;return{values:[]};}});api.handler._window=editorWindow;
  assert.equal(await api.solve(api.handler),100);assert.equal(requests,0);
  body.textContent='';assert.equal(api.handler.lastSolveResult.verifyFilled(),false);
});

test('Wisdom Tree multiple questions use concurrency and navigate exactly once after every fill',async()=>{
  const entries=[question(0),question(1),question(2)],gates=[];
  entries.forEach((entry)=>{entry.workType='zhs';});
  let clicks=0,waits=0;const api=harness(entries,{
    getAnswer:()=>{const gate=deferred();gates.push(gate);return gate.promise;},
    aiWaitForDelay:async(_seconds,current)=>{waits++;assert.ok(entries.every((entry)=>entry.fields[0].value));return current.isCurrent();}
  });
  api.config.platformParams.zhs.parts[0].params[0].value=true;
  api.handler._document={querySelectorAll:()=>[{}, {click(){clicks++;}}]};
  const result=api.solve(api.handler);assert.equal(gates.length,3);
  gates[2].resolve(answer(entries[2]));gates[0].resolve(answer(entries[0]));await flush();
  assert.equal(clicks,0);assert.equal(waits,0);
  gates[1].resolve(answer(entries[1]));assert.equal(await result,100);
  assert.equal(clicks,1);assert.equal(waits,1);assert.equal(api.intervals.size,0);
});

test('Wisdom Tree navigation rechecks existing answers after the batch delay',async()=>{
  const entry=question(0,['existing']);entry.workType='zhs';let clicks=0;
  const api=harness([entry],{aiWaitForDelay:async()=>{entry.fields[0].value='';return true;}});
  api.config.platformParams.zhs.parts[0].params[0].value=true;
  api.handler._document={querySelectorAll:()=>[{}, {click(){clicks++;}}]};
  assert.equal(await api.solve(api.handler),0);assert.equal(clicks,0);
  assert.equal(api.handler.lastSolveResult.complete,false);
});

test('a limit of 2500 starts all twelve remaining questions together and preserves existing answers',async()=>{
  const existing=[question('done-a',['my first answer']),question('done-b',['my second answer'])];
  const remaining=Array.from({length:12},(_,index)=>question(index));
  const entries=[...existing,...remaining],requests=[],pending=new Map();
  let active=0,peak=0,activeFills=0,peakFills=0;
  const api=harness(entries,{getAnswer:(entry)=>{
    requests.push(entry.title);active++;peak=Math.max(peak,active);
    const gate=deferred();pending.set(entry.title,gate);
    return gate.promise.finally(()=>{active--;});
  }});
  api.config.ai.concurrency=2500;
  const fill=api.handler.fillQuestion;
  api.handler.fillQuestion=async(...args)=>{
    activeFills++;peakFills=Math.max(peakFills,activeFills);
    await turn();try{return await fill(...args);}finally{activeFills--;}
  };
  const result=api.solve(api.handler);
  assert.equal(requests.length,12,'only remaining questions should have requests');
  assert.equal(active,12,'all remaining requests start before any one has completed');
  assert.equal(peak,12);
  assert.deepEqual(api.rows.map((entry)=>entry.title),entries.map((entry)=>entry.title));
  for(const entry of [...remaining].reverse())pending.get(entry.title).resolve(answer(entry));
  assert.equal(await result,100);assert.equal(peakFills,1);assert.equal(active,0);
  assert.deepEqual(existing.map((entry)=>entry.fields[0].value),['my first answer','my second answer']);
  assert.ok(remaining.every((entry)=>entry.fields[0].value===entry.expected[0]));
  assert.equal(api.handler.lastSolveResult.verifyFilled(),true);assert.equal(api.intervals.size,0);
});

test('a limit of 2500 creates zero workers when every question already has an answer',async()=>{
  const entries=Array.from({length:12},(_,index)=>question(index,[`existing:${index}`]));
  let requests=0;
  const api=harness(entries,{getAnswer:async()=>{requests++;throw new Error('must not request an answered question');}});
  api.config.ai.concurrency=2500;
  assert.equal(await api.solve(api.handler),100);assert.equal(requests,0);
  assert.ok(api.rows.every((entry)=>entry.answerSource==='existing'));
  assert.equal(api.handler.lastSolveResult.verifyFilled(),true);assert.equal(api.intervals.size,0);
});
