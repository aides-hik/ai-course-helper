"""Compare the real unpacked 0.9.3/0.9.4 extensions in isolated Edge profiles.

Frame timing is observational. Deterministic checks cover work counts and input
semantics; no hardware-independent 60/120 Hz promise or FPS pass threshold.
The browser-only instrumentation does not change the shipped application.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ast
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
BASELINE = "3a4b786278440b73b3984768c2aef877e01e3ac9"
FIXTURE = ROOT / "tests" / "browser-fixture" / "motion"
FIXTURE.mkdir(parents=True, exist_ok=True)
PROFILES = ROOT / "tests" / ".motion-profile"
PROFILES.mkdir(exist_ok=True)
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
network = []


def literal(filename, name):
    tree = ast.parse((ROOT / "tests" / filename).read_text(encoding="utf-8"))
    return next(node.value.value for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))


background = literal("redesign-panel-browser.py", "background")
PAGE = ('<!doctype html><html><head><meta charset="utf-8"><title>Motion performance fixture</title>'
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">'
        '</head><body>' + background + '</body></html>').encode()


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def log_message(self, *_args):
        pass

    def do_GET(self):
        is_page = self.path.startswith("/mooc2/work/dowork")
        if not is_page and not self.path.startswith("/favicon.ico"):
            network.append({"method": "GET", "path": self.path})
        data = PAGE if is_page else b""
        self.send_response(200 if is_page else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        network.append({"method": "POST", "path": self.path})
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()


transport = literal("extension-browser.py", "RUNNER")
RUNNER = transport[:transport.index("const debugPort=")] + r'''
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3],revision=process.argv[4];
const report={revision,realExtension:true,headless:true,gpuDisabled:true,timingObservational:true,checks:[],screenshots:[]};
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const poll=async(check,label,count=200)=>{for(let i=0;i<count;i++){try{const result=await check();if(result)return result;}catch{}await wait(40);}throw Error('Timed out: '+label);};
let page,isolated;
const ui=expression=>page.evaluate(expression,isolated);
const metrics=async()=>Object.fromEntries((await page.call('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const difference=(a,b)=>Object.fromEntries(['LayoutCount','RecalcStyleCount','TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].map(k=>[k,Math.round((b[k]-a[k])*1e6)/1e6]));
const shot=async name=>{const image=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(root+'/tests/'+name+'.png',Buffer.from(image.data,'base64'));report.screenshots.push(name+'.png');};
const discover=async()=>{
 isolated=await poll(async()=>{for(const context of page.events.filter(e=>e.method==='Runtime.executionContextCreated').map(e=>e.params.context).reverse()){try{if(await page.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue&&globalThis.Pinia)',context.id))return context.id;}catch{}}},'extension isolated context');
 await page.call('DOM.enable');
 await poll(async()=>{const {root:doc}=await page.call('DOM.getDocument',{depth:-1,pierce:true});const collect=n=>[...(n.shadowRoots||[]),...(n.children||[]).flatMap(collect),...(n.contentDocument?collect(n.contentDocument):[])];for(const candidate of collect(doc).filter(n=>n.shadowRootType)){const resolved=await page.call('DOM.resolveNode',{nodeId:candidate.nodeId,executionContextId:isolated});const result=await page.call('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:`function(){if(!this.querySelector('.ai-config'))return false;const mount=[...this.querySelectorAll('div')].find(n=>n.__vue_app__);const stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores)return false;globalThis.__motion={root:this,config:stores.get('configStore'),logs:stores.get('logStore'),questions:stores.get('questionStore')};return !!__motion.config;}`,returnByValue:true});if(result.result?.value)return true;}},'closed shadow UI');
};
try{
 const targets=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
 page=new CDP(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);
 await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Performance.enable');
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?motion'});await discover();
 await wait(5500); // Let normal no-key/no-question startup settle before sampling.
 report.environment=await page.evaluate(`(()=>{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return{userAgent:navigator.userAgent,devicePixelRatio,viewport:[innerWidth,innerHeight],screen:[screen.width,screen.height],webglRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,hardwareConcurrency:navigator.hardwareConcurrency,visibility:document.visibilityState};})()`);
 await ui(`(async()=>{const m=__motion;m.config.menuIndex='0';m.config.isMinus=false;m.config.position.x='40px';m.config.position.y='80px';m.logs.clearLogs();m.questions.clearQuestion();for(let i=0;i<40;i++)m.questions.addQuestion({title:'本地批题状态 '+i,answer:i<20?['本地模拟结果']:[],answerStatus:i<20?'success':'pending',type:'0'});for(let i=0;i<500;i++)m.logs.addLog('本地性能检查：第 '+i+' 条课程进度，已保留上下文','info');await Vue.nextTick();await new Promise(r=>setTimeout(r,400));})()`);
 report.instrumentation=await ui(`(()=>{
  const m=__motion,panel=m.root.querySelector('.main-page');m.panel=panel;m.count={transform:0,left:0,top:0,topVariable:0,maps:0,positionWrites:0,animate:0};m.restores=[];m.samples=[];m.longTasks=[];m.animationCalls=[];m.running=false;
  // Chromium exposes CSS named properties through an exotic object rather than
  // configurable prototype setters. Interpose only this panel's DOM style
  // getter, forwarding every operation to the native declaration unchanged.
  const rawStyle=panel.style,styleProxy=new Proxy(rawStyle,{get(target,key){if(key==='setProperty')return(name,...args)=>{if(name==='--ai-panel-top')m.count.topVariable++;return target.setProperty(name,...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},set(target,key,value){if(['left','top','transform'].includes(key))m.count[key]++;return Reflect.set(target,key,value,target);}});
  Object.defineProperty(panel,'style',{configurable:true,get:()=>styleProxy});m.restores.push(()=>delete panel.style);const wrapped=['left','top','transform'];
  const data=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){m.count.maps++;return Reflect.apply(data,this,args);};m.restores.push(()=>HTMLCanvasElement.prototype.toDataURL=data);
  const animate=Element.prototype.animate;Element.prototype.animate=function(...args){if(this.getRootNode()===m.root){m.count.animate++;m.animationCalls.push({target:this.className,frames:JSON.parse(JSON.stringify(args[0])),options:JSON.parse(JSON.stringify(args[1]||{}))});}return Reflect.apply(animate,this,args);};m.restores.push(()=>Element.prototype.animate=animate);
  m.storage=(changes,area)=>{if(area==='local')for(const key of Object.keys(changes))if(key.startsWith('openai-course-helper:config:v1:field:')&&key.includes('"position"'))m.count.positionWrites++;};chrome.storage.onChanged.addListener(m.storage);
  try{m.observer=new PerformanceObserver(list=>{if(m.running)for(const e of list.getEntries())m.longTasks.push({duration:e.duration,start:e.startTime});});m.observer.observe({type:'longtask',buffered:false});}catch{}
  m.reset=()=>{for(const key in m.count)m.count[key]=0;m.samples=[];m.longTasks=[];};
  m.begin=()=>{m.reset();m.running=true;let last=null;const step=now=>{if(!m.running)return;if(last!==null)m.samples.push(now-last);last=now;m.sampleRaf=requestAnimationFrame(step);};m.sampleRaf=requestAnimationFrame(step);};
  m.finish=()=>{m.running=false;cancelAnimationFrame(m.sampleRaf);const sorted=[...m.samples].sort((a,b)=>a-b),sum=sorted.reduce((a,b)=>a+b,0),quantile=q=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]||0;return{counts:{...m.count},frames:sorted.length,timing:{medianMs:quantile(.5),p95Ms:quantile(.95),maxMs:sorted.at(-1)||0,over33ms:sorted.filter(x=>x>33.3).length,over33Share:sorted.filter(x=>x>33.3).length/Math.max(1,sorted.length),observedMeanFps:1000/(sum/Math.max(1,sorted.length))},longTasks:m.longTasks};};
  return{wrappedStyleProperties:wrapped,closedShadow:true};
 })()`);
 assert(report.instrumentation.wrappedStyleProperties.length===3,'Style write counters could not attach');
 const before=await metrics();
 report.drag=await ui(`(async()=>{const m=__motion,p=m.panel,header=m.root.querySelector('.card-header'),b=header.getBoundingClientRect(),start={x:b.left+80,y:b.top+16};const original=p.getBoundingClientRect();m.begin();let updates=0;const update=()=>{m.logs.addLog('背景批处理状态 '+(++updates),'info');m.questions.questionList[20].answerStatus=updates%2?'searching':'pending';};header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:start.x,clientY:start.y}));await Vue.nextTick();const initial=p.getBoundingClientRect();for(let frame=0;frame<150;frame++){if(frame%6===0)update();for(let burst=0;burst<8;burst++){const phase=(frame*8+burst)/(150*8),x=50+220*(.5-.5*Math.cos(phase*Math.PI*4)),y=80+110*(.5-.5*Math.cos(phase*Math.PI*2));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,buttons:1,clientX:start.x+x-40,clientY:start.y+y-80}));}await new Promise(requestAnimationFrame);}await Vue.nextTick();const during={...m.count},movingRect=p.getBoundingClientRect();document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:start.x+10,clientY:start.y}));await Vue.nextTick();await new Promise(r=>setTimeout(r,120));const result=m.finish(),rect=p.getBoundingClientRect();return{...result,inputEvents:1200,requestedFrames:150,backgroundUpdates:updates,countsDuring:during,config:{...m.config.position},rect:{left:rect.left,top:rect.top},original:{left:original.left,top:original.top},initial:{left:initial.left,top:initial.top},movingRect:{left:movingRect.left,top:movingRect.top},dragging:p.dataset.aiDragging||null,transform:p.style.transform,willChange:p.style.willChange};})()`);
 report.drag.performance=difference(before,await metrics());
 assert(report.drag.countsDuring.positionWrites===0,'Drag wrote persistent coordinates before release');
 assert(report.drag.counts.positionWrites>0&&report.drag.counts.positionWrites<=2,'Final position did not persist once per field');
 assert(Math.abs(parseFloat(report.drag.config.x)-report.drag.rect.left)<1&&Math.abs(parseFloat(report.drag.config.y)-report.drag.rect.top)<1,'Committed coordinates do not match final panel');
 if(revision==='current'){
  assert(report.drag.initial.left===report.drag.original.left&&report.drag.initial.top===report.drag.original.top,'Pointer press jumped the panel');
  assert(report.drag.countsDuring.transform>0&&report.drag.countsDuring.transform<=153,'Drag did not coalesce to one transform per requested frame');
  assert(report.drag.countsDuring.left<=1&&report.drag.countsDuring.top<=1&&report.drag.countsDuring.topVariable<=1,'Drag still writes layout coordinates per frame');
  assert(report.drag.countsDuring.maps===0,'Glass map was regenerated while dragging');
  assert(!report.drag.dragging&&!report.drag.transform&&!report.drag.willChange,'Drag left interactive state or compositing hints behind');
 }
 report.checks.push('1200-mouse-inputs-150-frames-500-live-logs-persist-only-on-release');
 const motionBefore=await metrics();
 report.motion=await ui(`(async()=>{const m=__motion;m.begin();const captured=[];const inspect=()=>{for(const a of m.root.querySelector('.el-card').getAnimations({subtree:true})){const frames=a.effect.getKeyframes();captured.push({kind:a.constructor.name,target:a.effect.target?.className,transitionProperty:a.transitionProperty||null,duration:a.effect.getTiming().duration,properties:[...new Set(frames.flatMap(f=>Object.keys(f).filter(k=>!['offset','computedOffset','easing','composite'].includes(k))))]});}applicationPeak=Math.max(applicationPeak,m.root.querySelector('.el-card').getAnimations({subtree:true}).filter(a=>a.constructor.name==='Animation'&&a.playState==='running').length);};let peak=0,applicationPeak=0;for(let i=0;i<16;i++){m.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();await new Promise(requestAnimationFrame);inspect();peak=Math.max(peak,m.root.querySelector('.el-card').getAnimations({subtree:true}).length);await new Promise(r=>setTimeout(r,25));}for(let i=0;i<12;i++){const tab=m.root.querySelector('#tab-'+(i%3));tab.click();await Vue.nextTick();await new Promise(requestAnimationFrame);inspect();peak=Math.max(peak,m.root.querySelector('.el-card').getAnimations({subtree:true}).length);await new Promise(r=>setTimeout(r,25));}m.config.menuIndex='0';m.config.isMinus=false;await Vue.nextTick();await new Promise(r=>setTimeout(r,350));const remainingAnimations=m.root.querySelector('.el-card').getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({kind:a.constructor.name,target:a.effect.target?.className,transitionProperty:a.transitionProperty||null,duration:a.effect.getTiming().duration}));const remaining=remainingAnimations.length;return{...m.finish(),captured,peak,applicationPeak,remaining,remainingAnimations,motionAttribute:m.panel.dataset.aiMotion||null};})()`);
 report.motion.performance=difference(motionBefore,await metrics());
 assert(report.motion.remaining===0,'Interrupted animations remained active after settling');
 assert(report.motion.captured.length>0,'No real animations were sampled');
 assert(report.motion.captured.filter(a=>a.kind==='Animation').every(a=>a.properties.every(p=>['transform','opacity'].includes(p))),'Application motion changed a layout or filter property');
 if(revision==='current'){assert(report.motion.applicationPeak<=1,'Application motion accumulated on interrupted targets');assert(report.motion.captured.every(a=>!a.properties.some(p=>/filter|height|width|left|top/i.test(p))),'A CSS transition interpolated a filter/layout property');assert(!report.motion.motionAttribute,'Motion flag remained set');}
 report.checks.push('rapid-toggle-and-tab-interruptions-use-only-transform-opacity-and-settle');
 await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 report.reducedMotion=await ui(`(async()=>{const m=__motion;m.animationCalls=[];m.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();const animations=m.root.querySelector('.el-card').getAnimations({subtree:true}).map(a=>({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes()}));await new Promise(r=>setTimeout(r,180));m.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,180));return{matches:matchMedia('(prefers-reduced-motion:reduce)').matches,animations,calls:m.animationCalls};})()`);
 assert(report.reducedMotion.calls.length>=1&&report.reducedMotion.calls.every(a=>a.options.duration<=120&&a.frames.every(f=>!f.transform||f.transform==='none')),'Reduced motion native animate calls did not use short opacity-only frames');
 assert(report.reducedMotion.matches&&report.reducedMotion.animations.every(a=>a.duration<=120&&a.frames.every(f=>!f.transform||f.transform==='none'||f.transform==='translateY(0px)')),'Reduced motion still uses spatial travel or long animation');
 await page.call('Emulation.setEmulatedMedia',{features:[]});report.checks.push('reduced-motion-uses-no-spatial-travel');
 if(revision==='current'){
  // Real trusted mouse input exercises PointerEvent capture and the compatibility mouse path.
  const nativeStart=await ui(`(()=>{const h=__motion.root.querySelector('.card-header'),b=h.getBoundingClientRect();__motion.nativeInitial={...__motion.config.position};__motion.pointerTrace=[];h.addEventListener('pointerdown',e=>{__motion.lastPointer=e.pointerId;__motion.pointerTrace.push({type:e.type,pointerType:e.pointerType,isTrusted:e.isTrusted});});return{x:b.left+80,y:b.top+16};})()`);
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...nativeStart});await page.call('Input.dispatchMouseEvent',{type:'mousePressed',...nativeStart,button:'left',clickCount:1});
  const captured=await ui(`__motion.root.querySelector('.card-header').hasPointerCapture(__motion.lastPointer)`);
  for(let i=1;i<=15;i++){await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:nativeStart.x+i*4,y:nativeStart.y+i*2,button:'left',buttons:1});}
  await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:nativeStart.x+60,y:nativeStart.y+30,button:'left',clickCount:1});await wait(100);
  report.nativePointer=await ui(`(()=>{const m=__motion,b=m.panel.getBoundingClientRect();return{trace:m.pointerTrace,initial:m.nativeInitial,position:{...m.config.position},rect:{left:b.left,top:b.top},dragging:m.panel.dataset.aiDragging||null,transform:m.panel.style.transform};})()`);report.nativePointer.captured=captured;
  assert(Math.abs(parseFloat(report.nativePointer.position.x)-parseFloat(report.nativePointer.initial.x)-60)<1&&Math.abs(parseFloat(report.nativePointer.position.y)-parseFloat(report.nativePointer.initial.y)-30)<1,'Native last pending input was not committed');
  assert(captured&&report.nativePointer.trace[0]?.isTrusted&&!report.nativePointer.dragging&&!report.nativePointer.transform,'Native pointer capture/release failed');
  // A second pointer must not move or end an existing single-pointer drag.
  report.pointerIsolation=await ui(`(async()=>{const m=__motion,h=m.root.querySelector('.card-header'),b=h.getBoundingClientRect(),x=b.left+80,y=b.top+16;h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:710,pointerType:'touch',isPrimary:true,button:0,clientX:x,clientY:y}));document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:711,pointerType:'touch',isPrimary:false,buttons:1,clientX:x+300,clientY:y+300}));await new Promise(requestAnimationFrame);const wrongPointerTransform=m.panel.style.transform;document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:711,pointerType:'touch'}));const kept=m.panel.dataset.aiDragging==='true';document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:710,pointerType:'touch',isPrimary:true,buttons:1,clientX:x+20,clientY:y+10}));window.dispatchEvent(new Event('blur'));await Vue.nextTick();await new Promise(r=>setTimeout(r,100));return{wrongPointerTransform,kept,afterBlur:m.panel.dataset.aiDragging||null,transform:m.panel.style.transform};})()`);
  assert(!report.pointerIsolation.wrongPointerTransform&&report.pointerIsolation.kept&&!report.pointerIsolation.afterBlur&&!report.pointerIsolation.transform,'Pointer identity or blur cleanup failed');
  report.checks.push('trusted-pointer-capture-release-foreign-pointer-ignored-blur-flush');
  await page.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  const touchStart=await ui(`(()=>{__motion.touchInitial={...__motion.config.position};const b=__motion.root.querySelector('.card-header').getBoundingClientRect();return{x:b.left+70,y:b.top+16};})()`);
  await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchStart,id:1}]});
  for(let i=1;i<=8;i++)await page.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchStart.x+i*6,y:touchStart.y+i*3,id:1}]});
  await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(150);
  report.touch=await ui(`({initial:__motion.touchInitial,trace:__motion.pointerTrace,dragging:__motion.panel.dataset.aiDragging||null,transform:__motion.panel.style.transform,position:{...__motion.config.position}})`);
  assert(Math.abs(parseFloat(report.touch.position.x)-parseFloat(report.touch.initial.x)-48)<1&&Math.abs(parseFloat(report.touch.position.y)-parseFloat(report.touch.initial.y)-24)<1,'Trusted touch gesture was canceled or final position lost');
  assert(report.touch.trace.some(t=>t.pointerType==='touch'&&t.isTrusted)&&!report.touch.dragging&&!report.touch.transform,'Emulated touch drag did not clean up');
  await page.call('Emulation.setTouchEmulationEnabled',{enabled:false});report.checks.push('trusted-cdp-touch-emulation-drags-and-cleans-up');
  // Toggle is a real interactive target: pressing it must never start a drag.
  const toggle=await ui(`(()=>{const b=__motion.root.querySelector('.ai-panel-toggle').getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2,position:{...__motion.config.position}};})()`);
  await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:toggle.x,y:toggle.y,button:'left',clickCount:1});
  const toggleDragging=await ui(`__motion.panel.dataset.aiDragging==='true'`);
  await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:toggle.x,y:toggle.y,button:'left',clickCount:1});await wait(220);
  assert(!toggleDragging,'Toggle pointer press started dragging');
  await ui(`(async()=>{__motion.config.isMinus=false;await Vue.nextTick();await new Promise(r=>setTimeout(r,250));})()`);
  const saved=await ui(`({...__motion.config.position})`);
  await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?restored'});await discover();
  const restored=await ui(`({...__motion.config.position})`);assert(saved.x===restored.x&&saved.y===restored.y,'Final native drag position did not survive navigation');
  report.persistence={saved,restored};report.checks.push('toggle-does-not-drag-final-coordinates-survive-real-navigation');
 }
 await ui(`(async()=>{__motion.config.menuIndex='0';__motion.config.isMinus=false;__motion.logs.clearLogs();__motion.logs.addLog('本地测试：课程任务已完成，等待进入下一节','success');__motion.logs.addLog('动画与日志检查完成，未发送任何模型请求','info');await Vue.nextTick();await new Promise(r=>setTimeout(r,450));})()`);
 await shot('motion-'+revision+'-desktop');
 if(revision==='current'){
  await page.call('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:false});await wait(150);
  report.narrow=await ui(`(async()=>{const m=__motion,h=m.root.querySelector('.card-header'),b=h.getBoundingClientRect(),start={x:b.left+80,y:b.top+16};h.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:start.x,clientY:start.y}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:9000,clientY:9000}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));await Vue.nextTick();await new Promise(r=>setTimeout(r,150));const after=m.root.querySelector('.main-page').getBoundingClientRect();return{viewport:[innerWidth,innerHeight],rect:{left:after.left,top:after.top,width:after.width,right:after.right},position:{...m.config.position}};})()`);
  assert(report.narrow.viewport[0]===320&&report.narrow.rect.left>=0&&report.narrow.rect.right<=320&&report.narrow.rect.top<=612,'320px drag boundary failed');
  await ui(`(async()=>{__motion.config.position.x='8px';__motion.config.position.y='50px';window.dispatchEvent(new Event('resize'));await Vue.nextTick();await new Promise(r=>setTimeout(r,200));})()`);await shot('motion-current-320');report.checks.push('actual-320px-viewport-drag-boundaries');
 }
 report.errors=page.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
 assert(!report.errors.length,'Runtime exception: '+JSON.stringify(report.errors));
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{await shot('motion-'+revision+'-failure');}catch{}}
console.log(JSON.stringify(report));try{await page?.call('Browser.close');}catch{}page?.close();
'''


def build_baseline():
    destination = FIXTURE / ("baseline-" + BASELINE[:12])
    if not (destination / "dist" / "ai-course-helper-extension" / "manifest.json").exists():
        archive = subprocess.run(["git", "archive", "--format=tar", BASELINE], cwd=ROOT,
                                 capture_output=True, check=True).stdout
        destination.mkdir(exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            target = destination.resolve()
            for member in bundle.getmembers():
                if not (target / member.name).resolve().is_relative_to(target):
                    raise ValueError("Baseline archive escaped fixture directory")
            bundle.extractall(destination, filter="data")
        subprocess.run([sys.executable, "build_extension.py"], cwd=destination, check=True,
                       capture_output=True, timeout=60)
    return destination / "dist" / "ai-course-helper-extension"


def run_browser(extension, revision, host):
    content_hash = hashlib.sha256((extension / "content.js").read_bytes()).hexdigest().upper()
    with tempfile.TemporaryDirectory(prefix=revision + "-", dir=PROFILES) as profile:
        port_file = Path(profile) / "DevToolsActivePort"
        browser = subprocess.Popen([
            str(EDGE), "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--no-proxy-server", "--user-data-dir=" + profile,
            "--remote-debugging-port=0", "--load-extension=" + str(extension),
            "--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1", "--window-size=1280,900", "about:blank"
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    debug_port = int(port_file.read_text().splitlines()[0])
                    with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=1) as response:
                        targets = json.load(response)
                    if any(t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js") for t in targets):
                        break
                except (OSError, ValueError, IndexError):
                    pass
                time.sleep(.05)
            else:
                raise RuntimeError("Extension service worker did not load")
            result = subprocess.run(["node", "--input-type=module", "-e", RUNNER, str(debug_port), str(ROOT), host, revision],
                                    capture_output=True, text=True, encoding="utf-8", timeout=100)
            if result.returncode:
                raise RuntimeError(result.stderr[-6000:])
            report = json.loads(result.stdout)
            report["version"] = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))["version"]
            report["contentSha256"] = content_hash
            archive = extension.parent / ('ai-course-helper-extension-' + report['version'] + '.zip')
            report["packageSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
            assert content_hash == hashlib.sha256((extension / "content.js").read_bytes()).hexdigest().upper(), "Build changed while measuring"
            return report
        finally:
            if browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    browser.kill()
            # Edge sometimes releases profile files asynchronously on Windows.
            time.sleep(.7)


def main():
    baseline = build_baseline()
    current = ROOT / "dist" / "ai-course-helper-extension"
    baseline_only = "--baseline-only" in sys.argv[1:]
    if not baseline_only:
        assert json.loads((current / "manifest.json").read_text(encoding="utf-8"))["version"] == "0.9.4", "Build 0.9.4 first"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    output = {"baselineCommit": BASELINE, "measurementNotes": [
        "Real unpacked MV3 extension with native Chrome storage; no GM layer or real AI requests.",
        "Both revisions run the same 1280px complex course background, 500 stored logs, 40 simulated question statuses and 25 identical background updates.",
        "Edge headless with --disable-gpu; software rendering and host load affect frame timing.",
        "The physical display refresh rate is unavailable in this headless test; rAF cadence is measured, not inferred.",
        "Timing is observational; deterministic assertions use input semantics and bounded work counts.",
        "CDP trusted touch emulation does not replace a physical touchscreen/device test."
    ], "revisions": []}
    try:
        host = f"http://mooc1.chaoxing.com:{server.server_port}"
        output["revisions"].append(run_browser(baseline, "baseline", host))
        if not baseline_only:
            output["revisions"].append(run_browser(current, "current", host))
        output["network"] = network
        output["passed"] = all(r.get("passed") for r in output["revisions"]) and not network
    finally:
        server.shutdown()
    path = FIXTURE / "baseline-report.json" if baseline_only else ROOT / "tests" / "verification-0.9.4-motion-browser.log"
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({'passed':output['passed'],'revisions':[{'revision':r['revision'],'passed':r.get('passed'),'error':r.get('error'),'drag':r.get('drag',{}),'motionSummary':{k:r.get('motion',{}).get(k) for k in ['peak','applicationPeak','remaining']}} for r in output['revisions']],'report':str(path)},ensure_ascii=False))
    assert output["passed"], f"Motion browser verification failed; see {path}"


if __name__ == "__main__":
    main()
