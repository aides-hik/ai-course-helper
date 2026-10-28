"""Verify that native chapter learning works without AI credentials in Edge."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ast
import hashlib
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "dist" / "ai-course-helper-extension"
assert (EXTENSION / "manifest.json").exists(), "Build the native extension first"
version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
archive = ROOT / "dist" / f"ai-course-helper-extension-{version}.zip"
initial_package_hash = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
initial_content_hash = hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper()
fixture = ROOT / "tests" / "browser-fixture" / "optional-ai"
fixture.mkdir(parents=True, exist_ok=True)
video = fixture / "chapter.mp4"
if not video.exists():
    encoder = shutil.which("ffmpeg")
    assert encoder, "ffmpeg is required to generate a tiny real video fixture"
    subprocess.run([encoder, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x294d78:s=160x90:r=1",
                    "-t", "90", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video)], check=True, timeout=25)
network = []


def page(content, script=""):
    return ('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-optional-fixture\'; object-src \'none\'">'
            '<style>body{font:15px/1.7 "Microsoft YaHei UI",sans-serif;color:#21314c;background:#eef3fb;margin:0;padding:24px}iframe{width:100%;border:1px solid #dce4f2;background:#fff}.ans-attach-ct{padding:12px;border:1px solid #dce4f2;background:white;margin-bottom:15px}.ans-job-icon{width:14px;height:14px;background:#eeae47;border-radius:50%;margin-bottom:9px}.ans-job-finished .ans-job-icon{background:#319581}video{width:100%;max-height:300px;background:#294d78}button{padding:10px 24px;border:0;background:#5472e5;color:white;border-radius:20px}.TiMu,.questionLi{background:white;padding:12px}.before-after,.answerBg{padding:12px;border-bottom:1px solid #ddd;cursor:pointer}</style>'
            '</head><body>' + content + '<script nonce="optional-fixture">window.__fixtureErrors=[];addEventListener("error",e=>__fixtureErrors.push(e.message));' + script + '</script></body></html>').encode()


def question(chapter=False, answered=False):
    if chapter:
        return '<section class="TiMu"><div class="fontLabel">【单选题】No-key chapter question</div>' + ''.join(
            f'<div class="before-after"><input type="radio" name="q" {"checked" if answered and i == 0 else ""}><span class="fl after">Option {i}</span></div>' for i in range(2)) + '</section>'
    return '<section class="questionLi"><h3><span class="colorShallow">【单选题】</span>No-key standalone question</h3>' + ''.join(
        f'<div class="answerBg"><input type="radio" name="q" {"checked" if answered and i == 0 else ""}><span class="answer_p">Option {i}</span></div>' for i in range(2)) + '</section>'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, data, content_type="text/html; charset=utf-8"):
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        mode = query.get("scenario", ["video"])[0]
        if url.path == "/fixture-report":
            return self.send(json.dumps(network).encode(), "application/json")
        if url.path == "/media.mp4":
            return self.send(video.read_bytes(), "video/mp4")
        if url.path == "/mycourse/studentstudy":
            return self.send(page('<h1>章节学习 · 无需 AI 密钥</h1><p>本地课程样例，视频为真实合成媒体。</p><iframe id="iframe" height="510" src="/mooc-ans/knowledge/cards?scenario=' + mode + '"></iframe><button id="prevNextFocusNext">下一节</button>',
                                  'window.__nextClicks=0;window.__saves=0;window.__submits=0;document.querySelector("#prevNextFocusNext").onclick=()=>{window.__nextClicks++;};'))
        if url.path == "/mooc-ans/knowledge/cards":
            content = ""
            kinds = ["work", "video"] if mode == "mixed" else ["doc"] if mode == "doc" else ["work"] if mode == "work" else ["video"]
            for kind in kinds:
                src = "/api/work" if kind == "work" else "/ananas/modules/doc/index.html" if kind == "doc" else "/ananas/modules/video/index.html"
                content += '<div class="ans-attach-ct ' + ('ans-job-finished' if mode == 'finished' else '') + '"><div class="ans-job-icon ans-job-' + kind + '"></div><iframe height="360" src="' + src + '?scenario=' + mode + '"></iframe></div>'
            return self.send(page(content))
        if url.path == "/ananas/modules/video/index.html":
            return self.send(page('<video id="chapter-video" controls preload="metadata" src="/media.mp4"></video>'))
        if url.path == "/ananas/modules/doc/index.html":
            return self.send(page('<article style="height:1800px;background:linear-gradient(white,#cedced)"><h2>课程文档</h2><p>这是用于验证无密钥文档处理的本地页面。</p></article>'))
        if url.path == "/api/work":
            return self.send(page(question(chapter=True), 'window.noSubmit=()=>{top.__saves++;};window.btnBlueSubmit=()=>{top.__submits++;};window.submitCheckTimes=()=>{top.__submits++;};'))
        if url.path == "/mooc2/work/dowork":
            return self.send(page(question(answered="answered" in query), 'window.__nextClicks=0;window.__saves=0;window.__submits=0;for(const row of document.querySelectorAll(".answerBg"))row.onclick=()=>{for(const i of document.querySelectorAll("input"))i.checked=false;row.querySelector("input").checked=true;};'))
        return self.send(b"")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
        network.append({"method": "POST", "path": self.path, "cookieAbsent": not self.headers.get("Cookie"),
                        "correctKey": self.headers.get("Authorization") == "Bearer FAKE-OPTIONAL-AI-KEY", "model": body.get("model")})
        answer = {"answerable": True, "choice_indices": [1], "text_answers": [], "judgement": "unknown", "explanation": "configured fixture response"}
        payload = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}]}
        self.send(json.dumps(payload).encode(), "application/json")


# Reuse only the browser transport helper, never its fixtures or GM adapters.
tree = ast.parse((ROOT / "tests" / "extension-browser.py").read_text(encoding="utf-8"))
old_runner = next(node.value.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "RUNNER" for target in node.targets))
RUNNER = old_runner[:old_runner.index("const debugPort=")] + r'''
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3];
const list=async()=>await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
const report={realExtension:true,noGM:true,realSyntheticVideo:true,scenarios:[],screenshots:[],errors:[]};
const assert=(value,message)=>{if(!value)throw Error(message);};
const poll=async(check,label,attempts=180)=>{for(let i=0;i<attempts;i++){try{const value=await check();if(value)return value;}catch{}await wait(50);}throw Error('Timed out: '+label);};
let browser,isolated;
const ui=expression=>browser.evaluate(expression,isolated);
const mount=async()=>{
 isolated=await poll(async()=>{const contexts=browser.events.filter(e=>e.method==='Runtime.executionContextCreated').map(e=>e.params.context);for(const ctx of contexts.reverse()){try{if(await browser.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue&&globalThis.Pinia)',ctx.id))return ctx.id;}catch{}}},'isolated extension context');
 await browser.call('DOM.enable');
 await poll(async()=>{const {root:doc}=await browser.call('DOM.getDocument',{depth:-1,pierce:true});const collect=n=>[...(n.shadowRoots||[]),...(n.children||[]).flatMap(collect),...(n.contentDocument?collect(n.contentDocument):[])];for(const shadow of collect(doc).filter(n=>n.shadowRootType)){const {object}=await browser.call('DOM.resolveNode',{nodeId:shadow.nodeId,executionContextId:isolated});const result=await browser.call('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){const mount=[...this.querySelectorAll('div')].find(n=>n.__vue_app__);const stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores)return false;globalThis.__optional={root:this,config:stores.get('configStore'),logs:stores.get('logStore'),questions:stores.get('questionStore')};return !!__optional.config;}`,returnByValue:true});if(result.result?.value)return true;}return false;},'actual closed-shadow mount');
};
const navigate=async(path)=>{await browser.call('Page.navigate',{url:host+path});await mount();};
const source=()=>ui('__optional.logs.logList.map(x=>({message:x.message,type:x.type}))');
const network=async()=>await(await fetch('http://127.0.0.1:'+host.split(':').at(-1)+'/fixture-report')).json();
const video=()=>browser.evaluate(`(()=>{const cards=document.querySelector('#iframe')?.contentDocument;const frame=[...cards?.querySelectorAll('iframe')||[]].find(f=>f.src.includes('/modules/video/'));const v=frame?.contentDocument?.querySelector('video');return v?{paused:v.paused,current:v.currentTime,duration:v.duration,ended:v.ended}:null;})()`);
const shot=async(name)=>{const result=await browser.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(root+'/tests/'+name+'.png',Buffer.from(result.data,'base64'));report.screenshots.push(name+'.png');};
try{
 const targets=await list(),workerTarget=targets.find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js'));assert(workerTarget,'Extension worker missing');const worker=new CDP(workerTarget.webSocketDebuggerUrl);await worker.evaluate('chrome.storage.local.clear()');worker.close();
 const page=targets.find(t=>t.type==='page'&&t.url==='about:blank');assert(page,'Initial page missing');browser=new CDP(page.webSocketDebuggerUrl);await browser.call('Page.enable');await browser.call('Runtime.enable');
 await navigate('/mycourse/studentstudy?mooc2=1&scenario=video');
 await poll(async()=>{const media=await video();return media&&!media.paused&&media.current>.1;},'unconfigured real video starts playback',240);
 const unconfigured=await ui(`({key:__optional.config.ai.apiKey||'',tab:__optional.config.menuIndex,state:__optional.root.querySelector('.ai-status-badge')?.dataset.state,badge:__optional.root.querySelector('.ai-status-badge')?.textContent})`);assert(!unconfigured.key&&unconfigured.tab==='0'&&unconfigured.state==='running','No-key video should remain on running overview: '+JSON.stringify(unconfigured));assert(!(await network()).length,'Video-only page sent a model request');report.video=await video();report.scenarios.push('without-key-real-video-plays-and-overview-shows-running-without-forced-settings');await shot('optional-ai-video-desktop');
 await browser.call('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:false});await ui('window.dispatchEvent(new Event("resize"))');await wait(220);const narrow=await ui(`(()=>{const p=__optional.root.querySelector('.main-page'),b=p.getBoundingClientRect();return{viewport:innerWidth,width:b.width,fits:b.left>=0&&b.right<=innerWidth+1&&p.scrollWidth<=p.clientWidth+1};})()`);assert(narrow.viewport===320&&narrow.fits,'No-key narrow overview overflow');report.narrow=narrow;await shot('optional-ai-video-320');await browser.call('Emulation.clearDeviceMetricsOverride');await ui('window.dispatchEvent(new Event("resize"))');
 await navigate('/mycourse/studentstudy?mooc2=1&scenario=mixed');await poll(async()=>{const media=await video(),logs=await source();return media&&!media.paused&&media.current>.1&&logs.some(l=>l.message.includes('AI 未配置'));},'missing-key work does not stop later video',260);const mixed=await browser.evaluate('({saves:__saves,submits:__submits,next:__nextClicks})');assert(!mixed.saves&&!mixed.submits&&!mixed.next,'No-key chapter work must not save or complete: '+JSON.stringify(mixed));assert((await source()).filter(l=>l.message.includes('AI 未配置')).length===1,'Missing-key chapter notice should be deduplicated');assert(!(await network()).length,'Mixed no-key chapter requested AI');report.scenarios.push('missing-key-chapter-work-waits-without-save-or-completion-and-later-video-continues');
 await navigate('/mycourse/studentstudy?mooc2=1&scenario=doc');await poll(async()=>(await source()).some(l=>l.message.includes('已执行文档阅读')),'no-key document reading',260);const scrolled=await browser.evaluate(`(()=>{const card=document.querySelector('#iframe').contentDocument;return card.querySelector('iframe').contentWindow.scrollY;})()`);assert(scrolled>0,'No-key document did not scroll');assert(!(await network()).length,'No-key document sent a model request');report.scenarios.push('without-key-document-scrolls-and-runs-its-reading-wait');
 await ui(`(async()=>{__optional.config.platformParams.cx.parts[0].params[1].value=true;__optional.config.otherParams.params[0].value=0;await Vue.nextTick();await new Promise(r=>setTimeout(r,100));})()`);await navigate('/mycourse/studentstudy?mooc2=1&scenario=finished');await poll(async()=>await browser.evaluate('__nextClicks===1'),'completed video advances without key',200);await wait(800);assert(await browser.evaluate('__nextClicks===1'),'Chapter next action repeated');assert(!(await network()).length,'Completed no-key chapter requested AI');report.scenarios.push('completed-video-without-key-advances-once-when-auto-next-enabled');
 await navigate('/mooc2/work/dowork?answered=1');await poll(async()=>(await source()).some(l=>l.message.includes('已有作答')),'no-key existing answer retained',180);assert(await browser.evaluate('document.querySelectorAll("input")[0].checked&&!document.querySelectorAll("input")[1].checked'),'Existing no-key answer changed');assert(!(await network()).length,'No-key answered work sent AI');report.scenarios.push('no-key-work-retains-an-existing-answer-without-network');
 await navigate('/mooc2/work/dowork?pending=1');await poll(async()=>(await source()).some(l=>l.message.includes('AI 未配置')),'standalone no-key waiting notice');assert(await browser.evaluate('[...document.querySelectorAll("input")].every(i=>!i.checked)'),'No-key unanswered work was filled');assert(!(await network()).length,'No-key work sent AI');report.unconfiguredModelRequests=0;report.scenarios.push('no-key-unanswered-work-is-left-for-manual-answering');
 await ui(`(async()=>{__optional.config.menuIndex='0';await Vue.nextTick();globalThis.__copiedOptional='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.__copiedOptional=text;}}});__optional.logs.addLog('普通回归：学习继续','primary');__optional.logs.addLog('普通回归：学习继续','primary');__optional.logs.addLog('提醒回归：任务处理失败，请检查播放器权限','warning');__optional.logs.addLog('[章节诊断] 页面#99 视频；详细回归：保留原始选择器（#prevNextFocusNext）','info');await Vue.nextTick();})()`);
 const filter=await ui(`(async()=>{const root=__optional.root,mode=label=>[...root.querySelectorAll('.ai-log-mode')].find(b=>b.textContent.startsWith(label));if(!mode('提醒'))throw Error('Missing reminder mode');mode('简要').click();await Vue.nextTick();const brief=root.querySelector('.log').textContent;if(!brief.includes('普通回归')||!brief.includes('×2')||brief.includes('页面#99'))throw Error('Brief filter or repeat merge incorrect');mode('详细').click();await Vue.nextTick();if(!root.querySelector('.log').textContent.includes('页面#99'))throw Error('Detail must preserve raw diagnostic');mode('提醒').click();await Vue.nextTick();const alerts=root.querySelector('.log').textContent;if(!alerts.includes('提醒回归')||alerts.includes('普通回归')||alerts.includes('页面#99'))throw Error('Reminder filter incorrect');root.querySelector('.ai-copy-logs').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,0));if(!__copiedOptional.includes('普通回归')||!__copiedOptional.includes('页面#99')||!__copiedOptional.includes('#prevNextFocusNext'))throw Error('Copy did not export complete raw logs');const original=__optional.logs.logList;const clear=root.querySelector('.ai-clear-logs')||[...root.querySelectorAll('button')].find(b=>b.textContent==='清空');if(!clear)throw Error('Clear action missing');clear.click();await Vue.nextTick();if(__optional.logs.logList!==original||__optional.logs.logList.some(l=>l.message.includes('回归')))throw Error('Clear did not preserve array identity or remove logs');return{brief:true,detail:true,reminders:true,repeatMerged:true,fullRawCopy:true,clearPreservesIdentity:true};})()`);report.logControls=filter;report.scenarios.push('brief-detail-reminder-filters-copy-all-raw-logs-and-clear-keeps-reactive-array');
 await ui(`(async()=>{const c=__optional.config;c.ai.provider='openai';c.ai.apiKey='FAKE-OPTIONAL-AI-KEY';c.ai.model='optional-fixture-model';c.ai.apiUrl=${JSON.stringify(host+'/v1/responses')};c.ai.modelsUrl=${JSON.stringify(host+'/v1/models')};c.otherParams.params[0].value=0;await Vue.nextTick();await new Promise(r=>setTimeout(r,100));__optional.root.querySelector('.ai-save').click();})()`);await wait(220);await mount();await poll(async()=>await browser.evaluate('document.querySelectorAll("input")[1]?.checked===true'),'configured AI still answers actual work',200);const calls=await network();assert(calls.length===1&&calls[0].correctKey&&calls[0].cookieAbsent,'Configured AI request regression: '+JSON.stringify(calls));report.networkCalls=calls;report.scenarios.push('adding-a-key-enables-the-existing-native-AI-fill-flow');
 report.errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);assert(!report.errors.length,'Unexpected runtime exception: '+JSON.stringify(report.errors));report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{await shot('optional-ai-failure');}catch{}}
console.log(JSON.stringify(report));try{await browser?.call('Browser.close');}catch{}browser?.close();
'''

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
host = f"http://mooc1.chaoxing.com:{server.server_port}"
profile = ROOT / "tests" / ".optional-ai-profile"
port_file = profile / "DevToolsActivePort"
port_file.unlink(missing_ok=True)
browser = subprocess.Popen([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server", "--user-data-dir=" + str(profile),
    "--remote-debugging-port=0", "--load-extension=" + str(EXTENSION), "--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1",
    "--window-size=1280,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            debug_port = int(port_file.read_text().splitlines()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=1) as response:
                targets = json.load(response)
            if any(item.get("type") == "service_worker" and item.get("url", "").endswith("/background.js") for item in targets):
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
output["contentSha256"] = hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper()
assert output["packageSha256"] == initial_package_hash and output["contentSha256"] == initial_content_hash, "Extension package changed during verification; rerun the browser check"
(ROOT / "tests" / f"verification-{version}-optional-ai-browser.log").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(output, ensure_ascii=False))
assert output.get("passed"), output
