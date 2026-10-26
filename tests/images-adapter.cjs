'use strict';
// Provider requests are intercepted locally; the image module and adapter are real.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const imageModule = fs.readFileSync(path.join(root, 'ai-images.js'), 'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5wAAAABJRU5ErkJggg==';
const marker = index => `\uFFFC[ai-image:${index}]\uFFFC`;
const json = value => JSON.parse(JSON.stringify(value));
function image(source=png) {
  return {tagName:'IMG',currentSrc:'',complete:false,ownerDocument:{baseURI:'https://course.example/chapters/1'},getAttribute:name=>name==='src'?source:null};
}
function question({stem='选择正确图形',options=['甲','乙'],sources=[],labels=[],imageStem=false,imageOptions=false}={}) {
  const images=sources.map((source,index)=>({marker:marker(index),label:labels[index]||'题干',element:image(source)}));
  if(imageStem)stem=images.map(entry=>entry.marker).join('');
  const rawOptions=imageOptions?sources.map((source,index)=>`【图片选项${index+1}】<img src="${source}">`):options;
  const extractedOptions=imageOptions?images.map(entry=>entry.marker):options;
  const q={type:'0',title:stem,searchText:{stem,options:extractedOptions,images},optionsText:rawOptions};
  q.element={isConnected:true,ownerDocument:{baseURI:'https://course.example/chapters/1'},querySelectorAll:selector=>selector==='img'?images.map(entry=>entry.element):[]};
  return q;
}
function harness(options={}) {
  const config={ai:{provider:'openai',apiKey:'openai-fixture-key',model:'vision-model',deepseekApiKey:'deepseek-fixture-key',deepseekModel:'deepseek-flash',...options.ai},otherParams:{params:[{value:0}]}};
  const calls=[],timers=new Map();let timerId=0;
  const sandbox={AbortController,URL,
    useConfigStore:()=>config,
    isObject:value=>value!==null&&typeof value==='object'&&!Array.isArray(value),
    apiError:(message,status)=>({success:false,data:null,error:{message,status}}),
    extractRawTextFromHtml:text=>text.replace(/&lt;/g,'<').replace(/&gt;/g,'>'),
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),
    _GM_xmlhttpRequest(request){
      calls.push(request);
      const answer={answerable:true,choice_indices:[options.answerIndex??0],text_answers:[],judgement:'unknown',explanation:'offline fixture'};
      const payload=request.url.includes('deepseek')?{choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]};
      queueMicrotask(()=>request.onload({status:options.status??200,responseText:options.responseText??JSON.stringify(options.payload??payload)}));
      return {abort(){request.onabort();}};
    },
    ...options.helpers
  };
  vm.runInNewContext((options.helpers||options.withoutImages?'':imageModule)+adapter+'\nglobalThis.api={getAnswer,prepare:aiPrepareQuestion};',sandbox);
  return {config,calls,timers,...sandbox.api,
    poll(){for(const [id,timer]of [...timers])if(timers.has(id)){timers.delete(id);timer.callback();}},
    solve(q,context={}){return sandbox.api.getAnswer(q,{skipDelay:true,...context});}
  };
}
const bodyOf = h => JSON.parse(h.calls[0].data);

test('OpenAI sends an image-only stem and labelled option images as ordered Responses content',async()=>{
  const h=harness({answerIndex:1});
  const q=question({sources:[png,png,png],labels:['题干','选项1','选项2'],imageOptions:false});
  q.searchText.stem=marker(0);q.title=q.searchText.stem;
  q.searchText.options=[marker(1),marker(2)];
  q.optionsText=['【图片选项1】<img src="same-placeholder">','【图片选项2】<img src="same-placeholder">'];
  const result=await h.solve(q),body=bodyOf(h),content=body.input[0].content;
  assert.equal(result.success,true);
  assert.equal(h.calls[0].url,'https://api.openai.com/v1/responses');
  assert.equal(h.calls[0].headers.Authorization,'Bearer openai-fixture-key');
  assert.equal(body.model,'vision-model');assert.equal(body.store,false);
  assert.equal(body.text.format.strict,true);
  assert.deepEqual(content.map(part=>part.type),['input_text','input_image','input_image','input_image']);
  assert.ok(content.slice(1).every(part=>part.image_url===png&&part.detail==='high'));
  const input=JSON.parse(content[0].text);
  assert.equal(input.stem,marker(0));
  assert.deepEqual(input.options,[marker(1),marker(2)]);
  assert.deepEqual(input.image_labels,[{marker:marker(0),label:'题干'},{marker:marker(1),label:'选项1'},{marker:marker(2),label:'选项2'}]);
  assert.deepEqual(json(result.data.items[0].answer.values),[q.optionsText[1]]);
  assert.equal(result.data.items[0].stem,q.searchText.stem);
  assert.equal(h.timers.size,0);
});

test('DeepSeek flash uses image_url content with its own credential and JSON output mode',async()=>{
  const h=harness({ai:{provider:'deepseek'}}),q=question({sources:['../diagram.png'],imageStem:true});
  assert.equal((await h.solve(q)).success,true);
  const body=bodyOf(h),content=body.messages[1].content;
  assert.equal(h.calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(h.calls[0].headers.Authorization,'Bearer deepseek-fixture-key');
  assert.equal(body.model,'deepseek-flash');
  assert.deepEqual(body.response_format,{type:'json_object'});
  assert.deepEqual(content.map(part=>part.type),['text','image_url']);
  assert.deepEqual(content[1],{type:'image_url',image_url:{url:'https://course.example/diagram.png',detail:'high'}});
  assert.equal(JSON.parse(content[0].text).image_labels[0].marker,marker(0));
  assert.equal(h.timers.size,0);
});

test('deepseek-v4-pro rejects images before reading pixels or sending an API request',async()=>{
  let collected=0;
  const h=harness({ai:{provider:'deepseek',deepseekModel:'deepseek-v4-pro'},helpers:{aiQuestionImageDescriptors:q=>({images:q.searchText.images}),aiCollectQuestionImages:async()=>{collected++;return{images:[]};}}});
  const result=await h.solve(question({sources:[png],imageStem:true}));
  assert.equal(result.success,false);assert.match(result.error.message,/deepseek-v4-pro.*不支持图片/);
  assert.equal(collected,0);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
});

for(const provider of ['openai','deepseek']){
  test(`${provider} pure text keeps its original request shape and does not add image labels`,async()=>{
    const h=harness({ai:{provider,deepseekModel:'deepseek-v4-pro'}}),q=question();
    assert.equal((await h.solve(q)).success,true);
    const body=bodyOf(h),input=provider==='openai'?body.input:body.messages[1].content;
    assert.equal(typeof input,'string');
    assert.deepEqual(JSON.parse(input),{type:'single',stem:q.title,options:['甲','乙'],blank_count:null});
    assert.equal(h.timers.size,0);
  });
}

test('an unknown chosen model is attempted once and an image error does not switch model or provider',async()=>{
  const h=harness({ai:{provider:'deepseek',deepseekModel:'my-custom-vision-model'},status:400});
  const result=await h.solve(question({sources:[png],imageStem:true}));
  assert.equal(result.success,false);assert.match(result.error.message,/图像支持/);
  assert.equal(h.calls.length,1);assert.equal(bodyOf(h).model,'my-custom-vision-model');
  assert.equal(h.calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.doesNotMatch(JSON.stringify(result),/fixture-key|base64/);
  assert.equal(h.timers.size,0);
});

test('one unavailable image rejects the whole question instead of sending partial images or only text',async()=>{
  const h=harness(),q=question({sources:[png,'javascript:missing'],imageStem:true});
  const result=await h.solve(q);
  assert.equal(result.success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
});

test('missing markers, image-only options without complete extraction and duplicate raw options never request a model',async()=>{
  const missing=question({sources:[png],imageStem:true});missing.searchText.stem='missing the image marker';
  const partial=question({sources:[png],imageStem:true});partial.searchText.options=[marker(0)];partial.searchText.stem='choose';
  const duplicate=question({sources:[png,png],imageOptions:true});duplicate.optionsText=['<img src="same">','<img src="same">'];
  for(const q of [missing,partial,duplicate]){
    const h=harness();assert.equal((await h.solve(q)).success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
  }
});

test('legacy standalone adapter still refuses image markup or image markers when helpers are absent',async()=>{
  for(const q of [question({sources:[png],imageStem:true}),{...question(),searchText:{stem:'<img src="x">',options:['甲','乙']}}]){
    const h=harness({withoutImages:true});assert.equal((await h.solve(q)).success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
  }
});

test('literal img text remains text when the extractor explicitly recorded zero images',async()=>{
  const h=harness(),q=question({stem:'HTML 的 <img> 标签有什么作用？'});
  assert.equal((await h.solve(q)).success,true);
  assert.equal(typeof bodyOf(h).input,'string');
  assert.equal(JSON.parse(bodyOf(h).input).stem,q.title);
  assert.equal(h.timers.size,0);
});

for(const malformed of ['missing','reordered','empty-url']){
  test(`${malformed} resolved images are rejected before a paid request`,async()=>{
    const q=question({sources:[png,png],imageStem:true});
    const resolved=q.searchText.images.map(entry=>({marker:entry.marker,url:png}));
    if(malformed==='missing')resolved.pop();
    if(malformed==='reordered')resolved.reverse();
    if(malformed==='empty-url')resolved[1].url='';
    const h=harness({helpers:{aiQuestionImageDescriptors:q=>({images:q.searchText.images}),aiCollectQuestionImages:async()=>({images:resolved})}});
    assert.equal((await h.solve(q)).success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
  });
}

test('cancelling an uncooperative image collector releases the shared slot and ignores its late completion',async()=>{
  let release,collectorSignal;
  const h=harness({helpers:{aiQuestionImageDescriptors:q=>({images:q.searchText.images}),aiCollectQuestionImages:(q,context)=>new Promise(resolve=>{collectorSignal=context.signal;release=()=>resolve({images:q.searchText.images.map(entry=>({marker:entry.marker,url:png}))});})}});
  const controller=new AbortController(),first=h.solve(question({sources:[png],imageStem:true}),{signal:controller.signal});
  await tick();assert.equal(h.calls.length,0);assert.equal(typeof release,'function');
  const second=h.solve(question());controller.abort();
  assert.equal((await first).success,false);assert.equal(collectorSignal.aborted,true);
  assert.equal((await second).success,true);assert.equal(h.calls.length,1);
  release();await tick();assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});

test('provider changes during image loading cancel the old collector and release the slot without sending old images',async()=>{
  let collectorSignal;
  const h=harness({helpers:{aiQuestionImageDescriptors:q=>({images:q.searchText.images}),aiCollectQuestionImages:(_q,context)=>{collectorSignal=context.signal;return new Promise(()=>{});}}});
  const old=h.solve(question({sources:[png],imageStem:true}));await tick();
  h.config.ai.provider='deepseek';const next=h.solve(question());h.poll();
  assert.equal((await old).success,false);assert.equal(collectorSignal.aborted,true);
  assert.equal((await next).success,true);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(h.timers.size,0);
});

test('image preparation occupies bounded slots and a queued cancelled image never starts loading',async()=>{
  const releases=[];let collected=0;
  const h=harness({ai:{concurrentEnabled:true,concurrency:2},helpers:{aiQuestionImageDescriptors:q=>({images:q.searchText.images}),aiCollectQuestionImages:q=>new Promise(resolve=>{collected++;releases.push(()=>resolve({images:q.searchText.images.map(entry=>({marker:entry.marker,url:png}))}));})}});
  const controller=new AbortController();
  const first=h.solve(question({sources:[png],imageStem:true})),second=h.solve(question({sources:[png],imageStem:true})),queued=h.solve(question({sources:[png],imageStem:true}),{signal:controller.signal});
  await tick();assert.equal(collected,2);assert.equal(h.calls.length,0);
  controller.abort();assert.equal((await queued).success,false);assert.equal(collected,2);
  releases.forEach(release=>release());
  assert.ok((await Promise.all([first,second])).every(result=>result.success));
  assert.equal(collected,2);assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);
});

const diagnosticHelpers = {
  aiQuestionImageDescriptors:q=>({images:q.searchText.images}),
  aiCollectQuestionImages:async q=>({images:q.searchText.images.map(entry=>({marker:entry.marker,label:entry.label,url:png}))})
};
for(const [name,error,expected]of[
  ['download failure',{code:'invalid_image_url',type:'invalid_request_error',message:'Failed to download image at the supplied URL'},/图片下载失败或无法访问/],
  ['decode failure',{code:'invalid_image',message:'Failed to decode image: corrupted base64'},/图片格式或编码无法解码/],
  ['unsupported image format',{code:'unsupported_image_format',message:'Unsupported image MIME format'},/图片格式或编码无法解码/],
  ['image dimension limit',{code:'invalid_request_error',message:'Image width and height must not exceed 8192 pixels'},/图片边长或分辨率超出限制/],
  ['image count limit',{code:'invalid_request_error',message:'Too many images in this request'},/图片数量或数据体积超出限制/],
  ['image byte limit',{code:'image_too_large',message:'Image data size exceeds maximum bytes'},/图片数量或数据体积超出限制/],
  ['model vision support',{code:'unsupported_model',message:'This model does not support image input'},/当前模型不支持本次图像输入/],
  ['JSON output setting',{code:'invalid_request_error',param:'response_format',message:'Invalid response_format: JSON output is not supported'},/请求参数或 JSON 输出设置不被接受/],
  ['an ordinary unsupported parameter',{code:'unsupported_parameter',param:'max_tokens',message:'Unsupported parameter max_tokens'},/请求参数或 JSON 输出设置不被接受/],
  ['an unrecognized provider reason',{code:'new_provider_code',type:'new_provider_type',message:'Request could not be completed'},/具体原因未知/]
]){
  test(`HTTP 400 reports ${name} without changing models or retrying`,async()=>{
    const h=harness({ai:{provider:'deepseek'},status:400,payload:{error},helpers:diagnosticHelpers});
    const result=await h.solve(question({sources:[png],imageStem:true}));
    assert.equal(result.success,false);
    assert.match(result.error.message,/HTTP 400/);
    assert.match(result.error.message,/模型：deepseek-flash/);
    assert.match(result.error.message,expected);
    assert.equal(result.error.status,400);
    assert.equal(h.calls.length,1);
    assert.equal(bodyOf(h).model,'deepseek-flash');
    assert.equal(h.calls[0].url,'https://api.deepseek.com/chat/completions');
    if(error.code==='new_provider_code')assert.doesNotMatch(result.error.message,/new_provider_code|new_provider_type|Request could not/);
    else assert.match(result.error.message,new RegExp(`错误代码：${error.code}`));
    assert.equal(h.timers.size,0);
  });
}

test('HTTP 400 diagnostics suppress echoed keys, URLs, query strings, base64 and the long provider message',async()=>{
  const secretURL='https://private-fixture.example/image.png?token=SECRET-TOKEN';
  const error={code:'invalid_image_url\nBearer deepseek-fixture-key',type:'invalid_request_error',param:secretURL,
    message:`Image download failed: ${secretURL}; openai-fixture-key; Bearer deepseek-fixture-key; ${png}; ${'provider-private-body-'.repeat(600)}`};
  const h=harness({ai:{provider:'deepseek'},status:400,payload:{error},helpers:diagnosticHelpers});
  const result=await h.solve(question({sources:[png],imageStem:true}));
  const diagnostic=JSON.stringify(result);
  assert.match(result.error.message,/HTTP 400.*deepseek-flash/);
  assert.match(result.error.message,/图片下载失败或无法访问/);
  assert.match(result.error.message,/错误代码：invalid_request_error/);
  assert.doesNotMatch(diagnostic,/fixture-key|private-fixture|SECRET-TOKEN|https?:|Bearer|data:image|iVBOR|provider-private-body/);
  assert.ok(result.error.message.length<220);
  assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});

for(const model of ['https://model-fixture.example/?key=MODEL-SECRET','api-fixture.example.com','sk-model-secret','deepseek-fixture-key','openai-fixture-key']){
  test(`unsafe configured model labels are hidden from HTTP 400 diagnostics: ${model.split(/[?:]/)[0]}`,async()=>{
    const h=harness({ai:{provider:'deepseek',deepseekModel:model},status:400,payload:{error:{message:'Failed to download image'}},helpers:diagnosticHelpers});
    const result=await h.solve(question({sources:[png],imageStem:true}));
    assert.match(result.error.message,/模型：已配置模型/);
    assert.equal(result.error.message.includes(model),false);
    assert.doesNotMatch(result.error.message,/MODEL-SECRET|fixture-key|https?:|sk-model/);
    assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
  });
}

test('non-JSON HTTP 400 bodies produce an explicit unknown reason without showing the body',async()=>{
  const h=harness({ai:{provider:'deepseek'},status:400,responseText:'<html>Bearer deepseek-fixture-key https://fixture.example/?token=SECRET</html>',helpers:diagnosticHelpers});
  const result=await h.solve(question({sources:[png],imageStem:true}));
  assert.match(result.error.message,/HTTP 400.*deepseek-flash.*具体原因未知/);
  assert.doesNotMatch(JSON.stringify(result),/Bearer|fixture-key|https?:|SECRET|<html>/);
  assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});

test('other HTTP status messages retain their original meaning even if the body contains an image error',async()=>{
  for(const [status,expected]of[[401,/API Key 无效/],[403,/拒绝访问/],[429,/额度不足或请求过于频繁/],[500,/HTTP 500/]]){
    const h=harness({ai:{provider:'deepseek'},status,payload:{error:{code:'invalid_image',message:'DeepSeek key deepseek-fixture-key data:image/png;base64,secret'}},helpers:diagnosticHelpers});
    const result=await h.solve(question({sources:[png],imageStem:true}));
    assert.match(result.error.message,expected);
    assert.doesNotMatch(JSON.stringify(result),/fixture-key|base64|图片格式或编码|HTTP 400/);
    assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
  }
});

test('the image collector receives the selected provider/model snapshot and DeepSeek still requests five fields',async()=>{
  let received;
  const h=harness({ai:{provider:'deepseek'},helpers:{...diagnosticHelpers,aiCollectQuestionImages:async(q,context)=>{
    received={provider:context.provider,model:context.model,signal:context.signal};
    return diagnosticHelpers.aiCollectQuestionImages(q);
  }}});
  assert.equal((await h.solve(question({sources:[png],imageStem:true}))).success,true);
  assert.equal(received.provider,'deepseek');assert.equal(received.model,'deepseek-flash');
  assert.ok(received.signal instanceof AbortSignal);assert.equal(received.signal.aborted,false);
  assert.match(bodyOf(h).messages[0].content,/以下五个字段/);
  assert.doesNotMatch(bodyOf(h).messages[0].content,/六个字段/);
  assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});
