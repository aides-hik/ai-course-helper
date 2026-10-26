"""Offline Edge checks for image identity and the real platform DOM parsers."""
from pathlib import Path
import base64
import html
import json
import re
import subprocess

root = Path(__file__).resolve().parent.parent
template = (root / "userscript.template.js.in").read_text(encoding="utf-8")
adapter = (root / "ai-adapter.js").read_text(encoding="utf-8")
integration = (root / "ai-integration.js").read_text(encoding="utf-8")
extractors = (root / "text-extraction.js").read_text(encoding="utf-8")


def section(source, start, end):
    first = source.index(start)
    last = source.index(end, first + len(start))
    return source[first:last]


field_helpers = section(adapter, "  const aiControlVisible = ", "  const aiBlankCount = ")
labels = section(template, "  function stripOptionLabel(", "  const VIDEO_QUIZ_INPUTS = ")
video_parser = section(template, "  const VIDEO_QUIZ_INPUTS = ", "  const VIDEO_QUIZ_SETTING = ")
cx_classes = section(template, "  class BaseQuestionHandler {", "/* @ai-helper:CHAPTER@ */")
zhs_class = section(template, "  class ZhsQuestionHandler extends BaseQuestionHandler {", "/* @ai-helper:PAGE_HOOKS@ */")

# Two local resources let currentSrc change while the image's src remains fixed.
gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
for name in ("images-integration-a.gif", "images-integration-b.gif"):
    (root / "tests" / name).write_bytes(gif)

setup = """
const sleep=async()=>{};const vue={reactive:value=>value};
const __publicField=(object,key,value)=>{object[key]=value;};
const _unsafeWindow=window;
const config={ai:{concurrentEnabled:true,concurrency:3}};
const useConfigStore=()=>config,aiConcurrencyLimit=()=>config.ai.concurrency;
const useLogStore=()=>({addLog(){}}),useQuestionStore=()=>({addQuestion(){}});
let getAnswer=async question=>({values:question.expected,meta:{}});
const getAnswerValues=response=>response.values;
"""
checks = r"""
(async()=>{try{
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const sourceA=new URL('images-integration-a.gif',location.href).href;
  const sourceB=new URL('images-integration-b.gif',location.href).href;
  const frame=(markup)=>{
    const element=document.createElement('iframe');document.body.append(element);
    const doc=element.contentDocument;doc.open();doc.write('<!doctype html><meta charset="utf-8"><body>'+markup);doc.close();
    return element;
  };
  const settleImage=async(image)=>{
    if(!image.complete)await new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true});});
    await new Promise(resolve=>setTimeout(resolve,20));
  };
  const makeQuestion=(name)=>{
    const element=document.createElement('section');
    element.innerHTML='<h3>'+name+'<img src="'+sourceA+'"></h3><input name="'+name+'">';document.body.append(element);
    return{title:name,type:'2',element,options:{},answer:[],expected:['answer:'+name],image:element.querySelector('img'),field:element.querySelector('input')};
  };
  const makeHandler=questions=>({parseHtml(){this.questions=questions;},addLog(){},addQuestion(){},
    fillQuestion:(question,current)=>applyAiAnswers(question,window,'zy',undefined,current)});
  const changed=[];
  for(const attribute of ['src','srcset','sizes','data-src','data-original','data-lazy-src','lazy-src']){
    const question=makeQuestion('image-'+attribute);await settleImage(question.image);
    const context=createAiQuestionContext(question);
    question.image.setAttribute(attribute,attribute==='sizes'?'40px':sourceB);
    changed.push(!context.isCurrent());context.dispose();
  }
  assert(changed.every(Boolean),'image attribute changes must invalidate immediately');

  const responsive=makeQuestion('responsive');await settleImage(responsive.image);
  responsive.image.srcset=sourceA+' 1x';await settleImage(responsive.image);
  const originalSrc=responsive.image.getAttribute('src'),firstCurrent=responsive.image.currentSrc;
  const responsiveContext=createAiQuestionContext(responsive);
  responsive.image.srcset=sourceB+' 1x';await settleImage(responsive.image);
  const responsiveResult={srcUnchanged:responsive.image.getAttribute('src')===originalSrc,currentChanged:responsive.image.currentSrc!==firstCurrent,current:responsiveContext.isCurrent()};
  responsiveContext.dispose();assert(responsiveResult.srcUnchanged&&responsiveResult.currentChanged&&!responsiveResult.current,'live responsive source must invalidate');

  const pendingQuestions=[makeQuestion('pending-one'),makeQuestion('pending-two')];
  await Promise.all(pendingQuestions.map(question=>settleImage(question.image)));
  const signals=[];
  getAnswer=(question,context)=>new Promise(resolve=>{signals.push(context.signal);context.signal.addEventListener('abort',()=>resolve({values:[],meta:{}}),{once:true});});
  const pendingHandler=makeHandler(pendingQuestions),pending=solveAiQuestions(pendingHandler);
  pendingQuestions[1].image.setAttribute('data-src',sourceB);
  const cancelledRate=await pending;
  assert(cancelledRate===0&&signals.length===2&&signals.every(signal=>signal.aborted),'one changed image must abort active siblings');
  assert(pendingQuestions.every(question=>question.field.value===''),'cancelled answer must never write');

  const queuedQuestions=[makeQuestion('queued-one'),makeQuestion('queued-two')];
  await Promise.all(queuedQuestions.map(question=>settleImage(question.image)));
  config.ai.concurrency=1;let queuedRequests=0,release;
  getAnswer=question=>{queuedRequests++;return new Promise(resolve=>{release=()=>resolve({values:question.expected,meta:{}});});};
  const queuedHandler=makeHandler(queuedQuestions),queued=solveAiQuestions(queuedHandler);
  queuedQuestions[1].image.src=sourceB;release();
  assert(await queued===0&&queuedRequests===1,'queued changed image must not issue another request');
  assert(queuedQuestions.every(question=>question.field.value===''),'queued image change must prevent all writes');

  const background=makeQuestion('background');await settleImage(background.image);
  const heading=background.element.querySelector('h3');
  const styleContext=createAiQuestionContext(background);heading.style.backgroundColor='red';heading.classList.add('selected');
  assert(styleContext.isCurrent(),'ordinary style changes must not invalidate');
  heading.style.backgroundImage='url("'+sourceA+'")';
  assert(!styleContext.isCurrent(),'a new background image must invalidate');styleContext.dispose();
  assert(extractRawTextFromElement(heading,[]).includes('[ai-visual:background]'),'unsupported background must remain visible to validation');
  const vector=document.createElementNS('http://www.w3.org/2000/svg','svg');
  vector.innerHTML='<path d="M0 0L1 1"/>';heading.append(vector);
  const vectorContext=createAiQuestionContext(background);vector.firstChild.setAttribute('d','M0 1L1 0');
  assert(!vectorContext.isCurrent(),'SVG structure change must invalidate');vectorContext.dispose();
  assert(extractRawTextFromElement(vector,[]).includes('[ai-visual:svg]'),'unsupported SVG must not be dropped');
  const canvas=document.createElement('canvas');heading.append(canvas);
  const canvasContext=createAiQuestionContext(background);canvas.width=12;
  assert(!canvasContext.isCurrent(),'canvas dimensions must participate in identity');canvasContext.dispose();
  assert(extractRawTextFromElement(canvas,[]).includes('[ai-visual:canvas]'),'unsupported canvas must not be dropped');

  const cxFrame=frame('<section class="TiMu"><h3 class="fontLabel">Choose<img src="'+sourceA+'"></h3>'+
    '<label class="before-after"><input type="radio" name="cx"><span class="fl after"><img src="'+sourceA+'" data-src="'+sourceA+'"></span></label>'+
    '<label class="before-after"><input type="radio" name="cx"><span class="fl after"><img src="'+sourceA+'" data-src="'+sourceB+'"></span></label></section>');
  await Promise.all([...cxFrame.contentDocument.images].map(settleImage));
  const cx=new CxQuestionHandler('zj',cxFrame);cx.parseHtml();const cxQuestion=cx.questions[0];
  assert(cxQuestion.searchText.images.length===3,'Cx must preserve all three live images');
  assert(cxQuestion.searchText.images[0].element===cxFrame.contentDocument.images[0],'Cx stem must bind original live image');
  assert(Object.keys(cxQuestion.options).length===2&&new Set(cxQuestion.optionsText).size===2,'identical placeholder URLs must retain distinct options');
  cxQuestion.answer=[cxQuestion.optionsText[1]];
  assert(await cx.fillQuestion(cxQuestion,()=>true),'second image option must fill precisely');
  const cxInputs=[...cxFrame.contentDocument.querySelectorAll('input')];
  assert(!cxInputs[0].checked&&cxInputs[1].checked,'image index must map to the second control');

  const zhsFrame=frame('<section class="examPaper_subject"><div class="subject_describe"><div></div></div>'+
    '<label class="label"><input type="radio" name="zhs"><span class="node_detail"><img src="'+sourceA+'" data-src="'+sourceA+'"></span></label>'+
    '<label class="label"><input type="radio" name="zhs"><span class="node_detail"><img src="'+sourceA+'" data-src="'+sourceB+'"></span></label></section>');
  const host=zhsFrame.contentDocument.querySelector('.subject_describe div'),shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML='Shadow stem<img src="'+sourceA+'">';host.__Ivue__={_data:{shadowDom:shadow}};
  await Promise.all([...zhsFrame.contentDocument.images,shadow.querySelector('img')].map(settleImage));
  const zhs=new ZhsQuestionHandler();zhs._document=zhsFrame.contentDocument;zhs._window=zhsFrame.contentWindow;zhs.parseHtml();const zhsQuestion=zhs.questions[0];
  assert(zhsQuestion.searchText.images.length===3&&zhsQuestion.searchText.images[0].element===shadow.querySelector('img'),'ZHS must retain live shadow image binding');
  assert(Object.keys(zhsQuestion.options).length===2,'ZHS image options must not overwrite');
  const shadowContext=createAiQuestionContext(zhsQuestion);shadow.querySelector('img').setAttribute('data-src',sourceB);
  assert(!shadowContext.isCurrent(),'shadow image swap must invalidate');shadowContext.dispose();
  zhsQuestion.answer=[zhsQuestion.optionsText[1]];
  assert(await zhs.fillQuestion(zhsQuestion,()=>true),'ZHS second image option must fill');
  assert(zhsFrame.contentDocument.querySelectorAll('input')[1].checked,'ZHS index must select second image');

  const videoFrame=frame('<section class="ans-videoquiz"><h3 class="tkItem_title">Video<img src="'+sourceA+'"></h3>'+
    '<label class="ans-videoquiz-opt"><input type="radio" name="video">A. <img src="'+sourceA+'" data-src="'+sourceA+'"></label>'+
    '<label class="ans-videoquiz-opt"><input type="radio" name="video">B. <img src="'+sourceA+'" data-src="'+sourceB+'"></label></section>');
  const videoRoot=videoFrame.contentDocument.querySelector('section');await Promise.all([...videoFrame.contentDocument.images].map(settleImage));
  const video=parseVideoQuiz(videoRoot,[...videoRoot.querySelectorAll('input')]);
  assert(video&&video.question.searchText.images.length===3,'video must retain image markers and metadata');
  assert(new Set(video.question.optionsText).size===2,'video picture options must retain separate indices');
  const selected=matchVideoQuizAnswers(video,[video.question.optionsText[1]]);
  assert(selected&&selected.has(video.inputs[1]),'video image answer must map to the second control');
  const videoContext=createAiQuestionContext(video.question);videoRoot.querySelectorAll('img')[2].srcset=sourceB+' 1x';
  assert(!videoContext.isCurrent(),'video option image source must participate in question identity');videoContext.dispose();

  document.querySelector('#image-result').textContent=JSON.stringify({attributes:changed.length,responsive:responsiveResult,
    activeCancelled:signals.length,queuedRequests,cxImages:cxQuestion.searchText.images.length,cxDistinctOptions:Object.keys(cxQuestion.options).length,
    zhsImages:zhsQuestion.searchText.images.length,videoImages:video.question.searchText.images.length,passed:true});
}catch(error){document.querySelector('#image-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
"""
page = '<!doctype html><meta charset="utf-8"><body><pre id="image-result"></pre><script>' + setup + extractors + labels + field_helpers + integration + cx_classes + zhs_class + video_parser + checks + '</script>'
fixture = root / "tests" / "images-integration-browser.html"
fixture.write_text(page, encoding="utf-8")
browser = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
result = subprocess.run([browser, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--user-data-dir=" + str(root / "tests" / ".images-integration-profile"), "--virtual-time-budget=6000", "--dump-dom", fixture.as_uri()], capture_output=True, text=True, encoding="utf-8", timeout=25)
match = re.search(r'<pre id="image-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit image results: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
