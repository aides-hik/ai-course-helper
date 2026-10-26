"""Check authenticated cached images through a real browser canvas, offline."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import html
import json
import re
import subprocess
import threading

ROOT = Path(__file__).resolve().parent.parent
IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XkAAAAASUVORK5CYII=")
source = (ROOT / "ai-images.js").read_text(encoding="utf-8")
checks = r"""
(async()=>{try{
  const image=document.querySelector('#private');
  if(!image.complete)await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});
  const marker='\uFFFC[ai-image:0]\uFFFC';
  const entry={element:document.querySelector('section'),searchText:{stem:'What is shown? '+marker,options:[],images:[{marker,label:'题干',element:image}]}};
  const protectedResult=await aiCollectQuestionImages(entry);
  const blob=URL.createObjectURL(await (await fetch('/private.png')).blob());
  const temporary=new Image();temporary.src=blob;await temporary.decode();
  entry.searchText.images[0].element=temporary;
  const temporaryResult=await aiCollectQuestionImages(entry);
  URL.revokeObjectURL(blob);
  const controller=new AbortController();controller.abort();
  const cancelled=await aiCollectQuestionImages(entry,{signal:controller.signal});
  const unsupported=document.createElement('section');
  unsupported.innerHTML='<h3>Which option?</h3><div class="answerBg"><span class="answer_p">Option A</span><canvas width="2" height="2"></canvas></div>';
  document.body.append(unsupported);
  const unsupportedResult=aiQuestionImageDescriptors({element:unsupported,options:{A:unsupported.querySelector('.answerBg')},searchText:{stem:'Which option?',options:['Option A'],images:[]}});
  const output={loaded:image.naturalWidth===1,
    protectedEmbedded:protectedResult.images?.[0]?.url.startsWith('data:image/png;base64,')===true,
    temporaryEmbedded:temporaryResult.images?.[0]?.url.startsWith('data:image/png;base64,')===true,
    cancellation:cancelled.error==='请求已取消',outsideCanvasRejected:!!unsupportedResult.error,errors:[protectedResult.error,temporaryResult.error].filter(Boolean)};
  document.querySelector('#result').textContent=JSON.stringify(output);
}catch(error){document.querySelector('#result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
"""
page = ('<!doctype html><meta charset="utf-8"><section><img id="private" src="/private.png"></section>'
        '<pre id="result"></pre><script>' + source + checks + '</script>').encode()
authenticated = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/private.png":
            allowed = "image-test=fixture" in self.headers.get("Cookie", "")
            authenticated.append(allowed)
            self.send_response(200 if allowed else 403)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            if allowed:
                self.wfile.write(IMAGE)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Set-Cookie", "image-test=fixture; Path=/; SameSite=Strict")
            self.end_headers()
            self.wfile.write(page)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    result = subprocess.run([
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--user-data-dir=" + str(ROOT / "tests" / ".images-profile"),
        "--virtual-time-budget=4000", "--dump-dom", f"http://127.0.0.1:{server.server_port}/"
    ], capture_output=True, text=True, encoding="utf-8", timeout=25)
finally:
    server.shutdown()
    server.server_close()
match = re.search(r'<pre id="result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not return an image check: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output == {"loaded": True, "protectedEmbedded": True, "temporaryEmbedded": True, "cancellation": True, "outsideCanvasRejected": True, "errors": []}, output
assert authenticated and all(authenticated), authenticated
print(json.dumps({**output, "authenticatedImageRequests": len(authenticated)}, ensure_ascii=False))
