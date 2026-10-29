"""Verify continuous panel shape and stable glass in the real 0.9.5 extension.

The isolated-world hooks below only observe real DOM/native Web Animations.
No userscript shim, page-world extension privileges, or model requests.
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
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "dist" / "ai-course-helper-extension"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
PROFILES = ROOT / "tests" / ".stability-profile"
PROFILES.mkdir(exist_ok=True)


def literal(filename, name):
    tree = ast.parse((ROOT / "tests" / filename).read_text(encoding="utf-8"))
    return next(n.value.value for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == name for t in n.targets))


background = literal("redesign-panel-browser.py", "background")
PAGE = ('<!doctype html><html><head><meta charset="utf-8"><title>Panel stability fixture</title>'
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">'
        '</head><body>' + background + '</body></html>').encode()
network = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        page = self.path.startswith("/mooc2/work/dowork")
        if not page and not self.path.startswith("/favicon.ico"):
            network.append({"method": "GET", "path": self.path})
        data = PAGE if page else b""
        self.send_response(200 if page else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        network.append({"method": "POST", "path": self.path})
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()


transport = literal("extension-browser.py", "RUNNER")
RUNNER = transport[:transport.index("const debugPort=")] + r'''
const debugPort=process.argv[1],root=process.argv[2],host=process.argv[3],geometryOnly=process.argv[4]==='geometry-only';
const report={realExtension:true,headless:true,gpuDisabled:true,physicalDisplayRefreshRate:null,checks:[],viewports:[],screenshots:[],frameSequences:[]};
let page,isolated,recording=null;
const assert=(value,message)=>{if(!value)throw Error(message);};
const poll=async(test,label,attempts=200)=>{for(let i=0;i<attempts;i++){try{const value=await test();if(value)return value;}catch{}await wait(40);}throw Error('Timed out: '+label);};
const ui=expression=>page.evaluate(expression,isolated);
const metrics=async()=>Object.fromEntries((await page.call('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const metricDifference=(a,b)=>Object.fromEntries(['LayoutCount','RecalcStyleCount','TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].map(k=>[k,Math.round((b[k]-a[k])*1e6)/1e6]));
const frameTiming=samples=>{const sorted=samples.slice(1).map((s,i)=>s.frameTime-samples[i].frameTime).filter(Number.isFinite).sort((a,b)=>a-b);return{intervals:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)]||0,p95Ms:sorted[Math.floor(sorted.length*.95)]||0,maxMs:sorted.at(-1)||0,over33ms:sorted.filter(x=>x>33.3).length,observationalOnly:true};};
const shot=async name=>{const result=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(root+'/tests/'+name+'.png',Buffer.from(result.data,'base64'));report.screenshots.push(name+'.png');};
const startFrames=async name=>{const rect=await ui(`(()=>{const b=__stability.root.querySelector('.ai-glass-surface').getBoundingClientRect();return{left:b.left,top:b.top,width:b.width,height:b.height};})()`);recording={name,rect,frames:[]};await page.call('Page.startScreencast',{format:'png',maxWidth:1280,maxHeight:900,everyNthFrame:1});await wait(80);};
const stopFrames=async()=>{await wait(100);await page.call('Page.stopScreencast');if(recording)report.frameSequences.push(recording);recording=null;};
const discover=async()=>{
 isolated=await poll(async()=>{for(const c of page.events.filter(e=>e.method==='Runtime.executionContextCreated').map(e=>e.params.context).reverse()){try{if(await page.evaluate('Boolean(globalThis.chrome?.runtime?.id&&globalThis.Vue&&globalThis.Pinia)',c.id))return c.id;}catch{}}},'native extension isolated world');
 await page.call('DOM.enable');await poll(async()=>{const {root:doc}=await page.call('DOM.getDocument',{depth:-1,pierce:true});const collect=n=>[...(n.shadowRoots||[]),...(n.children||[]).flatMap(collect),...(n.contentDocument?collect(n.contentDocument):[])];for(const n of collect(doc).filter(n=>n.shadowRootType)){const object=await page.call('DOM.resolveNode',{nodeId:n.nodeId,executionContextId:isolated});const result=await page.call('Runtime.callFunctionOn',{objectId:object.object.objectId,functionDeclaration:`function(){const mount=[...this.querySelectorAll('div')].find(n=>n.__vue_app__),stores=mount?.__vue_app__?.config.globalProperties.$pinia?._s;if(!stores||!this.querySelector('.ai-config'))return false;globalThis.__stability={root:this,config:stores.get('configStore'),logs:stores.get('logStore')};return !!__stability.config;}`,returnByValue:true});if(result.result?.value)return true;}},'closed shadow panel');
 await ui(`(()=>{const s=__stability;s.rectCalls=[];s.tracingRects=false;const nativeRect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(...args){const value=Reflect.apply(nativeRect,this,args);if(s.tracingRects&&this.getRootNode()===s.root&&this.matches('.ai-glass-surface,.el-card__body')){const stack=new Error().stack.split(String.fromCharCode(10)).slice(1,5);if(stack.some(line=>line.includes('at height (')))s.rectCalls.push({target:this.className,height:value.height,collapsed:s.config.isMinus,domCollapsed:s.root.querySelector('.main-page')?.dataset.collapsed,stack});};return value;};s.animationCalls=[];const nativeAnimate=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.getRootNode()===s.root)s.animationCalls.push({target:this.className,frames:JSON.parse(JSON.stringify(frames)),options});return Reflect.apply(nativeAnimate,this,[frames,options]);};s.ids=new WeakMap();s.nextId=0;s.hrefs=new Map();s.id=node=>{if(!node)return null;if(!s.ids.has(node))s.ids.set(node,++s.nextId);return s.ids.get(node);};s.sample=()=>{const panel=s.root.querySelector('.main-page'),card=panel.querySelector('.el-card'),surface=panel.querySelector('.ai-glass-surface'),content=panel.querySelector('.ai-panel-content'),style=getComputedStyle(surface),rim=getComputedStyle(surface,'::before'),rect=surface.getBoundingClientRect(),image=s.root.querySelector('feImage'),href=image?.getAttribute('href')||image?.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';if(href&&!s.hrefs.has(href))s.hrefs.set(href,s.hrefs.size+1);let visibleHeight=rect.height;const match=style.clipPath.match(/^inset\((.+)\)$/);if(match){const values=match[1].split(/\s+round\s+/)[0].split(/\s+/).slice(0,4),top=values[0],bottom=values[2]||values[0],amount=value=>value?.endsWith('%')?parseFloat(value)*rect.height/100:parseFloat(value)||0;visibleHeight=Math.max(0,rect.height-amount(top)-amount(bottom));}const body=card.querySelector('.el-card__body'),bodyRect=body.getBoundingClientRect();return{time:performance.now(),bodyRect:{top:bodyRect.top,bottom:bodyRect.bottom,height:bodyRect.height},bodyOverflow:getComputedStyle(body).overflow,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},visibleHeight,transform:style.transform,clipPath:style.clipPath,contentDisplay:content?getComputedStyle(content).display:null,contentInert:content?.inert||false,collapsed:s.config.isMinus,filter:style.backdropFilter,rimFilter:rim.backdropFilter,rimDisplay:rim.display,rimOpacity:rim.opacity,cardId:s.id(card),surfaceId:s.id(surface),bodyTransform:getComputedStyle(card.querySelector('.el-card__body')).transform,innerTransform:getComputedStyle(card.querySelector('.ai-body-content')).transform,imageId:s.id(image),hrefId:href?s.hrefs.get(href):null,hrefLength:href.length,imageWidth:image?.getAttribute('width'),imageHeight:image?.getAttribute('height'),motion:panel.dataset.aiMotion||null};};s.settled=()=>{const panel=s.root.querySelector('.main-page'),card=panel.querySelector('.el-card');return{...s.sample(),running:card.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({kind:a.constructor.name,target:a.effect.target?.className,keyframes:a.effect.getKeyframes()})),inline:{height:card.style.height,transform:card.style.transform,willChange:card.style.willChange,overflow:card.style.overflow,surfaceHeight:panel.querySelector('.ai-glass-surface').style.height,surfaceWillChange:panel.querySelector('.ai-glass-surface').style.willChange,surfaceTransform:panel.querySelector('.ai-glass-surface').style.transform,bodyHeight:card.querySelector('.el-card__body').style.height,bodyTransform:card.querySelector('.el-card__body').style.transform,innerTransform:card.querySelector('.ai-body-content').style.transform},ariaExpanded:panel.querySelector('.ai-panel-toggle').getAttribute('aria-expanded')};};s.capture=async(action,duration=520)=>{const rows=[s.sample()],callStart=s.animationCalls.length,rectStart=s.rectCalls.length;s.tracingRects=true;action();await Vue.nextTick();const start=performance.now();while(performance.now()-start<duration){const frameTime=await new Promise(requestAnimationFrame);rows.push({...s.sample(),frameTime});}s.tracingRects=false;return{samples:rows,final:s.settled(),animations:s.animationCalls.slice(callStart),geometryCalls:s.rectCalls.slice(rectStart)};};})()`);
};
const shapeAssertion=(result,collapsed,label)=>{const values=result.samples.map(s=>s.visibleHeight),a=values[0],b=values.at(-1),lo=Math.min(a,b),hi=Math.max(a,b),middle=[...new Set(values.filter(v=>v>lo+2&&v<hi-2).map(v=>Math.round(v)))];assert(hi-lo>35,label+': shape did not change enough');assert(middle.length>=2,label+': no continuous visible outer shape, only endpoint/fade');assert(result.final.collapsed===collapsed&&result.final.running.length===0&&!result.final.motion,label+': final animation state did not settle');assert(result.final.ariaExpanded===String(!collapsed),label+': ARIA state is stale');return{start:a,end:b,intermediateHeights:middle};};
const glassAssertion=(samples,label)=>{if(geometryOnly)return{preliminaryGeometryRun:true};for(const key of ['filter','rimFilter','rimDisplay','rimOpacity','cardId','surfaceId','imageId','hrefId','hrefLength']){const values=[...new Set(samples.map(s=>s[key]))];assert(values.length===1,label+': glass '+key+' changed: '+JSON.stringify(values));}assert(samples[0].filter.includes('blur(')&&samples[0].rimDisplay!=='none',label+': glass or rim disappeared');return{samples:samples.length,filter:samples[0].filter,rimFilter:samples[0].rimFilter,rimDisplay:samples[0].rimDisplay,hrefId:samples[0].hrefId,hrefLength:samples[0].hrefLength};};
try{
 const list=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();page=new CDP(list.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);
 await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Network.enable');await page.call('Performance.enable');
 page.listeners.push(event=>{if(event.method!=='Page.screencastFrame')return;const p=event.params;if(recording&&recording.frames.length<28){const filename=recording.name+'-frame-'+String(recording.frames.length).padStart(3,'0')+'.png';fs.writeFileSync(root+'/tests/'+filename,Buffer.from(p.data,'base64'));recording.frames.push({filename,timestamp:p.metadata.timestamp});}void page.call('Page.screencastFrameAck',{sessionId:p.sessionId});});
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await page.call('Page.navigate',{url:host+'/mooc2/work/dowork?stability'});await discover();await wait(5600);
 report.environment=await page.evaluate(`(()=>{const gl=document.createElement('canvas').getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return{userAgent:navigator.userAgent,devicePixelRatio,screen:[screen.width,screen.height],webglRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};})()`);
 await ui(`(async()=>{const s=__stability;s.config.menuIndex='0';s.config.isMinus=false;s.logs.clearLogs();for(let i=0;i<80;i++)s.logs.addLog('真实浏览器形状与玻璃稳定性检查 '+i,'info');await Vue.nextTick();await new Promise(r=>setTimeout(r,500));})()`);
 const initial=await ui('__stability.sample()');
 assert(geometryOnly||(initial.hrefId!==null&&initial.rimFilter.includes('url(')&&initial.imageWidth==='100%'&&initial.imageHeight==='100%'),'SVG rim image/filter was not initialized with percentage geometry; this Edge run cannot test href stability');
 for(const width of [1280,320]){
  if(width===320){await page.call('Emulation.setDeviceMetricsOverride',{width:320,height:760,deviceScaleFactor:1,mobile:false});await wait(400);}
  const view={width,viewport:await page.evaluate('[innerWidth,innerHeight]')};report.viewports.push(view);
  await ui(`(async()=>{__stability.config.menuIndex='0';__stability.config.isMinus=false;await Vue.nextTick();await new Promise(r=>setTimeout(r,350));})()`);
  await startFrames('stability-'+width+'-collapse');const collapseBefore=await metrics();
  view.collapse=await ui(`__stability.capture(()=>__stability.root.querySelector('.ai-panel-toggle').click())`);
  await stopFrames();view.collapse.performance=metricDifference(collapseBefore,await metrics());view.collapse.timing=frameTiming(view.collapse.samples);view.collapse.activeTiming=frameTiming(view.collapse.samples.filter(s=>s.motion));view.collapseShape=shapeAssertion(view.collapse,true,width+' collapse');
  view.collapseGlass=glassAssertion(view.collapse.samples,width+' collapse');const scaleY=t=>t==='none'?1:Number(t.slice(t.indexOf('(')+1,-1).split(',')[t.startsWith('matrix3d')?5:3]);view.inverseScaleError=Math.max(...view.collapse.samples.map(s=>Math.abs(scaleY(s.bodyTransform)*scaleY(s.innerTransform)-1)));assert(view.inverseScaleError<.04,width+': inverse body scaling visibly stretches text');assert(view.collapse.samples.every(s=>s.bodyTransform==='none'&&s.innerTransform==='none'),width+': content still relies on independently composited scale');
  await startFrames('stability-'+width+'-expand');const expandBefore=await metrics();
  view.expand=await ui(`__stability.capture(()=>__stability.root.querySelector('.ai-panel-toggle').click())`);
  await stopFrames();view.expand.performance=metricDifference(expandBefore,await metrics());view.expand.timing=frameTiming(view.expand.samples);view.expand.activeTiming=frameTiming(view.expand.samples.filter(s=>s.motion));view.expandShape=shapeAssertion(view.expand,false,width+' expand');view.expandBodyOverflow=Math.max(...view.expand.samples.map(s=>s.bodyRect.bottom-s.rect.top-s.visibleHeight));assert(view.expandBodyOverflow<2,width+': content viewport exceeds shell bottom');assert(view.expand.samples.every(s=>s.bodyTransform==='none'&&s.innerTransform==='none'),width+': opening still scales text');view.expandGlass=glassAssertion(view.expand.samples,width+' expand');
  view.reverse=await ui(`(async()=>{const s=__stability,rows=[s.sample()];for(let i=0;i<8;i++){s.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();for(let f=0;f<2;f++){await new Promise(requestAnimationFrame);rows.push(s.sample());}}await new Promise(r=>setTimeout(r,420));return{samples:rows,final:s.settled()};})()`);
  assert(!view.reverse.final.collapsed&&view.reverse.final.running.length===0&&!view.reverse.final.motion,width+': rapid reversal did not settle');
  assert(!view.reverse.final.inline.height&&!view.reverse.final.inline.transform&&!view.reverse.final.inline.willChange&&!view.reverse.final.inline.bodyHeight&&!view.reverse.final.inline.surfaceHeight&&!view.reverse.final.inline.surfaceWillChange&&!view.reverse.final.inline.surfaceTransform&&!view.reverse.final.inline.bodyTransform&&!view.reverse.final.inline.innerTransform,width+': shape animation left permanent inline state');
  await startFrames('stability-'+width+'-tabs');
  view.tabs=await ui(`(async()=>{const s=__stability,rows=[s.sample()];for(const tab of [1,2,3,4,0,2,1,0]){s.root.querySelector('#tab-'+tab).click();await Vue.nextTick();for(let i=0;i<5;i++){await new Promise(requestAnimationFrame);rows.push(s.sample());}}await new Promise(r=>setTimeout(r,400));rows.push(s.sample());return{samples:rows,final:s.settled()};})()`);
  await stopFrames();view.tabGlass=glassAssertion(view.tabs.samples,width+' tab sweep');
  assert(view.tabs.final.running.length===0&&!view.tabs.final.motion,width+': tab animations did not settle');
  // The final native controls must remain focusable/clickable after interruptions.
  view.interactive=await ui(`(async()=>{const s=__stability;s.root.querySelector('#tab-1').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,250));const input=s.root.querySelector('input[type="password"]');input.focus();const focused=s.root.activeElement===input,rect=input.getBoundingClientRect();const inside=rect.width>0&&rect.height>0;s.root.querySelector('#tab-0').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,250));return{focused,inside,contentInert:s.root.querySelector('.ai-panel-content').inert};})()`);
  assert(view.interactive.focused&&view.interactive.inside&&!view.interactive.contentInert,width+': interrupted panel controls are not usable');
  const current=await ui('__stability.sample()');assert(geometryOnly||(current.hrefId===initial.hrefId&&current.hrefLength===initial.hrefLength),'SVG image changed after a viewport resize');
  await shot('stability-'+width+'-expanded');
 }
 report.checks.push('desktop-and-320-real-visible-shell-intermediate-heights','rapid-reversal-returns-controls-to-interactive-state','same-glass-filter-rim-and-SVG-image-across-tabs-shape-and-viewport-resize');
 await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 report.reduce=await ui(`(async()=>{const s=__stability,records=[],original=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.getRootNode()===s.root)records.push({target:this.className,frames:JSON.parse(JSON.stringify(frames)),options});return Reflect.apply(original,this,[frames,options]);};s.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,180));s.root.querySelector('.ai-panel-toggle').click();await Vue.nextTick();await new Promise(r=>setTimeout(r,180));Element.prototype.animate=original;return{records,final:s.settled()};})()`);
 assert(report.reduce.records.every(a=>(a.options?.duration||0)<=120&&a.frames.every(f=>!f.transform||f.transform==='none')),'Reduced motion retained a shape/spatial animation');
 assert(!report.reduce.final.collapsed&&!report.reduce.final.motion&&report.reduce.final.running.length===0,'Reduced-motion mode failed to settle');
 await page.call('Emulation.setEmulatedMedia',{features:[]});
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await wait(350);
 await page.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
 const touch=await ui(`(()=>{const s=__stability,b=s.root.querySelector('.card-header').getBoundingClientRect();s.touchBefore={...s.config.position};return{x:b.left+75,y:b.top+18};})()`);
 await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touch,id:1}]});for(let i=1;i<=8;i++)await page.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touch.x+i*6,y:touch.y+i*3,id:1}]});await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(200);
 report.touch=await ui(`({before:__stability.touchBefore,after:{...__stability.config.position},dragging:__stability.root.querySelector('.main-page').dataset.aiDragging||null})`);
 assert(Math.abs(parseFloat(report.touch.after.x)-parseFloat(report.touch.before.x)-48)<1&&Math.abs(parseFloat(report.touch.after.y)-parseFloat(report.touch.before.y)-24)<1&&!report.touch.dragging,'Trusted touch movement or release regressed');
 await page.call('Emulation.setTouchEmulationEnabled',{enabled:false});report.checks.push('reduced-motion-and-trusted-touch-emulation');
 report.modelRequests=page.events.filter(e=>e.method==='Network.requestWillBeSent'&&/api\.openai\.com|api\.deepseek\.com/.test(e.params.request.url)).map(e=>e.params.request.url);assert(!report.modelRequests.length,'Unexpected real model traffic');
 report.errors=page.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);assert(!report.errors.length,'Runtime exceptions: '+JSON.stringify(report.errors));report.passed=true;
}catch(error){report.passed=false;report.error=String(error);report.stack=error.stack;try{await stopFrames();await shot('stability-failure');}catch{}}
console.log(JSON.stringify(report));try{await page?.call('Browser.close');}catch{}page?.close();
'''


def analyze_pixels(sequence):
    """Observe stable header shell pixels, outside the changing tab contents."""
    from PIL import Image, ImageChops, ImageStat
    rect = sequence["rect"]
    x, y = round(rect["left"] + 4), round(rect["top"] + 38)
    crop = (x, y, x + 6, y + 14)
    images, stats = [], []
    for frame in sequence["frames"]:
        image = Image.open(ROOT / "tests" / frame["filename"]).convert("RGB")
        region = image.crop(crop)
        images.append(region)
        stats.append({"frame": frame["filename"], "meanRGB": [round(v, 2) for v in ImageStat.Stat(region).mean]})
    deltas = [max(ImageStat.Stat(ImageChops.difference(images[0], image)).mean) for image in images[1:]]
    maximum = max(deltas, default=0)
    sequence["pixelObservation"] = {"roi": list(crop), "reference": "first captured frame", "means": stats,
                                    "maximumMeanChannelDifference": round(maximum, 3),
                                    "stableHeaderEdge": len(images) >= 2 and maximum < 35,
                                    "maximumAllowedMeanChannelDifference": 35,
                                    "note": "This fixed header edge stays visible during every state. Large changes detect a warped corner or disappearing shell in this static fixture; this is not a universal flicker detector."}


def main():
    version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
    assert version == "0.9.5", "Build the 0.9.5 candidate before running this check"
    archive = EXTENSION.parent / f"ai-course-helper-extension-{version}.zip"
    content_hash = hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper()
    package_hash = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    output = None
    with tempfile.TemporaryDirectory(prefix="panel-", dir=PROFILES) as profile:
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
                                     f"http://mooc1.chaoxing.com:{server.server_port}", 'geometry-only' if '--geometry-only' in sys.argv else 'final'], capture_output=True, text=True,
                                    encoding="utf-8", timeout=100)
            if result.returncode:
                raise RuntimeError(result.stderr[-6000:])
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
    assert '--geometry-only' in sys.argv or content_hash == hashlib.sha256((EXTENSION / "content.js").read_bytes()).hexdigest().upper(), "Candidate changed during browser run"
    assert '--geometry-only' in sys.argv or package_hash == hashlib.sha256(archive.read_bytes()).hexdigest().upper(), "Package changed during browser run"
    output.update({"version": version, "contentSha256": content_hash, "packageSha256": package_hash,
                   "fixtureNetwork": network, "limitations": [
                       "Real Edge headless with --disable-gpu and software ANGLE; results do not guarantee a physical device refresh rate.",
                       "rAF geometry samples prove intermediate shell shapes; timing is observed and has no FPS pass threshold.",
                       "Screencast PNGs and header-edge pixel differences supplement deterministic filter/image stability checks.",
                       "Trusted CDP touch emulation is not a physical touchscreen device test."
                   ]})
    output["behaviorPassed"] = output.get("passed", False)
    for sequence in output.get("frameSequences", []):
        analyze_pixels(sequence)
    if output.get("passed") and not all(s["pixelObservation"]["stableHeaderEdge"] for s in output.get("frameSequences", [])):
        output["passed"] = False
        output["error"] = "The fixed header edge changed excessively in rendered frames (corner/shell distortion)"
    output["passed"] = output.get("passed", False) and not network
    log = ROOT / "tests" / "verification-0.9.5-browser.log"
    if "--geometry-only" in sys.argv:
        log = ROOT / "tests" / "browser-fixture" / "stability" / "geometry-report.json"
        log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": output["passed"], "error": output.get("error"), "checks": output["checks"],
                      "shapes": [{"width": v["width"], "collapse": v.get("collapseShape"), "expand": v.get("expandShape")} for v in output["viewports"]],
                      "frameCounts": [len(s["frames"]) for s in output["frameSequences"]], "report": str(log)}, ensure_ascii=False))
    assert output["passed"], f"Panel stability verification failed; see {log}"


if __name__ == "__main__":
    main()
