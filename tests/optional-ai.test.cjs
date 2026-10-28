'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const integration = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const chapter = fs.readFileSync(path.join(root, 'chapter-logic.js'), 'utf8');
const fieldHelpers = adapter.slice(adapter.indexOf('  const aiControlVisible = '), adapter.indexOf('  const aiBlankCount = '));
const keyHelpers = integration.slice(0, integration.indexOf('  // Page controls must acknowledge'));
function solveHarness(values = ['', ''], ai = {}) {
  const config = {ai: {provider:'openai',apiKey:'',deepseekApiKey:'',concurrentEnabled:false,...ai},otherParams:{params:[{value:0}]}};
  const rows=[], logs=[], document={};let requests=0;
  const pageWindow={Event:class{constructor(type){this.type=type;}}};
  const questions=values.map((value,index)=>{
    const field={tagName:'INPUT',name:'answer-'+index,value,isConnected:true,matches:()=>false,getAttribute:name=>name==='type'?'text':null,dispatchEvent(){}};
    const heading={tagName:'H3',childNodes:[{nodeType:3,nodeValue:'Question '+index}],getAttribute:()=>null};
    return {title:'Question '+index,type:'2',answer:[],options:{},field,
      element:{isConnected:true,getAttribute:()=>null,querySelector:()=>heading,querySelectorAll:selector=>selector==='input, textarea, [contenteditable="true"]'?[field]:[]}};
  });
  const sandbox={AbortController,setInterval:()=>1,clearInterval(){},sleep:async()=>{},vue:{reactive:entry=>entry},
    window:{location:{href:'https://mooc1.chaoxing.com/mooc2/work/dowork'}},useConfigStore:()=>config,
    getAnswer:async question=>{requests++;return{values:['model answer'],meta:{}};},getAnswerValues:response=>response.values};
  vm.runInNewContext(fieldHelpers+integration+'\nglobalThis.api={solve:solveAiQuestions,apply:applyAiAnswers,hasKey:aiHasConfiguredKey};',sandbox);
  const handler={_window:pageWindow,_document:document,parseHtml(){this.questions=questions;},
    addLog:message=>logs.push(message),addQuestion:question=>rows.push(question),
    fillQuestion:(question,isCurrent)=>sandbox.api.apply(question,pageWindow,'zy',undefined,isCurrent)};
  return {...sandbox.api,handler,config,questions,rows,logs,requests:()=>requests};
}
test('no-key solving preserves existing answers and skips only questions requiring inference',async()=>{
  const h=solveHarness(['manual answer','','']);
  assert.equal(await h.solve(h.handler),1/3*100);assert.equal(h.requests(),0);
  assert.equal(h.questions[0].field.value,'manual answer');assert.equal(h.rows[0].answerSource,'existing');
  assert.equal(h.rows[1].answerStatus,'pending');assert.equal(h.rows[1].answerSource,'configuration');
  assert.equal(h.handler.lastSolveResult.skippedForMissingKey,true);assert.equal(h.handler.lastSolveResult.complete,false);
  assert.equal(h.logs.filter(message=>message.startsWith('AI 未配置')).length,1);
  await h.solve(h.handler);assert.equal(h.logs.filter(message=>message.startsWith('AI 未配置')).length,1);
});
test('already answered questions need no key and remain verifiable in serial mode',async()=>{
  const h=solveHarness(['manual left','manual right']);
  assert.equal(await h.solve(h.handler),100);assert.equal(h.requests(),0);
  assert.equal(h.handler.lastSolveResult.skippedForMissingKey,false);assert.equal(h.handler.lastSolveResult.verifyFilled(),true);
  h.questions[0].field.value='';assert.equal(h.handler.lastSolveResult.verifyFilled(),false);
});
test('key selection uses only the active provider and solving can resume after configuration',async()=>{
  const h=solveHarness([''],{provider:'deepseek',apiKey:'unused-openai-key',deepseekApiKey:'  '});
  assert.equal(h.hasKey(),false);assert.equal(await h.solve(h.handler),0);assert.equal(h.requests(),0);
  h.config.ai.deepseekApiKey='configured-deepseek-key';assert.equal(h.hasKey(),true);
  assert.equal(await h.solve(h.handler),100);assert.equal(h.requests(),1);assert.equal(h.questions[0].field.value,'model answer');
  h.config.ai.provider='unrecognized';assert.equal(h.hasKey(),false);
});

function chapterHarness() {
  const logs=[],timers=new Map();let timerId=0,inferences=0;const quiz={active:false,options:null,disposed:0};
  const config={ai:{provider:'openai',apiKey:''},menuIndex:'0',platformParams:{cx:{parts:[{params:[{value:false},{value:false},{value:false},{name:'视频弹题自动处理（AI 解题）',value:true}]}]}},otherParams:{params:[{value:0},{value:100}]}};
  const document={URL:'https://mooc1.chaoxing.com/api/work',querySelector:()=>null,body:{scrollHeight:300},documentElement:{scrollHeight:300,querySelector:()=>null}};
  const frame={src:document.URL,parentElement:null,isConnected:true,contentDocument:document};
  const view={document,saves:0,submissions:0,confirmations:0,scrolls:0,async noSubmit(){this.saves++;},async btnBlueSubmit(){this.submissions++;},async submitCheckTimes(){this.confirmations++;},scrollTo(){this.scrolls++;}};
  frame.contentWindow=view;
  const sandbox={AbortController,URL,useConfigStore:()=>config,useLogStore:()=>({addLog:message=>logs.push(message)}),useQuestionStore:()=>({clearQuestion(){},addQuestion(){}}),
    setInterval:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),window:{location:{href:'https://mooc1.chaoxing.com/mycourse/studentstudy?mooc2=1'}},
    sleep:async()=>{},vue:{reactive:question=>question},VIDEO_QUIZ_SETTING:'视频弹题自动处理（AI 解题）',
    watchVideoQuiz:options=>{quiz.options=options;return{hasActiveQuiz:()=>quiz.active,dispose(){quiz.disposed++;}};},
    decrypt(){},CxQuestionHandler:class{parseHtml(){this.questions=[];}async init(isCurrent){inferences++;this.lastSolveResult={total:1,filled:1,rate:100,complete:true,cancelled:false,isCurrent,refreshVerification(){return this;}};}},
    getAnswer(){throw Error('No-key media must not request AI');}};
  const exported='    globalThis.api = {processMedia,processPpt,processWork,runIframeDocumentTask}; return;\n    init();';
  vm.runInNewContext(keyHelpers+chapter.replace('    init();',exported)+'\nuseCxChapterLogic();',sandbox);
  const controller=new AbortController();const context={signal:controller.signal,isCurrent:()=>!controller.signal.aborted};
  return {...sandbox.api,config,logs,timers,quiz,document,view,frame,context,inferences:()=>inferences};
}
test('no-key chapter work does not save, submit, change tabs or lock later configured attempts',async()=>{
  const h=chapterHarness();
  const run=()=>h.runIframeDocumentTask(h.document,()=>h.processWork(h.frame,h.document,h.view,h.context));
  assert.equal((await run()).state,'waiting-for-ai');assert.equal((await run()).state,'waiting-for-ai');
  assert.equal(h.inferences(),0);assert.equal(h.view.saves,0);assert.equal(h.view.submissions,0);assert.equal(h.config.menuIndex,'0');
  assert.equal(h.logs.filter(message=>message.startsWith('AI 未配置')).length,1);
  h.config.ai.apiKey='configured-key';assert.equal((await run()).state,'saved');assert.equal(h.inferences(),1);assert.equal(h.view.saves,1);
});
test('completed chapter work remains completed without credentials',async()=>{
  const h=chapterHarness();h.document.querySelector=()=>({textContent:'已完成'});
  assert.equal((await h.processWork(h.frame,h.document,h.view,h.context)).state,'completed');assert.equal(h.inferences(),0);assert.equal(h.logs.some(message=>message.startsWith('AI 未配置')),false);
});
test('no-key chapter media still plays and only an actual quiz requests manual handling',async()=>{
  const h=chapterHarness(),events={};
  const media={plays:0,pauses:0,ended:false,paused:true,pause(){this.pauses++;this.paused=true;},async play(){this.plays++;this.paused=false;},addEventListener:(type,fn)=>events[type]=fn,removeEventListener:type=>delete events[type]};
  h.document.documentElement.querySelector=()=>media;
  const finished=h.processMedia('video',h.frame,h.document,h.context);await [...h.timers.values()][0]();
  assert.equal(media.plays,1);assert.equal(h.inferences(),0);assert.equal(h.logs.some(message=>message.startsWith('AI 未配置')),false);
  h.quiz.active=true;assert.equal(h.quiz.options.isEnabled(),false);assert.equal(h.quiz.options.isEnabled(),false);
  assert.equal(h.logs.filter(message=>message.startsWith('AI 未配置')).length,1);
  h.quiz.active=false;media.ended=true;events.ended();await finished;assert.equal(h.timers.size,0);
});
test('a no-key chapter with skipped homework can still process a document',async()=>{
  const h=chapterHarness();assert.equal((await h.processWork(h.frame,h.document,h.view,h.context)).state,'waiting-for-ai');
  assert.equal((await h.processPpt(h.view,h.context)).state,'attempted');assert.equal(h.view.scrolls,2);assert.equal(h.inferences(),0);assert.equal(h.view.saves,0);
});
