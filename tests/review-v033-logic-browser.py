"""Offline real-DOM regressions for answer identity and verification."""
from pathlib import Path
import html
import json
import re
import subprocess

root = Path(__file__).resolve().parent.parent
source = (root / "ai-course-helper.user.js").read_text(encoding="utf-8")
adapter = (root / "ai-adapter.js").read_text(encoding="utf-8")
integration = (root / "ai-integration.js").read_text(encoding="utf-8")
helpers = adapter[adapter.index("  const aiControlVisible = "):adapter.index("  const aiBlankCount = ")]
extract = source[source.index("  function extractRawTextFromElement("):source.index("  function stripOptionLabel(")]
setup = """const sleep=async()=>{};const vue={reactive:value=>value};
let getAnswer=async question=>({values:question.expected,meta:{}});
const getAnswerValues=response=>response.values;
"""
checks = """
(async()=>{try{
  const makeQuestion=(title,names)=>{
    const element=document.createElement('section');
    const heading=document.createElement('h3');heading.textContent=title;element.append(heading);
    const fields=names.map(name=>{const field=document.createElement('input');field.name=name;element.append(field);return field;});
    document.body.append(element);
    return{title,type:'2',expected:names.map(name=>'answer-for-'+name),element,fields};
  };
  const makeHandler=questions=>({parseHtml(){this.questions=questions;},addLog(){},addQuestion(){},fillQuestion:(entry,current)=>applyAiAnswers(entry,window,'zy',undefined,current)});
  const reordered=makeQuestion('Fill two blanks',['left','right']);
  getAnswer=async entry=>{reordered.element.append(reordered.fields[0]);return{values:entry.expected,meta:{}};};
  const reorderedHandler=makeHandler([reordered]);
  const reorderedRate=await solveAiQuestions(reorderedHandler);
  const first=makeQuestion('First blank',['first']),second=makeQuestion('Second blank',['second']);
  getAnswer=async entry=>{if(entry===undefined)throw Error('missing');if(entry.title==='Second blank')first.fields[0].value='';return{values:entry.expected,meta:{}};};
  const erasedHandler=makeHandler([first,second]);
  const erasedRate=await solveAiQuestions(erasedHandler);
  const shadowQuestion=document.createElement('section');
  shadowQuestion.innerHTML='<div class="subject_describe"><div></div></div>';
  document.body.append(shadowQuestion);
  const host=shadowQuestion.querySelector('.subject_describe div');
  const shadow=host.attachShadow({mode:'open'});shadow.textContent='original shadow title';
  host.__Ivue__={_data:{shadowDom:shadow}};
  const parsedShadow=extractRawTextFromElement(host.__Ivue__._data.shadowDom);
  const shadowContext=createAiQuestionContext({title:parsedShadow,type:'单选题',element:shadowQuestion});
  shadow.textContent='replacement shadow title';
  const shadowCurrent=shadowContext.isCurrent();shadowContext.dispose();
  const results={
    reordered:{rate:reorderedRate,left:reordered.fields[0].value,right:reordered.fields[1].value,complete:reorderedHandler.lastSolveResult.complete},
    erased:{rate:erasedRate,first:first.fields[0].value,complete:erasedHandler.lastSolveResult.complete,current:erasedHandler.lastSolveResult.isCurrent()},
    shadow:{parsed:parsedShadow,live:extractRawTextFromElement(host.__Ivue__._data.shadowDom),current:shadowCurrent}
  };
  document.querySelector('#review-result').textContent=JSON.stringify(results);
}catch(error){document.querySelector('#review-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
"""
page = '<!doctype html><meta charset="utf-8"><body><pre id="review-result"></pre><script>' + setup + extract + helpers + integration + checks + '</script>'
fixture = root / "tests" / "review-v033-logic-browser.html"
fixture.write_text(page, encoding="utf-8")
browser = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
result = subprocess.run([browser, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--user-data-dir=" + str(root / "tests" / ".review-v033-profile"), "--virtual-time-budget=2000", "--dump-dom", fixture.as_uri()], capture_output=True, text=True, encoding="utf-8", timeout=20)
match = re.search(r'<pre id="review-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit review result: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output["reordered"] == {"rate": 0, "left": "", "right": "", "complete": False}, output
assert output["erased"] == {"rate": 50, "first": "", "complete": False, "current": True}, output
assert output["shadow"] == {"parsed": "original shadow title", "live": "replacement shadow title", "current": False}, output
print(json.dumps(output, ensure_ascii=False))
