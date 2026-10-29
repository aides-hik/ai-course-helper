"""Measure solver DOM work and verify the optimized unpacked extension in Edge.

The HEAD solver and current solver run against identical real DOM fixtures.
Only their model transport is simulated; timing is reported, not asserted.
"""
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
version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
assert version == "0.9.3", "Build the 0.9.3 candidate first"
archive = ROOT / "dist" / f"ai-course-helper-extension-{version}.zip"
initial_hash = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
baseline_commit = "e4530aaa5759ffca96cea46c5d597431c96c15ce"
try:
    baseline_read = subprocess.run(["git", "show", baseline_commit + ":ai-integration.js"], cwd=ROOT, capture_output=True)
    baseline_integration = baseline_read.stdout.decode() if baseline_read.returncode == 0 else None
except OSError:
    baseline_integration = None
fixture = ROOT / "tests" / "browser-fixture" / "performance"
fixture.mkdir(parents=True, exist_ok=True)
video = fixture / "chapter.mp4"
if not video.exists():
    existing = ROOT / "tests" / "browser-fixture" / "optional-ai" / "chapter.mp4"
    if existing.exists():
        shutil.copyfile(existing, video)
    else:
        subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "color=c=0x294d78:s=160x90:r=1", "-t", "90", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart", str(video)], check=True, timeout=25)
network = []

# Reuse fixture definitions only. Importing the original runner would launch it.
optional_tree = ast.parse((ROOT / "tests" / "optional-ai-browser.py").read_text(encoding="utf-8"))
definitions = [node for node in optional_tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
exec(compile(ast.Module(body=definitions, type_ignores=[]), "optional-ai-fixture-definitions", "exec"), globals())
ChapterHandler = Handler


def batch_questions(count=100, answered=0):
    parts = []
    for number in range(count):
        choices = ''.join('<div class="answerBg"><input type="radio" name="q-' + str(number) + '" ' +
                          ('checked' if number < answered and choice == 0 else '') + '><span class="answer_p">Option ' +
                          str(choice) + '</span></div>' for choice in range(2))
        parts.append('<section class="questionLi" data-performance-id="' + str(number) + '"><h3><span class="colorShallow">【单选题】</span>Performance question ' + str(number) + '</h3>' + choices + '</section>')
    return ''.join(parts)


BENCH_RUN = r'''
(async()=>{try{
 const measurements={querySelector:0,querySelectorAll:0,computedStyle:0,peakIntervals:0,activeIntervals:0};
 const nativeInterval=window.setInterval.bind(window),nativeClear=window.clearInterval.bind(window),active=new Set();
 const setInterval=(callback,ms)=>{const id=nativeInterval(callback,ms);active.add(id);measurements.peakIntervals=Math.max(measurements.peakIntervals,active.size);return id;};
 const clearInterval=id=>{active.delete(id);nativeClear(id);};
 const nativeQuery=Element.prototype.querySelector,nativeQueries=Element.prototype.querySelectorAll,nativeStyle=window.getComputedStyle.bind(window);
 const questions=[];
 for(let index=0;index<COUNT;index++){
  const element=document.createElement('section');element.innerHTML='<h3>Measured question '+index+'</h3><label class="answerBg"><input type="radio" name="m-'+index+'"><span class="answer_p">Option A</span></label><label class="answerBg"><input type="radio" name="m-'+index+'"><span class="answer_p">Option B</span></label>';document.body.append(element);
  const rows=[...element.querySelectorAll('.answerBg')];rows.forEach((row,i)=>row.onclick=()=>{for(const input of element.querySelectorAll('input'))input.checked=false;row.querySelector('input').checked=true;});
  if(MODE==='answered')rows[0].querySelector('input').checked=true;
  questions.push({title:'Measured question '+index,type:'0',workType:'zy',element,options:{'Option A':rows[0],'Option B':rows[1]},optionsText:['Option A','Option B'],searchText:{stem:'Measured question '+index,options:['Option A','Option B'],images:[]}});
 }
 Element.prototype.querySelector=function(...args){measurements.querySelector++;return Reflect.apply(nativeQuery,this,args);};
 Element.prototype.querySelectorAll=function(...args){measurements.querySelectorAll++;return Reflect.apply(nativeQueries,this,args);};
 window.getComputedStyle=(...args)=>{measurements.computedStyle++;return nativeStyle(...args);};
 const vue=Vue,config={ai:{provider:'openai',apiKey:'FAKE-PERFORMANCE-KEY',concurrentEnabled:true,concurrency:COUNT},platformParams:{zhs:{parts:[{params:[{value:false}]}]}},otherParams:{params:[{value:0}]}};
 const sleep=async()=>{},useConfigStore=()=>config,aiConcurrencyLimit=()=>COUNT;
 const getAnswerValues=response=>response.values,waiting=[];
 const getAnswer=(question,context)=>new Promise(resolve=>{waiting.push({resolve,context});});
 const aiWaitForDelay=async(_seconds,context)=>context.isCurrent();
 /* HELPERS */
 /* INTEGRATION */
 const resultRows=[],handler={_window:window,_document:document,parseHtml(){this.questions=questions;},addLog(){},addQuestion:q=>resultRows.push(q),fillQuestion:(q,current)=>applyAiAnswers(q,window,'zy',(options,answer)=>options[answer],current)};
 const started=performance.now();
 const solving=solveAiQuestions(handler);
 let pendingChecks=null;
 if(MODE==='pending'){
  const before={querySelector:measurements.querySelector,querySelectorAll:measurements.querySelectorAll,computedStyle:measurements.computedStyle};
  await new Promise(resolve=>window.setTimeout(resolve,280));
  pendingChecks={querySelector:measurements.querySelector-before.querySelector,querySelectorAll:measurements.querySelectorAll-before.querySelectorAll,computedStyle:measurements.computedStyle-before.computedStyle};
  for(const call of waiting)call.resolve({values:['Option A'],meta:{}});
 }
 const rate=await solving;
 measurements.activeIntervals=active.size;
 window.__performanceResult={revision:REVISION,mode:MODE,count:COUNT,rate,cancelled:handler.lastSolveResult.cancelled,requests:waiting.length,filled:resultRows.filter(row=>row.answerStatus==='success').length,measurements,pendingChecks,elapsedMs:performance.now()-started};
 for(const id of active)nativeClear(id);
}catch(error){window.__performanceResult={error:String(error),stack:error.stack};}})();
'''


def benchmark_page(revision, mode, count):
    adapter = (ROOT / "ai-adapter.js").read_text(encoding="utf-8")
    helpers = adapter[adapter.index("  const aiControlVisible = "):adapter.index("  const aiBlankCount = ")]
    source = baseline_integration if revision == "baseline" else (ROOT / "ai-integration.js").read_text(encoding="utf-8")
    assert source is not None, "Baseline history is not available in this checkout"
    script = BENCH_RUN.replace("/* HELPERS */", helpers).replace("/* INTEGRATION */", source)
    script = 'const COUNT=' + str(count) + ',MODE=' + json.dumps(mode) + ',REVISION=' + json.dumps(revision) + ';\n' + script
    return ('<!doctype html><html><head><meta charset="utf-8"><style>section{padding:5px}label{display:block}</style><script src="/bench-vue.js"></script></head><body><script>' + script.replace('</script', '<\\/script') + '</script></body></html>').encode()


class Handler(ChapterHandler):
    def handle(self):
        try:
            return super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            # Deliberate cancellation closes native request sockets mid-read.
            pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/bench-vue.js":
            return self.send((EXTENSION / "vendor" / "vue.runtime.global.prod.js").read_bytes(), "application/javascript")
        if url.path == "/solver-benchmark":
            return self.send(benchmark_page(query['revision'][0], query['mode'][0], int(query['count'][0])))
        if url.path == "/mooc2/work/dowork":
            count, answered = int(query.get('count', ['100'])[0]), int(query.get('answered', ['0'])[0])
            script = '''document.cookie='performance-cookie=DO-NOT-FORWARD; SameSite=Lax; path=/';
for(const row of document.querySelectorAll('.answerBg'))row.onclick=()=>{const question=row.closest('.questionLi');for(const input of question.querySelectorAll('input'))input.checked=false;row.querySelector('input').checked=true;};'''
            return self.send(page(batch_questions(count, answered), script))
        return super().do_GET()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
        try:
            prepared = json.loads(body.get('input', '{}'))
        except (TypeError, ValueError):
            prepared = {}
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        network.append({"method": "POST", "path": self.path, "stem": prepared.get('stem', ''),
                        "cookieAbsent": not self.headers.get('Cookie'), "correctKey": self.headers.get('Authorization') == 'Bearer FAKE-PERFORMANCE-KEY'})
        if 'delay' in query:
            time.sleep(float(query['delay'][0]))
        answer = {"answerable": True, "choice_indices": [1], "text_answers": [], "judgement": "unknown", "explanation": "local performance response"}
        self.send(json.dumps({"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer)}]}]}).encode(), "application/json")


# Reuse transport and the four real no-key chapter regressions, not GM adapters.
extension_tree = ast.parse((ROOT / "tests" / "extension-browser.py").read_text(encoding="utf-8"))
transport = next(node.value.value for node in extension_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'RUNNER' for target in node.targets))
optional_runner = next(node.value.right.value for node in optional_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'RUNNER' for target in node.targets))
native_runner = optional_runner[:optional_runner.index(" await navigate('/mooc2/work/dowork?answered=1')")]
native_runner = native_runner.replace('optional-ai-video-desktop', 'performance-video-desktop').replace('optional-ai-video-320', 'performance-video-320')
RUNNER = transport[:transport.index("const debugPort=")] + native_runner + r'''
 await ui(`(async()=>{const c=__optional.config;c.ai.provider='openai';c.ai.apiKey='FAKE-PERFORMANCE-KEY';c.ai.model='performance-fixture-model';c.ai.apiUrl=${JSON.stringify(host+'/v1/responses')};c.ai.modelsUrl=${JSON.stringify(host+'/v1/models')};c.ai.concurrentEnabled=true;c.ai.concurrency=100;c.otherParams.params[0].value=0;await Vue.nextTick();await new Promise(r=>setTimeout(r,100));})()`);
 await navigate('/mooc2/work/dowork?count=100&answered=10');
 await poll(async()=>await ui('__optional.questions.questionList.filter(q=>q.answerStatus==="success").length===100'),'100-question native batch',600);
 const calls=await network();assert(calls.length===90,'Exactly the 90 unanswered questions must request AI: '+calls.length);assert(calls.every(call=>call.correctKey&&call.cookieAbsent),'Model transport leaked cookies or changed credentials');
 const selection=await browser.evaluate(`({existing:[...document.querySelectorAll('.questionLi')].slice(0,10).every(q=>q.querySelectorAll('input')[0].checked),filled:[...document.querySelectorAll('.questionLi')].slice(10).every(q=>q.querySelectorAll('input')[1].checked)})`);assert(selection.existing&&selection.filled,'Existing selections or model fillings changed incorrectly');report.nativeBatch={questions:100,existingSkipped:10,modelRequests:90,...selection};report.scenarios.push('native-100-question-batch-fills-only-90-unanswered-items');
 report.drag=await ui(`(async()=>{const c=__optional.config;c.menuIndex='0';await Vue.nextTick();await new Promise(r=>setTimeout(r,120));const key=key=>key.startsWith('openai-course-helper:config:v1:field:')&&key.includes('"position"');const writes=[];const listener=(changes,area)=>{if(area==='local')for(const [name,value]of Object.entries(changes))if(key(name))writes.push({name,value:value.newValue});};chrome.storage.onChanged.addListener(listener);const header=__optional.root.querySelector('.card-header'),b=header.getBoundingClientRect(),start={x:b.left+80,y:b.top+16};header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:start.x,clientY:start.y}));for(let i=1;i<=40;i++){document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:start.x+i*3,clientY:start.y+i}));await Vue.nextTick();await new Promise(r=>setTimeout(r,0));}await new Promise(r=>setTimeout(r,80));const during=writes.length;document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));await Vue.nextTick();await new Promise(r=>setTimeout(r,100));chrome.storage.onChanged.removeListener(listener);const panel=__optional.root.querySelector('.main-page').getBoundingClientRect();return{moves:40,writesDuring: during,writesAfter:writes.length,config:{...c.position},panel:{left:panel.left,top:panel.top}};})()`);assert(report.drag.writesDuring===0&&report.drag.writesAfter<=2&&report.drag.writesAfter>0,'Dragging still writes every mouse movement: '+JSON.stringify(report.drag));report.scenarios.push('dragging-40-separated-movements-writes-position-only-on-release');
 const savedPosition=report.drag.config;await navigate('/mooc2/work/dowork?count=1&answered=1');const restored=await ui('({...__optional.config.position})');assert(restored.x===savedPosition.x&&restored.y===savedPosition.y,'Final drag coordinates did not survive navigation');
 report.logs=await ui(`(async()=>{const store=__optional.logs,root=__optional.root,c=__optional.config;store.clearLogs();for(let i=0;i<500;i++)store.addLog('Performance history line '+i,'info');c.menuIndex='0';await Vue.nextTick();const visible=root.querySelectorAll('.ai-log-entry').length;c.menuIndex='1';await Vue.nextTick();const hidden=root.querySelectorAll('.ai-log-entry').length;c.menuIndex='0';await Vue.nextTick();c.isMinus=true;await Vue.nextTick();const collapsed=root.querySelectorAll('.ai-log-entry').length;c.isMinus=false;await Vue.nextTick();const restored=root.querySelectorAll('.ai-log-entry').length;globalThis.__performanceCopied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.__performanceCopied=text;}}});root.querySelector('.ai-copy-logs').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,0));return{raw:store.logList.length,visible,hidden,collapsed,restored,copyFirst:__performanceCopied.includes('Performance history line 0'),copyLast:__performanceCopied.includes('Performance history line 499')};})()`);assert(report.logs.raw===500&&report.logs.visible===500&&report.logs.hidden===0&&report.logs.collapsed===0&&report.logs.restored===500&&report.logs.copyFirst&&report.logs.copyLast,'Hidden log work or copy regression: '+JSON.stringify(report.logs));report.scenarios.push('500-log-history-skips-hidden-rendering-and-restores-all-rows-and-export');
 await ui(`(async()=>{__optional.config.ai.apiUrl=${JSON.stringify(host+'/v1/responses?delay=2')};await Vue.nextTick();await new Promise(r=>setTimeout(r,100));})()`);const previousCalls=(await network()).length;await navigate('/mooc2/work/dowork?count=20');await poll(async()=>(await network()).length>previousCalls,'pending cancellation requests',240);await browser.evaluate(`document.querySelector('.questionLi h3').textContent='A different question after inference started'`);await poll(async()=>await ui('__optional.questions.questionList.some(q=>String(q.fillError||"").includes("本批解答已取消"))'),'changed page cancels pending batch',200);await wait(2200);assert(await browser.evaluate('[...document.querySelectorAll("input")].every(input=>!input.checked)'),'A late response filled a changed batch');report.scenarios.push('changing-a-question-aborts-the-pending-batch-and-prevents-late-filling');
 report.errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);assert(!report.errors.length,'Native extension runtime exception: '+JSON.stringify(report.errors));
 report.solverMeasurements=[];
 for(const mode of ['answered','pending'])for(const revision of BASELINE_AVAILABLE?['baseline','optimized']:['optimized']){
  const count=mode==='answered'?100:30;await browser.call('Page.navigate',{url:'http://127.0.0.1:'+host.split(':').at(-1)+'/solver-benchmark?revision='+revision+'&mode='+mode+'&count='+count});const measured=await poll(async()=>await browser.evaluate('window.__performanceResult||null'),revision+' '+mode+' DOM benchmark',1200);assert(!measured.error,'Benchmark failed: '+JSON.stringify(measured));assert(measured.rate===100&&measured.filled===count&&!measured.cancelled,'Benchmark changed solver behavior');assert(measured.measurements.activeIntervals===0,'Solver left an identity timer running after settlement');report.solverMeasurements.push(measured);
 }
 const all=report.solverMeasurements;if(BASELINE_AVAILABLE)for(const mode of ['answered','pending']){const before=all.find(x=>x.mode===mode&&x.revision==='baseline'),after=all.find(x=>x.mode===mode&&x.revision==='optimized');assert(after.measurements.querySelectorAll<before.measurements.querySelectorAll,'DOM queries did not decrease for '+mode);if(mode==='pending')assert(after.measurements.peakIntervals<before.measurements.peakIntervals,'Batch timer count did not decrease');}
 report.scenarios.push(BASELINE_AVAILABLE?'real-dom-fixed-v092-versus-optimized-solver-counts-less-work-with-identical-results':'real-dom-optimized-solver-results-with-baseline-history-unavailable');report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{await shot('performance-failure');}catch{}}
console.log(JSON.stringify(report));try{await browser?.call('Browser.close');}catch{}browser?.close();
'''
RUNNER = "const BASELINE_AVAILABLE=" + json.dumps(baseline_integration is not None) + ";\n" + RUNNER

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
host = f"http://mooc1.chaoxing.com:{server.server_port}"
profile = ROOT / "tests" / ".performance-profile"
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
            if any(item.get('type') == 'service_worker' and item.get('url', '').endswith('/background.js') for item in targets):
                break
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(.05)
    else:
        raise RuntimeError('Native extension did not register its worker')
    result = subprocess.run(['node', '--input-type=module', '-e', RUNNER, str(debug_port), str(ROOT), host], capture_output=True, text=True, encoding='utf-8', timeout=180)
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
output['baselineCommit'] = baseline_commit
output['baselineAvailable'] = baseline_integration is not None
if baseline_integration is None:
    output['baselineUnavailableReason'] = 'The fixed v0.9.2 Git object is not included in this checkout; no before/after performance claim is made.'
output['packageSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
assert output['packageSha256'] == initial_hash, 'Package changed during verification; rerun'
(ROOT / 'tests' / 'verification-0.9.3-performance-browser.log').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(output, ensure_ascii=False))
assert output.get('passed'), output
