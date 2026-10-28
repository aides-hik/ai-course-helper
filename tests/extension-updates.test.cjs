'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../extension/update-service.js'),'utf8');
const KEY='ai-course-helper:updates:v1';
const repo='https://github.com/aides-hik/ai-course-helper';
const event=()=>{const callbacks=[];return {addListener:fn=>callbacks.push(fn),fire:(...args)=>callbacks.forEach(fn=>fn(...args)),callbacks};};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const release=(version='0.9.3',overrides={})=>({tag_name:'v'+version,draft:false,prerelease:false,html_url:repo+'/releases/tag/v'+version,assets:[{name:'ai-course-helper-extension-'+version+'.zip',state:'uploaded',size:1000000,browser_download_url:repo+'/releases/download/v'+version+'/ai-course-helper-extension-'+version+'.zip'}],...overrides});
const jsonResponse=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(options={}){
  let now=1800000000000;
  const storage=options.saved?{[KEY]:options.saved}:{};
  const requests=[],reads=[],writes=[],tabs=[],badges=[],titles=[],createdAlarms=[];
  const onMessage=event(),onInstalled=event(),onStartup=event(),onAlarm=event();
  const chrome={runtime:{id:'fixture-extension',getManifest:()=>({version:options.version||'0.9.2'}),getURL:file=>'chrome-extension://fixture-extension/'+file,onMessage,onInstalled,onStartup},
    storage:{local:{get:async key=>{reads.push(key);assert.equal(key,KEY,'Updater must not read model configuration');return {[key]:storage[key]};},set:async value=>{writes.push(value);Object.assign(storage,value);}}},
    alarms:{get:async()=>undefined,create:async(name,settings)=>createdAlarms.push({name,...settings}),onAlarm},
    action:{setBadgeText:async value=>badges.push(value.text),setBadgeBackgroundColor:async()=>{},setTitle:async value=>titles.push(value.title)},
    tabs:{create:async value=>tabs.push(value.url)}};
  const sandbox={chrome,Date:class extends Date{static now(){return now;}},AbortController,TextDecoder,fetch:async(url,init)=>{requests.push({url,init});return options.fetch?options.fetch(url,init):jsonResponse(release());},setTimeout:options.setTimeout||setTimeout,clearTimeout:options.clearTimeout||clearTimeout};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const popup={id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')};
  const message=(body,sender=popup)=>new Promise(resolve=>{const active=onMessage.callbacks[0](body,sender,resolve);if(active!==true)resolve(undefined);});
  return {api:sandbox.AiHelperUpdates,chrome,popup,message,requests,reads,writes,tabs,badges,titles,createdAlarms,onInstalled,onStartup,onAlarm,storage,advance:ms=>now+=ms};
}
test('numeric version comparison handles Chrome version boundaries and rejects malformed versions',()=>{
  const h=fixture();
  assert.equal(h.api.compareVersions('0.10.0','0.9.9'),1);
  assert.equal(h.api.compareVersions('1.2','1.2.0.0'),0);
  assert.equal(h.api.compareVersions('2','10'),-1);
  for(const version of ['1.2.3.4.5','1.0-beta','01.2','65536','1..2','v1.2',' 1.2','1.2#x'])assert.throws(()=>h.api.compareVersions(version,'1.0'),/INVALID_VERSION/);
});
test('release validation accepts only the precise repository, stable tag and uploaded ZIP',()=>{
  const h=fixture();
  assert.equal(h.api.validateRelease(release()).downloadUrl,repo+'/releases/download/v0.9.3/ai-course-helper-extension-0.9.3.zip');
  for(const changed of [{draft:true},{prerelease:true},{tag_name:'v0.9.3-rc1'},{html_url:repo+'.evil.test/releases/tag/v0.9.3'},{assets:[{...release().assets[0],browser_download_url:'https://attacker.test/update.zip'}]},{assets:[...release().assets,...release().assets]},{assets:[{...release().assets[0],size:26*1024*1024}]},{assets:[{...release().assets[0],state:'new'}]}])assert.throws(()=>h.api.validateRelease(release('0.9.3',changed)),/INVALID_RELEASE/);
});
test('update check fetches public release metadata anonymously and touches only its own storage key',async()=>{
  const h=fixture();const result=await h.api.check(true);
  assert.equal(result.status,'available');assert.equal(result.currentVersion,'0.9.2');assert.equal(result.latestVersion,'0.9.3');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,h.api.RELEASE_API);
  assert.equal(h.requests[0].init.credentials,'omit');assert.equal(h.requests[0].init.redirect,'error');assert.equal(h.requests[0].init.referrerPolicy,'no-referrer');
  assert.deepEqual(Object.keys(h.requests[0].init.headers),['Accept']);assert.ok(h.reads.every(key=>key===KEY));assert.ok(h.writes.every(value=>Object.keys(value).join(',')===KEY));
  assert.equal(h.badges.at(-1),'NEW');assert.match(h.titles.at(-1),/0.9.3/);
});
test('manual checks are throttled, scheduled checks are six-hourly, and concurrent checks share one request',async()=>{
  const gate=deferred();const h=fixture({fetch:()=>gate.promise});
  const first=h.api.check(true),second=h.api.check(true);assert.equal(first,second);await tick();assert.equal(h.requests.length,1);gate.resolve(jsonResponse(release()));await first;
  await h.api.check(true);assert.equal(h.requests.length,1);
  h.advance(30001);await h.api.check(true);assert.equal(h.requests.length,2);
  h.advance(5*60*60*1000);await h.api.check(false);assert.equal(h.requests.length,2);
  h.advance(60*60*1000);await h.api.check(false);assert.equal(h.requests.length,3);
});
test('current and older releases do not advertise an install and reset the toolbar badge',async()=>{
  for(const version of ['0.9.2','0.9.1']){
    const h=fixture({fetch:async()=>jsonResponse(release(version))});const result=await h.api.check(true);
    assert.equal(result.status,'current');assert.equal(h.badges.at(-1),'');assert.equal(h.titles.at(-1),'AI 学习助手');
    const opened=await h.message({type:'ai-helper:updates-open',action:'download'});assert.equal(opened.ok,false);assert.equal(h.tabs.length,0);
  }
});
test('an unpublished repository and an incomplete release have distinct honest states',async()=>{
  const empty=fixture({fetch:async()=>new Response('',{status:404})});const none=await empty.api.check(true);assert.equal(none.status,'unknown');assert.equal(none.errorCode,'NO_RELEASE');assert.equal(none.downloadUrl,'');
  const pending=fixture({fetch:async()=>jsonResponse(release('0.9.3',{assets:[]}))});const result=await pending.api.check(true);assert.equal(result.status,'unknown');assert.equal(result.errorCode,'RELEASE_NOT_READY');assert.equal(result.downloadUrl,'');assert.ok(result.releaseUrl);
});
test('a failed check retains previously validated release information without claiming a successful check',async()=>{
  let fail=false;const h=fixture({fetch:async()=>{if(fail)throw Error('do-not-expose-secret');return jsonResponse(release());}});
  await h.api.check(true);h.advance(30001);fail=true;const result=await h.api.check(true);
  assert.equal(result.status,'error');assert.equal(result.errorCode,'NETWORK_ERROR');assert.equal(result.latestVersion,'0.9.3');assert.ok(result.downloadUrl);assert.equal(h.badges.at(-1),'NEW');assert.ok(!JSON.stringify(result).includes('do-not-expose-secret'));
});
test('malicious cached URLs cannot open tabs or leak credentials and only the popup can request checks',async()=>{
  const h=fixture({saved:{status:'available',latestVersion:'99.0',checkedAt:1800000000000,releaseUrl:'https://attacker.test/release',downloadUrl:'https://attacker.test/evil.zip'}});
  const opened=await h.message({type:'ai-helper:updates-open',action:'download'});assert.equal(opened.ok,false);assert.equal(h.tabs.length,0);
  for(const sender of [{...h.popup,id:'other'},{...h.popup,tab:{id:2}},{...h.popup,url:'https://mooc1.chaoxing.com/course'}, {...h.popup,url:h.popup.url+'?spoof=1'}]){
    const answer=await h.message({type:'ai-helper:updates-check'},sender);assert.equal(answer.ok,false);assert.equal(answer.code,'UNTRUSTED_SENDER');
  }
  assert.equal(h.requests.length,0);
  await h.message({type:'ai-helper:updates-check'});const download=await h.message({type:'ai-helper:updates-open',action:'download'});assert.equal(download.ok,true);assert.equal(h.tabs.at(-1),repo+'/releases/download/v0.9.3/ai-course-helper-extension-0.9.3.zip');
});
test('response limits, HTTP failures and redirects yield fixed safe error codes',async()=>{
  for(const [fetcher,code] of [
    [async()=>new Response('x'.repeat(256*1024+1)),'RESPONSE_TOO_LARGE'],
    [async()=>new Response('{}',{headers:{'content-length':String(256*1024+1)}}),'RESPONSE_TOO_LARGE'],
    [async()=>new Response('',{status:429}),'RATE_LIMITED'],
    [async()=>new Response('',{status:500}),'HTTP_ERROR'],
    [async()=>{const r=jsonResponse(release());Object.defineProperty(r,'redirected',{value:true});return r;},'INVALID_RELEASE'],
    [async()=>new Response('not-json'),'INVALID_RELEASE']]){
    const h=fixture({fetch:fetcher});const result=await h.api.check(true);assert.equal(result.status,'error');assert.equal(result.errorCode,code);assert.equal(result.downloadUrl,'');
  }
});
test('install/startup establish an alarm and scheduled wakeups honor the cached check time',async()=>{
  const h=fixture();await tick();assert.equal(h.createdAlarms[0].periodInMinutes,360);
  h.onInstalled.fire();await tick();await h.api.check(false);assert.equal(h.requests.length,1);
  h.onStartup.fire();await tick();await h.api.check(false);assert.equal(h.requests.length,1);
  h.advance(6*60*60*1000);h.onAlarm.fire({name:h.api.ALARM_NAME});await tick();await h.api.check(false);assert.equal(h.requests.length,2);
});
test('the fifteen-second deadline aborts metadata transport and returns a fixed timeout code',async()=>{
  let fire;
  const h=fixture({setTimeout:(callback,delay)=>{assert.equal(delay,15000);fire=callback;return 1;},clearTimeout:()=>{},fetch:async(_url,init)=>await new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('do-not-expose-transport-details')),{once:true}))});
  const pending=h.api.check(true);await tick();fire();const result=await pending;
  assert.equal(h.requests[0].init.signal.aborted,true);assert.equal(result.status,'error');assert.equal(result.errorCode,'CHECK_TIMEOUT');assert.ok(!JSON.stringify(result).includes('transport-details'));
});
