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
const fixtureInput=async(element,value)=>{
  fixtureAssert(!!element,'Missing editable field');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);
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
  const fieldInput=selector=>{const node=shadow.querySelector(selector);return node?.matches('input')?node:node?.querySelector('input');};
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
    document.querySelector('#fixture-endpoint-question').remove();
    const previous=fixtureRead('report',{});
    fixtureResult.textContent=JSON.stringify({...previous,customAnswerPosts:['openai','deepseek'],savedAndReloaded:true,savedFields:fixtureRead('writes',[]).length,passed:true});
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
  const save=shadow.querySelector('.ai-save');fixtureAssert(!!save,'Save and refresh action must remain available');
  save.scrollIntoView({block:'center'});await fixtureTick();
  const saveBounds=save.getBoundingClientRect();
  fixtureAssert(saveBounds.width>0&&saveBounds.left>=0&&saveBounds.right<=innerWidth&&saveBounds.top>=0&&saveBounds.bottom<=innerHeight,'Save action must be reachable by scrolling');
  const panel=shadow.querySelector('.main-page'),panelBounds=panel.getBoundingClientRect();
  fixtureAssert(panelBounds.left>=0&&panelBounds.right<=innerWidth,'Panel must fit viewport: '+JSON.stringify({viewport:innerWidth,left:panelBounds.left,right:panelBounds.right,width:panelBounds.width}));
  const fieldNodes=[...shadow.querySelectorAll('.ai-config input,.ai-config select,.ai-config button')];
  for(const node of fieldNodes){const bounds=node.getBoundingClientRect();if(bounds.width>0)fixtureAssert(bounds.left>=-1&&bounds.right<=innerWidth+1,'Settings control must fit viewport: '+node.className);}
  fixtureAssert(shadow.querySelector('.ai-config').scrollWidth<=shadow.querySelector('.ai-config').clientWidth+1,'Settings content must not overflow horizontally');
  const report={fullArtifact:true,explicitFetchOnly:true,listsIndependent:true,manualModelRetained:true,
    effortsIndependent:true,loadingAndErrors:true,staleRepliesRejected:true,abaRejected:true,
    customUrlsIndependent:true,derivedAndExplicitModelUrls:true,urlChangesCancel:true,urlAbaRejected:true,resetUrls:true,unknownAnswerPathPreserved:true,
    htmlRenderedAsText:true,fetchDoesNotSave:true,modelGetRequests:window.__modelCalls.length,
    layout:{viewport:[innerWidth,innerHeight],panel:panelBounds.toJSON(),save:saveBounds.toJSON(),controlsFit:true,resizeAndDrag,dispatchedResizeEvents}};
  fixtureWrite('report',report);fixtureWrite('phase','saved');
  stage('saving');
  save.click();
}catch(error){fixtureResult.textContent=JSON.stringify({stage:JSON.parse(fixtureResult.textContent).stage,error:String(error),stack:error.stack});}},2500);
'''

nonce = f"model-review-{time.time_ns()}:"
page = ('<!doctype html><html><head><meta charset="utf-8"><title>Offline model settings review</title></head><body>'
        + ''.join(tags) + '<script>window.__modelReviewPrefix=' + json.dumps(nonce)
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
    command.append('--screenshot='+str(ROOT/'tests'/'endpoint-settings.png'))
command.append(target.as_uri())
run = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=35)
match = re.search(r'<pre id="model-settings-result"[^>]*>(.*?)</pre>', run.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit model settings review: " + run.stderr[-1200:])
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
