'use strict';
// Regression checks for control identity, answer verification and shadow titles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'ai-course-helper.user.js'), 'utf8');
const integration = fs.readFileSync(path.resolve(__dirname, '..', 'ai-integration.js'), 'utf8');
const adapter = fs.readFileSync(path.resolve(__dirname, '..', 'ai-adapter.js'), 'utf8');
function section(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return text.slice(a, b);
}
const helpers = section(adapter, '  const aiControlVisible = ', '  const aiBlankCount = ');
function harness(overrides = {}) {
  const context = vm.createContext({
    AbortController, window: {location:{href:'https://example.chaoxing.com/exam-ans/exam'}},
    setInterval:()=>1,clearInterval(){},sleep:async()=>{},
    vue:{reactive:(value)=>value},
    getAnswer:async(question)=>({values:question.expected,meta:{}}),
    getAnswerValues:(response)=>response.values,
    ...overrides
  });
  vm.runInContext(helpers + integration + '\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers,context:createAiQuestionContext};',context);
  return context.api;
}
const pageWindow={Event:class{constructor(type){this.type=type;}}};
const field=(name)=>({tagName:'INPUT',name,value:'',isConnected:true,getAttribute:(key)=>key==='type'?'text':null,dispatchEvent(){}});
function question(title,fields) {
  const titleNode={tagName:'H3',childNodes:[{nodeType:3,nodeValue:title}],getAttribute:()=>null};
  const element={isConnected:true,getAttribute:()=>null,querySelector:()=>titleNode,querySelectorAll:(selector)=>selector==='input, textarea, [contenteditable="true"]'?fields:[]};
  return {title,type:'2',expected:fields.map((entry)=>`answer-for-${entry.name}`),element,fields};
}
function handler(questions,apply) {
  return {parseHtml(){this.questions=questions;},addLog(){},addQuestion(){},fillQuestion:(entry,isCurrent)=>apply(entry,pageWindow,'zy',undefined,isCurrent)};
}
async function main() {
  {
    const first=field('left'),second=field('right');
    const fields=[first,second],entry=question('Fill these two blanks',fields);
    const api=harness({getAnswer:async()=>{fields.reverse();return{values:entry.expected,meta:{}};}});
    const currentHandler=handler([entry],api.apply);
    assert.equal(await api.solve(currentHandler),0);
    assert.equal(first.value,'');
    assert.equal(second.value,'');
    assert.equal(currentHandler.lastSolveResult.complete,false);
    assert.equal(currentHandler.lastSolveResult.cancelled,true);
    console.log('PASS: reordered answer controls cancel the old answer before writing.');
  }
  {
    const first=question('First blank',[field('first')]);
    const second=question('Second blank',[field('second')]);
    const api=harness({getAnswer:async(entry)=>{
      if(entry.title==='Second blank')first.fields[0].value='';
      return{values:entry.expected,meta:{}};
    }});
    const currentHandler=handler([first,second],api.apply);
    assert.equal(await api.solve(currentHandler),50);
    assert.equal(first.fields[0].value,'');
    assert.equal(currentHandler.lastSolveResult.complete,false);
    assert.equal(currentHandler.lastSolveResult.filled,1);
    assert.equal(currentHandler.lastSolveResult.isCurrent(),true);
    first.fields[0].value='answer-for-first';
    assert.equal(currentHandler.lastSolveResult.verifyFilled(),true);
    assert.equal(currentHandler.lastSolveResult.rate,100);
    second.fields[0].value='changed after completion';
    assert.equal(currentHandler.lastSolveResult.verifyFilled(),false);
    assert.equal(currentHandler.lastSolveResult.rate,50);
    assert.equal(currentHandler.lastSolveResult.isCurrent(),true);
    console.log('PASS: verification rereads answers without invalidating the original question or requesting it again.');
  }
  {
    const shadowText={nodeType:3,nodeValue:'original shadow title'};
    const shadowDom={nodeType:11,childNodes:[shadowText]};
    const title={nodeType:1,tagName:'DIV',childNodes:[],getAttribute:()=>null,__Ivue__:{_data:{shadowDom}}};
    const stemContainer={nodeType:1,tagName:'DIV',childNodes:[title],getAttribute:()=>null};
    const entry={title:'original shadow title',type:'单选题',element:{isConnected:true,getAttribute:()=>null,querySelector:()=>stemContainer,querySelectorAll:()=>[]}};
    const api=harness();
    const context=api.context(entry);
    assert.equal(context.isCurrent(),true);
    shadowText.nodeValue='replacement shadow title';
    assert.equal(context.isCurrent(),false);
    context.dispose();
    console.log('PASS: changed Wisdom Tree shadow titles invalidate the question.');
  }
  for(const change of ['replace','rename','change-type']){
    const fields=[field('original')],entry=question('A stable title',fields);
    const api=harness({getAnswer:async()=>{
      if(change==='replace')fields[0]=field('original');
      if(change==='rename')fields[0].name='replacement';
      if(change==='change-type')fields[0].type='number';
      return{values:entry.expected,meta:{}};
    }});
    const currentHandler=handler([entry],api.apply);
    assert.equal(await api.solve(currentHandler),0);
    assert.equal(fields[0].value,'');
    assert.equal(currentHandler.lastSolveResult.cancelled,true);
    console.log('PASS: '+change+' invalidates the original answer control mapping.');
  }
  for(const variant of ['string','shadowRoot']){
    const node={nodeType:1,tagName:'DIV',childNodes:[],getAttribute:()=>null};
    if(variant==='string')node.__Ivue__={_data:{shadowDom:'<b>old title</b>'}};
    else node.shadowRoot={nodeType:11,childNodes:[{nodeType:3,nodeValue:'old title'}]};
    const entry={title:'old title',type:'0',element:{isConnected:true,getAttribute:()=>null,querySelector:()=>node,querySelectorAll:()=>[]}};
    const api=harness(),context=api.context(entry);
    assert.equal(context.isCurrent(),true);
    if(variant==='string')node.__Ivue__._data.shadowDom='<b>new title</b>';
    else node.shadowRoot.childNodes[0].nodeValue='new title';
    assert.equal(context.isCurrent(),false);
    context.dispose();
    console.log('PASS: '+variant+' title representation is part of question identity.');
  }
  {
    const sourceField={...field('rich'),tagName:'TEXTAREA',id:'editor-id',getClientRects:()=>[]};
    const body={isConnected:true,textContent:'old'};
    const editor={body,setContent(){},getContentTxt:()=>body.textContent};
    const editorWindow={UE:{instants:{'editor-id':editor}}};
    sourceField.ownerDocument={defaultView:editorWindow};
    const entry=question('An unchanged rich-text question',[sourceField]);
    entry.element.ownerDocument={defaultView:editorWindow};
    const api=harness(),context=api.context(entry);
    assert.equal(context.isCurrent(),true);
    editorWindow.UE.instants['editor-id']={...editor};
    assert.equal(context.isCurrent(),false);
    context.dispose();
    console.log('PASS: replacing an existing editor instance invalidates its original answer mapping.');
  }
  {
    const option={isConnected:true,selected:false,getAttribute:(key)=>key==='aria-checked'?String(option.selected):null,matches:()=>false,querySelector:()=>null,click(){option.selected=true;}};
    const entry=question('A choice answer',[ ]);
    entry.type='0';entry.expected=['answer'];entry.options={answer:option};
    const api=harness();
    const currentHandler=handler([entry],(entry,page,type,_match,current)=>api.apply(entry,page,type,(options,answer)=>options[answer],current));
    assert.equal(await api.solve(currentHandler),100);
    assert.equal(currentHandler.lastSolveResult.verifyFilled(),true);
    option.selected=false;
    assert.equal(currentHandler.lastSolveResult.verifyFilled(),false);
    assert.equal(currentHandler.lastSolveResult.filled,0);
    assert.equal(currentHandler.lastSolveResult.isCurrent(),true);
    console.log('PASS: changed choice selection is reverified without changing question identity.');
  }
  {
    const original={tagName:'DIV',getAttribute:()=>null};
    let row=original;
    const entry=question('Stable choice text',[]);
    entry.element.querySelectorAll=(selector)=>selector==='.answerBg,[class*="before-after"],.label,.ans-videoquiz-opt'?[row]:[];
    const api=harness(),context=api.context(entry);
    assert.equal(context.isCurrent(),true);
    row={...original};
    assert.equal(context.isCurrent(),false);
    context.dispose();
    console.log('PASS: replacing a custom option row with identical text invalidates its previous mapping.');
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
