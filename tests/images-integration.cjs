'use strict';
// Image identity checks use local DOM-shaped nodes and an offline model stub.
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
const node = (tag, children = []) => ({nodeType:1,tagName:tag.toUpperCase(),childNodes:children,getAttribute:()=>null});
function image(attributes = {}) {
  const attrs = {src:'/original.png', ...attributes};
  return {...node('img'),attrs,getAttribute:(name)=>attrs[name] ?? null,
    src:'https://course.test/original.png',currentSrc:'https://course.test/original.png',baseURI:'https://course.test/exam'};
}
function question(title, picture = image(), location = 'stem') {
  const field = {tagName:'INPUT',name:title,type:'text',value:'',isConnected:true,getAttribute:(key)=>key==='type'?'text':null,matches:()=>false,dispatchEvent(){}};
  const heading = node('h3', [{nodeType:3,nodeValue:title},...(location==='stem'?[picture]:[])]);
  const option = {...node('div',location==='option'?[picture]:[]),isConnected:true};
  const element = {...node('section',[heading,option,field]),isConnected:true,
    querySelector:()=>heading,
    querySelectorAll:(selector)=>selector===fieldSelector?[field]:[]};
  return {title,type:'2',expected:[`answer:${title}`],answer:[],element,field,picture,heading,options:{option}};
}
function harness(overrides = {}) {
  const timers = new Map();let timerId = 0;
  const config = {ai:{apiKey:'offline-fixture-key',concurrentEnabled:true,concurrency:3}};
  const context = vm.createContext({AbortController,
    window:{location:{href:'https://course.test/exam'}},
    setInterval(callback){const id=++timerId;timers.set(id,callback);return id;},clearInterval:(id)=>timers.delete(id),
    vue:{reactive:(entry)=>entry},useConfigStore:()=>config,aiConcurrencyLimit:()=>config.ai.concurrency,
    sleep:async()=>{},getAnswer:async(entry)=>({values:entry.expected,meta:{}}),getAnswerValues:(response)=>response.values,
    ...overrides});
  vm.runInContext(helpers+integration+'\nglobalThis.api={context:createAiQuestionContext,stamp:aiQuestionStamp,solve:solveAiQuestions,apply:applyAiAnswers};',context);
  const rows=[];
  const makeHandler=(entries)=>({parseHtml(){this.questions=entries;},addLog(){},addQuestion:(entry)=>rows.push(entry),
    fillQuestion:(entry,current)=>context.api.apply(entry,{Event:class{}},'zy',undefined,current)});
  return {...context.api,config,rows,timers,makeHandler,tick(){for(const callback of [...timers.values()])callback();}};
}

for(const location of ['stem','option'])for(const attribute of ['src','srcset','sizes','data-src','data-original','data-lazy-src','lazy-src','alt']){
  test(`changing ${location} image ${attribute} invalidates the original answer immediately`,()=>{
    const entry=question('Image question',image(),location),api=harness(),current=api.context(entry);
    assert.equal(current.isCurrent(),true);
    entry.picture.attrs[attribute]='replacement';
    assert.equal(current.isCurrent(),false);
    api.tick();assert.equal(current.signal.aborted,true);current.dispose();assert.equal(api.timers.size,0);
  });
}

for(const property of ['src','currentSrc','baseURI'])test(`a live image ${property} change invalidates even unchanged markup`,()=>{
  const entry=question('Responsive image'),api=harness(),current=api.context(entry);
  entry.picture[property]='https://different.test/replacement.png';
  assert.equal(current.isCurrent(),false);current.dispose();assert.equal(api.timers.size,0);
});

for(const attribute of ['src','srcset','sizes','media','type'])test(`picture source ${attribute} changes invalidate the question`,()=>{
  const source=image();source.tagName='SOURCE';
  const picture=node('picture',[source,image()]);
  const entry=question('Picture question',picture),api=harness(),current=api.context(entry);
  source.attrs[attribute]='replacement';
  assert.equal(current.isCurrent(),false);current.dispose();assert.equal(api.timers.size,0);
});

test('video option images outside the normal text selector are part of question identity',()=>{
  const entry=question('Video option',image(),'option');
  const row=entry.options.option;entry.options={};
  entry.element.querySelectorAll=(selector)=>selector==='.ans-videoquiz-opt'?[row]:selector===fieldSelector?[entry.field]:[];
  const api=harness(),current=api.context(entry);
  entry.picture.attrs['data-src']='/new-video-option.png';
  assert.equal(current.isCurrent(),false);current.dispose();
});

test('answer values and editor answer images do not become question content',()=>{
  const entry=question('Stable question'),answerImage=image();
  const editable={...node('div',[answerImage]),getAttribute:(attribute)=>attribute==='contenteditable'?'true':null};
  entry.element.childNodes.push(editable);
  const api=harness(),current=api.context(entry);
  entry.field.value='my answer';answerImage.attrs.src='/my-new-answer-image.png';
  assert.equal(current.isCurrent(),true);current.dispose();
});

test('a lazy image swap while inference is pending cancels siblings before any write',async()=>{
  const entries=[question('First'),question('Second'),question('Third')],signals=[],resolvers=[];
  const api=harness({getAnswer:(entry,current)=>{
    signals.push(current.signal);
    return new Promise((resolve)=>resolvers.push(()=>resolve({values:entry.expected,meta:{}})));
  }});
  const handler=api.makeHandler(entries),pending=api.solve(handler);
  assert.equal(signals.length,3);
  entries[1].picture.attrs.src='/real-loaded-question.png';api.tick();
  assert.equal(await pending,0);assert.ok(signals.every((signal)=>signal.aborted));
  assert.ok(entries.every((entry)=>entry.field.value===''));assert.equal(handler.lastSolveResult.cancelled,true);
  resolvers.forEach((resolve)=>resolve());await Promise.resolve();assert.equal(api.timers.size,0);
});

test('a queued question image change cancels before the queue can issue its request',async()=>{
  const entries=[question('First'),question('Queued')];let requests=0,release;
  const api=harness({getAnswer:(entry)=>{requests++;return new Promise((resolve)=>{release=()=>resolve({values:entry.expected,meta:{}});});}});
  api.config.ai.concurrency=1;
  const handler=api.makeHandler(entries),pending=api.solve(handler);
  entries[1].picture.attrs.srcset='/changed-queue-image.png 2x';
  release();
  assert.equal(await pending,0);assert.equal(requests,1);
  assert.ok(entries.every((entry)=>entry.field.value===''));assert.equal(api.timers.size,0);
});

test('unsupported visual structures appearing or changing invalidate a pending answer',()=>{
  for(const tag of ['svg','canvas','object','embed','iframe','math']){
    const entry=question(`Visual ${tag}`),api=harness(),current=api.context(entry);
    const visual={...node(tag),outerHTML:`<${tag}></${tag}>`,width:100,height:100};
    entry.heading.childNodes.push(visual);
    assert.equal(current.isCurrent(),false,`${tag} appeared`);current.dispose();
    const next=api.context(entry);
    if(tag==='canvas')visual.width=101;else visual.outerHTML=`<${tag} data-new="true"></${tag}>`;
    assert.equal(next.isCurrent(),false,`${tag} changed`);next.dispose();
  }
});

test('background image URLs participate in identity while ordinary styling and selection do not',()=>{
  const entry=question('Background image');
  let background='none';
  entry.heading.ownerDocument={defaultView:{getComputedStyle:()=>({backgroundImage:background,backgroundColor:'red'})}};
  const api=harness(),current=api.context(entry);
  entry.heading.className='selected';
  assert.equal(current.isCurrent(),true);
  background='url("https://course.test/figure-a.png")';
  assert.equal(current.isCurrent(),false);current.dispose();
  const next=api.context(entry);background='url("https://course.test/figure-b.png")';
  assert.equal(next.isCurrent(),false);next.dispose();
});
