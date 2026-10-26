"""Exercise formatted model answers with the real Chaoxing parser and controls."""
from pathlib import Path
import html
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
template = (ROOT / "userscript.template.js.in").read_text(encoding="utf-8")


def section(source, start, end):
    first = source.index(start)
    return source[first:source.index(end, first + len(start))]


common = section(template, "  const isObject = ", "/* @ai-helper:TEXT_EXTRACTORS@ */")
labels = section(template, "  function stripOptionLabel(", "  const VIDEO_QUIZ_INPUTS = ")
cx = section(template, "  class BaseQuestionHandler {", "/* @ai-helper:CHAPTER@ */")
modules = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in
                    ["text-extraction.js", "ai-images.js", "ai-endpoints.js", "ai-adapter.js", "ai-integration.js"])
setup = r"""
const vue={reactive:value=>value},__publicField=(object,key,value)=>{object[key]=value;},_unsafeWindow=window;
const sleep=async()=>{};
const config={ai:{provider:'deepseek',deepseekApiKey:'offline-fixture',deepseekModel:'deepseek-flash',concurrentEnabled:true,concurrency:3},otherParams:{params:[{value:0}]}};
const useConfigStore=()=>config,useLogStore=()=>({addLog(){}});
let rows=[];const useQuestionStore=()=>({addQuestion:question=>rows.push(question)});
const calls=[];
const _GM_xmlhttpRequest=request=>{
  const body=JSON.parse(request.data),content=body.messages[1].content;
  const input=JSON.parse(typeof content==='string'?content:content[0].text);
  const index=Number(/format:(\d+)/.exec(input.stem)[1]);
  calls.push({index,body});
  const answer={answerable:true,choice_indices:[1],text_answers:[],judgement:'unknown',explanation:'Braces {x} and quoted "words" are text.'};
  const valid=JSON.stringify(answer);
  let text=valid;
  if(index===0)text='\uFEFF'+valid;
  if(index===1)text='```json\n'+valid+'\n```';
  if(index===2)text='答案如下：\n'+valid+'\n以上为最终答案。';
  if(index===3)text=valid.replace('Braces {x}',String.raw`Invalid \sqrt{x}`);
  if(index===4)text=valid+'\n'+JSON.stringify({...answer,choice_indices:[0]});
  const payload={choices:[{finish_reason:'stop',message:{content:text,reasoning_content:JSON.stringify({...answer,choice_indices:[0]})}}]};
  queueMicrotask(()=>request.onload({status:200,responseText:JSON.stringify(payload)}));
  return{abort(){request.onabort?.();}};
};
"""
checks = r"""
(async()=>{try{
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const source='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const completed=[];
  for(const pictures of [false,true])for(const concurrent of [false,true]){
    const frame=document.createElement('iframe');document.body.append(frame);const doc=frame.contentDocument;
    doc.open();doc.write('<!doctype html><body>'+Array.from({length:6},(_,index)=>'<section class="questionLi"><h3><span class="colorShallow">【单选题】</span>format:'+index+'</h3>'+[0,1].map(choice=>'<div class="answerBg"><input type="radio" name="q'+index+'"><span class="before">'+String.fromCharCode(65+choice)+'</span><span class="answer_p">'+(pictures?'<img src="'+source+'">':'Option '+choice)+'</span></div>').join('')+'</section>').join(''));doc.close();
    await Promise.all([...doc.images].map(image=>image.decode()));
    for(const row of doc.querySelectorAll('.answerBg'))row.addEventListener('click',()=>{
      for(const input of row.parentElement.querySelectorAll('input'))input.checked=false;
      row.querySelector('input').checked=true;row.classList.add('check_answer');
    });
    rows=[];config.ai.concurrentEnabled=concurrent;config.ai.concurrency=3;const start=calls.length;
    const handler=new CxQuestionHandler('zy',frame),rate=await handler.init();
    const selected=[...doc.querySelectorAll('.questionLi')].map(root=>root.querySelectorAll('input')[1].checked);
    assert(JSON.stringify(selected)==='[true,true,true,false,false,true]','wrapped answers must map correctly, malformed answers must not fill: '+JSON.stringify({pictures,concurrent,selected,errors:rows.map(row=>row.answer)}));
    assert(calls.length-start===6,'a format error must never trigger another paid request');
    assert(!handler.lastSolveResult.cancelled&&Math.abs(rate-400/6)<0.001&&!handler.lastSolveResult.complete,'one failed question must leave other valid questions fillable without marking the batch complete');
    assert(rows[3].answerStatus==='error'&&rows[4].answerStatus==='error','malformed and ambiguous answers must show errors');
    assert(/转义/.test(rows[3].answer[0])&&/多个/.test(rows[4].answer[0]),'format failures must report their distinct causes');
    assert(rows.filter(row=>row.answerStatus==='success').length===4,'four valid answers must be verified');
    if(pictures)assert(calls.slice(start).every(call=>Array.isArray(call.body.messages[1].content)&&call.body.messages[1].content.length===3),'both image choices must remain in each request');
    completed.push({pictures,concurrent,requests:calls.length-start,filled:4,rejected:2,rate});
  }
  document.querySelector('#json-result').textContent=JSON.stringify({completed,passed:true});
}catch(error){document.querySelector('#json-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
"""
page = ('<!doctype html><meta charset="utf-8"><body><pre id="json-result"></pre><script>'
        + setup + common + modules + labels + cx + checks + '</script>')
fixture = ROOT / "tests" / "json-output-browser.html"
fixture.write_text(page, encoding="utf-8")
run = subprocess.run([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "--headless", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--user-data-dir=" + str(ROOT / "tests" / ".json-output-profile"),
    "--virtual-time-budget=8000", "--dump-dom", fixture.as_uri()
], capture_output=True, text=True, encoding="utf-8", timeout=25)
match = re.search(r'<pre id="json-result">(.*?)</pre>', run.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit JSON checks: " + run.stderr[-1000:])
assert match[1].strip(), "Browser did not finish: " + run.stderr[-1000:]
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
