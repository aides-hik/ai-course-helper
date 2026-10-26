'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'ai-adapter.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const question = id => ({title: `Question ${id}`,searchText:{stem:`Question ${id}`,options:['first','second']},type:'0',optionsText:['first','second']});
const answer = index => ({answerable:true,choice_indices:[index],text_answers:[],judgement:'unknown',explanation:'offline fixture'});
function harness(ai = {}, options = {}) {
  const config = {ai:{apiKey:'openai-key',model:'openai-model',deepseekApiKey:'deepseek-key',deepseekModel:'deepseek-model',...ai},otherParams:{params:[{value:100}]}};
  const calls = [], timers = new Map();
  let timerId = 0, active = 0, peak = 0;
  const sandbox = {
    AbortController, URL,
    setTimeout(callback, delay) {const id = ++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout: id => timers.delete(id),
    useConfigStore: () => config,
    isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    apiError: (message, status) => ({success:false,error:{message,status},data:null}),
    extractRawTextFromHtml: value => value,
    _GM_xmlhttpRequest(request) {
      const call = {request,done:false,aborted:false};
      calls.push(call); active++; peak=Math.max(peak,active);
      const settle = () => {if(!call.done){call.done=true;active--;}};
      call.load = (index=0) => {
        settle();
        const payload=request.url.includes('deepseek')
          ? {choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer(index))}}]}
          : {status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer(index))}]}]};
        request.onload({status:200,responseText:JSON.stringify(payload)});
      };
      call.fail = status => {settle();request.onload({status,responseText:'{}'});};
      call.error = () => {settle();request.onerror();};
      return {abort(){call.aborted=true;settle();if(options.abortThrows)throw Error('abort failed');request.onabort?.();}};
    }
  };
  vm.runInNewContext(source+'\nglobalThis.api={getAnswer,limit:aiConcurrencyLimit};',sandbox);
  return {config,calls,timers,...sandbox.api,active:()=>active,peak:()=>peak,
    poll(){for(const [id,timer] of [...timers]){if(timers.has(id)){timers.delete(id);timer.callback();}}},
    start(id,context={}){return sandbox.api.getAnswer(question(id),{skipDelay:true,...context});}
  };
}

test('concurrency switch defaults to serial; enabled values clamp to 1..2500 with a default of 3', () => {
  const h=harness({concurrency:2500});
  assert.equal(h.limit(),1);
  for(const enabled of [false,undefined,'true',1]){h.config.ai.concurrentEnabled=enabled;assert.equal(h.limit(),1);}
  h.config.ai.concurrentEnabled=true;
  for(const [value,expected] of [[undefined,3],[NaN,3],[Infinity,3],['bad',3],[0,1],[-10,1],[2.9,2],['4',4],[20,20],['2500',2500],[2500.9,2500],[3000,2500]]){
    h.config.ai.concurrency=value;assert.equal(h.limit(),expected);
  }
});

for (const cap of [12,20]) {
  test(`${cap} requests actually overlap across callers, share the cap and cancel active and queued work`, async () => {
    const h=harness({concurrentEnabled:true,concurrency:cap});
    const controllers=Array.from({length:cap+4},()=>new AbortController());
    const start=index=>h.start(index,{signal:controllers[index].signal});
    const firstCaller=Array.from({length:cap/2+2},(_,index)=>start(index));
    const secondCaller=Array.from({length:cap/2+2},(_,index)=>start(index+cap/2+2));
    const pending=[...firstCaller,...secondCaller];
    try {
      await tick();
      assert.equal(h.calls.length,cap);
      assert.equal(h.active(),cap);
      assert.equal(h.peak(),cap);
      h.calls[0].load();
      assert.equal((await pending[0]).success,true);
      await tick();
      assert.equal(h.calls.length,cap+1);
      assert.equal(h.active(),cap);
      controllers.forEach(controller=>controller.abort());
      const results=await Promise.all(pending);
      assert.ok(results.slice(1).every(result=>!result.success));
      assert.ok(h.calls.slice(1).every(call=>call.aborted));
      h.calls.forEach(call=>call.load());await tick();
      assert.equal(h.calls.length,cap+1);
      assert.equal(h.peak(),cap);
    } finally {
      controllers.forEach(controller=>controller.abort());
      await Promise.all(pending);
      assert.equal(h.active(),0);
      assert.equal(h.timers.size,0);
    }
  });
}

test('one shared queue caps all callers and returns out-of-order responses to the correct question', async () => {
  const h=harness({concurrentEnabled:true,concurrency:3});
  const pending=Array.from({length:8},(_,index)=>h.start(index));
  await tick();assert.equal(h.calls.length,3);assert.equal(h.active(),3);
  h.calls[1].load(1);assert.equal((await pending[1]).data.items[0].stem,'Question 1');
  await tick();assert.equal(h.calls.length,4);
  h.calls[0].load();h.calls[2].load();await tick();assert.equal(h.calls.length,6);
  h.calls[5].load(1);h.calls[3].load();await tick();assert.equal(h.calls.length,8);
  h.calls[7].load(1);h.calls[4].load();h.calls[6].load();
  const results=await Promise.all(pending);
  assert.deepEqual(results.map(result=>result.data.items[0].stem),Array.from({length:8},(_,index)=>`Question ${index}`));
  assert.equal(h.peak(),3);assert.equal(h.active(),0);assert.equal(h.timers.size,0);
});

test('queued AbortSignal cancellation resolves before occupied requests and never sends a request', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2});
  const first=h.start(0),second=h.start(1),controller=new AbortController();
  const queued=h.start(2,{signal:controller.signal});
  await tick();assert.equal(h.calls.length,2);
  controller.abort();assert.equal((await queued).success,false);assert.equal(h.calls.length,2);
  h.calls[0].load();h.calls[1].load();await Promise.all([first,second]);
  assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);
});

test('occupied request checks promptly discard stale queued work without an extra queue timer', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2});let current=true;
  const first=h.start(0),second=h.start(1),queued=h.start(2,{isCurrent:()=>current});
  await tick();assert.equal(h.timers.size,2);
  current=false;h.poll();assert.equal((await queued).success,false);assert.equal(h.calls.length,2);
  h.calls[0].load();h.calls[1].load();await Promise.all([first,second]);assert.equal(h.timers.size,0);
});

test('active abort releases a slot even if transport abort throws, and late callbacks cannot release it twice', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2},{abortThrows:true});
  const controller=new AbortController();
  const first=h.start(0,{signal:controller.signal}),second=h.start(1),third=h.start(2),fourth=h.start(3);
  await tick();controller.abort();assert.equal((await first).success,false);
  await tick();assert.equal(h.calls.length,3);assert.equal(h.active(),2);
  h.calls[0].load();await tick();assert.equal(h.calls.length,3);
  h.calls[2].load();await tick();assert.equal(h.calls.length,4);
  h.calls[1].load();h.calls[3].load();await Promise.all([second,third,fourth]);
  assert.equal(h.peak(),2);assert.equal(h.timers.size,0);
});

test('changing provider cancels waiting snapshots and aborts active requests before scheduling new-provider work', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2});
  const old=[h.start(0),h.start(1),h.start(2)];
  await tick();h.config.ai.provider='deepseek';
  const next=h.start(3);h.poll();
  assert.deepEqual((await Promise.all(old)).map(result=>result.success),[false,false,false]);
  await tick();assert.equal(h.calls.length,3);
  assert.ok(h.calls.slice(0,2).every(call=>call.aborted));
  assert.equal(h.calls[2].request.url,'https://api.deepseek.com/chat/completions');
  assert.equal(h.calls[2].request.headers.Authorization,'Bearer deepseek-key');
  h.calls[2].load();assert.equal((await next).success,true);assert.equal(h.timers.size,0);
});

test('reducing concurrency leaves active requests intact; later dispatches observe the lower limit', async () => {
  const h=harness({concurrentEnabled:true,concurrency:3});
  const pending=[0,1,2,3,4].map(index=>h.start(index));
  await tick();assert.equal(h.calls.length,3);
  h.config.ai.concurrentEnabled=false;h.poll();
  assert.ok(h.calls.every(call=>!call.aborted));
  h.calls[0].load();h.calls[1].load();await tick();assert.equal(h.calls.length,3);
  h.calls[2].load();await tick();assert.equal(h.calls.length,4);assert.equal(h.active(),1);
  h.calls[3].load();await tick();assert.equal(h.calls.length,5);assert.equal(h.active(),1);
  h.calls[4].load();assert.ok((await Promise.all(pending)).every(result=>result.success));assert.equal(h.timers.size,0);
});

test('increasing the limit allows queued work to start on the next lifecycle check', async () => {
  const h=harness({concurrentEnabled:true,concurrency:1});
  const pending=[0,1,2,3].map(index=>h.start(index));
  await tick();assert.equal(h.calls.length,1);
  h.config.ai.concurrency=3;h.poll();await tick();assert.equal(h.calls.length,3);
  h.calls[0].load();await tick();assert.equal(h.calls.length,4);
  h.calls.slice(1).forEach(call=>call.load());await Promise.all(pending);assert.equal(h.peak(),3);assert.equal(h.timers.size,0);
});

test('pre-request delays occupy bounded slots and remain immediately cancellable', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2});
  const firstController=new AbortController(),secondController=new AbortController();
  const first=h.start(0,{skipDelay:false,signal:firstController.signal}),second=h.start(1,{skipDelay:false,signal:secondController.signal}),third=h.start(2);
  await tick();assert.equal(h.calls.length,0);assert.equal(h.timers.size,2);
  firstController.abort();assert.equal((await first).success,false);
  await tick();assert.equal(h.calls.length,1);assert.match(JSON.parse(h.calls[0].request.data).input,/Question 2/);
  secondController.abort();assert.equal((await second).success,false);
  h.calls[0].load();assert.equal((await third).success,true);assert.equal(h.timers.size,0);
});

test('HTTP limits, errors and invalid local questions release slots without retries', async () => {
  const h=harness({concurrentEnabled:true,concurrency:2});
  const first=h.start(0),second=h.start(1),invalid=h.getAnswer({...question(2),type:'unsupported'},{skipDelay:true}),last=h.start(3);
  await tick();h.calls[0].fail(429);h.calls[1].error();
  assert.equal((await first).success,false);assert.equal((await second).success,false);assert.equal((await invalid).success,false);
  await tick();assert.equal(h.calls.length,3);assert.match(JSON.parse(h.calls[2].request.data).input,/Question 3/);
  h.calls[2].load();assert.equal((await last).success,true);assert.equal(h.calls.length,3);assert.equal(h.timers.size,0);
});
