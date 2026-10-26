'use strict';
// Use the real parser rules: writable-state changes can alter its inferred type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'userscript.template.js.in'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'ai-adapter.js'), 'utf8');
const chapter = fs.readFileSync(path.join(root, 'chapter-logic.js'), 'utf8');
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `source markers must exist: ${start}`);
  return source.slice(first, last);
}
const fieldHelpers = section(adapter, '  const aiControlVisible = ', '  const aiBlankCount = ');
const base = section(template, '  class BaseQuestionHandler {', '  class CxQuestionHandler extends BaseQuestionHandler {');
const fingerprint = section(chapter, '  const cxWorkFingerprint = ', '  const cxChapterNavigationAllowed = ');
const environment = {document:{}, _unsafeWindow:{},
  __publicField:(object, key, value)=>{object[key] = value;},
  useLogStore:()=>({addLog(){}}), useQuestionStore:()=>({addQuestion(){}})};
vm.runInNewContext(fieldHelpers + base + fingerprint + '\nglobalThis.api={Base:BaseQuestionHandler,fingerprint:cxWorkFingerprint};', environment);

function fixture() {
  const field = {tagName:'INPUT',type:'text',value:'',checked:false,readOnly:false,disabled:false,isConnected:true,
    getAttribute:(name)=>name === 'type' ? field.type : null,matches:()=>false};
  const element = {textContent:'A text question',
    querySelector:(selector)=>selector === 'input[type="checkbox"]' && field.type === 'checkbox' ? field : null,
    querySelectorAll:(selector)=>selector === 'input, textarea, [contenteditable="true"]' ? [field] : []};
  const handler = new environment.api.Base();
  let stem = 'A text question';
  handler.parseHtml = function () {
    this.questions.push({title:stem,searchText:{stem,options:[]},
      type:this.inferQuestionTypeByStructure(element,[],[]),element});
  };
  return {field,element,handler,stamp:()=>environment.api.fingerprint(handler),changeStem:(value)=>{stem = value;}};
}

test('a real inferred type change from writable text to unavailable text preserves logical work identity',()=>{
  const current = fixture();
  const before = current.stamp();
  assert.equal(current.handler.questions[0].type, '2');
  current.field.readOnly = true; current.field.disabled = true;
  const after = current.stamp();
  assert.equal(current.handler.questions[0].type, '8', 'this is the real parser behavior that exposed the regression');
  assert.equal(after, before, 'temporary answer-control availability must not restart the same work');
});

test('answer values, checked state and regenerated names do not change the work fingerprint',()=>{
  const current = fixture();
  const before = current.stamp();
  current.field.value = 'manually edited answer';current.field.checked = true;
  current.field.id = 'new-id';current.field.name = 'new-name';
  assert.equal(current.stamp(), before);
});

test('new question text and actual answer-control structure still permit new work',()=>{
  const current = fixture();
  const before = current.stamp();
  current.changeStem('A different question');assert.notEqual(current.stamp(), before);
  current.changeStem('A text question');assert.equal(current.stamp(), before);
  current.field.type = 'checkbox';assert.notEqual(current.stamp(), before);
  assert.equal(current.handler.questions[0].type, '1');
});

test('rich editor text changes do not enter a structural work fingerprint',()=>{
  const current = fixture();current.field.tagName = 'TEXTAREA';
  const before = current.stamp();
  current.field.value = 'first editor answer';
  assert.equal(current.stamp(), before);
  current.field.value = 'second editor answer';current.field.readOnly = true;
  assert.equal(current.stamp(), before);
});
