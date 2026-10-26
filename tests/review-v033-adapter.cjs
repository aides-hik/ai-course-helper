// V07/V08 real DOM regressions. Calls are intercepted locally; no API access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'userscript.template.js.in'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'ai-endpoints.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'ai-integration.js'), 'utf8');
const extract = fs.readFileSync(path.join(root, 'text-extraction.js'), 'utf8');
const handlers = source.slice(source.indexOf('  class BaseQuestionHandler {'), source.indexOf('/* @ai-helper:CHAPTER@ */'));
assert.ok(handlers.includes('class CxQuestionHandler'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-v033-review-'));
const fixture = path.join(temp, 'review.html');
const choice = (id, title, first = '10') => `<div id="${id}" class="questionLi"><h3><span class="colorShallow">单选题</span>${title}</h3><div class="answerBg"><div class="answer_p">A. ${first}</div></div><div class="answerBg"><div class="answer_p">B. 20</div></div></div>`;
const svg = '<svg width="40" height="40"><path d="M0 0 H40 V40 Z" fill="black"/></svg>';
const canvas = '<canvas width="80" height="40"></canvas>';
const page = `<!doctype html><meta charset="utf-8"><body>
<form id="disabled-question" class="questionLi"><h3><span class="colorShallow">填空题</span>6乘7等于多少？</h3><fieldset disabled><input type="text" name="answer"></fieldset></form>
<form id="legend-question" class="questionLi"><h3><span class="colorShallow">填空题</span>6乘7等于多少？</h3><fieldset disabled><legend><input type="text" name="first"></legend><input type="text" name="blocked"><legend><input type="text" name="second"></legend></fieldset></form>
<div id="disabled-editor-question" class="questionLi"><h3><span class="colorShallow">填空题</span>填写答案</h3><fieldset disabled><textarea id="disabled-editor" name="editor-answer" style="display:none"></textarea></fieldset><iframe srcdoc="<body contenteditable='true'>unchanged editor</body>"></iframe></div>
${choice('svg-stem', `如图，阴影部分的面积是多少？${svg}`)}
${choice('canvas-stem', `根据下图判断递增区间？${canvas}`)}
${choice('svg-option', '选择面积最大的图形', `10${svg}`)}
${choice('canvas-option', '选择递增的函数图形', `10${canvas}`)}
${choice('literal-question', '解释&lt;svg&gt;与&lt;canvas&gt;，当x&lt;b且b&gt;0时求x<sup>2</sup>与H<sub>2</sub>O', '&lt;svg&gt;是标签名')}
<pre id="review-result"></pre><script>
const __publicField=(object,key,value)=>Object.defineProperty(object,key,{configurable:true,enumerable:true,writable:true,value});
const _unsafeWindow=window;
const useLogStore=()=>({addLog(){}});
const useQuestionStore=()=>({addQuestion(){}});
const sleep=async()=>{};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const apiError=message=>({success:false,error:{message},data:null});
const config={ai:{apiKey:'offline-key',model:'offline-model'},otherParams:{params:[{value:0}]}};
const useConfigStore=()=>config;
const requests=[];
const _GM_xmlhttpRequest=request=>{
  const input=JSON.parse(JSON.parse(request.data).input);requests.push(input);
  const answer={answerable:true,choice_indices:input.type==='single'?[0]:[],text_answers:input.type==='blank'?['42']:[],judgement:'unknown',explanation:'offline fixture'};
  queueMicrotask(()=>request.onload({status:200,responseText:JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]})}));
  return {abort(){request.onabort?.();}};
};
${extract}
const stripOptionLabel=text=>text.replace(/^\\s*[A-Za-z]\\s*[.．、:：\\]\\)]/, '');
const stripQuestionTypeLabel=text=>text;
const extractJudgementToken=()=>null;
${adapter}
${integration}
${handlers}
window.addEventListener('load',async()=>{
  try {
    const editorQuestion=document.getElementById('disabled-editor-question');
    const editorSource=editorQuestion.querySelector('textarea');
    const editorBody=editorQuestion.querySelector('iframe').contentDocument.body;
    const editor={id:'disabled-editor',isReady:true,body:editorBody,setContent(markup){editorBody.innerHTML=markup;},getContentTxt(){return editorBody.textContent;}};
    window.UE={instants:{existing:editor}};
    const handler=new CxQuestionHandler('zy');handler.parseHtml();
    const byId=id=>handler.questions.find(question=>question.element.id===id);
    const disabled=byId('disabled-question');
    const field=disabled.element.querySelector('input');
    const disabledResult=await getAnswer({...disabled,type:'2'},{skipDelay:true});
    const disabledFilled=await applyAiAnswers({...disabled,type:'2',answer:['42']},window,'zy');
    const legend=byId('legend-question');
    const legendResult=await getAnswer(legend,{skipDelay:true});
    legend.answer=legendResult.data.items[0].answer.values;
    const legendFilled=await applyAiAnswers(legend,window,'zy');
    const visual=[];
    for(const id of ['svg-stem','canvas-stem','svg-option','canvas-option']){
      const question=byId(id),before=requests.length;
      const result=await getAnswer(question,{skipDelay:true});
      visual.push({id,apiSuccess:result.success,sent:requests.length-before,stem:question.searchText.stem,options:question.searchText.options,error:result.error?.message});
    }
    const editorResult=await getAnswer({...byId('disabled-editor-question'),type:'2'},{skipDelay:true});
    const editorFilled=await applyAiAnswers({...byId('disabled-editor-question'),type:'2',answer:['changed editor']},window,'zy');
    const literal=byId('literal-question');
    const literalResult=await getAnswer(literal,{skipDelay:true});
    const output={
      disabled:{ownDisabled:field.disabled,effectivelyDisabled:field.matches(':disabled'),count:aiAnswerFields(disabled).length,apiSuccess:disabledResult.success,reportedFilled:disabledFilled,value:field.value,submitted:new FormData(disabled.element).has('answer')},
      legend:{type:legend.type,count:aiAnswerFields(legend).length,apiSuccess:legendResult.success,reportedFilled:legendFilled,values:[...legend.element.querySelectorAll('input')].map(input=>input.value),effective:[...legend.element.querySelectorAll('input')].map(input=>input.matches(':disabled')),submitted:[...new FormData(legend.element).entries()]},
      editor:{ownDisabled:editorSource.disabled,effectivelyDisabled:editorSource.matches(':disabled'),count:aiAnswerFields(byId('disabled-editor-question')).length,found:!!aiExistingEditorForField(editorSource,window),apiSuccess:editorResult.success,reportedFilled:editorFilled,body:editorBody.textContent},
      visual,
      literal:{apiSuccess:literalResult.success,input:requests.at(-1)},
      requests:requests.length
    };
    document.getElementById('review-result').textContent=JSON.stringify(output);
  } catch(error){document.getElementById('review-result').textContent=JSON.stringify({error:String(error),stack:error.stack});}
});
</script>`;
fs.writeFileSync(fixture,page);
const browser=String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const result=spawnSync(browser,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+path.join(temp,'profile'),'--virtual-time-budget=2500','--dump-dom',pathToFileURL(fixture).href],{encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,windowsHide:true});
assert.ifError(result.error);
const match=result.stdout.match(/<pre id="review-result">(.*?)<\/pre>/s);
assert.ok(match,result.stderr.slice(-1000));
const output=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
assert.equal(output.error,undefined,JSON.stringify(output));
assert.deepEqual(output.disabled,{ownDisabled:false,effectivelyDisabled:true,count:0,apiSuccess:false,reportedFilled:false,value:'',submitted:false});
assert.deepEqual(output.legend,{type:'2',count:1,apiSuccess:true,reportedFilled:true,values:['42','',''],effective:[false,true,true],submitted:[['first','42']]});
assert.deepEqual(output.editor,{ownDisabled:false,effectivelyDisabled:true,count:0,found:false,apiSuccess:false,reportedFilled:false,body:'unchanged editor'});
for(const visual of output.visual){
  assert.equal(visual.apiSuccess,false,JSON.stringify(visual));
  assert.equal(visual.sent,0,JSON.stringify(visual));
  assert.match(visual.error,/非文字/);
  const marked=visual.id.endsWith('stem')?visual.stem:visual.options.join('');
  assert.match(marked,/\uFFFC\[ai-visual:(?:svg|canvas)\]\uFFFC/);
}
assert.equal(output.literal.apiSuccess,true);
assert.equal(output.literal.input.stem,'解释<svg>与<canvas>，当x<b且b>0时求x^(2)与H_(2)O');
assert.deepEqual(output.literal.input.options,['<svg>是标签名','20']);
assert.equal(output.requests,2);
console.log(JSON.stringify(output,null,2));
