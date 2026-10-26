"""Offline real DOM regressions for question extraction and rich editor filling."""
from pathlib import Path
import html
import json
import re
import subprocess

root = Path(__file__).resolve().parent.parent
source = (root / "ai-course-helper.user.js").read_text(encoding="utf-8")
integration = (root / "ai-integration.js").read_text(encoding="utf-8")
adapter = (root / "ai-adapter.js").read_text(encoding="utf-8")
helpers = adapter[adapter.index("  const aiControlVisible = "):adapter.index("  const aiBlankCount = ")]
extract = source[source.index("  function extractRawTextFromElement("):source.index("  function stripOptionLabel(")]
page = """<!doctype html><meta charset="utf-8"><body>
<h3 id="math-title">求x<sup>2</sup>的导数，H<sub>2</sub>O</h3>
<div id="question"><h3>填空题</h3><textarea id="existing-editor" name="answer-name-not-editor-id" style="display:none"></textarea><iframe srcdoc="<body contenteditable='true'>unchanged visible answer</body>"></iframe></div>
<div id="native-question"><h3>原生填空</h3><input type="text"><input type="hidden" value="id"><textarea disabled></textarea></div>
<pre id="review-result"></pre>
<script>
const sleep = async () => {};
""" + extract + helpers + integration + """
window.addEventListener('load', async () => {
  try {
  const question = document.querySelector('#question');
  const sourceField = question.querySelector('textarea');
  let createdEditors=0;
  window.UE = {instants:{},getEditor() {createdEditors++;throw new Error('Editor id not found');}};
  const unresolved = await applyAiAnswers({type:'2',answer:['new answer'],element:question},window,'zj');
  const unchangedSource=sourceField.value;
  const editorBody=question.querySelector('iframe').contentDocument.body;
  const unchangedVisible=editorBody.textContent;
  const existing={key:'existing-editor',body:editorBody,
    setContent(html){editorBody.innerHTML=html;},
    getContentTxt(){return editorBody.textContent;}};
  window.UE.instants.preexisting=existing;
  const unsafe='<img src=x onerror="window.__reviewInjection=true"> & answer';
  const filled = await applyAiAnswers({type:'2',answer:[unsafe],element:question},window,'zj');
  const native=document.querySelector('#native-question');
  const nativeFilled=await applyAiAnswers({type:'2',answer:['native answer'],element:native},window,'zy');
  const hiddenFrame=question.querySelector('iframe');hiddenFrame.style.display='none';
  const hiddenFrameRejected=aiAnswerFields({element:question},window).length===0;
  const result = {
    parsedMathTitle:extractRawTextFromElement(document.querySelector('#math-title')),
    sourceTextareaVisible:sourceField.getClientRects().length > 0,
    unresolved,unchangedSource,unchangedVisible,createdEditors,
    sourceTextarea:sourceField.value,
    visibleEditor:editorBody.textContent,
    noHtmlImage:editorBody.querySelector('img')===null,
    injection:!!window.__reviewInjection,
    reportedFilled:filled,nativeFilled,nativeValue:native.querySelector('input').value,hiddenFrameRejected
  };
  document.querySelector('#review-result').textContent=JSON.stringify(result);
  } catch(error) {document.querySelector('#review-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}
});
</script>"""
fixture = root / "tests" / "review-logic-browser.html"
fixture.write_text(page, encoding="utf-8")
browser = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
result = subprocess.run([browser, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--user-data-dir=" + str(root / "tests" / ".review-logic-profile"), "--virtual-time-budget=2000", "--dump-dom", fixture.as_uri()], capture_output=True, text=True, encoding="utf-8", timeout=20)
match = re.search(r'<pre id="review-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit review result: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output["parsedMathTitle"] == "求x^(2)的导数，H_(2)O", output
assert output["sourceTextareaVisible"] is False, output
assert output["unresolved"] is False, output
assert output["unchangedSource"] == "", output
assert output["unchangedVisible"] == "unchanged visible answer", output
assert output["createdEditors"] == 0, output
assert output["sourceTextarea"] == "", output
assert output["visibleEditor"] == '<img src=x onerror="window.__reviewInjection=true"> & answer', output
assert output["noHtmlImage"] is True and output["injection"] is False, output
assert output["reportedFilled"] is True, output
assert output["nativeFilled"] is True and output["nativeValue"] == "native answer", output
assert output["hiddenFrameRejected"] is True, output
print(json.dumps(output, ensure_ascii=False))
