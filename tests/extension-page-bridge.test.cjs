const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function harness() {
  class Bus {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { if (!event.target) event.target = this; for (const callback of [...(this.listeners.get(event.type) || [])]) callback(event); if (event.bubbles && this.ownerDocument) this.ownerDocument.dispatchEvent(event); return true; }
  }
  class Node extends Bus {
    constructor(doc, tag) { super(); this.ownerDocument = doc; this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.hidden = false; this.isConnected = true; this.children = []; this.parentElement = null; this.id = ''; this.name = ''; }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }
    appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = true; this.ownerDocument.nodes.add(child); return child; }
    remove() { this.isConnected = false; this.ownerDocument.nodes.delete(this); }
    matches() { return false; }
    getClientRects() { return [{width: 30, height: 20}]; }
  }
  class Doc extends Bus {
    constructor(url) { super(); this.URL = url; this.nodes = new Set(); this.frames = []; this.documentElement = new Node(this, 'html'); this.nodes.add(this.documentElement); }
    createElement(tag) { const node = new Node(this, tag); if (tag === 'template') { node.content = {nodeType: 11, textContent: '', childNodes: []}; Object.defineProperty(node, 'innerHTML', {set(value) { this.content.html = value; this.content.textContent = value.replace(/<[^>]*>/g, ''); }}); } return node; }
    querySelectorAll(selector) { if (selector === 'iframe,frame') return this.frames; const match = selector.match(/^\[data-ai-course-extension-ref="([^"]+)"\]$/); return match ? [...this.nodes].filter(node => node.getAttribute('data-ai-course-extension-ref') === match[1]) : []; }
  }
  class CE { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  const document = new Doc('https://mooc1.chaoxing.com/mooc2/work/dowork');
  const window = new Bus();
  Object.assign(window, {document, parent: window, top: window, location: {href: document.URL, hostname: 'mooc1.chaoxing.com'}, getComputedStyle() { return {display: 'block', visibility: 'visible'}; }});
  document.defaultView = window;
  const context = vm.createContext({window, document, CustomEvent: CE, setTimeout, clearTimeout, console});
  vm.runInContext(`(() => { const _unsafeWindow = window; ${fs.readFileSync(path.join(root, 'page-hooks.js'), 'utf8')}\n${fs.readFileSync(path.join(root, 'extension/page-main.js'), 'utf8')} })();`, context);
  vm.runInContext(`(() => { ${fs.readFileSync(path.join(root, 'extension/page-bridge.js'), 'utf8')}\nglobalThis.bridge = extensionPageBridge; globalThis.BridgeInterceptor = XMLHttpRequestInterceptor; })();`, context);
  const add = (tag) => { const node = document.createElement(tag); document.documentElement.appendChild(node); return node; };
  return {context, document, window, bridge: context.bridge, add, CE, Doc, Node};
}

test('page bridge waits for acknowledged save promises and never invokes arbitrary page methods', async () => {
  const {window, bridge, document} = harness();
  let calls = 0;
  window.noSubmit = () => new Promise(resolve => setTimeout(() => { calls++; resolve({secret: 'must not return arbitrary objects'}); }, 5));
  assert.equal(await bridge.call(window, 'noSubmit'), true);
  assert.equal(calls, 1);
  window.stealCredentials = () => { throw new Error('must not run'); };
  await assert.rejects(bridge.call(window, 'stealCredentials'));
  await assert.rejects(bridge.call(window, 'noSubmit', ['unexpected']));
  assert.equal(document.documentElement.children.filter(node => node.isConnected).length, 0, 'temporary bridge request nodes removed');
});

test('editor bridge preserves facade identity and rejects an editor replaced during filling', () => {
  const {window, bridge, add} = harness();
  const field = add('textarea'); field.id = 'answer';
  const body = add('div'); body.textContent = '';
  let value = '';
  const editor = {textarea: field, body, setContent(markup) { value = markup; body.textContent = markup.replace(/<[^>]*>/g, ''); }, getContentTxt() { return body.textContent; }};
  window.UE = {instants: {answer: editor}, instances: {answer: editor}};
  const facade = bridge.editorForField(field);
  assert.ok(facade);
  assert.equal(bridge.editorForField(field), facade);
  facade.setContent('answer<br>text');
  assert.equal(value, 'answer<br>text');
  assert.equal(facade.getContentTxt(), 'answertext');
  assert.throws(() => facade.setContent('<script>alert(1)</script>'));
  const replacement = {...editor};
  window.UE = {instants: {answer: replacement}};
  assert.notEqual(bridge.editorForField(field), facade);
  assert.throws(() => facade.setContent('stale response'));
  assert.equal(value, 'answer<br>text');
});

test('ambiguous editors and duplicated element references are rejected', () => {
  const {window, bridge, add} = harness();
  const field = add('textarea'); field.id = 'answer';
  const body = add('div'); body.textContent = 'saved';
  const editor = {textarea: field, body, setContent() {}, getContentTxt() { return body.textContent; }};
  window.UE = {instants: {answer: editor, duplicate: {...editor}}};
  assert.equal(bridge.editorForField(field), null);
  window.UE = {instants: {answer: editor}};
  const facade = bridge.editorForField(field);
  const duplicate = add('textarea');
  duplicate.setAttribute('data-ai-course-extension-ref', field.getAttribute('data-ai-course-extension-ref'));
  assert.equal(bridge.editorForField(field), null);
  assert.throws(() => facade.getContentTxt());
});

test('same-origin nested editor iframe bodies resolve and stale frame documents cannot be reused', () => {
  const {window, document, bridge, Doc, Node} = harness();
  const questionDocument = new Doc('https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew');
  const questionFrame = new Node(document, 'iframe');
  document.documentElement.appendChild(questionFrame);
  document.frames.push(questionFrame);
  const questionWindow = {document: questionDocument, parent: window, frameElement: questionFrame, location: {href: questionDocument.URL}, getComputedStyle: window.getComputedStyle};
  questionDocument.defaultView = questionWindow;
  questionFrame.contentWindow = questionWindow;
  questionFrame.contentDocument = questionDocument;
  const editorDocument = new Doc('about:blank');
  const editorFrame = new Node(questionDocument, 'iframe');
  questionDocument.documentElement.appendChild(editorFrame);
  questionDocument.frames.push(editorFrame);
  const editorWindow = {document: editorDocument, parent: questionWindow, frameElement: editorFrame, location: {href: editorDocument.URL}, getComputedStyle: window.getComputedStyle};
  editorDocument.defaultView = editorWindow;
  editorFrame.contentWindow = editorWindow;
  editorFrame.contentDocument = editorDocument;
  const field = questionDocument.createElement('textarea'); field.id = 'answer';
  questionDocument.documentElement.appendChild(field);
  const body = editorDocument.createElement('body'); body.textContent = '';
  editorDocument.documentElement.appendChild(body);
  const editor = {textarea: field, body, setContent(value) {body.textContent = value;}, getContentTxt() {return body.textContent;}};
  questionWindow.UE = {instants: {answer: editor}};
  const facade = bridge.editorForField(field);
  assert.ok(facade);
  assert.equal(facade.body, body);
  facade.setContent('Nested answer');
  assert.equal(facade.getContentTxt(), 'Nested answer');
  let saves = 0;
  questionWindow.noSubmit = () => {saves++;};
  return bridge.call(questionWindow, 'noSubmit').then(() => {
    assert.equal(saves, 1);
    questionDocument.URL = 'https://mooc1.chaoxing.com/another-question';
    assert.throws(() => facade.setContent('Stale nested answer'));
    assert.equal(body.textContent, 'Nested answer');
  });
});

test('hidden rendered question content is read afresh and never requested on ordinary pages', () => {
  const {window, bridge, add, document} = harness();
  const title = add('div'); title.__Ivue__ = {_data: {shadowDom: '<b>First question</b>'}};
  assert.equal(bridge.shadow(title), null);
  assert.equal(title.getAttribute('data-ai-course-extension-ref'), null);
  window.location.hostname = 'examh5.zhihuishu.com';
  assert.equal(bridge.shadow(title).textContent, 'First question');
  title.__Ivue__._data.shadowDom = '<b>Next question</b>';
  assert.equal(bridge.shadow(title).textContent, 'Next question');
  title.isConnected = false;
  assert.equal(bridge.shadow(title), null);
  assert.equal(document.documentElement.children.filter(node => node.tagName === 'SPAN' && node.isConnected).length, 0);
});

test('next question and book operations have fixed arguments and no arbitrary return serialization', async () => {
  const {window, bridge} = harness();
  const calls = [];
  window.getTheNextQuestion = value => calls.push(['next', value]);
  window.getFrameAttr = value => {calls.push(['get', value]); return 42;};
  window.onchangepage = value => calls.push(['book', value]);
  assert.equal(bridge.nextQuestion(), true);
  assert.equal(await bridge.book(window), true);
  assert.deepEqual(calls, [['next', 1], ['get', 'end'], ['book', 42]]);
  delete window.getTheNextQuestion;
  assert.equal(bridge.nextQuestion(), false);
});

test('XHR bridge cancels for BFCache, resumes once and detaches on disposal', () => {
  const {context, document, window, CE} = harness();
  const phases = [];
  const interceptor = new context.BridgeInterceptor(['gateway/t/v1/answer/hasAnswer'], (_response, phase) => phases.push(phase));
  const notify = phase => document.dispatchEvent(new CE('ai-course-extension-page-activity', {detail: JSON.stringify({v: 1, phase})}));
  notify('start'); notify('load'); notify('unexpected');
  window.dispatchEvent(new CE('pagehide', {persisted: true}));
  notify('load');
  window.dispatchEvent(new CE('pageshow', {persisted: true}));
  interceptor.dispose(); notify('load');
  assert.deepEqual(phases, ['start', 'load', 'start', 'resume']);
});
