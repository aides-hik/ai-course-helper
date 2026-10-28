'use strict';
// Regression checks for issues found during the strict review.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'ai-course-helper.user.js'), 'utf8');
const integration = fs.readFileSync(path.join(__dirname, '..', 'ai-integration.js'), 'utf8');
const adapter = fs.readFileSync(path.join(__dirname, '..', 'ai-adapter.js'), 'utf8');
const fieldHelpers = adapter.slice(adapter.indexOf('  const aiControlVisible = '), adapter.indexOf('  const aiBlankCount = '));
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function evaluate(code, globals) {
  const context = vm.createContext({useConfigStore:()=>({ai:{apiKey:'offline-fixture-key'}}), ...globals});
  vm.runInContext(code, context);
  return context;
}
const textNode = (text) => ({ nodeType: 3, nodeValue: text });
const element = (tag, children) => ({ nodeType: 1, tagName: tag, childNodes: children, getAttribute: () => null });

async function main() {
  {
    const context = evaluate(section('  function extractRawTextFromElement(', '  function stripOptionLabel(') + '\nglobalThis.extract=extractRawTextFromElement;', {});
    const markup = element('H3', [textNode('求x'), element('SUP', [textNode('2')]), textNode('的导数')]);
    const plain = context.extract(markup);
    assert.equal(plain, '求x^(2)的导数');
    console.log('PASS: superscript structure survives the actual DOM extraction path.');
  }
  {
    let flips = 0;
    const context = evaluate(section('  const useCxExamLogic = ', '  class ZhsQuestionHandler ') + '\nglobalThis.run=useCxExamLogic;', {
      useLogStore: () => ({ addLog() {} }),
      useQuestionStore: () => ({ clearQuestion() {} }),
      useConfigStore: () => ({ platformParams: { cx: { parts: [{}, { params: [{ value: true }] }] } }, otherParams: { params: [{ value: 0 }] } }),
      CxQuestionHandler: class { async init() { this.lastSolveResult = {cancelled:true,total:1,filled:0,complete:false,isCurrent:()=>false}; return 0; } },
      sleep: async () => {},
      clickNextStepButton: () => false,
      _unsafeWindow: { getTheNextQuestion() { flips += 1; } }
    });
    await context.run();
    assert.equal(flips, 0);
    console.log('PASS: exam stays in place after a cancelled or entirely unfilled solve.');
  }
  {
    const requestedTitles = [];
    const filledTitles = [];
    const secondTitle = { innerHTML: 'second question', textContent: 'second question' };
    const liveQuestion = (title, titleNode = { innerHTML: title, textContent: title }) => ({
      title, type: '0', answer: [],
      element: { isConnected: true, getAttribute: () => null, querySelector: () => titleNode, querySelectorAll: () => [] }
    });
    const first = liveQuestion('first question');
    const second = liveQuestion('second question', secondTitle);
    const handler = {
      parseHtml() { this.questions = [first, second]; },
      addQuestion() {}, addLog() {},
      async fillQuestion(question) { filledTitles.push({ snapshot: question.title, live: question.element.querySelector().textContent }); return true; }
    };
    const context = evaluate(fieldHelpers + integration + '\nglobalThis.solve=solveAiQuestions;', {
      window: { location: { href: 'https://example.chaoxing.com/exam' } },
      AbortController,
      setInterval: () => 1,
      clearInterval() {},
      vue: { reactive: (question) => question },
      getAnswer: async (question) => {
        requestedTitles.push(question.title);
        if (question.title === 'first question') {
          secondTitle.innerHTML = 'replacement question';
          secondTitle.textContent = 'replacement question';
        }
        return { values: ['answer'], meta: {} };
      },
      getAnswerValues: (result) => result.values
    });
    assert.equal(await context.solve(handler), 0);
    assert.deepEqual(requestedTitles, ['first question']);
    assert.deepEqual(filledTitles, []);
    assert.equal(handler.lastSolveResult.cancelled, true);
    assert.equal(handler.lastSolveResult.complete, false);
    assert.equal(handler.lastSolveResult.isCurrent(), false);
    console.log('PASS: every queued question is tied to its identity at parse time.');
  }
  {
    const visibleEditor = { text: 'unchanged visible editor' };
    const backingTextarea = {
      tagName: 'TEXTAREA', name: 'answer-name-not-editor-id', hidden: false, disabled: false,
      style: { display: 'none' }, getClientRects:()=>[], value: '', getAttribute: () => null, dispatchEvent() {}
    };
    const question = { type: '2', answer: ['new answer'], element: { isConnected: true, querySelectorAll: () => [backingTextarea] } };
    const context = evaluate(fieldHelpers + integration + '\nglobalThis.apply=applyAiAnswers;', { sleep: async () => {} });
    const result = await context.apply(question, {
      UE: { getEditor() { throw new Error('Editor id not found'); } },
      Event: class { constructor(type) { this.type = type; } }
    }, 'zj');
    assert.equal(result, false);
    assert.equal(backingTextarea.value, '');
    assert.equal(visibleEditor.text, 'unchanged visible editor');
    console.log('PASS: a hidden backing textarea cannot substitute for an unavailable rich editor.');
  }
  {
    const input = { tagName: 'INPUT', disabled: false, hidden: false, getAttribute: (key) => key === 'type' ? 'text' : null };
    const questionElement = {
      textContent: 'Fill the blank',
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === 'input') return [input];
        if (selector === 'textarea' || selector === '[contenteditable="true"]') return [];
        if (selector === 'input, textarea, [contenteditable="true"]') return [input];
        return [];
      }
    };
    const context = evaluate(
      section('  class BaseQuestionHandler {', '  class CxQuestionHandler extends BaseQuestionHandler {') +
      section('  const AI_RESPONSES_URL = ', '  const _sfc_main$8 = ') +
      '\nglobalThis.handler=new BaseQuestionHandler();globalThis.prepare=aiPrepareQuestion;',
      {
        document: {}, _unsafeWindow: {},
        __publicField: (object, key, value) => { object[key] = value; },
        useLogStore: () => ({ addLog() {} }), useQuestionStore: () => ({ addQuestion() {} }),
        isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
        extractRawTextFromHtml: String
      }
    );
    const type = context.handler.inferQuestionTypeByStructure(questionElement, [], []);
    assert.equal(type, '2');
    const prepared = context.prepare({type, title:'The answer is ___.', workType:'zy', element:questionElement});
    assert.equal(prepared.error, undefined);
    assert.equal(prepared.blankCount, 1);
    console.log('PASS: native input blanks use the same field enumeration for counting and filling.');
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
