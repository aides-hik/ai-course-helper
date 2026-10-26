'use strict';
// Independent real-Edge regression: filling an option must not change its stem.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');

const root = path.resolve(__dirname,'..');
const adapter = fs.readFileSync(path.join(root,'ai-adapter.js'),'utf8');
const integration = fs.readFileSync(path.join(root,'ai-integration.js'),'utf8');
const images = fs.readFileSync(path.join(root,'ai-images.js'),'utf8');
const helpers = adapter.slice(adapter.indexOf('  const aiControlVisible = '),adapter.indexOf('  const aiBlankCount = '));
const setup = `
const sleep=async()=>{},vue={reactive:value=>value};
const config={ai:{concurrentEnabled:true,concurrency:2}};
const useConfigStore=()=>config,aiConcurrencyLimit=()=>config.ai.concurrency;
const getAnswerValues=response=>response.values;
let getAnswer=async(question)=>({values:['Option A'],meta:{}});
`;
const checks = String.raw`
(async()=>{try{
  const result={};
  const makeQuestion=(id,stateClass)=>{
    const element=document.createElement('section');
    element.innerHTML='<h3>'+id+'</h3><div class="answerBg"><span class="answer_p">Option A</span></div><div class="answerBg"><span class="answer_p">Option B</span></div>';
    document.body.append(element);
    const options=Array.from(element.querySelectorAll('.answerBg'));
    options.forEach(option=>option.onclick=()=>{options.forEach(row=>row.classList.remove(stateClass));option.classList.add(stateClass);});
    return{title:id,type:'0',element,answer:[],options:{'Option A':options[0],'Option B':options[1]},optionsText:['Option A','Option B'],searchText:{stem:id,options:['Option A','Option B'],images:[]}};
  };
  for(const stateClass of ['check_answer','check_answer_dx','selected','active','checked','is-checked']){
    const question=makeQuestion('choose-'+stateClass,stateClass);
    const current=createAiQuestionContext(question);
    question.options['Option A'].click();
    result[stateClass]=current.isCurrent();current.dispose();
  }
  const batch=[makeQuestion('first-batch','check_answer'),makeQuestion('second-batch','check_answer')];
  const handler={_window:window,parseHtml(){this.questions=batch;},addLog(){},addQuestion(){},
    fillQuestion:(question,current)=>applyAiAnswers(question,window,'zy',(options,answer)=>options[answer],current)};
  result.batchRate=await solveAiQuestions(handler);
  result.batchCancelled=handler.lastSolveResult.cancelled;
  result.batchSelections=batch.map(question=>aiOptionSelected(question.options['Option A']));
  const changed=makeQuestion('actually changed','check_answer');
  const original=createAiQuestionContext(changed);
  changed.options['Option A'].querySelector('.answer_p').textContent='A different option';
  result.actualTextChangeRejected=!original.isCurrent();original.dispose();
  const selectedChange=makeQuestion('selected content changed','check_answer');
  selectedChange.options['Option A'].click();
  const selectedContext=createAiQuestionContext(selectedChange);
  selectedChange.options['Option A'].querySelector('.answer_p').textContent='Changed after selecting';
  result.selectedTextChangeRejected=!selectedContext.isCurrent();selectedContext.dispose();
  const background=makeQuestion('background option status','check_answer');
  background.options['Option A'].classList.add('check_answer');
  background.options['Option A'].style.backgroundImage='url("data:image/png;base64,iVBORw0KGgo=")';
  result.statusBackgroundSupported=!aiQuestionImageDescriptors(background).error;
  const statusIcon=makeQuestion('selection icon image','check_answer');
  const decoration=document.createElement('span');decoration.className='before';
  decoration.innerHTML='<img src="data:image/png;base64,iVBORw0KGgo=">';statusIcon.options['Option A'].prepend(decoration);
  result.statusIconSupported=!aiQuestionImageDescriptors(statusIcon).error;
  const siblingChoiceImage=makeQuestion('sibling choice can be an actual image','check_answer');
  const siblingChoice=document.createElement('span');siblingChoice.className='choice';
  siblingChoice.innerHTML='<img src="data:image/png;base64,iVBORw0KGgo=">';
  siblingChoiceImage.options['Option A'].append(siblingChoice);
  result.siblingChoiceImageRejected=!!aiQuestionImageDescriptors(siblingChoiceImage).error;
  const actualImage=makeQuestion('actual content image','check_answer');
  const actualImageNode=document.createElement('img');actualImageNode.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const contentWrapper=document.createElement('span');contentWrapper.className='choice';contentWrapper.append(actualImageNode);
  actualImage.options['Option A'].querySelector('.answer_p').append(contentWrapper);
  result.missingContentImageRejected=!!aiQuestionImageDescriptors(actualImage).error;
  const imageMarker='\uFFFC[ai-image:0]\uFFFC';
  actualImage.searchText.options[0]+=' '+imageMarker;
  actualImage.searchText.images=[{marker:imageMarker,label:'选项1',element:actualImageNode}];
  result.actualContentImageSupported=!aiQuestionImageDescriptors(actualImage).error;
  const realBackground=makeQuestion('actual content background','check_answer');
  realBackground.options['Option A'].querySelector('.answer_p').style.backgroundImage='url("data:image/png;base64,iVBORw0KGgo=")';
  result.contentBackgroundRejected=!!aiQuestionImageDescriptors(realBackground).error;
  const realCanvas=makeQuestion('actual sibling canvas','check_answer');
  realCanvas.options['Option A'].append(document.createElement('canvas'));
  result.siblingCanvasRejected=!!aiQuestionImageDescriptors(realCanvas).error;
  const ordinary=makeQuestion('normal image initial load','check_answer');
  const image=document.createElement('img');
  image.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  ordinary.element.querySelector('h3').append(image);
  const initially=image.currentSrc;
  const imageContext=createAiQuestionContext(ordinary);
  await image.decode();
  result.imageInitiallyEmpty=initially==='';
  result.sameImageLoadSupported=imageContext.isCurrent();imageContext.dispose();
  document.querySelector('#selection-result').textContent=JSON.stringify(result);
}catch(error){document.querySelector('#selection-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
`;

test('selecting real option rows preserves question identity and lets all questions finish',()=>{
  const fixture=path.join(root,'tests','selection-review-browser.html');
  fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><body><pre id="selection-result"></pre><script>'+setup+helpers+images+integration+checks+'</script>');
  const run=spawnSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
    '--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',
    '--user-data-dir='+path.join(root,'tests','.selection-review-profile'),'--virtual-time-budget=3000','--dump-dom',pathToFileURL(fixture).href
  ],{encoding:'utf8',timeout:20000});
  if(run.error)throw run.error;
  const match=/<pre id="selection-result">(.*?)<\/pre>/s.exec(run.stdout||'');
  assert.ok(match,'Edge did not return the selection result: '+run.stderr.slice(-1000));
  const output=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
  console.log('SELECTION_REVIEW',JSON.stringify(output));
  assert.equal(output.error,undefined,output.error);
  for(const name of ['check_answer','check_answer_dx','selected','active','checked','is-checked'])assert.equal(output[name],true,name+' must preserve identity');
  assert.equal(output.batchRate,100);
  assert.equal(output.batchCancelled,false);
  assert.deepEqual(output.batchSelections,[true,true]);
  assert.equal(output.actualTextChangeRejected,true);
  assert.equal(output.selectedTextChangeRejected,true);
  assert.equal(output.statusBackgroundSupported,true);
  assert.equal(output.statusIconSupported,true);
  assert.equal(output.siblingChoiceImageRejected,true);
  assert.equal(output.missingContentImageRejected,true);
  assert.equal(output.actualContentImageSupported,true);
  assert.equal(output.contentBackgroundRejected,true);
  assert.equal(output.siblingCanvasRejected,true);
  assert.equal(output.sameImageLoadSupported,true);
});
