"""Exercise the redesigned full userscript in offline Edge at desktop and 320px."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
press_only = "--press-only" in sys.argv[1:]
artifact = ROOT / "ai-course-helper.user.js"
source = artifact.read_text(encoding="utf-8")
version = re.search(r"^// @version\s+(\S+)", source, re.M).group(1)
cache = ROOT / "tests" / "browser-fixture" / "mooc2" / "work"
tags = []
for index, _url in enumerate(re.findall(r"^// @require\s+(https://\S+)", source, re.M)):
    path = cache / f"dependency-{index}.js"
    assert path.exists(), f"Missing offline dependency: {path}"
    tags.append('<script src="' + path.as_uri() + '"></script>')
resources = {}
for name, _url in re.findall(r"^// @resource\s+(ElementPlus\S*)\s+(https://\S+)", source, re.M):
    path = cache / f"{name}.css"
    assert path.exists(), f"Missing offline style: {path}"
    resources[name] = path.read_text(encoding="utf-8")

background = r'''
<style>
html,body{margin:0;min-height:100%;background:#f3f5fb;font:14px/1.6 "Microsoft YaHei UI",sans-serif;color:#26344c}
.review-course{position:fixed;inset:0;overflow:hidden;pointer-events:none}.review-course header{height:64px;padding:0 30px;display:flex;align-items:center;justify-content:space-between;background:white;border-bottom:1px solid #e4e8f1}
.review-course header strong{font-size:19px;color:#263e68}.review-course header span{font-size:12px;color:#7d8aa1}.review-course aside{position:absolute;top:64px;left:0;bottom:0;width:190px;padding:27px 22px;box-sizing:border-box;background:#1a2946;color:#d7e1f4}.review-course aside strong{display:block;color:white;margin-bottom:24px}.review-course aside p{padding:11px 13px;margin:8px -7px;border-radius:8px}.review-course aside p:first-of-type{background:#304b7b}
.review-course main{margin-left:190px;padding:32px;max-width:1100px}.review-course h1{font-size:26px;margin:0 0 7px}.review-course .lead{color:#7f8ca4;margin:0 0 25px}.review-plan{padding:23px;border:1px solid #d9e3f9;background:#e8effe;border-radius:16px}.review-plan strong{font-size:18px}.review-plan p{margin:5px 0;color:#687fa6}.review-courses{display:grid;grid-template-columns:repeat(3,1fr);gap:19px;margin-top:27px}.review-card{overflow:hidden;border-radius:14px;background:#fff;border:1px solid #e0e6f1}.review-thumb{height:150px;padding:18px;color:white;box-sizing:border-box;background:linear-gradient(135deg,#29467c,#6e8cca)}.review-card:nth-child(2) .review-thumb{background:linear-gradient(135deg,#57598c,#9898c6)}.review-card:nth-child(3) .review-thumb{background:linear-gradient(135deg,#9c6f4c,#d5aa7f)}.review-card b{display:block;padding:15px 17px 3px}.review-card p{font-size:12px;color:#8592a8;padding:0 17px 17px;margin:0}.review-notes{margin-top:26px;padding:22px;border:1px solid #e1e7f1;background:#fff;border-radius:13px;color:#73829c}
@media(max-width:600px){.review-course aside{width:105px;padding:24px 12px;font-size:11px}.review-course main{margin-left:105px;padding:24px 18px}.review-course h1{font-size:20px}.review-courses{grid-template-columns:1fr}.review-card:not(:first-child){display:none}.review-course header{padding:0 16px}.review-course header span{display:none}}
</style>
<div class="review-course" aria-hidden="true"><header><strong>知行 · 我的课程</strong><span>学习空间　　消息　　个人中心</span></header><aside><strong>课程学习</strong><p>正在学习</p><p>章节目录</p><p>作业练习</p><p>学习笔记</p></aside><main><h1>继续今天的学习</h1><p class="lead">从上次的进度继续，开启新的知识探索。</p><section class="review-plan"><strong>本周学习计划</strong><p>已完成 6 个章节，继续保持自己的节奏。</p><p>下一节：理解数据与日常生活中的统计</p></section><section class="review-courses"><article class="review-card"><div class="review-thumb">数据与逻辑</div><b>统计思维与数据分析</b><p>第三章　从样本理解总体</p></article><article class="review-card"><div class="review-thumb">阅读与表达</div><b>文学阅读与写作</b><p>第二章　观察与表达</p></article><article class="review-card"><div class="review-thumb">自然与科学</div><b>生活中的科学</b><p>第四章　身边的物理现象</p></article></section><section class="review-notes">课程动态<br>本周练习已开放，可在章节学习后查看。<br>这是用于界面检查的本地课程样例。</section></main></div>
'''
setup = r'''
window.__reviewErrors=[];window.__reviewRequests=0;window.__reviewCopied='';window.__reviewCopyCalls=0;
window.addEventListener('error',event=>window.__reviewErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.__reviewErrors.push(String(event.reason)));
window.GM_info={script:{name:'Offline UI review',namespace:'local',author:'local',version:window.__reviewVersion,description:'No API requests'}};
const reviewStorage=new Map();
window.GM_getValue=(key,fallback)=>reviewStorage.has(key)?reviewStorage.get(key):fallback;
window.GM_setValue=(key,value)=>reviewStorage.set(key,value);
window.GM_addStyle=css=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);return style;};
window.GM_getResourceText=name=>window.__reviewResources[name]||'';
window.GM_xmlhttpRequest=()=>{window.__reviewRequests++;throw Error('Unexpected model request during UI review');};
window.unsafeWindow=window;
const reviewAttach=Element.prototype.attachShadow;
Element.prototype.attachShadow=function(options){return reviewAttach.call(this,{...options,mode:'open'});};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__reviewCopyCalls++;window.__reviewCopied=text;}}});
'''
fixture_dir = ROOT / "tests" / "browser-fixture" / "redesign" / "mooc2" / "work"
fixture_dir.mkdir(parents=True, exist_ok=True)
fixture = fixture_dir / "dowork-redesign.html"
fixture.write_text('<!doctype html><html><head><meta charset="utf-8"><title>AI helper interface review</title></head><body>'
                   + background + ''.join(tags) + '<script>window.__reviewResources='
                   + json.dumps(resources) + ';window.__reviewVersion=' + json.dumps(version) + ';' + setup + '</script><script src="'
                   + artifact.as_uri() + '"></script></body></html>', encoding="utf-8")

runner = r'''
import fs from 'node:fs';
const socket=new WebSocket(process.argv[1]),pending=new Map();let sequence=0;
socket.addEventListener('message',event=>{const message=JSON.parse(event.data),handler=pending.get(message.id);if(handler){pending.delete(message.id);message.error?handler.reject(Error(message.error.message)):handler.resolve(message.result);}});
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async(expression)=>{const response=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw Error(response.exceptionDetails.text+': '+response.exceptionDetails.exception?.description);return response.result?.value;};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=process.argv[2],pressOnly=process.argv[3]==='press-only';const report={fullArtifact:true,offline:true,viewports:[],screenshots:[],errors:[]};
const shot=async name=>{const result=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(root+'/tests/'+name+'.png',Buffer.from(result.data,'base64'));report.screenshots.push(name+'.png');};
try{
  await call('Page.enable');
  for(let attempt=0;attempt<100;attempt++){
    const ready=await evaluate(`(()=>{const shadow=[...document.querySelectorAll('body > div')].map(node=>node.shadowRoot).find(root=>root?.querySelector('.ai-config'));if(!shadow)return false;const mount=[...shadow.children].find(node=>node.__vue_app__);const stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores)return false;window.__ui={shadow,stores,config:stores.get('configStore'),logs:stores.get('logStore')};return !!window.__ui.config&&!!window.__ui.logs;})()`);
    if(ready)break;
    if(attempt===99)throw Error('The complete userscript did not expose its mounted stores');await wait(50);
  }
  await evaluate(`(()=>{window.__ui.assert=(condition,message)=>{if(!condition)throw Error(message);};window.__ui.tick=async()=>{await Vue.nextTick();await new Promise(resolve=>setTimeout(resolve,0));await Vue.nextTick();};window.__ui.addState=async(done)=>{const {logs,config}=window.__ui;logs.logList.splice(0);config.ai.provider='deepseek';config.ai.deepseekModel='deepseek-chat';logs.addLog('脚本加载成功，正在解析网页','primary');logs.addLog('[章节诊断] 扫描状态：2 个页面，1 个任务，'+(done?'1':'0')+' 个已确认；自动跳章=开，只答题=关','primary');logs.addLog('[章节诊断] 扫描范围仅限章节主页面及其内容，已排除外层 5 个非章节框架','info');logs.addLog('[章节诊断] 页面#2 视频；https://course.test/video；完成依据='+(done?'祖先容器完成标记':'无')+'；文档=已加载','info');logs.addLog(done?'平台已确认本页任务完成':'发现一个video，正在解析',done?'success':'warning');logs.addLog('[章节诊断] 当前原因：'+(done?'平台任务已完成，等待页面稳定 1.5 秒':'页面#2：未识别到平台完成标记')+'；任务下一步=可用，章节下一章=隐藏或禁用','primary');if(done)logs.addLog('[章节诊断] 跳章：已点击下一节（#prevNextFocusNext），等待平台切换页面','primary');config.menuIndex='0';await window.__ui.tick();};})()`);
  await evaluate(`(async()=>{const {logs,config,shadow,assert,tick}=window.__ui;logs.logList.splice(0);config.menuIndex='0';await tick();assert(shadow.querySelector('.ai-status-badge')?.dataset.state==='waiting','No task evidence must show a waiting status, never fake completion');})()`);
  report.emptyStateHonest=true;
  if(!pressOnly)for(const width of [1280,320]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await evaluate(`window.dispatchEvent(new Event('resize'));window.__ui.addState(true)`);await wait(width===320?2700:300);
    await evaluate(`window.__ui.shadow.activeElement?.blur()`);
    const overview=await evaluate(`(async()=>{const {shadow,assert,logs}=window.__ui;const title=shadow.querySelector('.ai-overview-title'),badge=shadow.querySelector('.ai-status-badge'),panel=shadow.querySelector('.main-page');assert(title&&badge,'Overview status must be present');assert(badge.dataset.state==='complete','Confirmed task data must show complete state');assert(/1/.test(shadow.querySelector('.ai-overview-metrics').textContent),'Overview must contain the actual task count');const brief=shadow.querySelector('.ai-log-mode[aria-pressed="true"]');assert(brief?.textContent==='简要','Logs must default to brief mode');assert(!shadow.querySelector('.log').textContent.includes('页面#2 视频'),'Brief mode must hide per-frame diagnostics');assert(!shadow.querySelector('.ai-overview-note').textContent.includes('#prevNextFocusNext')&&!shadow.querySelector('.log').textContent.includes('#prevNextFocusNext'),'Overview and brief logs should present progress without internal selectors');const b=panel.getBoundingClientRect();assert(b.left>=0&&b.right<=innerWidth+1,'Panel must fit the viewport');assert(b.width<=396+1,'Panel should use the new compact width');assert(panel.scrollWidth<=panel.clientWidth+1,'Panel must not overflow horizontally');return{title:title.textContent,state:badge.dataset.state,panel:b.toJSON(),logRows:shadow.querySelectorAll('.ai-log-entry').length,logs:logs.logList.length};})()`);
    await shot('redesign-overview-'+(width===320?'320':'desktop'));
    const interactions=await evaluate(`(async()=>{const {shadow,assert,logs,tick}=window.__ui;const modes=[...shadow.querySelectorAll('.ai-log-mode')];modes.find(button=>button.textContent==='详细').click();await tick();assert(shadow.querySelector('.log').textContent.includes('页面#2 视频'),'Detailed mode must reveal the underlying frame diagnostics');const fullRows=shadow.querySelectorAll('.ai-log-entry').length;shadow.querySelector('.ai-copy-logs').click();await tick();await tick();assert(window.__reviewCopied.includes('页面#2 视频')&&window.__reviewCopied.includes('脚本加载成功')&&window.__reviewCopied.includes('#prevNextFocusNext'),'Copy must include all underlying logs, including hidden brief rows and original diagnostic selectors');assert(window.__reviewCopyCalls>0,'Copy button must call the clipboard');modes.find(button=>button.textContent==='简要').click();await tick();assert(shadow.querySelector('.ai-log-mode[aria-pressed="true"]').textContent==='简要','Brief mode must restore without mutating the source logs');assert(logs.logList.length===7,'Log filtering must preserve every original entry');return{filterToggle:true,fullRows,copyIncludesHiddenRows:true};})()`);
    await evaluate(`window.__ui.addState(false)`);await wait(30);
    await evaluate(`(()=>{const {shadow,assert}=window.__ui;assert(shadow.querySelector('.ai-status-badge').dataset.state!=='complete','An unfinished task must not display completion');})()`);
    await evaluate(`window.__ui.addState(true);`);
    await evaluate(`(async()=>{const {shadow,tick}=window.__ui;shadow.querySelector('#tab-1').click();await tick();})()`);await wait(260);
    const settings=await evaluate(`(async()=>{const {shadow,assert,tick}=window.__ui;const scroll=shadow.querySelector('.ai-config-scroll'),save=shadow.querySelector('.ai-save'),details=shadow.querySelector('.ai-advanced-details');assert(scroll&&save,'Model settings and fixed save action must stay available');const visibleSave=()=>{const b=save.getBoundingClientRect();assert(b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1,'Save action must remain in the viewport');const hit=shadow.elementFromPoint(b.left+b.width/2,b.top+b.height/2);assert(hit===save||save.contains(hit),'Save action must be hit-testable');return b.toJSON();};for(const fraction of [0,.5,1]){scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*fraction;await tick();visibleSave();}details.open=true;await tick();scroll.scrollTop=scroll.scrollHeight;await tick();visibleSave();details.open=false;scroll.scrollTop=0;await tick();for(const field of shadow.querySelectorAll('.ai-config input,.ai-config select,.ai-config textarea,.ai-config button')){if(!field.getClientRects().length)continue;const b=field.getBoundingClientRect();assert(b.left>=0&&b.right<=innerWidth+1,'Editable settings must fit without horizontal overflow');}const url=shadow.querySelector('.ai-request-url textarea,textarea.ai-request-url');assert(url,'URL remains a multiline field');const body=shadow.querySelector('.el-card__body'),outerScroll=body.scrollHeight-body.clientHeight;assert(outerScroll<=1,'Settings should use one content scroll area instead of a second outer scrollbar');return{save:visibleSave(),fixedAtScrollPositions:true,controlsFit:true,urlMultiline:true,outerScroll};})()`);
    await shot('redesign-settings-'+(width===320?'320':'desktop'));
    const motion=await evaluate(`(async()=>{const {shadow,assert,tick}=window.__ui;const toggle=shadow.querySelector('.ai-panel-toggle');toggle.focus();assert(shadow.activeElement===toggle,'Collapse control must be keyboard focusable');toggle.click();await tick();assert(toggle.getAttribute('aria-expanded')==='false','Collapse state must update immediately');const animations=shadow.querySelector('.el-card').getAnimations({subtree:true}).map(animation=>({duration:animation.effect.getTiming().duration,keyframes:animation.effect.getKeyframes().map(({transform,opacity})=>({transform,opacity}))}));assert(animations.some(animation=>Number(animation.duration)>0&&Number(animation.duration)<=300),'The collapse interaction must provide a short, actual browser animation');return{animations};})()`);await wait(280);
    await evaluate(`(async()=>{const {shadow,assert,tick}=window.__ui;const toggle=shadow.querySelector('.ai-panel-toggle');assert(shadow.activeElement===toggle,'Collapsing must retain focus on its trigger');for(let i=0;i<6;i++){toggle.click();await new Promise(resolve=>setTimeout(resolve,35));}if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();await tick();})()`);await wait(300);
    await evaluate(`(()=>{const {shadow,assert}=window.__ui;const toggle=shadow.querySelector('.ai-panel-toggle'),save=shadow.querySelector('.ai-save');assert(toggle.getAttribute('aria-expanded')==='true','Rapid retoggling must finish expanded');assert(save.getClientRects().length>0,'Rapid toggling must not strand hidden content');assert(!save.closest('[inert]'),'Reopened content must be interactive');})()`);
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const reduced=await evaluate(`(async()=>{const {shadow,assert,tick}=window.__ui;assert(matchMedia('(prefers-reduced-motion: reduce)').matches,'Reduced motion must reach the page');const toggle=shadow.querySelector('.ai-panel-toggle');toggle.click();await tick();const animations=shadow.querySelector('.el-card').getAnimations({subtree:true}).map(animation=>({duration:animation.effect.getTiming().duration,keyframes:animation.effect.getKeyframes().map(({transform,opacity})=>({transform,opacity}))}));assert(!animations.some(animation=>Number(animation.duration)>0&&animation.keyframes.some(frame=>frame.transform&&frame.transform!=='none'&&frame.transform!=='matrix(1, 0, 0, 1, 0, 0)')),'Reduced motion must suppress spatial animation');toggle.click();await tick();return{matches:true,spatialAnimationSuppressed:true,animations};})()`);await wait(100);
    report.viewports.push({width,overview,interactions,settings,motion,reduced,rapidToggle:true,focusPreserved:true});
  }
  await evaluate(`(async()=>{window.__ui.config.menuIndex='1';await window.__ui.tick();})()`);await wait(240);
  await call('DOM.enable');await call('CSS.enable');await call('DOM.getDocument',{depth:-1,pierce:true});
  const object=await call('Runtime.evaluate',{expression:'window.__ui.shadow.querySelector(".ai-save")',returnByValue:false});
  const {nodeId}=await call('DOM.requestNode',{objectId:object.result.objectId});
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await call('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['active']});
  const normalTransform=await evaluate('getComputedStyle(window.__ui.shadow.querySelector(".ai-save")).transform');
  if(!/^matrix\(0\.975, 0, 0, 0\.975,/.test(normalTransform))throw Error('Regular press should provide the intended scale feedback: '+normalTransform);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reducedTransform=await evaluate('getComputedStyle(window.__ui.shadow.querySelector(".ai-save")).transform');
  if(reducedTransform!=='none')throw Error('Reduced motion must override the active press transform: '+reducedTransform);
  await call('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});
  report.pressFeedback={forcedPseudoState:'active',normalTransform,reducedTransform,reducedOverrideVerified:true};
  report.errors=await evaluate('window.__reviewErrors');
  const requests=await evaluate('window.__reviewRequests');if(report.errors.length||requests)throw Error('Unexpected browser errors or network requests: '+JSON.stringify({errors:report.errors,requests}));
  report.requests=requests;report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{await shot('redesign-failure');}catch{}}
console.log(JSON.stringify(report));
socket.send(JSON.stringify({id:++sequence,method:'Browser.close'}));socket.close();
'''

profile = ROOT / "tests" / ".redesign-profile"
port_file = profile / "DevToolsActivePort"
port_file.unlink(missing_ok=True)
browser = subprocess.Popen([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--allow-file-access-from-files", "--user-data-dir=" + str(profile), "--remote-debugging-port=0",
    "--window-size=1280,900", fixture.as_uri()
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 12
    socket_url = None
    while time.monotonic() < deadline:
        try:
            port = int(port_file.read_text(encoding="utf-8").splitlines()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                pages = json.load(response)
            socket_url = next(item["webSocketDebuggerUrl"] for item in pages
                              if item.get("type") == "page" and "dowork-redesign.html" in item.get("url", ""))
            break
        except (OSError, ValueError, IndexError, StopIteration):
            time.sleep(.05)
    if not socket_url:
        raise RuntimeError("Offline redesign review did not open its browser page")
    run = subprocess.run(["node", "--input-type=module", "-e", runner, socket_url, str(ROOT), "press-only" if press_only else "full"],
                         capture_output=True, text=True, encoding="utf-8", timeout=35)
    if run.returncode != 0:
        raise RuntimeError("Could not read offline redesign result: " + run.stderr[-1500:])
    output = json.loads(run.stdout)
finally:
    if browser.poll() is None:
        browser.terminate()
        try:
            browser.wait(timeout=3)
        except subprocess.TimeoutExpired:
            browser.kill()
record_path = ROOT / "tests" / "verification-0.8.0-browser.log"
output["pressFeedback"] = {**output.get("pressFeedback", {}), "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest().upper()}
if press_only and record_path.exists():
    record = json.loads(record_path.read_text(encoding="utf-8"))
    # The full run's result remains independent of a retried targeted check.
    if "fullValidationPassed" not in record:
        record["fullValidationPassed"] = record.get("passed") is True
    record["pressFeedback"] = output["pressFeedback"]
    record["targetedPressPassed"] = output.get("passed") is True
    record["passed"] = record["fullValidationPassed"] and output.get("passed") is True
    if not output.get("passed"):
        record["targetedPressError"] = output
    else:
        record.pop("targetedPressError", None)
else:
    record = output
record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
