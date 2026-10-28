"""Verify GitHub update discovery with the real unpacked MV3 extension in Edge.

The service-worker fetch transport returns fixed local release metadata through
DevTools. Production update functions and Chrome APIs remain real. No ZIP is downloaded.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ast
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
version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
archive = ROOT / "dist" / f"ai-course-helper-extension-{version}.zip"
initial_hash = hashlib.sha256(archive.read_bytes()).hexdigest().upper()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = b'<!doctype html><html><head><meta charset="utf-8"><title>Update boundary fixture</title></head><body><h1>Local course</h1><p>No model key or question is provided.</p></body></html>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# Reuse only the CDP transport, without running the older test's fixture.
tree = ast.parse((ROOT / "tests" / "extension-browser.py").read_text(encoding="utf-8"))
old_runner = next(node.value.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "RUNNER" for target in node.targets))
RUNNER = old_runner[:old_runner.index("const debugPort=")] + r'''
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3];
const API='https://api.github.com/repos/aides-hik/ai-course-helper/releases/latest';
const transportCall=CDP.prototype.call;
CDP.prototype.call=async function(method,params={}){let guard;try{return await Promise.race([transportCall.call(this,method,params),new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('CDP command timed out: '+method)),22000);})]);}finally{clearTimeout(guard);}};
const REPO='https://github.com/aides-hik/ai-course-helper',KEY='ai-course-helper:updates:v1';
const report={realExtension:true,githubMetadataTransportStubbedViaDevTools:true,noProductionUpdateFunctionsReplaced:true,scenarios:[],errors:[]};
const assert=(value,message)=>{if(!value)throw Error(message);};
const poll=async(check,label,attempts=160)=>{for(let i=0;i<attempts;i++){try{const value=await check();if(value)return value;}catch{}await wait(50);}throw Error('Timed out: '+label);};
const list=async()=>await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
let worker,popup,page;
const release=(version)=>({draft:false,prerelease:false,tag_name:'v'+version,html_url:REPO+'/releases/tag/v'+version,assets:[{name:'ai-course-helper-extension-'+version+'.zip',state:'uploaded',size:1048576,browser_download_url:REPO+'/releases/download/v'+version+'/ai-course-helper-extension-'+version+'.zip'}]});
const read=()=>worker.evaluate(`AiHelperUpdates.readState()`);
const openPopup=async()=>{
 if(popup){try{await popup.evaluate('setTimeout(()=>window.close(),0);true');}catch{}popup.close();await wait(160);}
 await page.call('Page.bringToFront');await wait(80);
 await worker.evaluate('chrome.action.openPopup()');
 const target=await poll(async()=>(await list()).find(t=>t.url.endsWith('/popup.html')),'actual action popup target');
 popup=new CDP(target.webSocketDebuggerUrl);await popup.call('Page.enable');await popup.call('Runtime.enable');
 await poll(async()=>await popup.evaluate(`document.querySelector('#check-updates')&&!document.querySelector('#check-updates').disabled`),'actual update controls');
};
try{
 const targets=await list(),workerTarget=targets.find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js'));
 assert(workerTarget,'Native extension worker missing');
 worker=new CDP(workerTarget.webSocketDebuggerUrl);await worker.call('Runtime.enable');
 await poll(async()=>await worker.evaluate('Boolean(globalThis.AiHelperUpdates)'),'update module loaded');
 await worker.evaluate(`globalThis.__updateFixture={status:404,body:{message:'No releases'}};globalThis.__updateCalls=[];globalThis.fetch=async(url,options)=>{if(url!==${JSON.stringify(API)})throw Error('Unexpected fixture request');__updateCalls.push({url,method:options.method,credentials:options.credentials,redirect:options.redirect,authorizationAbsent:!Object.keys(options.headers||{}).some(key=>key.toLowerCase()==='authorization')});if(__updateFixture.fail)throw Error('Fixture network failure');return new Response(JSON.stringify(__updateFixture.body),{status:__updateFixture.status,headers:{'Content-Type':'application/json'}});};`);
 await worker.evaluate('AiHelperUpdates.check(false)');
 await worker.evaluate(`chrome.storage.local.remove(${JSON.stringify(KEY)})`);
 const version=await worker.evaluate('chrome.runtime.getManifest().version');report.version=version;
 const alarm=await worker.evaluate(`chrome.alarms.get('ai-helper:check-updates')`);
 assert(alarm?.periodInMinutes===360,'Six-hour update alarm missing: '+JSON.stringify(alarm));report.alarmPeriodMinutes=alarm.periodInMinutes;report.scenarios.push('real-native-six-hour-update-alarm-is-created');
 const initial=targets.find(t=>t.type==='page'&&t.url==='about:blank');assert(initial,'Initial browser page missing');
 page=new CDP(initial.webSocketDebuggerUrl);await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Network.enable');
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?updates-boundary=1'});
 const isolated=await poll(async()=>{for(const context of page.events.filter(e=>e.method==='Runtime.executionContextCreated').map(e=>e.params.context).reverse()){try{if(await page.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue)',context.id))return context.id;}catch{}}},'course isolated extension context');
 const rejected=await page.evaluate(`chrome.runtime.sendMessage({type:'ai-helper:updates-check'})`,isolated);
 assert(rejected?.ok===false&&rejected.code==='UNTRUSTED_SENDER','Course content was allowed to trigger privileged updater');
 assert(await page.evaluate('typeof GM_xmlhttpRequest==="undefined"&&typeof GM_getValue==="undefined"'),'MAIN page unexpectedly exposes adapters');report.scenarios.push('webpage-and-course-content-cannot-borrow-the-update-service');
 await worker.evaluate(`globalThis.__updateFixture=${JSON.stringify({status:200,body:release('9.9.9')})};`);
 await openPopup();
 await popup.evaluate(`document.getElementById('check-updates').click();true`);
 await poll(async()=>await popup.evaluate(`document.getElementById('update-status').dataset.state==='available'&&!document.getElementById('check-updates').disabled`),'native popup shows available release');
 const available=await read();assert(available.status==='available'&&available.latestVersion==='9.9.9','Higher release not detected');
 assert(await worker.evaluate('chrome.action.getBadgeText({})')==='NEW','NEW badge missing');report.scenarios.push('real-action-popup-manual-check-discovers-new-release-and-sets-toolbar-badge');
 const layout=await popup.evaluate(`(()=>{const b=document.getElementById('check-updates').getBoundingClientRect(),d=document.getElementById('download-update').getBoundingClientRect();return {viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight,checkVisible:b.top>=0&&b.bottom<=innerHeight,downloadVisible:d.top>=0&&d.bottom<=innerHeight};})()`);
 assert(layout.scrollWidth<=352&&layout.checkVisible&&layout.downloadVisible,'Popup controls are not reachable: '+JSON.stringify(layout));report.popupLayout=layout;
 try{const shot=await popup.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(root+'/tests/updates-popup.png',Buffer.from(shot.data,'base64'));report.screenshot='updates-popup.png';}catch{report.nativePopupScreenshotUnsupported=true;}
 const cached=await worker.evaluate(`chrome.storage.local.get(${JSON.stringify(KEY)})`);assert(cached[KEY].latestVersion==='9.9.9','Version cache was not persisted');report.scenarios.push('validated-release-is-persisted-in-independent-update-storage');
 await popup.evaluate(`document.getElementById('download-update').click();true`);
 const download=await poll(async()=>await worker.evaluate('chrome.tabs.query({})').then(tabs=>tabs.find(tab=>tab.url===REPO+'/releases/download/v9.9.9/ai-course-helper-extension-9.9.9.zip')),'validated release download tab');
 assert(await worker.evaluate('chrome.runtime.getManifest().version')===version,'Update must not install itself');await worker.evaluate(`chrome.tabs.remove(${download.id})`);report.scenarios.push('actual-download-button-opens-the-validated-release-asset-without-installing');
 const calls=await worker.evaluate('globalThis.__updateCalls');assert(calls.length&&calls.every(call=>call.url===API&&call.method==='GET'&&call.credentials==='omit'&&call.redirect==='error'&&call.authorizationAbsent),'Metadata request policy mismatch');report.githubTransportCalls=calls.length;report.updateRequestsContainNoModelCredentials=true;
 const modelCalls=page.events.filter(e=>e.method==='Network.requestWillBeSent'&&/api\.openai\.com|api\.deepseek\.com/.test(e.params.request.url));assert(modelCalls.length===0,'Update checks triggered model traffic');report.modelRequests=0;
 report.unitOnlyCoverage=['current-and-older-releases','malformed-and-foreign-metadata','404-and-network-failures','cooldown-and-concurrent-checks'];
 report.errors=[...worker.events,...popup.events,...page.events].filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);assert(!report.errors.length,'Runtime exceptions');report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{report.updateState=await read();report.popupState=await popup.evaluate(`({status:document.getElementById('update-status').textContent,disabled:document.getElementById('check-updates').disabled})`);}catch{}}
console.log(JSON.stringify(report));try{await page?.call('Browser.close');}catch{}popup?.close();page?.close();worker?.close();
'''

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
host = f"http://mooc1.chaoxing.com:{server.server_port}"
profile = ROOT / "tests" / ".updates-profile"
port_file = profile / "DevToolsActivePort"
port_file.unlink(missing_ok=True)
browser = subprocess.Popen([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server", "--user-data-dir=" + str(profile),
    "--remote-debugging-port=0", "--load-extension=" + str(EXTENSION),
    "--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1,MAP api.github.com 127.0.0.1,MAP github.com 127.0.0.1",
    "--window-size=1280,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            debug_port = int(port_file.read_text().splitlines()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=1) as response:
                targets = json.load(response)
            if any(target.get("type") == "service_worker" and target.get("url", "").endswith("/background.js") for target in targets):
                break
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(.05)
    else:
        raise RuntimeError("Native extension did not register its worker")
    result = subprocess.run(["node", "--input-type=module", "-e", RUNNER, str(debug_port), str(ROOT), host], capture_output=True, text=True, encoding="utf-8", timeout=100)
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
output["packageSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
assert initial_hash == output["packageSha256"], "The extension package changed while the browser was being checked"
(ROOT / "tests" / f"verification-{version}-updates-browser.log").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(output, ensure_ascii=False))
assert output.get("passed"), output
