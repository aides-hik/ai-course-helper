"""Offline browser checks for image decoding, resizing, CORS and cancellation."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import html
import json
import re
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
PIXEL = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XkAAAAASUVORK5CYII=")
source = (ROOT / "ai-images.js").read_text(encoding="utf-8")
records = []


class Images(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        records.append({"path": self.path, "cookie": self.headers.get("Cookie"), "origin": self.headers.get("Origin"), "referer": self.headers.get("Referer")})
        if self.path.startswith("/slow"):
            time.sleep(0.4)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(PIXEL[:8] if self.path.startswith("/broken") else PIXEL)
        except (BrokenPipeError, ConnectionResetError):
            pass


remote = ThreadingHTTPServer(("127.0.0.1", 0), Images)
threading.Thread(target=remote.serve_forever, daemon=True).start()
# The production code does not fetch private hosts. This isolated fixture routes
# its public-image branch to the two local test servers without external traffic.
fixture_source = source.replace('const aiImagePublicUrl = (url) => {', 'const aiImagePublicUrl = (url) => { if (url.hostname === "127.0.0.1" && url.port === "' + str(remote.server_port) + '") return true;')
checks = r"""
(async()=>{try{
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const marker=index=>'\uFFFC[ai-image:'+index+']\uFFFC';
  const image=async(src)=>{const img=new Image();img.src=src;await img.decode();return img;};
  const question=imgs=>({element:{ownerDocument:document,querySelectorAll:()=>[]},searchText:{stem:imgs.map((_,index)=>marker(index)).join(' '),options:[],images:imgs.map((element,index)=>({marker:marker(index),label:'题干',element}))}});
  const context={provider:'deepseek'};
  const bad=await aiCollectQuestionImages(question([Object.assign(new Image(),{src:'data:image/png;base64,iVBORw0KGgo='})]),context);
  assert(!!bad.error,'invalid signature-only data must be rejected locally');
  const wide=document.createElement('canvas');wide.width=10000;wide.height=20;
  const drawing=wide.getContext('2d');drawing.fillStyle='red';drawing.fillRect(0,0,5000,20);drawing.fillStyle='blue';drawing.fillRect(5000,0,5000,20);
  const original=await image(wide.toDataURL('image/png'));
  const single=await aiCollectQuestionImages(question([original]),context);assert(single.images?.length===1,'wide image must resize');
  const resized=await image(single.images[0].url);
  const read=document.createElement('canvas');read.width=resized.naturalWidth;read.height=resized.naturalHeight;read.getContext('2d').drawImage(resized,0,0);
  const left=read.getContext('2d').getImageData(0,0,1,1).data,right=read.getContext('2d').getImageData(read.width-1,0,1,1).data;
  assert(resized.naturalWidth===8192&&left[0]>240&&right[2]>240,'resize must preserve both boundaries');
  const many=await aiCollectQuestionImages(question(Array.from({length:15},()=>original)),context);
  assert(many.images?.length===15,'many image request must finish');
  const manyImage=await image(many.images[0].url);assert(manyImage.naturalWidth===4096,'15 image side limit');
  const remote='__REMOTE__';
  const tainted=await image(remote+'/cross.png');
  const cors=await aiCollectQuestionImages(question([tainted]),context);
  assert(cors.images?.[0]?.url.startsWith('data:'),'tainted image must reload anonymously');
  const broken=new Image();broken.src=remote+'/broken.png';try{await broken.decode();}catch{}
  const brokenResult=await aiCollectQuestionImages(question([broken]),context);
  assert(!!brokenResult.error&&!brokenResult.images,'known broken public images must stop locally');
  const placeholder=await image('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  placeholder.setAttribute('data-src',remote+'/lazy.png');
  const before=placeholder.outerHTML;
  const lazy=await aiCollectQuestionImages(question([placeholder]),context);
  assert(lazy.images?.[0]?.url.startsWith('data:')&&placeholder.outerHTML===before,'lazy source must embed without changing DOM');
  const cancellationImage=new Image();cancellationImage.src=remote+'/slow.png';
  const controller=new AbortController();queueMicrotask(()=>controller.abort());
  const started=performance.now();
  const cancelled=await aiCollectQuestionImages(question([cancellationImage]),{provider:'deepseek',signal:controller.signal});
  assert(cancelled.error==='请求已取消'&&performance.now()-started<500,'image wait must cancel quickly '+JSON.stringify({cancelled,elapsed:performance.now()-started}));
  document.querySelector('#result').textContent=JSON.stringify({badDataRejected:true,brokenUrlRejected:true,singleWidth:resized.naturalWidth,manyWidth:manyImage.naturalWidth,boundariesPreserved:true,anonymousCorsEmbedded:true,lazyEmbedded:true,originalUntouched:true,cancellation:true});
}catch(error){document.querySelector('#result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
""".replace("__REMOTE__", f"http://127.0.0.1:{remote.server_port}")
page = ('<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>' + fixture_source + checks + '</script>').encode()


class Page(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "image-test=fixture; Path=/; SameSite=Lax")
        self.end_headers()
        self.wfile.write(page)


server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    run = subprocess.run([
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--user-data-dir=" + str(ROOT / "tests" / ".images-deepseek-profile"),
        "--virtual-time-budget=25000", "--dump-dom", f"http://127.0.0.1:{server.server_port}/"
    ], capture_output=True, text=True, encoding="utf-8", timeout=35)
finally:
    server.shutdown()
    remote.shutdown()
    server.server_close()
    remote.server_close()
match = re.search(r'<pre id="result">(.*?)</pre>', run.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not return image results: " + run.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert "error" not in output, output
anonymous = [record for record in records if record["origin"]]
assert len(anonymous) >= 2 and all(not record["cookie"] and not record["referer"] for record in anonymous), records
print(json.dumps({**output, "anonymousRequestsWithoutCredentials": len(anonymous)}, ensure_ascii=False))
