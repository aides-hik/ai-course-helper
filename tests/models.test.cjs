'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'..','ai-models.js'),'utf8');
const endpoints=fs.readFileSync(path.resolve(__dirname,'..','ai-endpoints.js'),'utf8');
const plain=(value)=>JSON.parse(JSON.stringify(value));
function harness(options={}){
  const config={ai:{provider:'openai',apiKey:'openai-fixture-key',deepseekApiKey:'deepseek-fixture-key',...options.ai}};
  let now=0,nextTimer=0;
  const timers=new Map(),calls=[];
  const sandbox={URL,AbortController,Date:{now:()=>now},useConfigStore:()=>config,
    setTimeout(callback,delay){const id=++nextTimer;timers.set(id,{callback,deadline:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    _GM_xmlhttpRequest(request){
      const call={request,aborted:false};calls.push(call);
      const handle={abort(){call.aborted=true;request.onabort?.();if(options.abortThrows)throw Error('transport abort');}};
      options.onRequest?.(call,config);
      return handle;
    }};
  vm.runInNewContext(endpoints+source+'\nglobalThis.api={fetch:aiFetchModels,read:aiReadModelList,fits:aiModelListTextFits};',sandbox);
  return{config,timers,calls,...sandbox.api,
    advance(milliseconds){now+=milliseconds;for(const[id,timer]of[...timers])if(timer.deadline<=now){timers.delete(id);timer.callback();}},
    load(index,data,status=200){calls[index].request.onload({status,responseText:typeof data==='string'?data:JSON.stringify(data)});}};
}
const result=(ids)=>({data:ids.map(id=>({id}))});

test('models are fetched only explicitly, without requiring or choosing a model',async()=>{
  const h=harness();assert.equal(h.calls.length,0);
  const pending=h.fetch();assert.equal(h.calls.length,1);
  const request=h.calls[0].request;
  assert.equal(request.url,'https://api.openai.com/v1/models');assert.equal(request.method,'GET');
  assert.equal(request.anonymous,true);assert.equal(request.timeout,20000);
  assert.equal(request.redirect,'error');
  assert.deepEqual(plain(request.headers),{Authorization:'Bearer openai-fixture-key'});
  assert.equal(request.data,undefined);assert.equal(request.cookie,undefined);
  h.load(0,result(['z-model','ft:gpt-model:organisation:suffix','a-model','z-model']));
  assert.deepEqual(plain(await pending),{success:true,models:[{id:'a-model'},{id:'ft:gpt-model:organisation:suffix'},{id:'z-model'}]});
  assert.equal(h.config.ai.model,undefined);assert.equal(h.timers.size,0);
});

test('DeepSeek uses only its own key and returns whitelisted advertised metadata',async()=>{
  const h=harness({ai:{provider:'deepseek'}}),pending=h.fetch();
  assert.equal(h.calls[0].request.url,'https://api.deepseek.com/models');
  assert.equal(h.calls[0].request.headers.Authorization,'Bearer deepseek-fixture-key');
  h.load(0,{data:[{id:'deepseek-model',name:'DeepSeek Model',effort:{supported_levels:['max','high','unknown','high']},input_modalities:['video','image','image','secret','text'],html:'<script>bad</script>'}]});
  assert.deepEqual(plain(await pending),{success:true,models:[{id:'deepseek-model',name:'DeepSeek Model',effortLevels:['high','max'],inputModalities:['text','image','video']}]});
  assert.equal(h.config.ai.deepseekModel,undefined);
});

test('invalid or missing provider credentials never trigger a request',async()=>{
  for(const ai of [{provider:'other'},{apiKey:''},{apiKey:null},{apiKey:'secret\nvalue'},{apiKey:'a'.repeat(4097)}]){
    const h=harness({ai});assert.equal((await h.fetch()).success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
  }
});

test('unsafe identifiers, server HTML and credentials cannot enter a returned list',async()=>{
  const h=harness({ai:{provider:'deepseek'}}),pending=h.fetch();
  h.load(0,{data:[
    {id:'valid',name:'<b>HTML</b>'},{id:'another',name:'https://secret.example/?token=deepseek-fixture-key'},
    {id:'deepseek-fixture-key'},{id:'sk-secret-key'},{id:'https://model.example/name'},{id:'http:secret'},
    {id:'bad\nmodel'},{id:'<img>'},{id:'a'.repeat(201)},{id:' leading'},{id:'safe',name:'deepseek-fixture-key'}
  ]});
  const output=plain(await pending);
  assert.deepEqual(output,{success:true,models:[{id:'another'},{id:'safe'},{id:'valid'}]});
  assert.ok(!JSON.stringify(output).includes('deepseek-fixture-key'));
});

test('malformed, empty, excessive and oversized responses produce fixed errors',async()=>{
  for(const body of ['not json','[]','{}',JSON.stringify({data:[]}),JSON.stringify({data:[{id:'<invalid>'}]}),JSON.stringify({data:Array.from({length:2001},(_,index)=>({id:'model'+index}))}),'x'.repeat(1024*1024+1),JSON.stringify({data:[],padding:'中'.repeat(400000)})]){
    const h=harness(),pending=h.fetch();h.load(0,body);const output=await pending;
    assert.equal(output.success,false);assert.ok(output.error);assert.equal(h.timers.size,0);assert.ok(!output.error.includes('not json'));
  }
});

test('HTTP errors are diagnosed without returning provider messages or secrets',async()=>{
  for(const [status,fragment]of [[401,'Key'],[403,'权限'],[429,'频繁'],[500,'不可用'],[503,'不可用'],[400,'失败']]){
    const h=harness(),pending=h.fetch();h.load(0,{error:{message:'openai-fixture-key https://secret.example/'}},status);
    const output=await pending;assert.equal(output.success,false);assert.ok(output.error.includes(fragment));assert.ok(!output.error.includes('fixture'));assert.ok(!output.error.includes('secret.example'));assert.equal(h.timers.size,0);
  }
});

test('provider or active key changes abort old requests; model-only changes remain valid',async()=>{
  for(const change of ['provider','key']){
    const h=harness(),pending=h.fetch();
    if(change==='provider')h.config.ai.provider='deepseek';else h.config.ai.apiKey='changed-key';
    h.advance(250);const output=await pending;
    assert.equal(output.success,false);assert.ok(output.error.includes('取消'));assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);
    h.load(0,result(['old-list']));
    assert.equal((await pending).models,undefined);
  }
  const h=harness(),pending=h.fetch();h.config.ai.model='new-selection';h.advance(250);h.load(0,result(['still-valid']));
  assert.equal((await pending).success,true);
});

test('a stale response is rejected even before the next polling tick',async()=>{
  const h=harness(),pending=h.fetch();h.config.ai.apiKey='new-key';h.load(0,result(['old-model']));
  const output=await pending;assert.equal(output.success,false);assert.ok(output.error.includes('取消'));assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);
});

test('AbortSignal cancellation removes listeners and tolerates throwing transport aborts',async()=>{
  const h=harness({abortThrows:true}),controller=new AbortController();let added=0,removed=0;
  const add=controller.signal.addEventListener.bind(controller.signal),remove=controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener=(...args)=>{added++;return add(...args);};controller.signal.removeEventListener=(...args)=>{removed++;return remove(...args);};
  const pending=h.fetch({signal:controller.signal});controller.abort();
  assert.equal((await pending).success,false);assert.equal(added,removed);assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);
  h.load(0,result(['late']));assert.equal((await pending).models,undefined);
});

test('deadline and native timeouts release transport and all timers',async()=>{
  for(const native of [false,true]){
    const h=harness(),pending=h.fetch();
    if(native)h.calls[0].request.ontimeout();else h.advance(20001);
    const output=await pending;assert.ok(output.error.includes('超时'));assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);assert.equal(h.calls.length,1);
  }
});

test('network failures, thrown send and synchronous callbacks settle once without retries',async()=>{
  const network=harness(),failed=network.fetch();network.calls[0].request.onerror();assert.ok((await failed).error.includes('网络'));assert.equal(network.timers.size,0);
  const thrown=harness({onRequest(){throw Error('secret send error');}});assert.equal((await thrown.fetch()).success,false);assert.equal(thrown.timers.size,0);
  const sync=harness({onRequest(call){call.request.onload({status:200,responseText:JSON.stringify(result(['synchronous']))});}});
  const output=await sync.fetch();assert.equal(output.success,true);assert.equal(sync.timers.size,0);sync.calls[0].request.onerror();sync.load(0,result(['late']));assert.equal((await Promise.resolve(output)).models[0].id,'synchronous');assert.equal(sync.calls.length,1);
});

test('pre-cancelled and throwing context guards never issue network calls',async()=>{
  const h=harness(),controller=new AbortController();controller.abort();
  assert.equal((await h.fetch({signal:controller.signal})).success,false);
  assert.equal((await h.fetch({isCurrent(){throw Error('stale context');}})).success,false);
  assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
});

test('custom completion URLs derive the models endpoint with prefix and query preserved',async()=>{
  for(const ai of [
    {apiUrl:'https://gateway.example/proxy/v1/responses?tenant=fixture'},
    {provider:'deepseek',deepseekApiUrl:'https://gateway.example/proxy/chat/completions?tenant=fixture'}
  ]){
    const h=harness({ai}),pending=h.fetch();
    assert.equal(h.calls[0].request.url,ai.provider==='deepseek'?'https://gateway.example/proxy/models?tenant=fixture':'https://gateway.example/proxy/v1/models?tenant=fixture');
    assert.equal(h.calls[0].request.redirect,'error');
    h.load(0,result(['gateway-model']));assert.equal((await pending).success,true);
  }
});

test('each provider can use an explicit models URL independent of its completion route',async()=>{
  for(const ai of [
    {apiUrl:'https://gateway.example/infer',modelsUrl:'https://catalog.example/models/list?tenant=fixture'},
    {provider:'deepseek',deepseekApiUrl:'http://127.0.0.1:8080/infer',deepseekModelsUrl:'http://127.0.0.1:8080/catalog'}
  ]){
    const h=harness({ai}),pending=h.fetch();
    assert.equal(h.calls[0].request.url,ai.provider==='deepseek'?ai.deepseekModelsUrl:ai.modelsUrl);
    assert.equal(h.calls[0].request.headers.Authorization,ai.provider==='deepseek'?'Bearer deepseek-fixture-key':'Bearer openai-fixture-key');
    h.load(0,result(['explicit-model']));assert.equal((await pending).success,true);
  }
});

test('invalid URLs and unknown automatic routes are rejected before sending credentials',async()=>{
  for(const ai of [
    {apiUrl:'https://gateway.example/custom-infer'},
    {apiUrl:'javascript:alert(1)'},{apiUrl:'https://user:password@gateway.example/v1/responses'},
    {modelsUrl:'https://catalog.example/models#fragment'},{modelsUrl:'file:///private/models'},
    {apiUrl:'https://gateway.example/\nresponses'},{modelsUrl:'https://gateway.example\\models'}
  ]){
    const h=harness({ai}),result=await h.fetch();
    assert.equal(result.success,false);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
    assert.ok(!result.error.includes('password'));assert.ok(!result.error.includes('gateway.example'));
  }
});

test('completion or models URL changes cancel stale lists even when the other URL is unchanged',async()=>{
  for(const changedField of ['apiUrl','modelsUrl']){
    const h=harness({ai:{apiUrl:'https://gateway.example/v1/responses',modelsUrl:'https://catalog.example/models'}}),pending=h.fetch();
    h.config.ai[changedField]='https://changed.example/'+(changedField==='apiUrl'?'v1/responses':'models');
    h.advance(250);assert.equal((await pending).success,false);assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);
    h.load(0,result(['stale-model']));assert.equal((await pending).models,undefined);
  }
  const h=harness(),pending=h.fetch();h.config.ai.modelsUrl='https://new.example/models';h.load(0,result(['too-late']));
  assert.equal((await pending).success,false);assert.equal(h.calls[0].aborted,true);assert.equal(h.timers.size,0);
});

test('inactive provider URL changes do not cancel the current provider list',async()=>{
  const h=harness(),pending=h.fetch();
  h.config.ai.deepseekApiUrl='https://changed.example/chat/completions';h.config.ai.deepseekModelsUrl='https://changed.example/models';
  h.advance(250);assert.equal(h.calls[0].aborted,false);h.load(0,result(['still-current']));assert.equal((await pending).success,true);
});

test('unexpected redirect responses cannot return a model list or expose the target URL',async()=>{
  const h=harness({ai:{apiUrl:'https://gateway.example/v1/responses'}}),pending=h.fetch();
  h.calls[0].request.onload({status:200,finalUrl:'https://other.example/private?token=secret',responseText:JSON.stringify(result(['wrong-origin-model']))});
  const output=await pending;assert.equal(output.success,false);assert.ok(output.error.includes('跳转'));assert.ok(!output.error.includes('other.example'));assert.equal(h.timers.size,0);
});
