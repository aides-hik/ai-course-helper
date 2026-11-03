"""Reproduce the observed Chaoxing empty DOM in the native Edge extension.

This serves a local reproduction over HTTP. It does not automate, modify or
log into the user's real course page. The production extension and its actual
five-second observation/navigation timers run unchanged on the real clock.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "dist" / "ai-course-helper-extension"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
PROFILES = ROOT / "tests" / ".platform-empty-chapter-profile"
PROFILES.mkdir(exist_ok=True)
spec = importlib.util.spec_from_file_location("empty_chapter_browser_helpers", ROOT / "tests" / "chapter-empty-browser.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
traffic = []


def reported_empty(mode):
    marker = '' if mode == "no-marker" else '<div class="ans-cc"><div class="nullpage"><dl><dt></dt><dd>暂无内容</dd></dl></div></div>'
    hidden = '' if mode == "visible-audio" else ' style="display:none"'
    source = ' src="/media.wav"' if mode == "source-audio" else ''
    task = '<div class="ans-attach-ct"><iframe src="/ananas/modules/video/index.html"></iframe></div>' if mode == "task" else ''
    return '<div class="wrap"><audio id="auditionAudio" preload="auto" controls autobuffer' + hidden + source + '></audio>' + marker + task + '</div>'


class Handler(base.Handler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        mode = query.get("scenario", ["reported"])[0]
        chapter = int(query.get("knowledgeid", ["1"])[0])
        if url.path == "/mycourse/studentstudy":
            script = """window.__nextClicks=0;window.__clickTimes=[];window.__loads=[];
const chapter=document.querySelector('#iframe');chapter.addEventListener('load',()=>__loads.push({time:performance.now(),url:chapter.src}));
document.querySelector('#prevNextFocusNext').onclick=()=>{__nextClicks++;__clickTimes.push(performance.now());const next=new URL(chapter.src);next.searchParams.set('knowledgeid',String(Number(next.searchParams.get('knowledgeid'))+1));chapter.src=next.href;};"""
            return self.send(base.page('<h1>平台空章节结构 · 本地复现</h1><iframe id="iframe" src="/mooc-ans/knowledge/cards?scenario=' + mode + '&knowledgeid=1"></iframe><button id="prevNextFocusNext">下一节</button>', script))
        if url.path == "/mooc-ans/knowledge/cards":
            return self.send(base.page(reported_empty(mode) if chapter == 1 else '<div class="ans-attach-ct">下一节任务占位</div>'))
        if url.path == "/media.wav":
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(b"\0\0" * 8000)
            data = buffer.getvalue()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return
        if url.path == "/ananas/modules/video/index.html":
            return self.send(base.page('<p>未完成任务的本地资源页面</p>'))
        if url.path == "/favicon.ico":
            return self.send(b"", 204)
        traffic.append({"method": "GET", "path": url.path})
        self.send(b"", 404)

    def do_POST(self):
        traffic.append({"method": "POST", "path": urllib.parse.urlparse(self.path).path})
        self.send(b"", 403)


# Reuse native CDP transport and closed-shadow discovery, not the prior tests.
separator = "try{\n const targets="
assert base.RUNNER.count(separator) == 1
RUNNER = base.RUNNER[:base.RUNNER.index(separator)] + r'''
try{
 const targets=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
 const worker=new CDP(targets.find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js')).webSocketDebuggerUrl);await worker.evaluate('chrome.storage.local.clear()');worker.close();
 browser=new CDP(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);await browser.call('Page.enable');await browser.call('Runtime.enable');await browser.call('Network.enable');
 report.localReproductionOfObservedDom=true;report.realUserPageAutomated=false;
 await navigate('reported');await config(true,0);
 report.initialDom=await browser.evaluate(`(()=>{const doc=document.querySelector('#iframe').contentDocument,a=doc.querySelector('#auditionAudio'),marker=doc.querySelector('.ans-cc>.nullpage');return{documentUrl:doc.URL,childFrames:doc.querySelectorAll('iframe').length,audioTag:a.tagName,audioHidden:getComputedStyle(a).display==='none',audioSrc:a.getAttribute('src'),currentSrc:a.currentSrc,sourceCount:a.querySelectorAll('source').length,markerText:marker.innerText.trim(),ddText:marker.querySelector('dd').innerText.trim(),sameWrap:a.parentElement===marker.parentElement.parentElement,preload:a.preload,controls:a.controls,autobuffer:a.hasAttribute('autobuffer')};})()`);
 assert(report.initialDom.childFrames===0&&report.initialDom.audioHidden&&!report.initialDom.audioSrc&&!report.initialDom.currentSrc&&report.initialDom.sourceCount===0&&report.initialDom.markerText==='暂无内容'&&report.initialDom.ddText==='暂无内容'&&report.initialDom.sameWrap,'Reported empty DOM was not faithfully reproduced: '+JSON.stringify(report.initialDom));
 assert(await ui(`!__empty.config.ai.apiKey&&!__empty.config.ai.deepseekApiKey`),'Fixture has model credentials');
 await poll(async()=>await clicks()===1,'real reported empty helper advances',200);await wait(1000);
 report.navigation=await browser.evaluate('({clicks:__nextClicks,times:__clickTimes,loads:__loads,src:document.querySelector("#iframe").src})');
 assert(report.navigation.clicks===1&&new URL(report.navigation.src).searchParams.get('knowledgeid')==='2','Reported empty page did not perform one actual next action');
 assert(report.navigation.times[0]-report.navigation.loads[0].time>=4800,'Reported empty page did not retain the stability window');
 report.scenarios.push('observed-visible-empty-marker-and-hidden-source-less-audition-helper-advance-to-the-next-http-chapter-once');
 for(const mode of ['no-marker','visible-audio','source-audio','task']){
  await navigate(mode);await config(true,0);await wait(6200);
  assert(await clicks()===0,'Unsafe helper exception navigated '+mode);
  report.scenarios.push(mode==='no-marker'?'hidden-audition-helper-without-visible-platform-empty-marker-blocks':mode==='visible-audio'?'visible-audition-audio-remains-a-resource':mode==='source-audio'?'hidden-audition-audio-with-actual-src-remains-a-resource':'unfinished-task-beside-the-empty-marker-and-helper-still-blocks');
 }
 await navigate('delay');await config(true,2);
 await poll(async()=>(await logs()).some(l=>/检查通过，已选择下一节/.test(l.message)),'pending platform-empty navigation interval',200);
 await browser.evaluate(`document.querySelector('#iframe').contentDocument.querySelector('#auditionAudio').src='/media.wav'`);await wait(2600);
 assert(await clicks()===0,'Audition helper acquiring a real source during the delay was skipped');
 assert((await logs()).some(l=>/已取消：等待期间页面、任务或完成状态发生变化/.test(l.message)),'Fresh validation did not cancel the now-real resource');
 report.scenarios.push('hidden-helper-acquiring-src-during-operation-interval-cancels-navigation');
 report.modelRequests=browser.events.filter(e=>e.method==='Network.requestWillBeSent'&&/api\.openai\.com|api\.deepseek\.com/.test(e.params.request.url)).map(e=>e.params.request.url);
 assert(!report.modelRequests.length,'Platform-empty processing requested a model');
 report.errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
 assert(!report.errors.length,'Runtime exceptions: '+JSON.stringify(report.errors));report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{report.lastLogs=await logs();report.currentPage=await browser.evaluate('({url:location.href,clicks:window.__nextClicks})');}catch{}}
console.log(JSON.stringify(report));try{await browser?.call('Browser.close');}catch{}browser?.close();
'''


def main():
    version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
    assert version == "0.9.7", "Build the 0.9.7 candidate first"
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
                       "Local HTTP reproduction of the observed empty-page DOM; not automation of the user's real course page.",
                       "The actual extension and five-second stable observation run on the real clock."]})
    output["passed"] = output.get("passed", False) and not traffic
    (ROOT / "tests" / "verification-0.9.7-browser.log").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))
    assert output["passed"], output


if __name__ == "__main__":
    main()
