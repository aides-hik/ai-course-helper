"""Review model settings in the complete userscript with offline GM responses."""
from pathlib import Path
import argparse
import html
import json
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--width',type=int,default=1280)
parser.add_argument('--screenshot',action='store_true')
parser.add_argument('--preview',action='store_true',help='Capture the default settings screen after its UI checks')
parser.add_argument('--glass-background',action='store_true',help='Render an offline course page behind the panel for glass readability review')
parser.add_argument('--glass-fallback',action='store_true',help='Disable only SVG backdrop-filter support detection while retaining real standard blur')
args = parser.parse_args()
ARTIFACT = ROOT / "ai-course-helper.user.js"
source = ARTIFACT.read_text(encoding="utf-8")
fixture_dir = ROOT / "tests" / "browser-fixture" / "mooc2" / "work"
fixture_dir.mkdir(parents=True, exist_ok=True)

# Reuse prepare_browser_smoke.py's local dependency and resource cache. This
# review never downloads dependencies and never contacts either model service.
tags = []
for index, _url in enumerate(re.findall(r"^// @require\s+(https://\S+)", source, re.M)):
    cached = fixture_dir / f"dependency-{index}.js"
    assert cached.exists(), f"Missing local browser dependency: {cached.name}"
    tags.append(f'<script src="{cached.name}"></script>')
resources = {}
for name, _url in re.findall(r"^// @resource\s+(ElementPlus\S*)\s+(https://\S+)", source, re.M):
    cached = fixture_dir / f"{name}.css"
    assert cached.exists(), f"Missing local browser resource: {cached.name}"
    resources[name] = cached.read_text(encoding="utf-8")

setup = r'''
if(window.__glassFallback){
  const fixtureCssSupports=CSS.supports.bind(CSS);
  CSS.supports=(...args)=>/backdrop-filter/i.test(args.join(' '))&&/url\s*\(/i.test(args.join(' '))?false:fixtureCssSupports(...args);
}
const fixturePrefix = window.__modelReviewPrefix;
const fixtureRead = (name, fallback) => {
  const text=sessionStorage.getItem(fixturePrefix+name);
  return text===null?fallback:JSON.parse(text);
};
const fixtureWrite = (name, value) => sessionStorage.setItem(fixturePrefix+name,JSON.stringify(value));
window.__modelErrors=[];
window.__modelCalls=[];
window.__modelPostCalls=[];
window.__modelXss=0;
window.addEventListener('error',event=>window.__modelErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.__modelErrors.push(String(event.reason)));
window.GM_info={script:{name:'Model settings offline review',author:'local',namespace:'local',version:'review',description:'local browser regression'}};
window.GM_getValue=(key,fallback)=>fixtureRead('gm:'+key,fallback);
window.GM_setValue=(key,value)=>{
  fixtureWrite('gm:'+key,value);
  const writes=fixtureRead('writes',[]);writes.push(key);fixtureWrite('writes',writes);
};
window.GM_addStyle=css=>{const node=document.createElement('style');node.textContent=css;document.head.append(node);return node;};
window.GM_getResourceText=name=>window.__modelResources[name]||'';
window.GM_xmlhttpRequest=request=>{
  if(request.method==='POST'){
    const phase=fixtureRead('phase','initial'),deepseek=phase==='post-deepseek';
    if(!['saved','post-deepseek'].includes(phase))throw Error('Unexpected answer request before explicit save');
    const expected=deepseek?'https://deepseek-route.example/gateway/chat/completions?tenant=math':'https://openai-route.example/proxy/custom-answer?region=west';
    if(request.url!==expected||request.anonymous!==true)throw Error('Wrong custom answer endpoint or credential mode');
    if(request.headers?.Authorization!=='Bearer '+(deepseek?'offline-deepseek-key':'offline-openai-final'))throw Error('Custom route received wrong provider key');
    const body=JSON.parse(request.data);
    if(deepseek?(!body.messages||body.model!=='deepseek-manual-final'||body.reasoning_effort!=='low'):(!body.input||body.model!=='openai-manual-final'||body.reasoning?.effort!=='high'))throw Error('Custom endpoint must preserve the selected provider protocol and effort');
    const record={request,aborted:false};window.__modelPostCalls.push(record);
    const answer={answerable:true,choice_indices:[1],text_answers:[],judgement:'unknown',explanation:'offline custom endpoint fixture'};
    const payload=deepseek?{choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]};
    queueMicrotask(()=>request.onload({status:200,responseText:JSON.stringify(payload)}));
    return{abort(){record.aborted=true;request.onabort?.();}};
  }
  if(request.method!=='GET')throw Error('Unexpected method in settings fixture');
  const record={request,aborted:false};window.__modelCalls.push(record);
  return{abort(){record.aborted=true;request.onabort?.();}};
};
window.unsafeWindow=window;
const fixtureAttachShadow=Element.prototype.attachShadow;
Element.prototype.attachShadow=function(options){return fixtureAttachShadow.call(this,{...options,mode:'open'});};
const fixtureResult=document.createElement('pre');fixtureResult.id='model-settings-result';fixtureResult.style.display='none';fixtureResult.textContent=JSON.stringify({stage:'mount'});document.body.append(fixtureResult);
const fixtureAssert=(condition,message)=>{if(!condition)throw Error(message);};
const fixtureTick=async()=>{await Promise.resolve();await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,0));};
const fixtureWait=async(check,label)=>{
  for(let attempt=0;attempt<100;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('Timed out: '+label);
};
const fixtureReveal=async(element)=>{
  for(let ancestor=element?.parentElement;ancestor;ancestor=ancestor.parentElement){
    if(ancestor.matches('details')&&!ancestor.open){ancestor.querySelector(':scope > summary')?.click();await fixtureTick();}
  }
};
const fixtureInput=async(element,value)=>{
  fixtureAssert(!!element,'Missing editable field');
  await fixtureReveal(element);
  const prototype=element.matches('textarea')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);
  element.dispatchEvent(new Event('input',{bubbles:true}));await fixtureTick();
};
const fixtureSelect=async(element,value)=>{
  fixtureAssert(!!element,'Missing select');element.value=value;
  fixtureAssert(element.value===value,'Requested option unavailable: '+value);
  element.dispatchEvent(new Event('change',{bubbles:true}));await fixtureTick();
};
const fixtureReply=async(record,data,status=200)=>{
  const writes=fixtureRead('writes',[]).length;
  record.request.onload({status,responseText:JSON.stringify(data)});await fixtureTick();
  fixtureAssert(fixtureRead('writes',[]).length===writes,'A model-list reply must not save settings');
};
const fixtureModels=ids=>({object:'list',data:ids.map(id=>({id,object:'model',name:id}))});
if(['saved','post-deepseek'].includes(fixtureRead('phase','initial'))){
  const question=document.createElement('section');question.id='fixture-endpoint-question';question.className='questionLi';
  question.innerHTML='<h3><span class="colorShallow">【单选题】</span>Custom endpoint offline question</h3>'+[0,1].map(index=>'<div class="answerBg"><input type="radio" name="endpoint-q"><span class="before">'+String.fromCharCode(65+index)+'</span><span class="answer_p">Option '+index+'</span></div>').join('');
  document.body.append(question);
  for(const row of question.querySelectorAll('.answerBg'))row.addEventListener('click',()=>{
    for(const input of question.querySelectorAll('input'))input.checked=false;
    row.querySelector('input').checked=true;row.classList.add('check_answer');
  });
}
setTimeout(async()=>{try{
  let shadow;
  await fixtureWait(()=>{shadow=[...document.querySelectorAll('body > div')].map(node=>node.shadowRoot).find(root=>root?.querySelector('.ai-config'));return !!shadow;},'settings mount');
  const provider=()=>shadow.querySelector('.ai-provider-select');
  const key=()=>shadow.querySelector('input[type="password"]');
  const model=()=>shadow.querySelector('.ai-model-row input');
  const thought=()=>shadow.querySelector('.ai-reasoning-select');
  const fieldInput=selector=>{const node=shadow.querySelector(selector);return node?.matches('input,textarea')?node:node?.querySelector('input,textarea');};
  const requestUrl=()=>fieldInput('.ai-request-url');
  const modelsUrl=()=>fieldInput('.ai-models-url');
  const routeDefaults={openai:'https://api.openai.com/v1/responses',deepseek:'https://api.deepseek.com/chat/completions'};
  const routes={openai:'https://openai-route.example/proxy/v1/responses?region=west',deepseek:'https://deepseek-route.example/gateway/chat/completions?tenant=math'};
  const finalRoutes={...routes,openai:'https://openai-route.example/proxy/custom-answer?region=west'};
  const listedRoutes={openai:'https://openai-route.example/proxy/v1/models?region=west',deepseek:'https://deepseek-route.example/gateway/models?tenant=math'};
  const explicitRoutes={openai:'https://openai-list.example/catalog/models?account=west',deepseek:'https://deepseek-list.example/catalog/models?account=math'};
  const expectedModelRoutes={openai:'https://api.openai.com/v1/models',deepseek:'https://api.deepseek.com/models'};
  const fetchButton=()=>shadow.querySelector('.ai-fetch-models');
  const models=()=>shadow.querySelector('.ai-model-select');
  const values=element=>[...element?.options||[]].map(option=>option.value);
  const text=()=>shadow.textContent;
  const noUnexpected=()=>fixtureAssert(window.__modelErrors.length===0,'Uncaught browser error: '+window.__modelErrors.join('; '));
  const chooseProvider=async value=>fixtureSelect(provider(),value);
  const stage=name=>fixtureResult.textContent=JSON.stringify({stage:name});
  const glassReport=()=>{
    if(!window.__glassBackground&&!window.__glassFallback)return undefined;
    const card=shadow.querySelector('.el-card'),shell=getComputedStyle(card),edge=getComputedStyle(card,'::before');
    fixtureAssert(/blur\(18px\)/.test(shell.backdropFilter),'Glass shell must preserve its standard blur');
    if(window.__glassFallback){
      fixtureAssert(!shadow.querySelector('#course-helper-glass'),'SVG-disabled fixture must not create its refraction filter');
      fixtureAssert(!/url\(/.test(edge.backdropFilter)&&/blur\(/.test(edge.backdropFilter),'SVG fallback must retain the standard blurred rim');
    }
    return {background:!!window.__glassBackground,mode:window.__glassFallback?'standard-blur':'svg-allowed',shellFilter:shell.backdropFilter,edgeFilter:edge.backdropFilter,svgFilter:!!shadow.querySelector('#course-helper-glass'),urlFieldBackground:getComputedStyle(requestUrl()).backgroundColor};
  };
  const saveVisible=()=>{
    const save=shadow.querySelector('.ai-save'),bounds=save?.getBoundingClientRect();
    fixtureAssert(bounds&&bounds.width>0&&bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight,'Save action must remain in viewport: '+JSON.stringify(bounds?.toJSON()));
    const hit=shadow.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
    fixtureAssert(hit===save||save.contains(hit),'Save action must not be covered by scrolling content');
    return bounds;
  };
  const checkSaveAtScrollPositions=async()=>{
    const scroll=shadow.querySelector('.ai-config-scroll'),savebar=shadow.querySelector('.ai-savebar'),save=shadow.querySelector('.ai-save');
    fixtureAssert(scroll&&savebar?.contains(save)&&!scroll.contains(save),'Save action must be outside the configuration scroll area');
    for(const fraction of [0,0.5,1]){scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*fraction;await fixtureTick();saveVisible();}
    scroll.scrollTop=0;await fixtureTick();
  };
  const clickFetch=async()=>{
    const count=window.__modelCalls.length,writes=fixtureRead('writes',[]).length;fetchButton().click();await fixtureTick();
    fixtureAssert(fixtureRead('writes',[]).length===writes,'Fetch action must not save settings');
    fixtureAssert(window.__modelCalls.length===count+1,'Fetch click must create exactly one GET');
    const record=window.__modelCalls.at(-1);
    const expected=expectedModelRoutes[provider().value];
    fixtureAssert(record.request.url===expected,'Model listing must use the displayed/derived URL: '+record.request.url);
    fixtureAssert(record.request.anonymous===true,'Model listing must be anonymous');
    fixtureAssert(!record.request.data,'GET must not contain an answer request body');
    fixtureAssert(record.request.headers?.Authorization==='Bearer '+key().value.trim(),'Provider must use only its displayed key');
    return record;
  };
  if(fixtureRead('phase','initial')==='post-deepseek'){
    stage('deepseek-custom-post');
    fixtureAssert(provider().value==='deepseek'&&requestUrl().value===routes.deepseek&&modelsUrl().value===explicitRoutes.deepseek,'DeepSeek saved URLs must restore independently');
    await fixtureWait(()=>window.__modelPostCalls.length===1&&document.querySelectorAll('#fixture-endpoint-question input')[1]?.checked&&shadow.querySelector('.answer-result.answer-result--success'),'DeepSeek custom endpoint must answer and fill the real question');
    fixtureAssert(window.__modelCalls.length===0,'Saved endpoint must not cause a model GET');noUnexpected();
    const resultSheet=shadow.querySelector('.question-sheet'),resultBounds=resultSheet.getBoundingClientRect();
    fixtureAssert(resultBounds.height<=Math.min(180,innerHeight*0.2)+1&&resultSheet.tabIndex===0,'Answer results must stay bounded and keyboard scrollable');
    await checkSaveAtScrollPositions();
    document.querySelector('#fixture-endpoint-question').remove();
    const previous=fixtureRead('report',{});
    fixtureResult.textContent=JSON.stringify({...previous,customAnswerPosts:['openai','deepseek'],savedAndReloaded:true,savedFields:fixtureRead('writes',[]).length,resultLayout:{resultHeight:resultBounds.height,configScrollHeight:shadow.querySelector('.ai-config-scroll').clientHeight,save:saveVisible().toJSON()},passed:true});
    return;
  }
  if(fixtureRead('phase','initial')==='saved'){
    stage('reload');
    const previous=fixtureRead('report',{});
    fixtureAssert(provider().value==='openai','Saved provider must restore');
    fixtureAssert(key().value==='offline-openai-final','OpenAI key must restore after save');
    fixtureAssert(model().value==='openai-manual-final','OpenAI manual model must restore after save');
    fixtureAssert(thought().value==='high','OpenAI effort must restore after save');
    fixtureAssert(requestUrl().value===finalRoutes.openai&&modelsUrl().value===explicitRoutes.openai,'OpenAI custom URLs must restore after save');
    await fixtureWait(()=>window.__modelPostCalls.length===1&&document.querySelectorAll('#fixture-endpoint-question input')[1]?.checked&&shadow.querySelector('.answer-result.answer-result--success'),'OpenAI custom endpoint must answer and fill the real question');
    await chooseProvider('deepseek');
    fixtureAssert(key().value==='offline-deepseek-key','DeepSeek key must restore independently');
    fixtureAssert(model().value==='deepseek-manual-final','DeepSeek manual model must restore independently');
    fixtureAssert(thought().value==='low','DeepSeek effort must restore independently');
    fixtureAssert(requestUrl().value===routes.deepseek&&modelsUrl().value===explicitRoutes.deepseek,'DeepSeek custom URLs must restore independently');
    fixtureAssert(window.__modelCalls.length===0,'Reload and provider selection must not fetch models');
    const writes=fixtureRead('writes',[]);
    for(const field of ['model','deepseekModel','reasoningEffort','deepseekReasoningEffort','apiUrl','modelsUrl','deepseekApiUrl','deepseekModelsUrl'])fixtureAssert(writes.some(name=>name.endsWith(JSON.stringify(['ai',field]))),'Save must persist '+field);
    noUnexpected();
    fixtureWrite('phase','post-deepseek');shadow.querySelector('.ai-save').click();
    return;
  }
  stage('defaults');
  fixtureAssert(!!fetchButton()&&!!thought(),'All new model settings controls must mount');
  const panelToggle=shadow.querySelector('.ai-panel-toggle');
  fixtureAssert(panelToggle?.matches('button[type="button"]')&&panelToggle.getAttribute('aria-expanded')==='true','Panel toggle must be a native expanded button');
  const beforeToggleBounds=shadow.querySelector('.main-page').getBoundingClientRect();
  panelToggle.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:beforeToggleBounds.right-20,clientY:beforeToggleBounds.top+15}));
  document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:800,clientY:500}));
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:800,clientY:500}));await fixtureTick();
  const afterToggleBounds=shadow.querySelector('.main-page').getBoundingClientRect();
  fixtureAssert(beforeToggleBounds.left===afterToggleBounds.left&&beforeToggleBounds.top===afterToggleBounds.top,'Panel toggle must not initiate header dragging');
  panelToggle.focus();fixtureAssert(shadow.activeElement===panelToggle,'Panel toggle must accept keyboard focus');
  panelToggle.click();await fixtureTick();
  fixtureAssert(panelToggle.getAttribute('aria-expanded')==='false'&&/展开/.test(panelToggle.getAttribute('aria-label')),'Collapsing the panel must update its accessible state: '+JSON.stringify({expanded:panelToggle.getAttribute('aria-expanded'),label:panelToggle.getAttribute('aria-label'),rects:shadow.querySelector('.ai-config').getClientRects().length}));
  fixtureAssert(shadow.querySelector('.ai-config').getClientRects().length===0,'Collapsing must hide the settings content');
  panelToggle.click();await fixtureTick();
  fixtureAssert(panelToggle.getAttribute('aria-expanded')==='true'&&/收起/.test(panelToggle.getAttribute('aria-label')),'Reopening must restore the full panel state');
  fixtureAssert(window.__modelCalls.length===0,'Panel toggling must not request models');
  fixtureAssert(requestUrl()?.matches('textarea')&&requestUrl().rows>=2&&!requestUrl().closest('details'),'Answer URL must be a multiline field outside collapsed sections');
  const endpointDetails=shadow.querySelector('.ai-endpoint-details'),advancedDetails=shadow.querySelector('.ai-advanced-details');
  fixtureAssert(endpointDetails?.matches('details')&&advancedDetails?.matches('details')&&!endpointDetails.open&&!advancedDetails.open,'Interface and advanced options must start collapsed');
  const detailWrites=fixtureRead('writes',[]).length;
  for(const details of [endpointDetails,advancedDetails]){
    const summary=details.querySelector(':scope > summary');fixtureAssert(!!summary,'Collapsed settings need a native summary');
    summary.focus();fixtureAssert(shadow.activeElement===summary,'Settings summary must accept keyboard focus');
    summary.click();await fixtureTick();fixtureAssert(details.open,'Settings summary must reveal its fields');
    summary.click();await fixtureTick();fixtureAssert(!details.open,'Settings summary must collapse its fields');
  }
  fixtureAssert(fixtureRead('writes',[]).length===detailWrites&&window.__modelCalls.length===0,'Disclosure changes must not save settings or fetch models');
  for(const element of [provider(),key(),model(),requestUrl(),modelsUrl(),thought()]){
    fixtureAssert(element?.labels?.length>0||!!element?.getAttribute('aria-label')?.trim(),'Editable settings need an accessible label: '+element?.className);
  }
  await checkSaveAtScrollPositions();
  if(window.__uiPreview){
    fixtureResult.textContent=JSON.stringify({passed:true,preview:true,defaultDisclosuresClosed:true,keyboardFocusablePanelToggle:true,multilineUrl:true,accessibleLabels:true,savePinnedAtAllScrollPositions:true,glass:glassReport(),viewport:[innerWidth,innerHeight],scrollHeight:shadow.querySelector('.ai-config-scroll').clientHeight,save:saveVisible().toJSON()});
    return;
  }
  fixtureAssert(requestUrl()?.value===routeDefaults.openai&&modelsUrl()?.value==='','Default OpenAI request URL must be visible and editable');
  fixtureAssert(text().includes('https://api.openai.com/v1/models'),'Actual default model-list URL must be visible');
  fixtureAssert(!!shadow.querySelector('.ai-reset-urls'),'Reset addresses control must be available');
  fixtureAssert(model().closest('.el-input')!==null,'Manual model input must remain an Element Plus input');
  fixtureAssert(fetchButton().getAttribute('aria-label')==='获取模型','Fetch action must have stable accessible label');
  fixtureAssert(window.__modelCalls.length===0,'Mount must not fetch models');
  fixtureAssert(thought().value==='default','OpenAI effort must default to provider default');
  fixtureAssert(JSON.stringify(values(thought()))===JSON.stringify(['default','none','minimal','low','medium','high','xhigh','max']),'OpenAI effort options must be complete');
  fetchButton().click();await fixtureTick();
  fixtureAssert(window.__modelCalls.length===0,'Missing key must not send a GET');
  fixtureAssert(/(?:填写|输入|缺少).{0,30}(?:Key|密钥)|(?:Key|密钥).{0,30}(?:填写|输入|缺少)/i.test(text()),'Missing key must show an explanation');
  await fixtureInput(key(),'offline-openai-key');
  await fixtureInput(model(),'openai-manual-start');
  await fixtureInput(requestUrl(),routes.openai);expectedModelRoutes.openai=listedRoutes.openai;
  fixtureAssert(text().includes(listedRoutes.openai),'Derived model URL must preserve prefix and query');
  fixtureAssert(window.__modelCalls.length===0,'Typing credentials or a model must not fetch');

  stage('openai-list');
  const first=await clickFetch();
  fixtureAssert(fetchButton().disabled&&/获取中/.test(fetchButton().textContent),'Pending listing must show fetching state');
  const malicious='<img/src=x/onerror=window.__modelXss=1>';
  const payload=fixtureModels(['gpt-ui-a','gpt-ui-b',malicious]);
  payload.data[0].name='<img src=x onerror="window.__modelXss=2">';
  await fixtureReply(first,payload);
  fixtureAssert(!fetchButton().disabled,'Completed request must release fetching state');
  fixtureAssert(values(models()).includes('gpt-ui-a')&&values(models()).includes('gpt-ui-b'),'Fetched OpenAI models must be selectable');
  fixtureAssert(model().value==='openai-manual-start','Fetching must not automatically change the model');
  fixtureAssert(thought().value==='default','Fetching must not automatically change effort');
  fixtureAssert(!shadow.querySelector('.ai-model-select img,.ai-model-select script')&&window.__modelXss===0,'Model option content must be rendered as text');
  await fixtureSelect(models(),'gpt-ui-b');
  fixtureAssert(model().value==='gpt-ui-b','Selecting a fetched model must update manual input');
  await fixtureInput(model(),'openai-manual-final');
  await fixtureSelect(thought(),'high');
  fixtureAssert(window.__modelCalls.length===1,'Selecting a model or effort must not call the API');

  stage('deepseek-list');
  await chooseProvider('deepseek');
  fixtureAssert(key().value===''&&model().value==='deepseek-flash','DeepSeek must keep its own default credentials and model');
  fixtureAssert(requestUrl().value===routeDefaults.deepseek&&modelsUrl().value==='','DeepSeek defaults must be independent from edited OpenAI URLs');
  fixtureAssert(!values(models()).includes('gpt-ui-a'),'OpenAI list must not leak into DeepSeek');
  fixtureAssert(thought().value==='default','DeepSeek effort default must be independent');
  fixtureAssert(JSON.stringify(values(thought()))===JSON.stringify(['default','none','low','high','max']),'DeepSeek effort options must match its supported levels');
  await fixtureInput(key(),'offline-deepseek-key');
  await fixtureInput(requestUrl(),routes.deepseek);expectedModelRoutes.deepseek=listedRoutes.deepseek;
  fixtureAssert(text().includes(listedRoutes.deepseek),'Derived DeepSeek list URL must preserve prefix and query');
  const ds=await clickFetch();
  await fixtureReply(ds,fixtureModels(['deepseek-ui-a','deepseek-ui-b']));
  fixtureAssert(model().value==='deepseek-flash','DeepSeek fetch must not select a model automatically');
  await fixtureSelect(models(),'deepseek-ui-b');
  fixtureAssert(model().value==='deepseek-ui-b','DeepSeek list selection must update its model input');
  await fixtureInput(model(),'deepseek-manual-final');
  await fixtureSelect(thought(),'low');
  const beforeManualList=window.__modelCalls.length;
  await fixtureInput(modelsUrl(),explicitRoutes.deepseek);expectedModelRoutes.deepseek=explicitRoutes.deepseek;
  fixtureAssert(window.__modelCalls.length===beforeManualList,'Typing an explicit list URL must not request it');
  const dsExplicit=await clickFetch();await fixtureReply(dsExplicit,fixtureModels(['deepseek-ui-a','deepseek-ui-b']));
  await chooseProvider('openai');
  fixtureAssert(model().value==='openai-manual-final'&&thought().value==='high','OpenAI model and effort must survive provider switching');
  fixtureAssert(requestUrl().value===routes.openai&&modelsUrl().value==='','OpenAI URLs must survive provider switching');
  fixtureAssert(values(models()).includes('gpt-ui-a')&&!values(models()).includes('deepseek-ui-a'),'Provider model lists must remain separate');
  await chooseProvider('deepseek');
  fixtureAssert(model().value==='deepseek-manual-final'&&thought().value==='low','DeepSeek model and effort must survive provider switching');
  fixtureAssert(requestUrl().value===routes.deepseek&&modelsUrl().value===explicitRoutes.deepseek,'DeepSeek URLs must survive provider switching');
  fixtureAssert(values(models()).includes('deepseek-ui-a'),'Previously fetched DeepSeek list must remain available');
  await chooseProvider('openai');

  stage('errors');
  const unauthorized=await clickFetch();
  await fixtureReply(unauthorized,{error:{message:'offline secret response must not be shown'}},401);
  fixtureAssert(/401|认证|密钥|Key/i.test(text()),'401 must show a useful authentication error');
  fixtureAssert(!text().includes('offline secret response must not be shown'),'Provider raw errors must not leak to the panel');
  const timedOut=await clickFetch();timedOut.request.ontimeout();await fixtureTick();
  fixtureAssert(/超时/.test(text())&&!fetchButton().disabled,'Timeout must explain the error and release the action');

  stage('stale-provider');
  const staleProvider=await clickFetch();
  await chooseProvider('deepseek');
  fixtureAssert(staleProvider.aborted&&!fetchButton().disabled,'Provider change must abort and release old fetch');
  await fixtureReply(staleProvider,fixtureModels(['stale-provider-model']));
  fixtureAssert(!values(models()).includes('stale-provider-model')&&model().value==='deepseek-manual-final','Stale provider response must not change current model or list');
  await chooseProvider('openai');
  fixtureAssert(!values(models()).includes('stale-provider-model'),'Stale provider response must not be cached for later');

  stage('stale-key');
  const staleKey=await clickFetch();
  await fixtureInput(key(),'offline-openai-other');
  fixtureAssert(staleKey.aborted&&!fetchButton().disabled,'Key edit must abort and release old fetch');
  await fixtureReply(staleKey,fixtureModels(['stale-key-model']));
  fixtureAssert(!values(models()).includes('stale-key-model')&&model().value==='openai-manual-final','Stale key response must not replace the list or chosen model');

  stage('aba');
  await fixtureInput(key(),'offline-openai-final');
  const keyAba=await clickFetch();
  await fixtureInput(key(),'offline-openai-temporary');
  await fixtureInput(key(),'offline-openai-final');
  await fixtureReply(keyAba,fixtureModels(['stale-key-aba-model']));
  fixtureAssert(keyAba.aborted&&!values(models()).includes('stale-key-aba-model'),'Returning to an old key must not restore ownership to its stale fetch');
  const providerAba=await clickFetch();
  await chooseProvider('deepseek');await chooseProvider('openai');
  await fixtureReply(providerAba,fixtureModels(['stale-provider-aba-model']));
  fixtureAssert(providerAba.aborted&&!values(models()).includes('stale-provider-aba-model'),'Returning to a provider must not restore ownership to its stale fetch');

  stage('stale-urls');
  const listed=await clickFetch();await fixtureReply(listed,fixtureModels(['before-url-change']));
  const requestStale=await clickFetch(),requestCount=window.__modelCalls.length;
  await fixtureInput(requestUrl(),'https://openai-other.example/v1/responses?region=other');
  expectedModelRoutes.openai='https://openai-other.example/v1/models?region=other';
  fixtureAssert(requestStale.aborted&&!models()&&window.__modelCalls.length===requestCount,'Request URL editing must abort/clear model listing without fetching');
  await fixtureReply(requestStale,fixtureModels(['stale-request-url-model']));
  fixtureAssert(!values(models()).includes('stale-request-url-model'),'Old request URL reply must be discarded');
  await fixtureInput(requestUrl(),routes.openai);expectedModelRoutes.openai=listedRoutes.openai;
  const requestAba=await clickFetch();
  await fixtureInput(requestUrl(),'https://openai-other.example/v1/responses');
  await fixtureInput(requestUrl(),routes.openai);
  await fixtureReply(requestAba,fixtureModels(['stale-request-url-aba-model']));
  fixtureAssert(requestAba.aborted&&!values(models()).includes('stale-request-url-aba-model'),'Request URL ABA must not revive old ownership');
  const modelUrlStale=await clickFetch();
  await fixtureInput(modelsUrl(),explicitRoutes.openai);expectedModelRoutes.openai=explicitRoutes.openai;
  fixtureAssert(modelUrlStale.aborted&&!models(),'Model-list URL editing must abort and clear the list');
  await fixtureReply(modelUrlStale,fixtureModels(['stale-model-list-url-model']));
  fixtureAssert(!values(models()).includes('stale-model-list-url-model'),'Old model-list URL reply must be discarded');
  const modelsAba=await clickFetch();
  await fixtureInput(modelsUrl(),'https://openai-list-other.example/models');
  await fixtureInput(modelsUrl(),explicitRoutes.openai);
  await fixtureReply(modelsAba,fixtureModels(['stale-model-list-url-aba-model']));
  fixtureAssert(modelsAba.aborted&&!values(models()).includes('stale-model-list-url-aba-model'),'Model-list URL ABA must not revive old ownership');

  stage('reset-and-custom-model-list');
  const noCalls=window.__modelCalls.length;
  await fixtureReveal(shadow.querySelector('.ai-reset-urls'));
  shadow.querySelector('.ai-reset-urls').click();await fixtureTick();
  fixtureAssert(requestUrl().value===routeDefaults.openai&&modelsUrl().value===''&&window.__modelCalls.length===noCalls,'Reset must restore current provider addresses without fetching');
  fixtureAssert(model().value==='openai-manual-final'&&thought().value==='high'&&key().value==='offline-openai-final','Reset addresses must preserve chosen model, effort and credential');
  await chooseProvider('deepseek');
  fixtureAssert(requestUrl().value===routes.deepseek&&modelsUrl().value===explicitRoutes.deepseek,'Resetting OpenAI URLs must preserve DeepSeek URLs');
  await chooseProvider('openai');
  await fixtureInput(requestUrl(),finalRoutes.openai);
  fetchButton().click();await fixtureTick();
  fixtureAssert(window.__modelCalls.length===noCalls,'An unknown answer path must require explicit models URL without sending a GET');
  fixtureAssert(/模型.{0,30}(?:URL|地址)|(?:URL|地址).{0,30}模型/.test(text()),'Missing derivable model URL must have an actionable explanation');
  fixtureAssert(requestUrl().value===finalRoutes.openai,'Unknown answer paths must remain usable as entered');
  await fixtureInput(modelsUrl(),explicitRoutes.openai);expectedModelRoutes.openai=explicitRoutes.openai;
  fixtureAssert(text().includes(explicitRoutes.openai),'Explicit effective model-list URL must be visible');
  const final=await clickFetch();await fixtureReply(final,fixtureModels(['gpt-final-model']));
  fixtureAssert(values(models()).includes('gpt-final-model')&&model().value==='openai-manual-final','A fresh request must still work after cancellations');
  fixtureAssert(window.__modelXss===0,'Model text must never execute HTML');
  noUnexpected();
  stage('layout');
  const beforeLongUrlCalls=window.__modelCalls.length,beforeLongUrl=requestUrl().value;
  const longUrl='https://openai-route.example/proxy/'+('very-long-segment-'.repeat(18))+'/responses?region='+('longvalue'.repeat(12));
  await fixtureInput(requestUrl(),longUrl);
  fixtureAssert(requestUrl().value===longUrl&&window.__modelCalls.length===beforeLongUrlCalls,'Long URL editing must preserve the full value and stay local');
  requestUrl().focus();requestUrl().scrollIntoView({block:'center'});await fixtureTick();
  const longBounds=requestUrl().getBoundingClientRect();
  fixtureAssert(longBounds.width>0&&longBounds.left>=0&&longBounds.right<=innerWidth&&getComputedStyle(requestUrl()).whiteSpace!=='nowrap','Long URL editor must wrap within the panel');
  const scrollBounds=shadow.querySelector('.ai-config-scroll').getBoundingClientRect();
  fixtureAssert(shadow.activeElement===requestUrl()&&longBounds.top>=scrollBounds.top&&longBounds.bottom<=scrollBounds.bottom,'Focused URL editor must be visible inside the scroll area');
  await fixtureInput(requestUrl(),beforeLongUrl);
  let resizeAndDrag=false,dispatchedResizeEvents=0,nativeResizeEvents=0;
  if(window.frameElement){
    const frame=window.frameElement;
    const panel=shadow.querySelector('.main-page');
    window.addEventListener('resize',()=>nativeResizeEvents++);
    const assertPanelFits=label=>{const bounds=panel.getBoundingClientRect();fixtureAssert(bounds.left>=0&&bounds.right<=innerWidth,label+': '+JSON.stringify({viewport:innerWidth,left:bounds.left,right:bounds.right}));};
    const resize=async width=>{
      const seen=nativeResizeEvents;frame.style.width=width+'px';
      await fixtureWait(()=>innerWidth===width,'viewport resize');
      await new Promise(resolve=>setTimeout(resolve,50));await fixtureTick();
      // Virtual-time --dump-dom may update frame layout without scheduling a
      // rendering turn or its native resize event. Exercise the real registered
      // resize listener explicitly in that case, after changing actual width.
      if(nativeResizeEvents===seen){dispatchedResizeEvents++;window.dispatchEvent(new Event('resize'));await fixtureTick();}
    };
    const dragHorizontal=async x=>{
      const header=shadow.querySelector('.card-header'),bounds=header.getBoundingClientRect(),y=bounds.top+10;
      header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:bounds.left+10,clientY:y}));
      document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x,clientY:y}));
      await fixtureTick();
    };
    await resize(480);await dragHorizontal(1000);assertPanelFits('Right drag must clamp');
    await resize(280);assertPanelFits('Shrinking viewport must clamp saved position');
    await dragHorizontal(-100);assertPanelFits('Left drag must clamp');
    await resize(320);assertPanelFits('Restored 320px viewport must fit');
    resizeAndDrag=true;
  }
  await checkSaveAtScrollPositions();
  if(!advancedDetails.open){advancedDetails.querySelector(':scope > summary').click();await fixtureTick();}
  await fixtureReveal(advancedDetails.querySelector('input'));
  const scroll=shadow.querySelector('.ai-config-scroll');scroll.scrollTop=scroll.scrollHeight;await fixtureTick();
  const advancedInputs=[...advancedDetails.querySelectorAll('input')];
  fixtureAssert(advancedInputs.length>=2,'Advanced disclosure must keep timeout and output controls');
  const lastAdvanced=advancedInputs.at(-1),lastBounds=lastAdvanced.getBoundingClientRect(),barBounds=shadow.querySelector('.ai-savebar').getBoundingClientRect();
  fixtureAssert(lastBounds.top>=scroll.getBoundingClientRect().top&&lastBounds.bottom<=barBounds.top+1,'Last advanced control must scroll above the save bar');
  advancedDetails.querySelector(':scope > summary').click();await fixtureTick();
  if(endpointDetails.open){endpointDetails.querySelector(':scope > summary').click();await fixtureTick();}
  scroll.scrollTop=0;await fixtureTick();
  const save=shadow.querySelector('.ai-save');fixtureAssert(!!save,'Save and refresh action must remain available');
  const saveBounds=saveVisible();
  const panel=shadow.querySelector('.main-page'),panelBounds=panel.getBoundingClientRect();
  fixtureAssert(panelBounds.left>=0&&panelBounds.right<=innerWidth,'Panel must fit viewport: '+JSON.stringify({viewport:innerWidth,left:panelBounds.left,right:panelBounds.right,width:panelBounds.width}));
  const fieldNodes=[...shadow.querySelectorAll('.ai-config input,.ai-config textarea,.ai-config select,.ai-config button')];
  for(const node of fieldNodes){const bounds=node.getBoundingClientRect();if(bounds.width>0)fixtureAssert(bounds.left>=-1&&bounds.right<=innerWidth+1,'Settings control must fit viewport: '+node.className);}
  fixtureAssert(shadow.querySelector('.ai-config').scrollWidth<=shadow.querySelector('.ai-config').clientWidth+1,'Settings content must not overflow horizontally');
  const report={fullArtifact:true,explicitFetchOnly:true,listsIndependent:true,manualModelRetained:true,
    effortsIndependent:true,loadingAndErrors:true,staleRepliesRejected:true,abaRejected:true,
    customUrlsIndependent:true,derivedAndExplicitModelUrls:true,urlChangesCancel:true,urlAbaRejected:true,resetUrls:true,unknownAnswerPathPreserved:true,
    htmlRenderedAsText:true,fetchDoesNotSave:true,modelGetRequests:window.__modelCalls.length,glass:glassReport(),
    ui:{collapsibleSettings:true,disclosureDoesNotSave:true,accessibleLabels:true,keyboardFocusablePanelToggle:true,panelToggleState:true,multilineUrl:true,longUrlPreserved:true,savePinnedAtAllScrollPositions:true,advancedFieldsReachable:true},
    layout:{viewport:[innerWidth,innerHeight],panel:panelBounds.toJSON(),save:saveBounds.toJSON(),configScrollHeight:scroll.clientHeight,controlsFit:true,resizeAndDrag,dispatchedResizeEvents}};
  fixtureWrite('report',report);fixtureWrite('phase','saved');
  stage('saving');
  save.click();
}catch(error){fixtureResult.textContent=JSON.stringify({stage:JSON.parse(fixtureResult.textContent).stage,error:String(error),stack:error.stack});}},2500);
'''

nonce = f"model-review-{time.time_ns()}:"
glass_background = r'''
<style>
.fixture-glass-backdrop{position:fixed;inset:0;overflow:hidden;z-index:0;background:#f3f5fa;color:#24304b;font:14px/1.6 "Microsoft YaHei",sans-serif;pointer-events:none}
.fixture-glass-backdrop *{box-sizing:border-box;min-width:0}
.fixture-course-top{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;background:#fff;border-bottom:1px solid #e3e8f2}
.fixture-course-brand{font-size:20px;font-weight:700;color:#254a80}.fixture-course-user{font-size:12px;color:#64738b}
.fixture-course-layout{display:grid;grid-template-columns:208px minmax(0,1fr);height:calc(100% - 64px)}
.fixture-course-nav{padding:25px 20px;background:#172a48;color:#d5e2f6}.fixture-course-nav strong{display:block;margin-bottom:24px;font-size:15px;color:white}
.fixture-course-nav div{margin:10px -8px;padding:10px 14px;border-radius:8px}.fixture-course-nav div:first-of-type{background:#2e568e;color:#fff}
.fixture-course-body{padding:25px 28px;overflow:hidden}.fixture-course-heading{margin:0 0 8px;font-size:23px;line-height:1.4;color:#152a4d}.fixture-course-lead{margin:0 0 22px;color:#687894}
.fixture-course-hero{display:flex;justify-content:space-between;gap:25px;padding:24px;border-radius:14px;background:#e4efff;border:1px solid #ccdef8}
.fixture-course-hero strong{font-size:20px;color:#254b83}.fixture-course-hero p{margin:6px 0 0;color:#536f96}.fixture-course-progress{min-width:140px;align-self:center;font-size:30px;font-weight:600;color:#315d99}
.fixture-course-section-title{margin:25px 0 13px;font-size:17px;color:#233957}.fixture-course-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.fixture-course-card{border-radius:12px;overflow:hidden;background:#fff;border:1px solid #e1e7f0}.fixture-course-thumb{position:relative;height:150px;overflow:hidden;padding:17px;color:#fff;font-size:13px;font-weight:600}
.fixture-course-thumb:before,.fixture-course-thumb:after{content:"";position:absolute;border:1px solid #ffffff70;border-radius:50%;width:140px;height:140px;right:-20px;bottom:-42px}
.fixture-course-thumb:after{width:88px;height:88px;right:55px;bottom:24px;background:#ffffff10}.fixture-course-thumb.blue{background:linear-gradient(135deg,#142e5b,#4168bd)}.fixture-course-thumb.purple{background:linear-gradient(135deg,#593778,#a15b9d)}.fixture-course-thumb.orange{background:linear-gradient(135deg,#aa502a,#e4a549)}
.fixture-course-card-copy{padding:14px 15px}.fixture-course-card-copy strong{display:block;font-size:15px;color:#21334d}.fixture-course-card-copy p{margin:5px 0 0;color:#7a889d;font-size:12px}
.fixture-course-notes{margin-top:22px;padding:18px 20px;background:#fff;border:1px solid #e1e7f0;border-radius:12px}.fixture-course-notes strong{display:block;margin-bottom:8px}.fixture-course-notes p{margin:6px 0;font-size:13px;color:#65748e}
@media(max-width:700px){.fixture-course-layout{grid-template-columns:132px minmax(0,1fr)}.fixture-course-nav{padding:24px 12px;font-size:12px}.fixture-course-body{padding:24px 18px}.fixture-course-cards{grid-template-columns:1fr}.fixture-course-card:not(:first-child){display:none}.fixture-course-hero{display:block;padding:17px}.fixture-course-progress{font-size:25px;margin-top:12px}.fixture-course-heading{font-size:19px}.fixture-course-top{padding:0 18px}.fixture-course-brand{font-size:16px}.fixture-course-user{display:none}}
</style>
<div class="fixture-glass-backdrop" aria-hidden="true">
  <header class="fixture-course-top"><span class="fixture-course-brand">知行 · 课程学习</span><span class="fixture-course-user">学习空间　　课程消息　　个人中心</span></header>
  <div class="fixture-course-layout">
    <aside class="fixture-course-nav"><strong>我的学习空间</strong><div>正在学习</div><div>章节目录</div><div>课程作业</div><div>学习笔记</div><div>成绩与反馈</div></aside>
    <main class="fixture-course-body">
      <h1 class="fixture-course-heading">继续今天的学习</h1><p class="fixture-course-lead">从上次的进度继续，查看课程内容与待完成的练习。</p>
      <section class="fixture-course-hero"><div><strong>本周学习计划</strong><p>已完成 6 个章节，继续探索新的课程内容。</p><p>下一节：理解数据与日常生活中的统计</p></div><div class="fixture-course-progress">6 / 10</div></section>
      <h2 class="fixture-course-section-title">正在学习的课程</h2>
      <section class="fixture-course-cards">
        <article class="fixture-course-card"><div class="fixture-course-thumb blue">数据与逻辑 · 基础课程</div><div class="fixture-course-card-copy"><strong>统计思维与数据分析</strong><p>第三章　从样本理解总体</p></div></article>
        <article class="fixture-course-card"><div class="fixture-course-thumb purple">阅读与表达 · 通识课程</div><div class="fixture-course-card-copy"><strong>文学阅读与写作</strong><p>第二章　文字中的观察与表达</p></div></article>
        <article class="fixture-course-card"><div class="fixture-course-thumb orange">自然与科学 · 探索课程</div><div class="fixture-course-card-copy"><strong>生活中的科学</strong><p>第四章　看见身边的物理现象</p></div></article>
      </section>
      <section class="fixture-course-notes"><strong>课程动态</strong><p>本周练习已开放，可在章节学习后查看。</p><p>学习笔记支持按课程和章节整理，方便复习。</p><p>这是用于界面检查的本地课程样例，所有内容均为模拟数据。</p></section>
    </main>
  </div>
</div>
''' if args.glass_background else ''
page = ('<!doctype html><html><head><meta charset="utf-8"><title>Offline model settings review</title></head><body>'
        + glass_background + ''.join(tags) + '<script>window.__modelReviewPrefix=' + json.dumps(nonce)
        + ';window.__uiPreview=' + json.dumps(args.preview)
        + ';window.__glassBackground=' + json.dumps(args.glass_background)
        + ';window.__glassFallback=' + json.dumps(args.glass_fallback)
        + ';window.__modelResources=' + json.dumps(resources) + ';' + setup + '</script><script src="'
        + ARTIFACT.as_uri() + '"></script></body></html>')
fixture = fixture_dir / "dowork-model-settings.html"
fixture.write_text(page, encoding="utf-8")
target = fixture
if args.width < 500:
    # Desktop Chromium clamps the outer window to ~500px. A same-origin frame
    # gives the unchanged artifact a real 320px layout viewport instead.
    target = fixture_dir / "model-settings-narrow.html"
    target.write_text('<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="narrow" '
                      f'src="{fixture.name}" style="border:0;width:{args.width}px;height:900px"></iframe>'
                      '<pre id="model-settings-result" style="display:none">{"stage":"frame"}</pre><script>'
                      'const copy=setInterval(()=>{try{const result=document.querySelector("#narrow").contentDocument.querySelector("#model-settings-result");'
                      'if(result)document.querySelector("#model-settings-result").textContent=result.textContent;}catch{}},50);'
                      '</script>',encoding='utf-8')
command = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--allow-file-access-from-files", "--user-data-dir=" + str(ROOT / "tests" / ".model-settings-profile"),
    f"--window-size={max(args.width,500)},900", "--virtual-time-budget=20000", "--dump-dom"
]
if args.screenshot:
    if args.glass_background or args.glass_fallback:
        screenshot_name = 'ui-glass-' + ('narrow' if args.width < 500 else 'desktop') + ('-standard' if args.glass_fallback else '-svg') + ('-default' if args.preview else '-flow') + '.png'
    else:
        screenshot_name = 'ui-settings-default.png' if args.preview else 'ui-settings.png'
    command.append('--screenshot='+str(ROOT/'tests'/screenshot_name))
command.append(target.as_uri())
run = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=35)
match = re.search(r'<pre id="model-settings-result"[^>]*>(.*?)</pre>', run.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit model settings review: " + run.stderr[-1200:])
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
