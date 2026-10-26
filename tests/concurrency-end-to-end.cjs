'use strict';
// Exercise both production layers together. Only the GM transport is replaced;
// Vue, response mapping, scheduling, existing-answer detection and filling are real.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'userscript.template.js.in'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const extractors = fs.readFileSync(path.join(root, 'text-extraction.js'), 'utf8');
const vue = fs.readFileSync(path.join(root, 'tests', 'browser-fixture', 'mooc2', 'work', 'dependency-0.js'), 'utf8');
function section(source, start, end) {
  const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
  assert.ok(first>=0&&last>first);
  return source.slice(first,last);
}
const common = section(template, '  const isObject = ', '/* @ai-helper:TEXT_EXTRACTORS@ */');
const sleep = section(template, '  const sleep = ', '/* @ai-helper:ADAPTER@ */');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate) {
  const deadline=Date.now()+3000;
  while(!predicate()) {
    if(Date.now()>deadline)throw Error('Timed out waiting for the production solver');
    await pause(2);
  }
}
const selectors = {
  fields:'input, textarea, [contenteditable="true"]',
  rows:'.answerBg,[class*="before-after"],.label,.ans-videoquiz-opt',
  texts:'.node_detail,.fl.after,.answer_p'
};
function harness(concurrency=3) {
  const config={ai:{concurrentEnabled:true,concurrency,apiKey:'offline-key',model:'offline-model'},otherParams:{params:[{value:0}]},platformParams:{zhs:{parts:[{params:[{value:false}]}]}}};
  const calls=[],rows=[],fills=[],timeouts=new Set(),intervals=new Set();
  let activeRequests=0,peakRequests=0,activeFills=0,peakFills=0;
  const sandbox=vm.createContext({AbortController,URL,console,
    window:{location:{href:'https://example.chaoxing.com/work'}},
    useConfigStore:()=>config,
    setTimeout(callback,ms){let id;id=setTimeout(()=>{timeouts.delete(id);callback();},ms);timeouts.add(id);return id;},
    clearTimeout(id){timeouts.delete(id);clearTimeout(id);},
    setInterval(callback,ms){const id=setInterval(callback,ms);intervals.add(id);return id;},
    clearInterval(id){intervals.delete(id);clearInterval(id);},
    _GM_xmlhttpRequest(request){
      const body=JSON.parse(request.data),input=JSON.parse(body.input);
      const call={request,input,done:false,aborted:false};calls.push(call);
      activeRequests++;peakRequests=Math.max(peakRequests,activeRequests);
      const close=()=>{if(!call.done){call.done=true;activeRequests--;}};
      call.respond=index=>{
        close();
        const answer={answerable:true,choice_indices:[index],text_answers:[],judgement:'unknown',explanation:`Answer for ${input.stem}`};
        request.onload({status:200,responseText:JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]})});
      };
      return {abort(){close();call.aborted=true;request.onabort();}};
    }
  });
  vm.runInContext(vue,sandbox);
  vm.runInContext('const vue=Vue;\n'+common+extractors+sleep+adapter+integration+'\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers,raw:Vue.markRaw};',sandbox);
  const raw=sandbox.api.raw;
  const pageWindow=raw({Event:class{constructor(type){this.type=type;}}});
  function element(tagName,attributes={}) {
    return raw({tagName,isConnected:true,disabled:false,readOnly:false,
      getAttribute:name=>Object.hasOwn(attributes,name)?attributes[name]:null,
      matches:()=>false,querySelector:()=>null,querySelectorAll:()=>[],
      ownerDocument:{defaultView:pageWindow}});
  }
  function choice(id,selected=-1) {
    const title=`Question ${id}`;
    const inputs=[0,1].map(index=>Object.assign(element('INPUT',{type:'radio'}),{name:`answer-${id}`,type:'radio',checked:index===selected}));
    const optionTexts=[`${id}:first`,`${id}:second`];
    const optionRows=inputs.map((input,index)=>{
      const row=element('LABEL');
      row.querySelector=selector=>selector.includes('input')?input:null;
      row.querySelectorAll=selector=>selector.includes('input')?[input]:[];
      row.click=()=>{inputs.forEach((item,itemIndex)=>{item.checked=itemIndex===index;});};
      return row;
    });
    const titleNode=Object.assign(element('H3'),{nodeType:1,childNodes:[{nodeType:3,nodeValue:title}]});
    const textNodes=optionTexts.map(text=>Object.assign(element('DIV'),{nodeType:1,childNodes:[{nodeType:3,nodeValue:text}]}));
    const container=element('DIV',{'data-question-id':String(id)});
    container.querySelector=()=>titleNode;
    container.querySelectorAll=selector=>selector===selectors.fields?inputs:selector===selectors.rows?optionRows:selector===selectors.texts?textNodes:[];
    return {title,type:'0',workType:'zy',element:container,optionsText:optionTexts,searchText:{stem:title,options:optionTexts},options:Object.fromEntries(optionTexts.map((text,index)=>[text,optionRows[index]])),inputs};
  }
  function existingText(id,value) {
    const title=`Existing ${id}`,field=Object.assign(element('INPUT',{type:'text'}),{name:`answer-${id}`,value,dispatchEvent(){}});
    const titleNode=Object.assign(element('H3'),{nodeType:1,childNodes:[{nodeType:3,nodeValue:title}]});
    const container=element('DIV',{'data-question-id':String(id)});
    container.querySelector=()=>titleNode;
    container.querySelectorAll=selector=>selector===selectors.fields?[field]:[];
    return {title,type:'2',workType:'zy',element:container,optionsText:[],searchText:{stem:title,options:[]},options:{},field};
  }
  function handler(questions) {
    return {_window:pageWindow,parseHtml(){this.questions=questions;},addQuestion:question=>rows.push(question),addLog(){},
      async fillQuestion(question,current){
        activeFills++;peakFills=Math.max(peakFills,activeFills);fills.push(question.title);
        try{return await sandbox.api.apply(question,pageWindow,'zy',(options,answer)=>options[answer],current);}
        finally{activeFills--;}
      }
    };
  }
  return {calls,rows,fills,choice,existingText,handler,solve:sandbox.api.solve,
    peakRequests:()=>peakRequests,peakFills:()=>peakFills,activeRequests:()=>activeRequests,
    assertClean(){assert.equal(timeouts.size,0);assert.equal(intervals.size,0);assert.equal(activeRequests,0);assert.equal(activeFills,0);}
  };
}

test('real adapter and solver overlap requests to the cap, map out-of-order answers and serialize page fills',async()=>{
  const h=harness(3),questions=Array.from({length:6},(_,index)=>h.choice(index)),handler=h.handler(questions);
  const solving=h.solve(handler);
  await waitFor(()=>h.calls.length===3);
  assert.equal(h.activeRequests(),3);
  assert.deepEqual(h.rows.map(row=>row.title),questions.map(question=>question.title));
  for(const index of [2,0,1])h.calls[index].respond(index%2);
  await waitFor(()=>h.calls.length===6);
  for(const index of [5,3,4])h.calls[index].respond(index%2);
  assert.equal(await solving,100);
  assert.equal(h.peakRequests(),3);
  assert.equal(h.peakFills(),1);
  assert.deepEqual(h.fills.slice(0,3),['Question 2','Question 0','Question 1']);
  questions.forEach((question,index)=>assert.deepEqual(question.inputs.map(input=>input.checked),[index%2===0,index%2===1]));
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  assert.ok(h.rows.every(row=>row.answerStatus==='success'));
  h.assertClean();
});

test('already completed choice and text answers skip the actual transport while pending questions still complete',async()=>{
  const h=harness(3),answeredChoice=h.choice(0,1),answeredText=h.existingText(1,'my existing answer'),pending=h.choice(2);
  const handler=h.handler([answeredChoice,answeredText,pending]),solving=h.solve(handler);
  await waitFor(()=>h.calls.length===1);
  assert.equal(h.calls[0].input.stem,'Question 2');h.calls[0].respond(0);
  assert.equal(await solving,100);
  assert.equal(h.calls.length,1);
  assert.equal(answeredChoice.inputs[1].checked,true);
  assert.equal(answeredText.field.value,'my existing answer');
  assert.deepEqual(h.rows.map(row=>row.answerSource),['existing','existing','ai']);
  assert.deepEqual(h.fills,['Question 2']);
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  h.assertClean();
});

test('a limit of 2500 starts only the six unanswered questions among eight without empty work',async()=>{
  const h=harness(2500),answeredChoice=h.choice(0,1),answeredText=h.existingText(1,'my existing answer');
  const pending=Array.from({length:6},(_,index)=>h.choice(index+2));
  const questions=[answeredChoice,answeredText,...pending],handler=h.handler(questions),controller=new AbortController();
  const solving=h.solve(handler,{signal:controller.signal});
  try {
    await waitFor(()=>h.calls.length===6);
    assert.equal(h.activeRequests(),6);
    assert.equal(h.peakRequests(),6);
    assert.deepEqual(h.calls.map(call=>call.input.stem),pending.map(question=>question.title));
    assert.deepEqual(h.rows.map(row=>row.title),questions.map(question=>question.title));
    for(const index of [5,2,0,4,1,3])h.calls[index].respond(index%2);
    assert.equal(await solving,100);
    assert.equal(h.calls.length,6);
    assert.equal(h.fills.length,6);
    assert.equal(h.peakFills(),1);
    assert.equal(answeredChoice.inputs[1].checked,true);
    assert.equal(answeredText.field.value,'my existing answer');
    assert.deepEqual(h.rows.slice(0,2).map(row=>row.answerSource),['existing','existing']);
    pending.forEach((question,index)=>assert.deepEqual(question.inputs.map(input=>input.checked),[index%2===0,index%2===1]));
    assert.equal(handler.lastSolveResult.total,8);
    assert.equal(handler.lastSolveResult.verifyFilled(),true);
  } finally {
    controller.abort();
    await solving;
    h.assertClean();
  }
});

test('a limit of 2500 creates no model request or fill when every question is already answered',async()=>{
  const h=harness(2500),questions=Array.from({length:8},(_,index)=>index%2?h.existingText(index,`my answer ${index}`):h.choice(index,index%2));
  const handler=h.handler(questions);
  assert.equal(await h.solve(handler),100);
  assert.equal(h.calls.length,0);
  assert.equal(h.peakRequests(),0);
  assert.equal(h.fills.length,0);
  assert.equal(h.peakFills(),0);
  assert.equal(handler.lastSolveResult.total,8);
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  assert.ok(h.rows.every(row=>row.answerSource==='existing'));
  h.assertClean();
});

test('a limit of 2500 still aborts every started remaining request without later work',async()=>{
  const h=harness(2500),questions=[h.choice(0,1),h.existingText(1,'my answer'),...Array.from({length:6},(_,index)=>h.choice(index+2))];
  const handler=h.handler(questions),controller=new AbortController();
  const solving=h.solve(handler,{signal:controller.signal});
  try {
    await waitFor(()=>h.calls.length===6);
    controller.abort();
    assert.equal(await solving,0);
    assert.equal(handler.lastSolveResult.cancelled,true);
    assert.ok(h.calls.every(call=>call.aborted));
    h.calls.forEach(call=>call.respond(1));await pause(20);
    assert.equal(h.calls.length,6);
    assert.equal(h.fills.length,0);
    assert.ok(questions.slice(2).every(question=>question.inputs.every(input=>!input.checked)));
  } finally {
    controller.abort();
    await solving;
    h.assertClean();
  }
});

test('cancelling a complete batch aborts overlapping requests and prevents any later paid request or fill',async()=>{
  const h=harness(3),questions=Array.from({length:9},(_,index)=>h.choice(index)),handler=h.handler(questions),controller=new AbortController();
  const solving=h.solve(handler,{signal:controller.signal});
  await waitFor(()=>h.calls.length===3);
  controller.abort();
  assert.equal(await solving,0);
  assert.equal(handler.lastSolveResult.cancelled,true);
  assert.ok(h.calls.every(call=>call.aborted));
  h.calls.forEach(call=>call.respond(1));await pause(20);
  assert.equal(h.calls.length,3);
  assert.equal(h.fills.length,0);
  assert.ok(questions.every(question=>question.inputs.every(input=>!input.checked)));
  h.assertClean();
});

test('two solver batches share the actual adapter cap and cancellation also removes their waiting requests',async()=>{
  const h=harness(2),first=h.handler([0,1,2,3].map(index=>h.choice(index))),second=h.handler([4,5,6,7].map(index=>h.choice(index))),controller=new AbortController();
  const solving=[h.solve(first,{signal:controller.signal}),h.solve(second,{signal:controller.signal})];
  await waitFor(()=>h.calls.length===2);
  assert.equal(h.peakRequests(),2);
  controller.abort();
  assert.deepEqual(await Promise.all(solving),[0,0]);await pause(20);
  assert.equal(h.calls.length,2);
  assert.equal(h.fills.length,0);
  assert.ok(h.calls.every(call=>call.aborted));
  h.assertClean();
});
