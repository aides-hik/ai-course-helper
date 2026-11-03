"""Exercise taskless chapter navigation in the real native Edge extension.

The course pages and requests are local fixtures. The shipped extension and its
500 ms scanner, five-second observation, native storage and navigation run on
the real clock; no GM shim or model endpoint is used.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ast
import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "dist" / "ai-course-helper-extension"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
PROFILES = ROOT / "tests" / ".empty-chapter-profile"
PROFILES.mkdir(exist_ok=True)
traffic = []


def page(body, script=""):
    return ('<!doctype html><html><head><meta charset="utf-8"><title>Local empty chapter fixture</title>'
            '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-empty-fixture\'; object-src \'none\'">'
            '<style>body{margin:20px;font:16px/1.7 sans-serif;background:#eef3fa}iframe{width:92%;height:280px;background:white}button{padding:12px}.loading{padding:20px;background:#ffe5aa}</style>'
            '</head><body>' + body + '<script nonce="empty-fixture">window.__fixtureErrors=[];addEventListener("error",e=>__fixtureErrors.push(e.message));' + script + '</script></body></html>').encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        mode = query.get("scenario", ["chain"])[0]
        chapter = int(query.get("knowledgeid", ["1"])[0])
        if url.path == "/mycourse/studentstudy":
            script = """window.__nextClicks=0;window.__clickTimes=[];window.__loads=[];
const chapter=document.querySelector('#iframe');chapter.addEventListener('load',()=>__loads.push({time:performance.now(),url:chapter.src}));
document.querySelector('#prevNextFocusNext').onclick=()=>{__nextClicks++;__clickTimes.push(performance.now());const next=new URL(chapter.src);next.searchParams.set('knowledgeid',String(Number(next.searchParams.get('knowledgeid'))+1));chapter.src=next.href;};"""
            return self.send(page('<h1>本地空章节导航检查</h1><iframe id="iframe" src="/mooc-ans/knowledge/cards?scenario=' + mode + '&knowledgeid=1"></iframe><button id="prevNextFocusNext">下一节</button>', script))
        if url.path == "/mooc-ans/knowledge/cards":
            if mode == "chain":
                body = "" if chapter == 1 else "<p>无任务的课程说明文字。</p>" if chapter == 2 else '<div class="ans-attach-ct">下一章任务尚未加载</div>'
                return self.send(page(body))
            if chapter > 1:
                return self.send(page('<div class="ans-attach-ct">下一章任务占位</div>'))
            if mode == "busy":
                return self.send(page('<div class="loading" aria-busy="true" aria-hidden="true" disabled style="pointer-events:none">正在加载课程内容</div>'))
            if mode == "late":
                return self.send(page("", "setTimeout(()=>{const wrapper=document.createElement('div');wrapper.className='ans-attach-ct';wrapper.id='late-task';const frame=document.createElement('iframe');frame.src='/ananas/modules/video/index.html';wrapper.append(frame);document.body.append(wrapper);},3000);"))
            return self.send(page(""))
        if url.path == "/ananas/modules/video/index.html":
            return self.send(page("<p>未完成视频任务页面</p>"))
        if url.path == "/favicon.ico":
            return self.send(b"", 204)
        traffic.append({"method": "GET", "path": url.path})
        return self.send(b"", 404)

    def do_POST(self):
        traffic.append({"method": "POST", "path": urllib.parse.urlparse(self.path).path})
        self.send(b"", 403)


tree = ast.parse((ROOT / "tests" / "extension-browser.py").read_text(encoding="utf-8"))
transport = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "RUNNER" for t in n.targets))
RUNNER = transport[:transport.index("const debugPort=")] + r'''
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3];
const report={realExtension:true,realClock:true,noGM:true,noModelKey:true,scenarios:[],errors:[]};
const assert=(value,message)=>{if(!value)throw Error(message);};
const poll=async(test,label,attempts=240)=>{for(let i=0;i<attempts;i++){try{const v=await test();if(v)return v;}catch{}await wait(50);}throw Error('Timed out: '+label);};
let browser,isolated;
const ui=expression=>browser.evaluate(expression,isolated);
const mount=async()=>{
 isolated=await poll(async()=>{const contexts=browser.events.filter(e=>e.method==='Runtime.executionContextCreated').map(e=>e.params.context);for(const c of contexts.reverse()){try{if(await browser.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue&&globalThis.Pinia)',c.id))return c.id;}catch{}}},'native isolated context');
 await browser.call('DOM.enable');
 await poll(async()=>{const {root:doc}=await browser.call('DOM.getDocument',{depth:-1,pierce:true});const walk=n=>[...(n.shadowRoots||[]),...(n.children||[]).flatMap(walk),...(n.contentDocument?walk(n.contentDocument):[])];for(const n of walk(doc).filter(n=>n.shadowRootType)){const {object}=await browser.call('DOM.resolveNode',{nodeId:n.nodeId,executionContextId:isolated});const result=await browser.call('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){const mount=[...this.querySelectorAll('div')].find(n=>n.__vue_app__),stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores)return false;globalThis.__empty={root:this,config:stores.get('configStore'),logs:stores.get('logStore')};return !!__empty.config;}`,returnByValue:true});if(result.result?.value)return true;}},'native closed-shadow stores');
 await poll(async()=>await browser.evaluate(`document.querySelector('#iframe')?.contentDocument?.readyState==='complete'`),'loaded cards document');
};
const navigate=async(mode)=>{await browser.call('Page.navigate',{url:host+'/mycourse/studentstudy?mooc2=1&scenario='+mode});await mount();};
const logs=()=>ui('__empty.logs.logList.map(l=>({message:l.message,type:l.type}))');
const clicks=()=>browser.evaluate('__nextClicks');
const overview=()=>ui(`({badge:__empty.root.querySelector('.ai-status-badge')?.textContent,title:__empty.root.querySelector('.ai-overview-title')?.textContent,note:__empty.root.querySelector('.ai-overview-note')?.textContent})`);
const config=async(auto,delay=0)=>{await ui(`(async()=>{__empty.config.platformParams.cx.parts[0].params[1].value=${auto};__empty.config.otherParams.params[0].value=${delay};await Vue.nextTick();await new Promise(r=>setTimeout(r,150));})()`);};
try{
 const targets=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
 const worker=new CDP(targets.find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js')).webSocketDebuggerUrl);await worker.evaluate('chrome.storage.local.clear()');worker.close();
 browser=new CDP(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);await browser.call('Page.enable');await browser.call('Runtime.enable');await browser.call('Network.enable');
 await navigate('chain');await config(false);await wait(6200);
 assert(await clicks()===0,'Disabled automatic navigation skipped an empty chapter');
 assert(await ui(`!__empty.config.ai.apiKey&&!__empty.config.ai.deepseekApiKey`),'Fixture unexpectedly contains a model credential');
 report.disabledOverview=await overview();report.scenarios.push('no-key-empty-chapter-respects-disabled-auto-next-after-five-seconds');
 await config(true);await poll(async()=>await clicks()===2,'empty then text-only chapter advance',260);await wait(1200);
 report.chain=await browser.evaluate('({clicks:__nextClicks,times:__clickTimes,loads:__loads,src:document.querySelector("#iframe").src})');
 assert(report.chain.clicks===2&&new URL(report.chain.src).searchParams.get('knowledgeid')==='3','Empty chapter chain did not reach its actual next page exactly once per chapter');
 assert(report.chain.times[1]-report.chain.times[0]>=4800,'Second empty chapter reused the previous stable observation');
 report.scenarios.push('real-iframe-navigation-skips-empty-and-text-only-chapters-once-and-stops-at-task-placeholder');
 await navigate('busy');await config(true);await wait(6100);
 assert(await clicks()===0,'Visible loading placeholder was mistaken for an empty chapter');
 await browser.evaluate(`document.querySelector('#iframe').contentDocument.querySelector('.loading').remove()`);await wait(2300);
 await browser.evaluate(`document.querySelector('#iframe').contentDocument.body.append(document.createTextNode('延迟到达的无任务说明文字'))`);await wait(3300);
 assert(await clicks()===0,'Body change did not restart the five-second observation');
 await poll(async()=>await clicks()===1,'stable content after loading and body changes',100);await wait(600);
 assert(await clicks()===1,'Taskless page repeated its next action');report.scenarios.push('visible-loading-and-late-body-content-restart-the-empty-observation-window');
 await navigate('late');await config(true);await wait(7200);
 assert(await clicks()===0,'A late unfinished task was skipped');
 assert((await logs()).some(l=>/1 个任务/.test(l.message)),'Late task iframe was not observed by the real scanner');
 await browser.evaluate(`document.querySelector('#iframe').contentDocument.querySelector('#late-task').classList.add('ans-job-finished')`);
 await poll(async()=>await clicks()===1,'platform-confirmed task resumes existing navigation',140);await wait(500);assert(await clicks()===1,'Completed task repeated navigation');
 report.scenarios.push('late-unfinished-task-blocks-empty-navigation-and-platform-completion-resumes-normal-next');
 await navigate('delay');await config(true,2);
 await poll(async()=>(await logs()).some(l=>/检查通过，已选择下一节/.test(l.message)),'pending empty navigation operation interval',180);
 await browser.evaluate(`const node=document.createElement('div');node.className='ans-attach-ct';node.textContent='等待期间到达的新任务';document.querySelector('#iframe').contentDocument.body.append(node)`);
 await wait(2500);assert(await clicks()===0,'Task placeholder arriving during the operation interval was skipped');
 assert((await logs()).some(l=>/已取消：等待期间页面、任务或完成状态发生变化/.test(l.message)),'Fresh pre-navigation validation did not report the cancellation');
 report.scenarios.push('late-placeholder-during-operation-delay-cancels-the-pending-next-action');
 await navigate('srcdoc');await config(true,0);
 await browser.evaluate(`document.querySelector('#iframe').srcdoc='<!doctype html><html><body><p>Unverified inline document</p></body></html>'`);
 await poll(async()=>await browser.evaluate(`document.querySelector('#iframe').contentDocument.URL==='about:srcdoc'`),'actual inline iframe document');await wait(6200);
 assert(await clicks()===0,'A cards src with an actual about:srcdoc document was treated as a verified empty chapter');
 report.scenarios.push('canonical-cards-src-does-not-validate-an-actual-about-srcdoc-document');
 report.modelRequests=browser.events.filter(e=>e.method==='Network.requestWillBeSent'&&/api\.openai\.com|api\.deepseek\.com/.test(e.params.request.url)).map(e=>e.params.request.url);
 assert(!report.modelRequests.length,'Empty chapter processing requested a real model');
 report.errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
 assert(!report.errors.length,'Runtime exceptions: '+JSON.stringify(report.errors));report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{report.lastLogs=await logs();report.currentPage=await browser.evaluate('({url:location.href,clicks:window.__nextClicks})');}catch{}}
console.log(JSON.stringify(report));try{await browser?.call('Browser.close');}catch{}browser?.close();
'''


def main():
    version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
    assert version == "0.9.6", "Build the 0.9.6 candidate first"
    archive = EXTENSION.parent / f"ai-course-helper-extension-{version}.zip"
    content_hash = hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper()
    package_hash = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    output = None
    with tempfile.TemporaryDirectory(prefix="native-", dir=PROFILES) as profile:
        browser = subprocess.Popen([str(EDGE), "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                                    "--disable-background-networking", "--no-proxy-server", "--user-data-dir=" + profile,
                                    "--remote-debugging-port=0", "--load-extension=" + str(EXTENSION),
                                    "--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1", "--window-size=1280,900", "about:blank"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 15
            port_file = Path(profile) / "DevToolsActivePort"
            while time.monotonic() < deadline:
                try:
                    port = int(port_file.read_text().splitlines()[0])
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                        targets = json.load(response)
                    if any(t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js") for t in targets):
                        break
                except (OSError, ValueError, IndexError):
                    pass
                time.sleep(.05)
            else:
                raise RuntimeError("Unpacked extension did not start")
            result = subprocess.run(["node", "--input-type=module", "-e", RUNNER, str(port), str(ROOT),
                                     f"http://mooc1.chaoxing.com:{server.server_port}"], capture_output=True, text=True,
                                    encoding="utf-8", timeout=105)
            if result.returncode:
                raise RuntimeError(result.stderr[-5000:])
            output = json.loads(result.stdout)
        finally:
            if browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    browser.kill()
            server.shutdown()
            time.sleep(.7)
    assert content_hash == hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper(), "Candidate changed during browser check"
    assert package_hash == hashlib.sha256(archive.read_bytes()).hexdigest().upper(), "Archive changed during browser check"
    output.update({"version": version, "contentSha256": content_hash, "packageSha256": package_hash,
                   "fixtureUnexpectedTraffic": traffic, "limitations": [
                       "Local synthetic course HTML in real headless Edge; not a logged-in school environment.",
                       "The production extension, scanner and five-second window run on the real clock."]})
    output["passed"] = output.get("passed", False) and not traffic
    (ROOT / "tests" / "verification-0.9.6-browser.log").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))
    assert output["passed"], output


if __name__ == "__main__":
    main()
