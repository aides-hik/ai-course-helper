'use strict';
// Exercise chapter reloads through the real scanner without a platform account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname,'..','chapter-logic.js'),'utf8');
const tick = () => new Promise((resolve)=>setImmediate(resolve));

function frame(src, options={}) {
  const nested=[];
  const wrapper={className:options.finished?'ans-job-finished':'',parentElement:null,querySelector:()=>options.task?{}:null};
  const doc={URL:src,readyState:'complete',questionTitle:options.title||'A stable question',questionFields:[],questionId:'dynamic-question-1',querySelector:()=>null,
    documentElement:{querySelectorAll:()=>nested,querySelector:()=>null}};
  const view={document:doc,saves:0,submits:0,
    async noSubmit(){this.saves++;options.onSave?.();},
    async btnBlueSubmit(){this.submits++;}, async submitCheckTimes(){}};
  return {src,nested,isConnected:true,parentElement:wrapper,contentDocument:doc,contentWindow:view,addEventListener(){},removeEventListener(){}};
}
function harness(options={}) {
  const rootFrame=frame('https://course.test/knowledge/cards?knowledgeid=chapter-1&courseid=course');
  const next={style:{display:''},isConnected:true,clicks:0,textContent:'下一章',click(){this.clicks++;options.onNext?.(api);},getAttribute:()=>null};
  const nextSection={style:{display:''},isConnected:true,clicks:0,textContent:'下一节',click(){this.clicks++;options.onNextSection?.(api);},getAttribute:()=>null};
  const prev=options.modern?nextSection:null;
  const pageRoot={querySelectorAll:(selector)=>selector==='iframe'?[rootFrame]:[],querySelector:(selector)=>selector==='iframe'?rootFrame:selector==='#prevNextFocusNext'?prev:null};
  const logs=[],timers=new Map(),cleanups=[];
  let now=0,inferences=0,timerId=0,documentNext=next;
  const config={platformParams:{cx:{parts:[{params:[{value:false},{value:!!options.autoNext},{value:false}]}]}},otherParams:{params:[{value:0},{value:100}]}};
  const sandbox={URL,AbortController,Date:{now:()=>now},
    document:{documentElement:pageRoot,querySelector:(selector)=>selector.includes('nextChapter')?documentNext:pageRoot.querySelector(selector)},
    window:{location:{href:'https://course.test/mycourse/studentstudy?courseid=course&mooc2=1'}},
    useConfigStore:()=>config,useQuestionStore:()=>({clearQuestion(){}}),useLogStore:()=>({addLog:(message)=>logs.push(message)}),
    setInterval(callback){const id=++timerId;timers.set(id,callback);return id;},clearInterval:(id)=>timers.delete(id),
    MutationObserver:class{observe(){}disconnect(){}},vue:{onBeforeUnmount:(callback)=>cleanups.push(callback)},
    decrypt(){},sleep:async()=>{},aiWaitForDelay:async(_seconds,context)=>{options.beforeAdvance?.(api);return context.isCurrent();},
    CxQuestionHandler:class{
      constructor(_type,iframe){this.iframe=iframe;this.questions=[];}
      parseHtml(){
        const doc=this.iframe.contentDocument;
        this.questions=[{title:doc.questionTitle,type:'0',searchText:{stem:doc.questionTitle,options:['A','B']},optionsText:['A','B'],
          element:{id:doc.questionId,querySelectorAll:()=>doc.questionFields,getAttribute:(name)=>name==='data-question-id'?doc.questionId:null}}];
      }
      async init(isCurrent){
        inferences++;
        options.onSolve?.(api);
        this.lastSolveResult={total:1,filled:1,rate:100,complete:true,cancelled:false,isCurrent,
          refreshVerification(){return this;}};
        return 100;
      }
    },
    concatMap:(mapper)=>mapper,
    rxjs:{from(items){return{pipe(mapper){return{subscribe(callbacks){
      Promise.resolve().then(async()=>{for(const item of items)await mapper(item);await callbacks.complete();}).catch(callbacks.error);
    }}}}}}
  };
  const exposure='    globalThis.chapter={processIframeTask,processWork,checkChapterCompletion};\n    init();';
  vm.runInNewContext(source.replace('    init();',exposure)+'\nuseCxChapterLogic();',sandbox);
  const api={...sandbox.chapter,rootFrame,next,nextSection,prev,pageRoot,config,logs,timers,
    inferences:()=>inferences,advanceTime:(duration)=>now+=duration,
    replaceNext:(value)=>documentNext=value,
    dispose:()=>cleanups.forEach((callback)=>callback())};
  return api;
}
function reload(frame) {
  frame.contentDocument={...frame.contentDocument};
  frame.contentWindow.document=frame.contentDocument;
}

test('same chapter work reloaded by noSubmit is not solved and saved in a loop',async()=>{
  const h=harness();await tick();
  const work=frame('https://course.test/api/work?workId=work-1&jobid=job-1',{task:true});
  work.contentWindow.noSubmit=async function(){this.saves++;reload(work);};
  h.rootFrame.nested.push(work);
  for(let index=0;index<4;index++){h.processIframeTask();await tick();}
  assert.equal(h.inferences(),1,'same questions after save-triggered document reload must not be sent to AI again');
  assert.equal(work.contentWindow.saves,1);
  assert.ok(h.logs.some((message)=>message.includes('重复')||message.includes('已处理')));
  h.dispose();
});

test('new iframe objects and volatile URL tokens cannot restart the same paid work',async()=>{
  const h=harness();await tick();
  const first=frame('https://course.test/api/work?workId=work-1&jobid=job-1&enc=old&t=1',{task:true});
  h.rootFrame.nested.push(first);h.processIframeTask();await tick();
  const replacement=frame('https://course.test/api/work?t=2&jobid=job-1&enc=new&workId=work-1',{task:true});
  h.rootFrame.nested.splice(0,1,replacement);first.isConnected=false;
  h.processIframeTask();await tick();
  assert.equal(h.inferences(),1);
  assert.equal(replacement.contentWindow.saves,0);
  h.dispose();
});

test('a new work id or changed question can still be processed',async()=>{
  const h=harness();await tick();
  const work=frame('https://course.test/api/work?workId=work-1',{task:true});
  h.rootFrame.nested.push(work);h.processIframeTask();await tick();
  reload(work);work.contentDocument.questionTitle='A different question';
  h.processIframeTask();await tick();
  const another=frame('https://course.test/api/work?workId=work-2',{task:true});
  h.rootFrame.nested.push(another);h.processIframeTask();await tick();
  assert.equal(h.inferences(),3);
  h.dispose();
});

test('save reloads changing control identifiers and read-only state do not restart the same questions',async()=>{
  const h=harness();await tick();
  const work=frame('https://course.test/api/work?workId=work-1',{task:true});
  work.contentDocument.questionFields=[{tagName:'INPUT',type:'text',id:'old-field',name:'old-name',readOnly:false,getAttribute:()=>null}];
  h.rootFrame.nested.push(work);h.processIframeTask();await tick();
  reload(work);
  work.contentDocument.questionId='dynamic-question-2';
  work.contentDocument.questionFields=[{tagName:'INPUT',type:'text',id:'new-field',name:'new-name',readOnly:true,disabled:true,getAttribute:()=>null}];
  h.processIframeTask();await tick();
  assert.equal(h.inferences(),1);
  h.dispose();
});

test('new answer controls becoming available permit a new attempt',async()=>{
  const h=harness();await tick();
  const work=frame('https://course.test/api/work?workId=work-1',{task:true});
  h.rootFrame.nested.push(work);h.processIframeTask();await tick();
  reload(work);work.contentDocument.questionFields=[{tagName:'INPUT',type:'text',getAttribute:()=>null}];
  h.processIframeTask();await tick();
  assert.equal(h.inferences(),2);
  h.dispose();
});

test('a duplicate blocked after reload can later show different questions in the same document',async()=>{
  const h=harness();await tick();
  const work=frame('https://course.test/api/work?workId=work-1',{task:true});
  h.rootFrame.nested.push(work);h.processIframeTask();await tick();
  reload(work);h.processIframeTask();await tick();
  assert.equal(h.inferences(),1);
  work.contentDocument.questionTitle='A new question without replacing the document';
  h.processIframeTask();await tick();
  assert.equal(h.inferences(),2);
  h.dispose();
});

test('computed hidden or disabled chapter navigation is never clicked',async()=>{
  for(const mode of ['hidden','disabled','aria-disabled']){
    const h=harness({autoNext:true});await tick();
    h.rootFrame.nested.push(frame('https://course.test/api/work?workId=done',{task:true,finished:true}));
    if(mode==='hidden')h.next.ownerDocument={defaultView:{getComputedStyle:()=>({display:'none'})}};
    if(mode==='disabled')h.next.disabled=true;
    if(mode==='aria-disabled')h.next.getAttribute=(name)=>name==='aria-disabled'?'true':null;
    h.processIframeTask();await tick();h.advanceTime(2000);h.processIframeTask();await tick();
    assert.equal(h.next.clicks,0,mode);
    h.dispose();
  }
});

test('a navigation control replaced during the delay is not clicked',async()=>{
  let replacementClicks=0;
  const h=harness({autoNext:true,beforeAdvance(api){api.replaceNext({style:{display:''},click(){replacementClicks++;}});}});await tick();
  h.rootFrame.nested.push(frame('https://course.test/api/work?workId=done',{task:true,finished:true}));
  h.processIframeTask();await tick();h.advanceTime(2000);h.processIframeTask();await tick();
  assert.equal(h.next.clicks,0);assert.equal(replacementClicks,0);
  h.dispose();
});

test('returning to an already departed chapter stops automatic chapter cycles',async()=>{
  const h=harness({autoNext:true});await tick();
  h.rootFrame.nested.push(frame('https://course.test/api/work?workId=done',{task:true,finished:true}));
  const scan=async()=>{h.processIframeTask();await tick();h.advanceTime(2000);h.processIframeTask();await tick();};
  await scan();assert.equal(h.next.clicks,1);
  h.rootFrame.src='https://course.test/knowledge/cards?knowledgeid=chapter-2&courseid=course';reload(h.rootFrame);
  await scan();assert.equal(h.next.clicks,2,'a new chapter must still advance');
  h.rootFrame.src='https://course.test/knowledge/cards?courseid=course&knowledgeid=chapter-1';reload(h.rootFrame);
  await scan();assert.equal(h.next.clicks,2,'a revisited chapter must stop the cycle');
  h.dispose();
});

test('the visible next-section route preserves one-click behavior and stops automatic chapter cycles',async()=>{
  const h=harness({autoNext:true,modern:true});await tick();
  h.next.style.display='none';
  h.rootFrame.nested.push(frame('https://course.test/api/work?workId=done',{task:true,finished:true}));
  const scan=async()=>{h.processIframeTask();await tick();h.advanceTime(2000);h.processIframeTask();await tick();};
  await scan();
  h.processIframeTask();await tick();
  assert.equal(h.nextSection.clicks,1);
  assert.equal(h.next.clicks,0);
  h.rootFrame.src='https://course.test/knowledge/cards?knowledgeid=chapter-2&courseid=course';reload(h.rootFrame);
  await scan();assert.equal(h.nextSection.clicks,2,'A new section remains eligible');
  h.rootFrame.src='https://course.test/knowledge/cards?courseid=course&knowledgeid=chapter-1';reload(h.rootFrame);
  await scan();
  assert.equal(h.nextSection.clicks,2,'Returning to a departed section must stop the cycle');
  assert.equal(h.next.clicks,0,'A hidden legacy button must never be clicked');
  h.dispose();
});
