'use strict';
// Independent behavioral checks: queued model work must respect existing answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const helpers = adapter.slice(adapter.indexOf('  const aiControlVisible = '), adapter.indexOf('  const aiBlankCount = '));
const pageWindow = {Event: class {constructor(type) {this.type = type;}}};
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fieldSelector = 'input, textarea, [contenteditable="true"]';

function field(name, value = '') {
  return {tagName:'INPUT', name, value, isConnected:true,
    getAttribute:(key)=>key === 'type' ? 'text' : null,
    matches:()=>false, dispatchEvent(){}};
}
function option(text, selected = false) {
  const value = {tagName:'DIV', textContent:text, selected, isConnected:true,
    getAttribute:(key)=>key === 'aria-checked' ? String(value.selected) : null,
    matches:()=>false, querySelector:()=>null, querySelectorAll:()=>[],
    click(){value.selected = !value.selected;}};
  return value;
}
function question(title, type = '2', fields = [], options = {}) {
  const titleNode = {tagName:'H3', childNodes:[{nodeType:3,nodeValue:title}], getAttribute:()=>null};
  const entry = {title, type, fields, options, expected:fields.map((item)=>`model:${item.name}`)};
  entry.element = {isConnected:true, getAttribute:()=>null,
    querySelector:()=>titleNode, querySelectorAll:(selector)=>selector === fieldSelector ? entry.fields : []};
  return entry;
}
function harness(getAnswer, settings = {}) {
  const config = {ai:{apiKey:'offline-fixture-key',concurrentEnabled:true, concurrency:3, ...settings},
    otherParams:{params:[{value:0}]}, platformParams:{zhs:{parts:[{params:[{value:false}]}]}}};
  const context = vm.createContext({AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    window:{location:{href:'https://example.chaoxing.com/work'}},
    vue:{reactive:(value)=>value}, useConfigStore:()=>config,
    aiConcurrencyLimit:()=>config.ai.concurrentEnabled === true ? config.ai.concurrency : 1,
    sleep:async()=>{}, aiWaitForDelay:async(_seconds, current)=>current.isCurrent(),
    getAnswer, getAnswerValues:(response)=>response.values});
  vm.runInContext(helpers + integration + '\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers};', context);
  const rows = [], logs = [];
  const makeHandler = (questions) => ({_window:pageWindow,
    parseHtml(){this.questions = questions;}, addQuestion:(entry)=>rows.push(entry),
    addLog:(message)=>logs.push(message),
    fillQuestion:(entry, current)=>context.api.apply(entry,pageWindow,'zy',(options, answer)=>options[answer],current)});
  return {...context.api, rows, logs, makeHandler};
}

test('existing complete choices and text are skipped, remaining blanks are solved', async () => {
  const multiple = question('existing choice','1',[],{A:option('A',true),B:option('B',false)});
  const existing = question('existing text','2',[field('existing','my answer')]);
  const blank = question('new text','2',[field('empty')]);
  const requested = [];
  const api = harness(async(entry)=>{requested.push(entry.title);return {values:entry.expected,meta:{}};});
  const handler = api.makeHandler([multiple,existing,blank]);
  assert.equal(await api.solve(handler),100);
  assert.deepEqual(requested,['new text']);
  assert.equal(existing.fields[0].value,'my answer');
  assert.equal(multiple.options.A.selected,true);
  assert.equal(multiple.options.B.selected,false);
  assert.deepEqual(api.rows.map((entry)=>entry.title),['existing choice','existing text','new text']);
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  multiple.options.B.selected = true;
  assert.equal(handler.lastSolveResult.verifyFilled(),false);
});

test('partly filled multiple blanks still require a complete model answer', async () => {
  const entry = question('two blanks','2',[field('first','only one answer'),field('second')]);
  let count = 0;
  const api = harness(async(entry)=>{count++;return {values:entry.expected,meta:{}};});
  const handler = api.makeHandler([entry]);
  assert.equal(await api.solve(handler),100);
  assert.equal(count,1);
  assert.deepEqual(entry.fields.map((item)=>item.value),['model:first','model:second']);
});

test('skipped answers retain a verification receipt while other requests run', async () => {
  const answered = question('done','2',[field('done','existing answer')]);
  const pending = question('waiting','2',[field('pending')]);
  let count = 0;
  const api = harness(async(entry)=>{count++;answered.fields[0].value = '';return {values:entry.expected,meta:{}};});
  const handler = api.makeHandler([answered,pending]);
  assert.equal(await api.solve(handler),50);
  assert.equal(count,1);
  assert.equal(handler.lastSolveResult.complete,false);
  assert.equal(handler.lastSolveResult.filled,1);
  assert.equal(handler.lastSolveResult.isCurrent(),true);
});

test('all already answered questions complete without a model request', async () => {
  const entry = question('answered','2',[field('answer','  existing  ')]);
  let count = 0;
  const api = harness(async()=>{count++;throw new Error('must not query');});
  const handler = api.makeHandler([entry]);
  assert.equal(await api.solve(handler),100);
  assert.equal(count,0);
  entry.fields[0].value = 'user changed answer';
  assert.equal(handler.lastSolveResult.verifyFilled(),false);
  assert.equal(count,0);
});

test('answers completed manually during a model request are preserved', async () => {
  const entry = question('initially empty','2',[field('answer')]);
  const api = harness(async(question)=>{
    question.fields[0].value = 'my newer answer';
    return {values:question.expected,meta:{}};
  });
  const handler = api.makeHandler([entry]);
  assert.equal(await api.solve(handler),100);
  assert.equal(entry.fields[0].value,'my newer answer');
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
});

test('changing one question cancels active siblings before any answer is written', async () => {
  const entries = [question('first','2',[field('one')]),question('second','2',[field('two')]),question('third','2',[field('three')])];
  let started = 0, aborted = 0;
  const api = harness((entry, context)=>new Promise((resolve)=>{
    started++;
    const timer = setTimeout(()=>resolve({values:entry.expected,meta:{}}),1000);
    context.signal.addEventListener('abort',()=>{aborted++;clearTimeout(timer);resolve({values:[],meta:{}});},{once:true});
    if (started === 3) setTimeout(()=>{entries[0].fields[0].name = 'replaced identity';},10);
  }));
  const handler = api.makeHandler(entries);
  const result = await Promise.race([api.solve(handler),pause(1800).then(()=>{throw new Error('cancellation did not settle');})]);
  assert.equal(started,3);
  assert.equal(result,0);
  assert.equal(aborted,3);
  assert.equal(handler.lastSolveResult.cancelled,true);
  assert.ok(entries.every((entry)=>entry.fields[0].value === ''));
});

test('synchronous transport callbacks settle the bounded queue without leaked slots or timers', async () => {
  const config = {ai:{concurrentEnabled:true,concurrency:3,apiKey:'fixture',model:'fixture-model'},otherParams:{params:[{value:0}]}};
  const timers = new Set(), sent = [], lateCallbacks = [];
  const output = {answerable:true,choice_indices:[0],text_answers:[],judgement:'unknown',explanation:'offline'};
  const sandbox = {AbortController, URL,
    useConfigStore:()=>config,
    isObject:(value)=>value !== null && typeof value === 'object' && !Array.isArray(value),
    extractRawTextFromHtml:(value)=>value,
    apiError:(message)=>({success:false,error:{message}}),
    setTimeout:(callback, milliseconds)=>{const id=setTimeout(callback,milliseconds);timers.add(id);return id;},
    clearTimeout:(id)=>{timers.delete(id);clearTimeout(id);},
    _GM_xmlhttpRequest(request){
      sent.push(JSON.parse(request.data).input);
      request.onload({status:200,responseText:JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]})});
      lateCallbacks.push(()=>request.onerror());
      return {abort(){request.onabort();}};
    }};
  vm.runInNewContext(adapter+'\nglobalThis.api={getAnswer};',sandbox);
  const make = (index)=>({title:`Question ${index}`,searchText:{stem:`Question ${index}`,options:['A','B']},optionsText:['A','B'],type:'0'});
  const pending = Array.from({length:25},(_,index)=>sandbox.api.getAnswer(make(index),{skipDelay:true}));
  const results = await Promise.all(pending);
  assert.equal(results.length,25);
  assert.ok(results.every((value)=>value.success));
  lateCallbacks.forEach((callback)=>callback());
  assert.equal((await sandbox.api.getAnswer(make(25),{skipDelay:true})).success,true);
  assert.equal(sent.length,26);
  assert.equal(timers.size,0);
});
