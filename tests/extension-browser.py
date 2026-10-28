"""Exercise the unpacked MV3 extension in real Edge, with local HTTP endpoints."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "dist" / "ai-course-helper-extension"
assert (EXTENSION / "manifest.json").exists(), "Run python build_extension.py first"
requests = []
lock = threading.Lock()

PAGE = r'''<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-native-fixture'; object-src 'none'"><title>Native extension offline review</title>
<style>body{font:16px/1.6 sans-serif;background:#eef1fa;margin:0;padding:30px}.questionLi{margin-top:50px;padding:20px;background:white}.answerBg{padding:12px;border-bottom:1px solid #eee;cursor:pointer}.answerBg input{margin-right:10px}.check_answer{background:#e9f5e9}</style>
</head><body><h1>本地课程 · 原生扩展检查</h1><p>此页面没有加载篡改猴或任何 GM 兼容代码。</p>
<script nonce="native-fixture">
window.__pageErrors=[];window.__pageActions={save:0,submit:0,confirm:0,next:0};
window.addEventListener('error',event=>window.__pageErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.__pageErrors.push(String(event.reason)));
window.noSubmit=()=>{window.__pageActions.save++;return Promise.resolve('saved');};
window.btnBlueSubmit=()=>{window.__pageActions.submit++;};
window.submitCheckTimes=()=>{window.__pageActions.confirm++;};
window.getTheNextQuestion=()=>{window.__pageActions.next++;};
if(new URL(location.href).searchParams.get('question')==='editor'){
 const question=document.createElement('section');question.id='native-editor-question';question.className='questionLi';question.innerHTML='<h3><span class="colorShallow">【填空题】</span>Native rich editor question ___</h3><textarea id="native-editor" style="display:none"></textarea><div id="native-editor-body" contenteditable="true" style="min-height:80px;border:1px solid #ddd"></div>';document.body.append(question);
 const editor={isReady:true,textarea:question.querySelector('textarea'),body:question.querySelector('[contenteditable]'),setContent(html){this.body.innerHTML=html;},getContentTxt(){return this.body.textContent;}};window.UE={instants:{'native-editor':editor}};
}else if(new URL(location.href).searchParams.has('question')){
 const question=document.createElement('section');question.id='native-question';question.className='questionLi';
 question.innerHTML='<h3><span class="colorShallow">【单选题】</span>Native extension offline question</h3>'+[0,1].map(index=>'<div class="answerBg"><input type="radio" name="native-q"><span class="before">'+String.fromCharCode(65+index)+'</span><span class="answer_p">Option '+index+'</span></div>').join('');document.body.append(question);
 for(const row of question.querySelectorAll('.answerBg'))row.addEventListener('click',()=>{for(const input of question.querySelectorAll('input'))input.checked=false;for(const item of question.querySelectorAll('.answerBg'))item.classList.remove('check_answer');row.querySelector('input').checked=true;row.classList.add('check_answer');});
}
document.cookie='native_test_cookie=DO-NOT-FORWARD; SameSite=Lax; path=/';
</script></body></html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, payload, status=200, content_type="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def record(self, body=""):
        # Fake fixture credentials are checked in memory; never serialize them.
        entry = {"method": self.command, "path": self.path, "cookieAbsent": not self.headers.get("Cookie"),
                 "authorizationCorrect": self.headers.get("Authorization") == "Bearer FAKE-EXTENSION-KEY",
                 "body": body, "started": time.monotonic()}
        with lock:
            requests.append(entry)
        return entry

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/mooc2/work/dowork"):
            return self.reply(PAGE.encode(), content_type="text/html; charset=utf-8")
        if path == "/favicon.ico":
            return self.reply(b"", status=204)
        if path == "/fixture-report":
            with lock:
                summary = [{key: value for key, value in item.items() if key not in ("body", "started", "finished")} for item in requests]
            return self.reply(summary)
        entry = self.record()
        if path == "/redirect/models":
            self.send_response(302)
            self.send_header("Location", "/should-not-receive")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path in ("/slow/models", "/abort/models", "/close/models"):
            time.sleep(33 if path == "/slow/models" else 8)
        if path == "/oversize/models":
            return self.reply(b"x" * (4 * 1024 * 1024 + 1))
        entry["finished"] = time.monotonic()
        return self.reply({"object": "list", "data": [{"id": "native-fixture-model", "object": "model"}]})

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        self.record(data)
        if urllib.parse.urlparse(self.path).path == "/slow/responses":
            time.sleep(33)
        try:
            prepared = json.loads(json.loads(data).get("input", "{}"))
        except (ValueError, TypeError):
            prepared = {}
        text_type = prepared.get("type") in ("blank", "text")
        answer = {"answerable": True, "choice_indices": [] if text_type else [1], "text_answers": ["native editor answer"] if text_type else [], "judgement": "unknown", "explanation": "local native extension fixture"}
        return self.reply({"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}], "usage": {"total_tokens": 12}})


RUNNER = r'''
import fs from 'node:fs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class CDP {
 constructor(url){this.ws=new WebSocket(url);this.pending=new Map();this.seq=0;this.events=[];this.listeners=[];this.opened=new Promise((res,rej)=>{this.ws.addEventListener('open',res,{once:true});this.ws.addEventListener('error',rej,{once:true});});this.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const job=this.pending.get(value.id);if(!job)return;this.pending.delete(value.id);value.error?job.reject(Error(value.error.message)):job.resolve(value.result);}else{this.events.push(value);for(const listener of this.listeners)listener(value);}});}
 async call(method,params={}){await this.opened;return new Promise((resolve,reject)=>{const id=++this.seq;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression,contextId){const response=await this.call('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true,userGesture:true});if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);return response.result?.value;}
 close(){this.ws.close();}
}
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3],extensionId=process.argv[4];
const report={realExtension:true,tampermonkey:false,offline:true,scenarios:[],errors:[]};
const list=async()=>await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
let page,worker,isolated,shadow;
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const poll=async(check,label,attempts=160)=>{for(let i=0;i<attempts;i++){try{const result=await check();if(result)return result;}catch{}await wait(50);}throw Error('Timed out: '+label);};
const connectPage=async target=>{const c=new CDP(target.webSocketDebuggerUrl);await c.call('Page.enable');await c.call('Runtime.enable');return c;};
const discoverUi=async()=>{
 isolated=await poll(async()=>{const contexts=page.events.filter(event=>event.method==='Runtime.executionContextCreated').map(event=>event.params.context);for(const context of contexts.reverse()){try{if(await page.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue&&globalThis.Pinia)',context.id))return context.id;}catch{}}},'extension isolated context');
 await page.call('DOM.enable');
 shadow=await poll(async()=>{const {root:doc}=await page.call('DOM.getDocument',{depth:-1,pierce:true});const collect=node=>[...(node.shadowRoots||[]),...(node.children||[]).flatMap(collect),...(node.contentDocument?collect(node.contentDocument):[])];const roots=collect(doc).filter(node=>node.shadowRootType);for(const candidate of roots){const resolved=await page.call('DOM.resolveNode',{nodeId:candidate.nodeId,executionContextId:isolated});const inspected=await page.call('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:`function(){if(!this.querySelector('.ai-config'))return false;const mount=[...this.querySelectorAll('div')].find(node=>node.__vue_app__);const stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores)return false;globalThis.__nativeUi={root:this,config:stores.get('configStore'),logs:stores.get('logStore'),questions:stores.get('questionStore')};return !!globalThis.__nativeUi.config;}`,returnByValue:true});if(inspected.result?.value)return candidate.nodeId;}return false;},'real extension closed-shadow UI');
 return true;
};
const ui=expression=>page.evaluate(expression,isolated);
const configEndpoint=async(path='/v1/models',method='GET')=>{
 await ui(`chrome.storage.local.set({['openai-course-helper:config:v1:field:'+JSON.stringify(['ai',${JSON.stringify(method==='POST'?'apiUrl':'modelsUrl')}])]:JSON.stringify({v:1,value:${JSON.stringify(host)}+${JSON.stringify(path)}})})`);await wait(75);
};
const direct=async(path,timeout=20000,abortAfter=0,method='GET')=>{
 await configEndpoint(path,method);
 return await ui(`(async()=>{const ready=await chrome.runtime.sendMessage({type:'ai-helper:network-ready'});if(!ready?.ok)throw Error('Network document was not ready: '+JSON.stringify(ready));const port=chrome.runtime.connect({name:'ai-helper:network'});return await new Promise((resolve,reject)=>{const guard=setTimeout(()=>{port.disconnect();reject(Error('No network reply'));},${Math.min(360000,timeout+7000)});port.onMessage.addListener(message=>{if(message.id!=='qa-direct')return;clearTimeout(guard);port.disconnect();resolve(message);});port.onDisconnect.addListener(()=>{if(chrome.runtime.lastError){};});port.postMessage({type:'request',id:'qa-direct',request:{url:${JSON.stringify(host+path)},method:${JSON.stringify(method)},headers:{Authorization:'Bearer FAKE-EXTENSION-KEY'${method==='POST'?',"Content-Type":"application/json"':''}},${method==='POST'?'data:"{}",':''}timeout:${timeout}}});${abortAfter?`setTimeout(()=>port.postMessage({type:'abort',id:'qa-direct'}),${abortAfter});`:''}});})()`);
};
try{
 const targets=await list();const target=targets.find(item=>item.type==='page'&&item.url==='about:blank');assert(target,'Initial page target missing');
 page=await connectPage(target);
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?initial'});await discoverUi();
 report.scenarios.push('native-extension-mounts-from-local-resources-without-GM');
 assert(await page.evaluate(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')&&Array.isArray(window.__pageErrors)`),'Nonce-restricted fixture script did not execute');report.scenarios.push('nonce-restricted-course-CSP-runs-the-native-content-app-without-eval');
 const confidentiality=await page.evaluate(`({gm:typeof GM_getValue,network:typeof GM_xmlhttpRequest,unsafe:typeof unsafeWindow,vue:typeof Vue,chromeId:globalThis.chrome?.runtime?.id??null,body:document.body.textContent.includes('FAKE-EXTENSION-KEY')})`);
 assert(confidentiality.gm==='undefined'&&confidentiality.network==='undefined'&&confidentiality.unsafe==='undefined'&&confidentiality.vue==='undefined'&&!confidentiality.chromeId&&!confidentiality.body,'Extension privileges or globals leaked into MAIN: '+JSON.stringify(confidentiality));
 report.scenarios.push('page-world-has-no-GM-api-keys-or-extension-library-globals');
 const stores=await ui(`(async()=>{const {root,config}=__nativeUi;const input=(selector,value)=>{const node=root.querySelector(selector);if(!node)throw Error('Missing '+selector);const proto=node.matches('textarea')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};config.ai.provider='openai';config.menuIndex='1';await Vue.nextTick();input('input[type="password"]','FAKE-EXTENSION-KEY');input('input[placeholder*="模型"]','native-fixture-model');config.ai.apiUrl=${JSON.stringify(host+'/v1/responses')};config.ai.modelsUrl=${JSON.stringify(host+'/v1/models')};config.ai.timeoutSeconds=120;config.ai.concurrentEnabled=true;config.ai.concurrency=2500;await Vue.nextTick();await new Promise(resolve=>setTimeout(resolve,100));return{key:config.ai.apiKey==='FAKE-EXTENSION-KEY',model:config.ai.model,save:!!root.querySelector('.ai-save')};})()`);
 assert(stores.key&&stores.model==='native-fixture-model'&&stores.save,'Real input configuration failed: '+JSON.stringify(stores));
 await ui(`__nativeUi.root.querySelector('.ai-save').click()`);await wait(300);await discoverUi();
 const restored=await ui(`({key:__nativeUi.config.ai.apiKey==='FAKE-EXTENSION-KEY',model:__nativeUi.config.ai.model,concurrency:__nativeUi.config.ai.concurrency,url:__nativeUi.config.ai.apiUrl})`);
 assert(restored.key&&restored.model==='native-fixture-model'&&restored.concurrency===2500&&restored.url===host+'/v1/responses','Save/reload lost configuration: '+JSON.stringify(restored));
 report.scenarios.push('real-controls-save-and-reload-key-model-custom-URL-and-concurrency-2500');
 await ui(`(async()=>{__nativeUi.config.menuIndex='1';await Vue.nextTick();const button=[...__nativeUi.root.querySelectorAll('button')].find(node=>node.textContent.includes('获取模型'));if(!button)throw Error('No get-models button');button.click();})()`);
 await poll(async()=>await ui(`__nativeUi.root.textContent.includes('native-fixture-model')&&/获取.*1|1.*模型|成功/.test(__nativeUi.root.querySelector('.ai-model-status')?.textContent||'')`),'real GET model list');
 report.scenarios.push('model-button-fetches-from-native-offscreen-network-worker');
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?question=1'});await discoverUi();
 await poll(async()=>await page.evaluate(`document.querySelectorAll('#native-question input')[1]?.checked===true`),'real POST answer filling',240);
 const answer=await ui(`({result:__nativeUi.root.querySelector('.answer-result--success')?.textContent||'',rows:__nativeUi.questions?.questionList?.length||0})`);
 assert(answer.result||answer.rows,'Native answer did not reach result display');report.scenarios.push('native-POST-model-answer-fills-actual-course-radio-option');
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?question=editor'});await discoverUi();
 await poll(async()=>await page.evaluate(`document.querySelector('#native-editor-body')?.textContent==='native editor answer'`),'MAIN UEditor bridge fill',240);
 const rich=await page.evaluate(`({editorText:UE.instants['native-editor'].getContentTxt(),body:document.querySelector('#native-editor-body').textContent})`);assert(rich.editorText==='native editor answer'&&rich.body==='native editor answer','Rich editor bridge did not synchronize page editor');report.scenarios.push('isolated-model-answer-fills-and-verifies-MAIN-UEditor');
 await ui(`(async()=>{__nativeUi.config.menuIndex='0';await Vue.nextTick();})()`);await wait(200);const preview=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(root+'/tests/extension-native-desktop.png',Buffer.from(preview.data,'base64'));report.screenshot='extension-native-desktop.png';
 const pageActions=await ui(`(async()=>{const invoke=action=>new Promise((resolve,reject)=>{const span=document.createElement('span');span.hidden=true;span.setAttribute('data-ai-request',JSON.stringify({v:1,id:'qa-page-action',action:action==='nextQuestion'?'nextQuestion':'call',frame:{path:[],url:document.URL},method:action,args:[]}));document.documentElement.append(span);const read=()=>{const value=JSON.parse(span.getAttribute('data-ai-response')||'null');if(value&&!value.pending){span.remove();resolve(value);}};span.addEventListener('ai-course-extension-page-response',read);span.dispatchEvent(new CustomEvent('ai-course-extension-page-request',{bubbles:true}));read();setTimeout(()=>{if(span.isConnected){span.remove();reject(Error('Page action bridge timeout'));}},1000);});return{saved:await invoke('noSubmit'),next:await invoke('nextQuestion'),blocked:await invoke('fetch')};})()`);assert(pageActions.saved.ok&&pageActions.next.ok&&!pageActions.blocked.ok,'Fixed action bridge failed: '+JSON.stringify(pageActions));
 const counters=await page.evaluate('window.__pageActions');assert(counters.save===1&&counters.next===1&&counters.submit===0,'Bridge action counters incorrect: '+JSON.stringify(counters));report.scenarios.push('fixed-page-save-and-next-actions-work-arbitrary-function-is-rejected');
 await page.call('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:false});
 const narrow=await ui(`(async()=>{window.dispatchEvent(new Event('resize'));__nativeUi.config.menuIndex='1';await Vue.nextTick();await new Promise(resolve=>setTimeout(resolve,200));const root=__nativeUi.root,panel=root.querySelector('.main-page'),save=root.querySelector('.ai-save'),scroll=root.querySelector('.ai-config-scroll');const visible=()=>{const b=save.getBoundingClientRect();const hit=root.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight&&(hit===save||save.contains(hit));};for(const fraction of [0,.5,1]){scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*fraction;await Vue.nextTick();if(!visible())throw Error('Narrow save clipped or covered');}scroll.scrollTop=0;const b=panel.getBoundingClientRect();if(b.width>305||b.right>innerWidth+1||b.left<0||panel.scrollWidth>panel.clientWidth+1)throw Error('Native narrow panel overflows');return{viewport:innerWidth,panelWidth:b.width,pinnedSave:true};})()`);assert(narrow.viewport===320&&narrow.pinnedSave,'Native narrow viewport test failed');report.narrow=narrow;report.scenarios.push('real-320px-extension-layout-keeps-save-visible-at-all-scroll-positions');
 const narrowShot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(root+'/tests/extension-native-320.png',Buffer.from(narrowShot.data,'base64'));
 await page.call('Emulation.clearDeviceMetricsOverride');await ui(`window.dispatchEvent(new Event('resize'))`);
 const primary={page,isolated,shadow};const {targetId:secondId}=await page.call('Target.createTarget',{url:host+'/mooc2/work/dowork?second'});const secondTarget=await poll(async()=>(await list()).find(item=>item.id===secondId),'second native tab');page=await connectPage(secondTarget);await discoverUi();const second={page,isolated,shadow};page=primary.page;isolated=primary.isolated;shadow=primary.shadow;
 await ui(`(async()=>{for(const value of ['FAKE-TRANSIENT-ONE','FAKE-TRANSIENT-TWO','FAKE-EXTENSION-KEY']){__nativeUi.config.ai.apiKey=value;await Vue.nextTick();await new Promise(resolve=>setTimeout(resolve,0));}__nativeUi.config.ai.model='native-first-tab-model';await Vue.nextTick();})()`);
 await second.page.evaluate(`(async()=>{__nativeUi.config.ai.maxOutputTokens=16384;await Vue.nextTick();})()`,second.isolated);
 await poll(async()=>await ui(`__nativeUi.config.ai.maxOutputTokens===16384`)&&await second.page.evaluate(`__nativeUi.config.ai.model==='native-first-tab-model'&&__nativeUi.config.ai.apiKey==='FAKE-EXTENSION-KEY'`,second.isolated),'cross-tab field sync');
 const persisted=await ui(`(async()=>{const data=await chrome.storage.local.get(null);return{key:JSON.parse(data['openai-course-helper:config:v1:field:'+JSON.stringify(['ai','apiKey'])]).value==='FAKE-EXTENSION-KEY',model:JSON.parse(data['openai-course-helper:config:v1:field:'+JSON.stringify(['ai','model'])]).value,maxOutputTokens:JSON.parse(data['openai-course-helper:config:v1:field:'+JSON.stringify(['ai','maxOutputTokens'])]).value};})()`);assert(persisted.key&&persisted.model==='native-first-tab-model'&&persisted.maxOutputTokens===16384,'Storage echo or second tab overwrote pending fields: '+JSON.stringify(persisted));
 await ui(`(async()=>{__nativeUi.config.ai.model='native-fixture-model';await Vue.nextTick();await new Promise(resolve=>setTimeout(resolve,100));})()`);await page.call('Target.closeTarget',{targetId:secondId});second.page.close();report.scenarios.push('rapid-local-writes-and-independent-two-tab-edits-preserve-final-credentials');
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?popup'});await discoverUi();await ui(`(async()=>{__nativeUi.config.isMinus=true;await Vue.nextTick();})()`);
 const {targetId:popupId}=await page.call('Target.createTarget',{url:'chrome-extension://'+extensionId+'/popup.html',background:true});const popupTarget=await poll(async()=>(await list()).find(item=>item.id===popupId),'popup document');const popup=await connectPage(popupTarget);
 await poll(async()=>await popup.evaluate(`document.querySelector('#show')&&document.querySelector('#version')?.textContent.includes(chrome.runtime.getManifest().version)`),'actual popup UI');
 await popup.evaluate(`(async()=>{const tabs=await chrome.tabs.query({url:${JSON.stringify(host+'/*')}});const course=tabs.find(tab=>tab.url.includes('?popup'));if(!course)throw Error('Course tab missing');await chrome.tabs.update(course.id,{active:true});document.querySelector('#show').click();})()`);
 await poll(async()=>await popup.evaluate(`document.querySelector('#status').textContent==='面板已展开。'`)&&await ui(`__nativeUi.config.isMinus===false`),'popup opens active course panel');
 await page.evaluate(`document.body.dataset.qaBeforeRefresh='true'`);await popup.evaluate(`setTimeout(()=>document.querySelector('#refresh').click(),0);true`);await poll(async()=>await page.evaluate(`!document.body.dataset.qaBeforeRefresh`),'popup refreshes active course');await discoverUi();try{await page.call('Target.closeTarget',{targetId:popupId});}catch{}popup.close();report.scenarios.push('actual-popup-buttons-expand-the-panel-and-refresh-current-course');
 const plain=await direct('/v1/models');assert(plain.type==='response'&&plain.response.status===200,'Direct native models failed: '+JSON.stringify(plain));
 const blocked=await ui(`(async()=>{await chrome.runtime.sendMessage({type:'ai-helper:network-ready'});const p=chrome.runtime.connect({name:'ai-helper:network'});return new Promise(resolve=>{p.onMessage.addListener(m=>{if(m.id==='blocked'){p.disconnect();resolve(m);}});p.postMessage({type:'request',id:'blocked',request:{url:${JSON.stringify(host+'/not-configured')},method:'GET',headers:{Authorization:'Bearer FAKE-EXTENSION-KEY'},timeout:20000}});});})()`);
 assert(blocked.type==='error','Unconfigured request must fail: '+JSON.stringify(blocked));report.scenarios.push('arbitrary-unconfigured-URL-rejected');
 const redirect=await direct('/redirect/models');assert(redirect.type==='error','Redirect must be rejected: '+JSON.stringify(redirect));report.scenarios.push('credential-bearing-redirect-rejected');
 const oversize=await direct('/oversize/models');assert(oversize.type==='error','Oversize response must be rejected');report.scenarios.push('response-size-limit-enforced');
 const started=Date.now();const slow=await direct('/slow/responses',60000,0,'POST');const elapsed=Date.now()-started;assert(slow.type==='response'&&slow.response.status===200&&elapsed>=32000,'Long model request failed: '+JSON.stringify({slow,elapsed}));report.longRequestMilliseconds=elapsed;report.scenarios.push('model-response-after-33-seconds-survives-service-worker-lifetime');
 const aborted=await direct('/abort/models',20000,150);assert(aborted.type==='abort','Abort must be acknowledged: '+JSON.stringify(aborted));report.scenarios.push('in-flight-native-request-aborts');
 await configEndpoint('/close/models');
 await ui(`(async()=>{await chrome.runtime.sendMessage({type:'ai-helper:network-ready'});globalThis.__closePort=chrome.runtime.connect({name:'ai-helper:network'});__closePort.postMessage({type:'request',id:'close-request',request:{url:${JSON.stringify(host+'/close/models')},method:'GET',headers:{Authorization:'Bearer FAKE-EXTENSION-KEY'},timeout:20000}});})()`);await wait(250);
 await page.call('Page.navigate',{url:'about:blank'});await wait(300);report.scenarios.push('navigation-disconnects-the-content-request-port');
 const summaries=await(await fetch('http://127.0.0.1:'+host.split(':').at(-1)+'/fixture-report')).json();
 assert(summaries.length>=7,'Fixture did not receive actual native network calls');assert(summaries.every(item=>item.cookieAbsent),'Page cookies reached model endpoint');assert(summaries.every(item=>item.authorizationCorrect),'Model endpoint received wrong Authorization');assert(!summaries.some(item=>item.path.startsWith('/should-not-receive')||item.path.startsWith('/not-configured')),'Rejected endpoint received credentials');
 report.networkCalls=summaries;report.scenarios.push('all-real-model-requests-omit-page-cookies-and-use-correct-provider-key');
 report.errors=page.events.filter(event=>event.method==='Runtime.exceptionThrown').map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text);assert(!report.errors.length,'Unexpected runtime exceptions: '+JSON.stringify(report.errors));
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{const shot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(root+'/tests/extension-failure.png',Buffer.from(shot.data,'base64'));}catch{}}
console.log(JSON.stringify(report));
try{await page?.call('Browser.close');}catch{}page?.close();worker?.close();
'''

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
host = f"http://mooc1.chaoxing.com:{server.server_port}"
profile = ROOT / "tests" / ".extension-profile"
port_file = profile / "DevToolsActivePort"
port_file.unlink(missing_ok=True)
browser = subprocess.Popen([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server",
    "--user-data-dir=" + str(profile), "--remote-debugging-port=0", "--load-extension=" + str(EXTENSION),
    "--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1", "--window-size=1280,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
output = None
try:
    deadline = time.monotonic() + 12
    extension_id = None
    while time.monotonic() < deadline:
        try:
            debug_port = int(port_file.read_text().splitlines()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=1) as response:
                targets = json.load(response)
            target = next(item for item in targets if item.get("type") == "service_worker" and item.get("url", "").endswith("/background.js"))
            extension_id = urllib.parse.urlparse(target["url"]).netloc
            break
        except (OSError, ValueError, IndexError, StopIteration):
            time.sleep(.05)
    if not extension_id:
        raise RuntimeError("The unpacked extension service worker did not load")
    result = subprocess.run(["node", "--input-type=module", "-e", RUNNER, str(debug_port), str(ROOT), host, extension_id],
                            capture_output=True, text=True, encoding="utf-8", timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    output = json.loads(result.stdout)
finally:
    if browser.poll() is None:
        browser.terminate()
        try:
            browser.wait(timeout=3)
        except subprocess.TimeoutExpired:
            browser.kill()
    server.shutdown()
if output:
    output["extensionId"] = extension_id
    output["manifestSha256"] = hashlib.sha256((EXTENSION / "manifest.json").read_bytes()).hexdigest().upper()
    output["contentSha256"] = hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper()
    output["pageMainSha256"] = hashlib.sha256((EXTENSION / "page-main.js").read_bytes()).hexdigest().upper()
    version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
    archive = ROOT / "dist" / f"ai-course-helper-extension-{version}.zip"
    output["packageSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
    (ROOT / "tests" / f"verification-{version}-browser.log").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))
    assert output.get("passed"), output
