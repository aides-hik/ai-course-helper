"""Independent offline review of native image loading, resizing and solver receipts."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import html
import json
import re
import struct
import subprocess
import threading
import time
import zlib

ROOT = Path(__file__).resolve().parent.parent
template = (ROOT / "userscript.template.js.in").read_text(encoding="utf-8")
image_source = (ROOT / "ai-images.js").read_text(encoding="utf-8")
adapter = (ROOT / "ai-endpoints.js").read_text(encoding="utf-8") + "\n" + (ROOT / "ai-adapter.js").read_text(encoding="utf-8")
integration = (ROOT / "ai-integration.js").read_text(encoding="utf-8")
extractors = (ROOT / "text-extraction.js").read_text(encoding="utf-8")


def section(source, start, end):
    first = source.index(start)
    return source[first:source.index(end, first + len(start))]


def png(width, height, quadrants=False, color=(0, 0, 255)):
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content) & 0xFFFFFFFF)

    if quadrants:
        top = bytes((255, 0, 0)) * (width // 2) + bytes((0, 255, 0)) * (width - width // 2)
        bottom = bytes((0, 0, 255)) * (width // 2) + bytes((255, 255, 0)) * (width - width // 2)
        pixels = (b"\0" + top) * (height // 2) + (b"\0" + bottom) * (height - height // 2)
    else:
        pixels = (b"\0" + bytes(color) * width) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


IMAGES = {"/red.png": png(10, 5, color=(255, 0, 0)), "/blue.png": png(10, 5),
          "/green.png": png(10, 5, color=(0, 255, 0)), "/cors-blue.png": png(10, 5),
          "/large.png": png(9000, 450, quadrants=True), "/slow.png": png(10, 5)}
requests = []
page = b""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Set-Cookie", "image-review=fixture; Path=/; SameSite=Strict")
            self.end_headers()
            self.wfile.write(page)
        elif path in IMAGES:
            requests.append({"path": self.path, "port": self.server.server_port,
                             "cookie": self.headers.get("Cookie", ""), "origin": self.headers.get("Origin", ""),
                             "referer": self.headers.get("Referer", "")})
            if path == "/slow.png":
                time.sleep(2)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Vary", "Origin")
            self.end_headers()
            try:
                self.wfile.write(IMAGES[path])
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
        else:
            self.send_response(404)
            self.end_headers()


main_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
cross_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
cross_origin = f"http://127.0.0.1:{cross_server.server_port}"
# Test-only hook: local fixture origins exercise the anonymous public-URL path.
# Production private-network validation remains byte-for-byte unchanged on disk.
image_source = image_source.replace("const aiImagePublicUrl = (url) => {", "const aiImagePublicUrl = (url) => { if(url.hostname === '127.0.0.1') return true;", 1)
common = section(template, "  const isObject = ", "/* @ai-helper:TEXT_EXTRACTORS@ */")
labels = section(template, "  function stripOptionLabel(", "  const VIDEO_QUIZ_INPUTS = ")
cx = section(template, "  class BaseQuestionHandler {", "/* @ai-helper:CHAPTER@ */")
setup = """
const vue={reactive:value=>value},__publicField=(object,key,value)=>{object[key]=value;},_unsafeWindow=window;
const sleep=async()=>{};
const config={ai:{provider:'deepseek',deepseekApiKey:'offline-fixture',deepseekModel:'deepseek-flash',concurrentEnabled:true,concurrency:3},otherParams:{params:[{value:0}]}};
const useConfigStore=()=>config,useLogStore=()=>({addLog(){}}),useQuestionStore=()=>({addQuestion(){}});
const calls=[];
const _GM_xmlhttpRequest=request=>{
  const body=JSON.parse(request.data);calls.push({body,anonymous:request.anonymous,headers:request.headers});
  const answer={answerable:true,choice_indices:[1],text_answers:[],judgement:'unknown',explanation:'offline fixture'};
  queueMicrotask(()=>request.onload({status:200,responseText:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]})}));
  return{abort(){request.onabort?.();}};
};
"""
checks = r"""
(async()=>{try{
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const progress=stage=>{document.querySelector('#review-result').textContent=JSON.stringify({stage});};progress('starting');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const cross=__CROSS__;
  const load=value=>new Promise((resolve,reject)=>{if(value.complete&&value.naturalWidth>0)return resolve(value);value.addEventListener('load',()=>resolve(value),{once:true});value.addEventListener('error',()=>reject(Error('fixture image load failed')),{once:true});});
  const image=async(source,container=document.body)=>{
    const value=new Image();value.src=source;container.append(value);await load(value);return value;
  };
  const entry=(element)=>{
    const root=document.createElement('section');document.body.append(root);root.append(element);
    const title=document.createElement('h3');root.prepend(title);title.append(element);
    const marker='\uFFFC[ai-image:0]\uFFFC';
    return{element:root,title:marker,type:'0',optionsText:['A','B'],options:{},searchText:{stem:marker,options:['A','B'],images:[{marker,label:'题干',element}]}};
  };
  const decoded=async(source)=>{const value=new Image();value.src=source;await load(value);return value;};
  const pixel=async(source,x=0,y=0)=>{const value=await decoded(source),canvas=document.createElement('canvas');canvas.width=value.naturalWidth;canvas.height=value.naturalHeight;const context=canvas.getContext('2d');context.drawImage(value,0,0);return [...context.getImageData(x,y,1,1).data].slice(0,3);};
  const lazy=await image('/red.png');lazy.dataset.src=cross+'/cors-blue.png?lazy=1';
  progress('lazy loaded');
  const lazyQuestion=entry(lazy),lazyContext=createAiQuestionContext(lazyQuestion);
  const before={src:lazy.getAttribute('src'),currentSrc:lazy.currentSrc,crossOrigin:lazy.getAttribute('crossorigin')};
  const lazyResult=await aiCollectQuestionImages(lazyQuestion,{provider:'deepseek',model:'deepseek-flash',signal:lazyContext.signal,isCurrent:lazyContext.isCurrent});
  progress('lazy collected');
  assert(!lazyResult.error&&lazyResult.images[0].url.startsWith('data:image/'),'lazy source must be locally embedded for DeepSeek');
  assert(JSON.stringify(await pixel(lazyResult.images[0].url))==='[0,0,255]','must encode the blue actual lazy source, not the red loaded placeholder');
  assert(before.src===lazy.getAttribute('src')&&before.currentSrc===lazy.currentSrc&&before.crossOrigin===lazy.getAttribute('crossorigin')&&lazyContext.isCurrent(),'collector must leave the original page image and identity unchanged');lazyContext.dispose();

  const tainted=await image(cross+'/cors-blue.png?tainted=1'),taintedQuestion=entry(tainted);
  progress('tainted loaded');
  const taintedSource=tainted.src,taintedResult=await aiCollectQuestionImages(taintedQuestion,{provider:'deepseek',model:'deepseek-flash'});
  assert(!taintedResult.error&&taintedResult.images[0].url.startsWith('data:image/png;base64,'),'tainted loaded image must retry through anonymous CORS and embed');
  assert(tainted.src===taintedSource&&tainted.crossOrigin===null,'original cross-origin page image must remain untouched');

  const large=await image('/large.png'),largeQuestion=entry(large);
  progress('large loaded');
  const resized=await aiCollectQuestionImages(largeQuestion,{provider:'deepseek',model:'deepseek-flash'});
  assert(!resized.error,'large image should be resized, not rejected');
  const resizedImage=await decoded(resized.images[0].url);
  assert(resizedImage.naturalWidth===8192&&Math.abs(resizedImage.naturalHeight-450*8192/9000)<1,'DeepSeek single image must preserve aspect ratio within 8192');
  const corners=[];
  for(const [x,y]of [[0,0],[8191,0],[0,resizedImage.naturalHeight-1],[8191,resizedImage.naturalHeight-1]])corners.push(await pixel(resized.images[0].url,x,y));
  assert(JSON.stringify(corners)==='[[255,0,0],[0,255,0],[0,0,255],[255,255,0]]','resizing must retain all image corners without cropping');
  assert(large.naturalWidth===9000&&large.naturalHeight===450,'resizing must never mutate native image dimensions');

  const small=await image('/blue.png'),manyImages=[large,...Array(14).fill(small)],manyRoot=document.createElement('section');document.body.append(manyRoot);
  const many={element:manyRoot,searchText:{stem:manyImages.map((_,index)=>'\uFFFC[ai-image:'+index+']\uFFFC').join(''),options:[],images:manyImages.map((element,index)=>({marker:'\uFFFC[ai-image:'+index+']\uFFFC',label:'题干',element}))}};
  const manyResult=await aiCollectQuestionImages(many,{provider:'deepseek',model:'deepseek-flash'});
  assert(!manyResult.error&&manyResult.images.length===15,'fifteen image collection should complete');
  const manyLarge=await decoded(manyResult.images[0].url);
  assert(manyLarge.naturalWidth===4096&&Math.abs(manyLarge.naturalHeight-450*4096/9000)<1,'DeepSeek 15 images must apply the 4096 longest-side limit without cropping');

  const pureResults=[];
  for(const concurrent of [false,true]){
    const frame=document.createElement('iframe');document.body.append(frame);const doc=frame.contentDocument;
    const red=new URL('/red.png',location.href).href,blue=new URL('/blue.png',location.href).href,green=new URL('/green.png',location.href).href;
    doc.open();doc.write('<!doctype html><body>'+Array.from({length:3},(_,index)=>'<section class="questionLi"><h3><span class="colorShallow">【单选题】</span>Image '+index+'</h3>'+[blue,green].map((source,choice)=>'<div class="answerBg"><input type="radio" name="q'+index+'"><span class="before">'+String.fromCharCode(65+choice)+'</span><span class="answer_p"><img src="'+red+'" data-src="'+source+'"></span></div>').join('')+'</section>').join(''));doc.close();
    await Promise.all([...doc.images].map(load));
    for(const row of doc.querySelectorAll('.answerBg'))row.addEventListener('click',()=>{for(const input of row.parentElement.querySelectorAll('input'))input.checked=false;row.querySelector('input').checked=true;row.classList.add('check_answer');});
    config.ai.concurrentEnabled=concurrent;config.ai.concurrency=3;const start=calls.length;
    const handler=new CxQuestionHandler('zy',frame);const rate=await handler.init();
    assert(rate===100&&!handler.lastSolveResult.cancelled&&handler.lastSolveResult.verifyFilled(),'pure image choices must complete with live receipts');
    assert([...doc.querySelectorAll('.questionLi')].every(root=>root.querySelectorAll('input')[1].checked),'model choice index 1 must select the second image');
    const emitted=calls.slice(start);assert(emitted.length===3,'each remaining image question needs exactly one model request');
    for(const call of emitted){const content=call.body.messages[1].content;assert(call.body.model==='deepseek-flash'&&call.anonymous===true,'provider/model and anonymous API request must stay correct');assert(content.length===3&&content.slice(1).every(part=>part.image_url.url.startsWith('data:image/png;base64,')),'DeepSeek should receive the actual image pixels for both choices');}
    const first=doc.querySelector('input');first.checked=true;doc.querySelectorAll('input')[1].checked=false;
    assert(!handler.lastSolveResult.verifyFilled(),'receipts must still detect user changes after completion');
    pureResults.push({concurrent,requests:emitted.length,rate});
  }

  config.ai.concurrentEnabled=true;config.ai.concurrency=1;
  const slow=await image('/red.png');slow.dataset.src=cross+'/slow.png?cancel=1';const slowQuestion=entry(slow);
  const fast=entry(await image('/blue.png'));const controller=new AbortController();const beforeCancel=calls.length;
  const cancelStart=performance.now();
  const waiting=getAnswer(slowQuestion,{signal:controller.signal,skipDelay:true});
  const next=getAnswer(fast,{skipDelay:true});
  await pause(50);controller.abort();
  const [cancelled,continued]=await Promise.all([waiting,next]);const cancelMs=performance.now()-cancelStart;
  assert(cancelled.success===false&&continued.success===true,'cancelling image load must release its worker for the next request');
  assert(cancelMs<1500&&calls.length===beforeCancel+1,'cancelled image must never reach the model and must not stall the queue');
  document.querySelector('#review-result').textContent=JSON.stringify({lazyActualPixels:true,originalImageStable:true,anonymousCorsEmbedded:true,
    resized:[resizedImage.naturalWidth,resizedImage.naturalHeight],corners,many:[manyLarge.naturalWidth,manyLarge.naturalHeight],pureResults,cancelMs:Math.round(cancelMs),passed:true});
}catch(error){document.querySelector('#review-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
""".replace("__CROSS__", json.dumps(cross_origin))

page = ('<!doctype html><meta charset="utf-8"><body><pre id="review-result"></pre><script>window.addEventListener("error",event=>{document.querySelector("#review-result").textContent=JSON.stringify({error:event.message,line:event.lineno});});</script><script>' + setup + common + extractors + labels + image_source + adapter + integration + cx + checks + '</script>').encode()
threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (main_server, cross_server)]
for thread in threads:
    thread.start()
try:
    result = subprocess.run([
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--user-data-dir=" + str(ROOT / "tests" / ".images-v052-review-profile"),
        "--virtual-time-budget=180000", "--dump-dom", f"http://127.0.0.1:{main_server.server_port}/"
    ], capture_output=True, text=True, encoding="utf-8", timeout=35)
finally:
    for server in (main_server, cross_server):
        server.shutdown()
        server.server_close()
match = re.search(r'<pre id="review-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not return independent image review: " + result.stderr[-1000:])
assert match[1].strip(), "Browser script did not settle: " + result.stderr[-1000:]
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, {"output": output, "requests": requests}
cors_requests = [request for request in requests if urlsplit(request["path"]).path == "/cors-blue.png" and request["origin"]]
assert cors_requests and all(not request["cookie"] and not request["referer"] for request in cors_requests), cors_requests
print(json.dumps({**output, "anonymousCorsRequests": len(cors_requests)}, ensure_ascii=False))
