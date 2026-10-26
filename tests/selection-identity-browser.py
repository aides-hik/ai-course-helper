"""Offline Edge regressions for selection UI and the real Chaoxing work parser."""
from pathlib import Path
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
    return source[first:source.index(end, first + len(start))]


labels = section(template, "  function stripOptionLabel(", "  const VIDEO_QUIZ_INPUTS = ")
fields = section(adapter, "  const aiControlVisible = ", "  const aiBlankCount = ")
cx = section(template, "  class BaseQuestionHandler {", "/* @ai-helper:CHAPTER@ */")
setup = """
const vue={reactive:value=>value};const __publicField=(object,key,value)=>{object[key]=value;};const _unsafeWindow=window;
const sleep=async()=>{};const config={ai:{concurrentEnabled:true,concurrency:3}};
const useConfigStore=()=>config,aiConcurrencyLimit=()=>config.ai.concurrency;
const useLogStore=()=>({addLog(){}}),useQuestionStore=()=>({addQuestion(){}});
const getAnswerValues=response=>response.values;
let getAnswer=async question=>({values:[question.optionsText[1]],meta:{model:'offline',usage:{total_tokens:0}}});
"""
checks = r"""
(async()=>{try{
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const imageA='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const imageB='data:image/gif;base64,R0lGODlhAQABAIAAAAD/AP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const makeFrame=(withPicture=false,pictureOnly=false,pictureStem=false)=>{
    const frame=document.createElement('iframe');document.body.append(frame);
    const markup=Array.from({length:3},(_,index)=>'<section class="questionLi" data-question-id="q'+index+'">'+
      '<h3><span class="colorShallow">【单选题】</span><span class="question-copy">'+(pictureStem?'<img src="'+imageA+'">':'Question '+index)+'</span></h3>'+
      [0,1].map(choice=>'<div class="answerBg"><input type="radio" name="q'+index+'"><span class="before">'+String.fromCharCode(65+choice)+
        '<img src="'+imageA+'"></span><span class="answer_p">'+(pictureOnly?'':(choice?'Second':'First')+' option '+index)+
        (pictureOnly?'<img class="actual-question-image" src="'+imageA+'" data-src="'+(choice?imageB:imageA)+'">':withPicture&&choice?'<img class="actual-question-image" src="'+imageA+'">':'')+'</span></div>').join('')+'</section>').join('');
    const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><meta charset="utf-8"><body>'+markup);doc.close();
    for(const row of doc.querySelectorAll('.answerBg'))row.addEventListener('click',()=>{
      const parent=row.closest('.questionLi');parent.querySelectorAll('input').forEach(input=>{input.checked=false;});
      row.querySelector('input').checked=true;
      row.classList.add('check_answer');row.style.backgroundImage='url("'+imageB+'")';
      const letter=row.querySelector('.before');letter.classList.add('check_answer_dx');letter.firstChild.nodeValue='✓';letter.querySelector('img').src=imageB;
      parent.querySelector('.colorShallow').textContent='【单选题】 已作答（2分）';
      const status=doc.createElement('span');status.className='answer-status';status.textContent='已作答';row.append(status);
    });
    return frame;
  };
  const complete=[];
  for(const concurrent of [false,true]){
    const frame=makeFrame();const handler=new CxQuestionHandler('zy',frame);
    config.ai.concurrentEnabled=concurrent;config.ai.concurrency=concurrent?3:1;
    let requests=0,firstFilled=false;const checkpoints=[];
    getAnswer=async question=>{requests++;return{values:[question.optionsText[1]],meta:{model:'offline'}};};
    const fill=handler.fillQuestion;
    handler.fillQuestion=async(question,current)=>{
      const filled=await fill(question,current);checkpoints.push({filled,current:current()});
      if(checkpoints.length===1)firstFilled=filled&&frame.contentDocument.querySelectorAll('input')[1].checked;
      return filled;
    };
    const rate=await handler.init();
    const selected=[...frame.contentDocument.querySelectorAll('.questionLi')].map(element=>element.querySelectorAll('input')[1].checked);
    assert(firstFilled,'the first actual choice must fill');
    assert(rate===100&&!handler.lastSolveResult.cancelled&&handler.lastSolveResult.verifyFilled(),'the whole work must complete');
    assert(selected.every(Boolean)&&requests===3&&checkpoints.every(item=>item.filled&&item.current),'later questions must finish without paid retries');
    complete.push({concurrent,requests,firstFilled,rate,selected,cancelled:handler.lastSolveResult.cancelled});
  }

  const pictureChoices=[];
  for(const concurrent of [false,true])for(const pictureStem of [false,true]){
    const frame=makeFrame(true,true,pictureStem),handler=new CxQuestionHandler('zy',frame);
    config.ai.concurrentEnabled=concurrent;config.ai.concurrency=concurrent?3:1;
    let requests=0;const extracted=[];
    getAnswer=async question=>{
      requests++;
      const images=question.searchText.images,markers=[question.searchText.stem,...question.searchText.options].flatMap(text=>text.match(/\uFFFC\[ai-image:[^\]]*\]\uFFFC/g)||[]);
      assert(images.length===(pictureStem?3:2)&&images.length===markers.length,'pure image descriptors must match text markers');
      assert(images.every((image,index)=>image.marker===markers[index]),'image marker order must match descriptor order');
      assert(new Set(question.optionsText).size===2&&Object.keys(question.options).length===2,'placeholder images must preserve both option keys');
      const choices=images.filter(({label})=>label.startsWith('选项'));
      assert(choices.length===2&&choices[0].element.getAttribute('src')===choices[1].element.getAttribute('src')&&choices[0].element.getAttribute('data-src')!==choices[1].element.getAttribute('data-src'),'same-placeholder different lazy images must stay distinct');
      extracted.push(images.length);
      return{values:[question.optionsText[1]],meta:{model:'offline'}};
    };
    const rate=await handler.init(),selected=[...frame.contentDocument.querySelectorAll('.questionLi')].map(element=>element.querySelectorAll('input')[1].checked);
    assert(rate===100&&!handler.lastSolveResult.cancelled&&handler.lastSolveResult.verifyFilled()&&selected.every(Boolean)&&requests===3,'pure image choices must complete all questions precisely');
    pictureChoices.push({concurrent,pictureStem,requests,rate,selected,extracted});
  }

  const invalid=[];
  for(const mutation of ['stem','option','content-choice','image','new-sibling-image','new-choice-image','new-sibling-canvas','replace-sibling-image','replace-control','reorder-rows']){
    const frame=makeFrame(mutation==='image');const handler=new CxQuestionHandler('zy',frame);
    config.ai.concurrentEnabled=true;config.ai.concurrency=3;
    const releases=[];getAnswer=question=>new Promise(resolve=>releases.push(()=>resolve({values:[question.optionsText[1]],meta:{}})));
    if(mutation==='content-choice'){
      const content=frame.contentDocument.querySelector('.answer_p');const detail=frame.contentDocument.createElement('span');detail.className='choice';detail.textContent='Real answer text';content.append(detail);
    }
    if(mutation==='replace-sibling-image'){
      const image=frame.contentDocument.createElement('img');image.className='real-sibling-image';image.src=imageA;frame.contentDocument.querySelector('.answerBg').append(image);
    }
    const pending=handler.init();assert(releases.length===3,'all pending requests should start');
    const element=frame.contentDocument.querySelector('.questionLi');
    if(mutation==='stem')element.querySelector('.question-copy').textContent='Replacement question';
    if(mutation==='option')element.querySelector('.answer_p').textContent='Replacement option';
    if(mutation==='content-choice')element.querySelector('.choice').textContent='Changed real answer text';
    if(mutation==='image')element.querySelector('.actual-question-image').setAttribute('data-src',imageB);
    if(mutation==='new-sibling-image'){
      const image=frame.contentDocument.createElement('img');image.src=imageB;element.querySelector('.answerBg').append(image);
    }
    if(mutation==='new-choice-image'){
      const wrapper=frame.contentDocument.createElement('span');wrapper.className='choice';
      const image=frame.contentDocument.createElement('img');image.src=imageB;wrapper.append(image);element.querySelector('.answerBg').append(wrapper);
    }
    if(mutation==='new-sibling-canvas')element.querySelector('.answerBg').append(frame.contentDocument.createElement('canvas'));
    if(mutation==='replace-sibling-image')element.querySelector('.real-sibling-image').src=imageB;
    if(mutation==='replace-control'){const input=element.querySelector('input');input.replaceWith(input.cloneNode());}
    if(mutation==='reorder-rows')element.append(element.querySelector('.answerBg'));
    releases.forEach(release=>release());const rate=await pending;
    assert(rate===0&&handler.lastSolveResult.cancelled,'actual '+mutation+' must cancel');
    assert(![...frame.contentDocument.querySelectorAll('input')].some(input=>input.checked),'stale '+mutation+' must not write any answer');
    invalid.push(mutation);
  }

  const imageFrame=makeFrame(true),imageHandler=new CxQuestionHandler('zy',imageFrame);imageHandler.parseHtml();
  const imageQuestion=imageHandler.questions[0],actualImage=imageQuestion.searchText.images.find(({element})=>element.classList.contains('actual-question-image')).element;
  const realImageContext=createAiQuestionContext(imageQuestion);actualImage.src=imageB;
  assert(!realImageContext.isCurrent(),'actual bound image still participates in identity');realImageContext.dispose();

  document.querySelector('#selection-result').textContent=JSON.stringify({complete,pictureChoices,guarded:invalid,passed:true});
}catch(error){document.querySelector('#selection-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
"""
page = '<!doctype html><meta charset="utf-8"><body><pre id="selection-result"></pre><script>' + setup + extractors + labels + fields + integration + cx + checks + '</script>'
fixture = root / "tests" / "selection-identity-browser.html"
fixture.write_text(page, encoding="utf-8")
browser = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
result = subprocess.run([browser, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--user-data-dir=" + str(root / "tests" / ".selection-identity-profile"), "--virtual-time-budget=4000", "--dump-dom", fixture.as_uri()], capture_output=True, text=True, encoding="utf-8", timeout=25)
match = re.search(r'<pre id="selection-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit selection results: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
