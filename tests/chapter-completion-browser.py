"""Check chapter completion against real, offline iframe DOM in Edge."""
from pathlib import Path
import json
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / "chapter-logic.js").read_text(encoding="utf-8")
exposure = """    window.__chapter = {
      isFinishedTask, canAdvanceChapter, collectChapterFrames, checkChapterCompletion, processIframeTask
    };
    if (window.__chapterInspectOnly) return;
    init();"""
assert source.count("    init();") == 1
source = source.replace("    init();", exposure)

setup = r"""
const failures = [], logs = [], cleanups = [];
let fixtureNow = 0, waitHook = null, navigationClicks = 0, modernClicks = 0, legacyClicks = 0;
window.addEventListener('error', event => failures.push(event.message));
window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
document.addEventListener('click',event=>{
  const target=event.target.closest('#prevNextFocusNext,.nextChapter');
  if(!target)return;
  navigationClicks++;
  if(target.id==='prevNextFocusNext')modernClicks++;else legacyClicks++;
});
const useLogStore = () => ({addLog: message => logs.push(message)});
const useQuestionStore = () => ({clearQuestion(){}});
const useConfigStore = () => ({platformParams:{cx:{parts:[{params:[
  {value:false}, {value:true}, {value:true}
]}]}},otherParams:{params:[{value:0}]}});
const vue = {onBeforeUnmount: callback => cleanups.push(callback)};
const concatMap = callback => callback;
const rxjs = {from(items){return {pipe(mapper){return {subscribe(callbacks){
  Promise.resolve().then(async()=>{
    for(const item of items) await mapper(item);
    await callbacks.complete();
  }).catch(callbacks.error);
}};}};}};
const aiWaitForDelay = async (_seconds, context) => {
  if (waitHook) await waitHook();
  return context.isCurrent();
};
const assert = (condition, message) => { if (!condition) throw Error(message); };
const result = document.querySelector('#chapter-completion-result');
const report = {realDom:true, offline:true, scenarios:[]};
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
const frame = async (parent, {video=false, blank=false, inaccessible=false, emptySrc=false, editor=false}={}) => {
  const node = document.createElement('iframe');
  if (inaccessible) node.setAttribute('sandbox','');
  if (blank && emptySrc) node.setAttribute('src','');
  if (blank && editor) {node.src='about:blank';node.className='edui-default';}
  if (!blank) {
    // srcdoc takes precedence; the HTTP address is metadata only and must not
    // be requested. It lets diagnostic URL redaction use its production path.
    node.src = video ? 'https://course.test/ananas/modules/video/index.html?id=fixture&token=fixture-secret' : 'https://course.test/mooc-ans/knowledge/cards?knowledgeid=fixture';
    node.srcdoc = '<!doctype html><html><body>' + (video ? '<video></video>' : '') + '</body></html>';
  }
  result.textContent=JSON.stringify({...report,stage:'waiting-for-offline-iframe-load'});
  let timer;
  const loaded = new Promise((resolve,reject) => {
    node.addEventListener('load',()=>{clearTimeout(timer);resolve();},{once:true});
    timer=setTimeout(()=>reject(Error('Offline iframe did not finish its load event')),2500);
  });
  parent.append(node);
  await loaded;
  return node;
};
const addVideo = async (parent, {finished=false,inaccessible=false}={}) => {
  const wrapper = document.createElement('div'); wrapper.className = 'ans-attach-ct';
  const icon = document.createElement('div');
  icon.className = 'ans-job-icon' + (finished ? ' ans-job-finished' : '');
  wrapper.append(icon); parent.append(wrapper);
  const video = await frame(wrapper,{video:true,inaccessible});
  return {wrapper,icon,video};
};
const fresh = async () => {
  cleanups.splice(0).forEach(dispose => dispose());
  document.querySelector('#tasks').replaceChildren();
  document.querySelector('#navigation-controls').innerHTML='<button id="prevNextFocusNext">下一节</button><button class="jb_btn jb_btn_92 fr fs14 nextChapter">下一章</button>';
  const rootFrame = await frame(document.querySelector('#tasks'));
  rootFrame.id='iframe';
  logs.length = 0; navigationClicks = 0; modernClicks = 0; legacyClicks = 0; fixtureNow = 0; waitHook = null;
  window.__chapterInspectOnly = true; window.__initChapter(); fixtureNow = 2000;
  const chapter = window.__chapter;
  const context = {signal:new AbortController().signal,isCurrent:()=>true};
  return {...chapter,rootFrame,body:rootFrame.contentDocument.body,
    complete:()=>chapter.checkChapterCompletion(document.documentElement,context,0)};
};
const addOuterAuxiliaries = async (rootFrame) => {
  const host=rootFrame.parentElement,auxiliaries=[];
  // Match the reported seven-page tree: one chapter, one internal video,
  // plus four outer empty-source helper frames and an editor about:blank.
  for(const emptySrc of [false,true]){
    const helper=await frame(host,{blank:true,emptySrc});
    host.insertBefore(helper,rootFrame);auxiliaries.push(helper);
  }
  for(const options of [{emptySrc:false},{emptySrc:true},{editor:true}])
    auxiliaries.push(await frame(host,{blank:true,...options}));
  await tick();
  assert(auxiliaries.length===5&&auxiliaries.every(node=>node.contentDocument?.URL==='about:blank'),
    'All five outer helpers must be real blank iframe documents');
  assert(document.querySelector('iframe')!==rootFrame,'A blank helper must precede the actual chapter iframe');
  assert(auxiliaries.some(node=>node.className==='edui-default'),'Fixture must include the actual editor iframe class');
  return auxiliaries;
};
const startScanner = async () => {
  fixtureNow = 0; logs.length = 0; window.__chapterInspectOnly = false;
  window.__initChapter(); fixtureNow = 2000;
  await tick(); window.__chapter.processIframeTask(); await tick();
  window.__chapter.processIframeTask(); await tick();
};
const assertNoDiagnosticSpam = async () => {
  window.__chapter.processIframeTask(); await tick();
  const before=logs.filter(text=>text.startsWith('[章节诊断]')).length;
  for(let scan=0;scan<3;scan++){window.__chapter.processIframeTask();await tick();}
  const after=logs.filter(text=>text.startsWith('[章节诊断]')).length;
  assert(after===before,'Repeated stable scans must not repeat the diagnostic group');
  return after-before;
};
"""

checks = r"""
(async () => {try {
  let h = await fresh();
  let task = await addVideo(h.body,{finished:true});
  let helper = await frame(task.video.contentDocument.body,{blank:true});
  assert(helper.contentDocument.URL === 'about:blank','Fixture must have a real about:blank helper');
  assert(!task.wrapper.classList.contains('ans-job-finished'),'Completion must come from the sibling icon');
  assert(h.isFinishedTask(task.video),'Sibling icon must confirm its own video');
  assert(h.collectChapterFrames(document.documentElement).length === 2,'Completed player helpers must be pruned');
  assert(h.canAdvanceChapter(document.documentElement),'Finished video with blank helper must permit completion');
  await h.complete(); await h.complete();
  assert(navigationClicks === 1,'Confirmed chapter must advance exactly once');
  assert(modernClicks === 1 && legacyClicks === 0,'When both controls are visible, only the modern next-section control may be clicked');
  assert(logs.includes('平台已确认本页任务完成') && !logs.some(text=>text.includes('未确认完成')),'Confirmed video must not show the unfinished warning');
  report.scenarios.push('finished-sibling-icon-with-blank-helper-advances-once');
  report.navigation={bothVisible:{modernClicks,legacyClicks}};

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  const pending = await addVideo(h.body);
  assert(h.isFinishedTask(task.video) && !h.isFinishedTask(pending.video),'Finished neighbor must not complete the pending video');
  assert(!h.canAdvanceChapter(document.documentElement),'Pending neighbor must block navigation');
  await h.complete(); assert(navigationClicks === 0,'Pending neighbor must never be skipped');
  await startScanner();
  assert(navigationClicks===0,'Normal scanner must keep a pending neighbor blocked');
  const blocker=logs.find(text=>text.startsWith('[章节诊断] 当前原因：')&&text.includes('未识别到平台完成标记'));
  const sourceRow=logs.find(text=>text.startsWith('[章节诊断] 页面#')&&text.includes('视频；https://course.test/ananas/modules/video/index.html；')&&text.includes('完成依据=无')&&text.includes('阻塞=未识别到平台完成标记'));
  assert(blocker&&sourceRow,'Normal scanner must identify the exact pending video and completion-marker blocker');
  assert(!logs.some(text=>text.includes('fixture-secret')||text.includes('?id=')),'Diagnostic source must omit URL query credentials');
  report.diagnostics={blocker,taskSource:sourceRow,stableScanExtraLines:await assertNoDiagnosticSpam()};
  report.scenarios.push('unfinished-neighbor-blocks-navigation');

  h = await fresh();
  await addVideo(h.body,{finished:true});
  await frame(h.body,{blank:true});
  assert(!h.canAdvanceChapter(document.documentElement),'Unrelated blank chapter container must still block navigation');
  report.scenarios.push('unrelated-blank-container-still-blocks');

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  helper = await frame(task.video.contentDocument.body,{inaccessible:true});
  assert(helper.contentDocument === null,'Sandbox must produce a truly inaccessible helper document');
  assert(h.canAdvanceChapter(document.documentElement),'Inaccessible helper inside a completed player must not block');
  report.scenarios.push('finished-player-inaccessible-helper-ignored');

  h = await fresh();
  task = await addVideo(h.body,{finished:true,inaccessible:true});
  assert(task.video.contentDocument === null,'Sandbox must produce a truly inaccessible video document');
  assert(h.canAdvanceChapter(document.documentElement),'Authoritative parent marker must confirm an inaccessible finished video');
  report.scenarios.push('finished-inaccessible-video-confirmed-by-parent');

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  let release;
  waitHook = () => new Promise(resolve => {release=resolve;});
  const navigation = h.complete();
  assert(typeof release === 'function','Completion must reach the actual navigation delay');
  task.icon.classList.remove('ans-job-finished'); release(); await navigation;
  assert(navigationClicks === 0,'Revoked completion during navigation delay must cancel the click');
  report.scenarios.push('completion-revoked-during-delay-blocks-navigation');

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  const secondIcon = document.createElement('div');secondIcon.className='ans-job-icon';
  task.wrapper.append(secondIcon);
  assert(!h.isFinishedTask(task.video),'Ambiguous multiple sibling icons must not confirm a video');
  assert(!h.canAdvanceChapter(document.documentElement),'Ambiguous task ownership must block navigation');
  report.scenarios.push('ambiguous-sibling-icons-rejected');

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  await frame(task.video.contentDocument.body,{blank:true});
  await startScanner();
  assert(navigationClicks===1,'Normal scanner must advance a finished video with blank helper exactly once');
  assert(logs.includes('平台已确认本页任务完成')&&!logs.some(text=>text.includes('未确认完成')),'Normal scanner must report completion without the false warning');
  assert(logs.some(text=>text.startsWith('[章节诊断] 页面#')&&text.includes('完成依据=所属任务图标完成标记')),'Normal scanner must explain the successful platform completion source');
  await assertNoDiagnosticSpam();
  report.scenarios.push('normal-scanner-blank-helper-confirms-and-advances-once');

  h = await fresh();
  task = await addVideo(h.body,{finished:true});
  task.video.contentDocument.open();
  assert(task.video.contentDocument.readyState==='loading','Fixture must have a real loading video document');
  await startScanner();
  assert(navigationClicks===1,'Normal scanner must not wait for a platform-confirmed loading video');
  assert(logs.includes('平台已确认本页任务完成')&&!logs.some(text=>text.includes('未确认完成')),'Loading finished video must not trigger the false warning');
  report.scenarios.push('normal-scanner-finished-loading-video-advances-once');

  h = await fresh();
  await addVideo(h.body,{finished:true});
  let auxiliaries=await addOuterAuxiliaries(h.rootFrame);
  await startScanner();
  const scopedSummary=logs.find(text=>text.startsWith('[章节诊断]')&&text.includes('2 个页面，1 个任务，1 个已确认'));
  assert(scopedSummary,'Normal scanner must count only the chapter and its completed video');
  assert(navigationClicks===1,'Outer blank/editor helpers must not block a completed chapter or cause duplicate navigation');
  assert(logs.includes('平台已确认本页任务完成')&&!logs.some(text=>text.includes('未确认完成')),'Outer helpers must not create a false unfinished warning');
  report.outerHelpers={blankFrames:auxiliaries.length,beforeAndAfterChapter:true,scopedSummary};
  report.scenarios.push('normal-scanner-ignores-five-outer-blank-editor-helpers');

  h = await fresh();
  await addVideo(h.body,{finished:true});
  auxiliaries=await addOuterAuxiliaries(h.rootFrame);
  const nextButton=document.querySelector('.nextChapter');nextButton.style.display='none';
  await startScanner();
  assert(logs.includes('平台已确认本页任务完成'),'The user screenshot scenario must still confirm the finished task');
  assert(navigationClicks===1&&modernClicks===1&&legacyClicks===0,'The visible next-section button must advance even when the old next-chapter control is hidden');
  assert(getComputedStyle(nextButton).display==='none','The hidden legacy control must remain hidden');
  assert(!logs.some(text=>text.includes('未确认完成')),'A hidden next button must not be reported as unfinished tasks');
  report.navigation.userScreenshot={modernClicks,legacyClicks,legacyStillHidden:true,
    action:logs.find(text=>text.startsWith('[章节诊断] 跳章：')&&text.includes('已点击'))};
  report.scenarios.push('visible-next-section-advances-once-with-hidden-legacy-next-chapter');

  for(const mode of ['missing','hidden']){
    h = await fresh();
    await addVideo(h.body,{finished:true});
    const modern=document.querySelector('#prevNextFocusNext');
    if(mode==='missing')modern.remove();else modern.style.display='none';
    await startScanner();
    assert(navigationClicks===1&&modernClicks===0&&legacyClicks===1,'An unavailable modern control must allow the visible legacy next-chapter control: '+mode);
    report.navigation['legacyWithModern'+mode]={modernClicks,legacyClicks};
    report.scenarios.push('legacy-next-chapter-advances-when-modern-'+mode);
  }

  for(const mode of ['hidden','disabled']){
    h = await fresh();
    await addVideo(h.body,{finished:true});
    const modern=document.querySelector('#prevNextFocusNext'),legacy=document.querySelector('.nextChapter');
    if(mode==='hidden'){modern.style.display='none';legacy.style.display='none';}
    else{modern.disabled=true;legacy.setAttribute('aria-disabled','true');}
    await startScanner();
    const unavailable=logs.find(text=>text.startsWith('[章节诊断] 当前原因：')&&text.includes('平台任务已完成，下一步按钮不可用'));
    assert(unavailable&&logs.includes('平台已确认本页任务完成'),'Two unavailable controls must be explained separately from task completion: '+mode);
    assert(navigationClicks===0,'No unavailable navigation control may be clicked: '+mode);
    report.navigation['both'+mode]={modernClicks,legacyClicks,reason:unavailable};
    report.scenarios.push('completed-task-with-both-navigation-controls-'+mode+'-does-not-click');
  }

  for(const mode of ['replaced','hidden']){
    h = await fresh();
    await addVideo(h.body,{finished:true});
    let releaseButton;
    waitHook=()=>new Promise(resolve=>{releaseButton=resolve;});
    const before=document.querySelector('#prevNextFocusNext');
    const waiting=h.complete();
    assert(typeof releaseButton==='function','Navigation must reach its delay before modifying the chosen control');
    if(mode==='replaced')before.replaceWith(before.cloneNode(true));else before.style.display='none';
    releaseButton();await waiting;
    assert(navigationClicks===0,'A chosen control changed during delay must cancel, without switching to a different control: '+mode);
    report.scenarios.push('navigation-delay-cancels-when-modern-control-'+mode);
  }
  cleanups.splice(0).forEach(dispose => dispose());
  assert(failures.length===0,'Uncaught browser errors: '+failures.join('; '));
  result.textContent=JSON.stringify({...report,errors:failures,passed:true});
}catch(error){result.textContent=JSON.stringify({...report,passed:false,error:String(error),stack:error.stack,errors:failures});}})();
"""

page = ('<!doctype html><meta charset="utf-8"><title>Offline chapter completion check</title>'
        '<div id="navigation-controls"></div>'
        '<div id="tasks"></div><pre id="chapter-completion-result">{"stage":"starting"}</pre>'
        '<script>window.addEventListener("error",event=>{document.querySelector("#chapter-completion-result").textContent=JSON.stringify({passed:false,stage:"browser-error",error:event.message});});</script><script>'
        + setup + '\n(function(Date){\n' + source
        + '\nwindow.__initChapter=useCxChapterLogic;\n})({now:()=>fixtureNow});\n'
        + checks + '</script>')
fixture_dir = ROOT / "tests" / "browser-fixture" / "chapter-completion"
fixture_dir.mkdir(parents=True, exist_ok=True)
fixture = fixture_dir / "chapter.html"
fixture.write_text(page, encoding="utf-8")
profile = ROOT / "tests" / ".chapter-completion-profile"
port_file = profile / "DevToolsActivePort"
port_file.unlink(missing_ok=True)
browser = subprocess.Popen([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--allow-file-access-from-files",
    "--user-data-dir=" + str(profile), "--remote-debugging-port=0",
    fixture.as_uri() + '?mooc2=1'
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    # Real time avoids virtual clocks racing sandboxed iframe renderer startup.
    deadline = time.monotonic() + 12
    socket_url = None
    while time.monotonic() < deadline:
        try:
            port = int(port_file.read_text(encoding="utf-8").splitlines()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                pages = json.load(response)
            socket_url = next(item["webSocketDebuggerUrl"] for item in pages
                              if item.get("type") == "page" and "chapter.html" in item.get("url", ""))
            break
        except (OSError, ValueError, IndexError, StopIteration):
            time.sleep(0.05)
    if not socket_url:
        raise RuntimeError("Offline chapter review did not start its browser page")
    runner = r"""
const socket=new WebSocket(process.argv[1]),pending=new Map();let sequence=0;
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data),handler=pending.get(message.id);
  if(handler){pending.delete(message.id);message.error?handler.reject(Error(message.error.message)):handler.resolve(message.result);}
});
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));
});
let output;
for(let attempt=0;attempt<150;attempt++){
  const response=await call('Runtime.evaluate',{expression:'JSON.parse(document.querySelector("#chapter-completion-result")?.textContent || "{}")',returnByValue:true});
  output=response.result?.value;
  if(typeof output?.passed==='boolean')break;
  await new Promise(resolve=>setTimeout(resolve,100));
}
console.log(JSON.stringify(output));
socket.send(JSON.stringify({id:++sequence,method:'Browser.close'}));socket.close();
"""
    run = subprocess.run(["node", "--input-type=module", "-e", runner, socket_url],
                         capture_output=True, text=True, encoding="utf-8", timeout=22)
    if run.returncode != 0:
        raise RuntimeError("Could not read offline chapter result: " + run.stderr[-1500:])
    output = json.loads(run.stdout)
finally:
    if browser.poll() is None:
        browser.terminate()
        try:
            browser.wait(timeout=3)
        except subprocess.TimeoutExpired:
            browser.kill()
(ROOT / "tests" / "verification-0.7.5-browser.log").write_text(
    json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
