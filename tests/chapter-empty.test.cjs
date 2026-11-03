'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reuse the existing document-boundary fixture without executing its tests or
// adding production-only exports. This keeps task ownership identical to the
// chapter-completion regression suite.
const fixturePath = path.join(__dirname, 'chapter-completion.test.cjs');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const fixtureEnd = fixtureSource.indexOf('\nconst navigationClicks =');
assert.ok(fixtureEnd > 0, 'Chapter completion fixture boundary must exist');
const fixtures = { require, __dirname, URL, AbortController };
vm.runInNewContext(fixtureSource.slice(0, fixtureEnd) +
  '\nglobalThis.helpers = { harness, Element, addFrame, addVideo };', fixtures,
  { filename: fixturePath });
const { harness, Element, addFrame, addVideo } = fixtures.helpers;

function emptyChapter(options) {
  const h = harness(options);
  h.advanceTime(-2000);
  return h;
}
const clicks = h => h.focus.clicks + h.next.clicks;
async function settle(h) {
  await h.complete();
  assert.equal(clicks(h), 0, 'A first observation must not skip a still-initializing chapter');
  h.advanceTime(10000);
}

function platformEmptyWithAudition(options) {
  const h = emptyChapter(options);
  const wrap = h.chapterBody.append(new Element('div', { class: 'wrap' }));
  const content = wrap.append(new Element('div', { class: 'ans-cc' }));
  const marker = content.append(new Element('div', { class: 'nullpage' }));
  const list = marker.append(new Element('dl'));
  const message = list.append(new Element('dd'));
  marker.innerText = message.innerText = '暂无内容';
  const audio = wrap.append(new Element('audio', { id: 'auditionAudio' }));
  audio.style.display = 'none';
  audio.currentSrc = '';
  audio.srcObject = null;
  h.chapterBody.innerText = '暂无内容';
  h.chapterBody.innerHTML = '<div class="wrap"><div class="ans-cc"><div class="nullpage"><dl><dd>暂无内容</dd></dl></div></div><audio id="auditionAudio" style="display:none"></audio></div>';
  return Object.assign(h, { wrap, content, marker, list, message, audio });
}

test('a loaded cards page with no tasks advances once after its observation window', async () => {
  const h = emptyChapter();
  assert.equal(h.inspectChapterCompletion(h.root).tasks.length, 0);
  await settle(h);
  await h.complete();
  await h.complete();
  assert.equal(h.focus.clicks, 1);
  assert.equal(h.next.clicks, 0);
  assert.ok(h.logs.some(message => /空白|无任务|没有任务/.test(message)), 'Diagnostics should distinguish an empty chapter from completed tasks');
});

test('a chapter containing only ungraded text can continue without a model request or task marker', async () => {
  const h = emptyChapter();
  const paragraph = h.chapterBody.append(new Element('p'));
  paragraph.textContent = '本节导读：下一节开始学习。';
  h.chapterBody.innerHTML = '<p>本节导读：下一节开始学习。</p>';
  await settle(h);
  await h.complete();
  assert.equal(clicks(h), 1);
});

test('about:blank, loading and inaccessible main chapter documents cannot be called empty', async () => {
  for (const state of ['blank', 'loading', 'null', 'cross-origin']) {
    const h = emptyChapter();
    if (state === 'blank') h.rootFrame.contentDocument.URL = 'about:blank';
    if (state === 'loading') h.rootFrame.contentDocument.readyState = 'loading';
    if (state === 'null') h.rootFrame.contentDocument = null;
    if (state === 'cross-origin') Object.defineProperty(h.rootFrame, 'contentDocument', { get() { throw Error('Cross-origin'); } });
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, state);
    assert.equal(h.canAdvanceChapter(h.root), false, state);
  }
});

test('a chapter root that is missing or ambiguous is never treated as an empty chapter', async () => {
  for (const state of ['missing', 'ambiguous']) {
    const h = emptyChapter();
    if (state === 'missing') h.rootFrame.remove();
    else addFrame(h.outer.body, 'https://course.test/mooc-ans/knowledge/cards?knowledgeid=2');
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, state);
  }
});

test('task attachment and job-icon placeholders block empty navigation before their iframes arrive', async () => {
  const resources = [
    ['div', { class: 'ans-attach-ct' }], ['div', { class: 'ans-job-icon' }],
    ['div', { class: 'ans-attach-ct ans-job-finished' }],
    ['div', { 'data-module': 'video' }], ['div', { 'data-objectid': 'not-yet-attached' }],
    ['video', {}], ['audio', {}], ['object', {}], ['embed', {}]
  ];
  for (const [tag, attributes] of resources) {
    const h = emptyChapter();
    h.chapterBody.append(new Element(tag, attributes));
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, tag + JSON.stringify(attributes));
  }
});

test('an unloaded nested frame still blocks an otherwise taskless chapter', async () => {
  for (const state of ['blank', 'loading', 'inaccessible']) {
    const h = emptyChapter();
    const child = addFrame(h.chapterBody, 'https://course.test/delayed-content');
    if (state === 'blank') child.contentDocument.URL = 'about:blank';
    if (state === 'loading') child.contentDocument.readyState = 'loading';
    if (state === 'inaccessible') child.contentDocument = null;
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, state);
  }
});

test('automatic navigation remains optional for a confirmed empty chapter', async () => {
  const h = emptyChapter();
  h.config.platformParams.cx.parts[0].params[1].value = false;
  await settle(h);
  await h.complete();
  assert.equal(clicks(h), 0);
});

test('time spent loading does not count toward the empty-chapter observation window', async () => {
  const h = emptyChapter();
  h.rootFrame.contentDocument.readyState = 'loading';
  await h.complete();
  h.advanceTime(10000);
  await h.complete();
  h.rootFrame.contentDocument.readyState = 'complete';
  await h.complete();
  assert.equal(clicks(h), 0, 'A newly loaded document may still attach its tasks');
  h.advanceTime(10000);
  await h.complete();
  assert.equal(clicks(h), 1);
});

test('removing a delayed attachment placeholder starts a fresh empty observation window', async () => {
  const h = emptyChapter();
  const placeholder = h.chapterBody.append(new Element('div', { class: 'ans-attach-ct' }));
  await h.complete();
  h.advanceTime(10000);
  await h.complete();
  placeholder.remove();
  await h.complete();
  assert.equal(clicks(h), 0, 'Removing the placeholder must not immediately skip an incoming task');
  h.advanceTime(10000);
  await h.complete();
  assert.equal(clicks(h), 1);
});

test('a late unfinished task cancels pending empty-chapter navigation', async () => {
  let release;
  const h = emptyChapter({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  addVideo(h.chapterBody);
  release();
  await pending;
  assert.equal(clicks(h), 0);
});

test('a late task placeholder cancels navigation even when the iframe list did not change', async () => {
  let release;
  const h = emptyChapter({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.chapterBody.append(new Element('div', { class: 'ans-attach-ct' }));
  release();
  await pending;
  assert.equal(clicks(h), 0);
});

test('turning off automatic navigation during the delay still cancels an empty chapter', async () => {
  let release;
  const h = emptyChapter({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.config.platformParams.cx.parts[0].params[1].value = false;
  release();
  await pending;
  assert.equal(clicks(h), 0);
});

test('a cards document becoming about:blank during the delay cancels empty navigation', async () => {
  let release;
  const h = emptyChapter({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.rootFrame.contentDocument.URL = 'about:blank';
  release();
  await pending;
  assert.equal(clicks(h), 0);
});

test('visible loading, error and login controls are not accepted as an empty chapter', async () => {
  for (const [tag, attributes] of [
    ['div', { 'aria-busy': 'true' }], ['div', { 'data-loading': 'true' }],
    ['div', { class: 'loading' }], ['div', { class: 'el-loading-mask' }],
    ['div', { class: 'error-page' }], ['div', { 'data-load-error': '' }],
    ['input', { type: 'password' }]
  ]) {
    const h = emptyChapter();
    h.chapterBody.append(new Element(tag, attributes));
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, tag + JSON.stringify(attributes));
  }
  const h = emptyChapter();
  h.rootFrame.contentDocument.title = '加载失败，请稍后重试';
  await settle(h);
  await h.complete();
  assert.equal(clicks(h), 0, 'A loaded error title must not count as course content');
});

test('hidden loading and error indicators do not permanently block a loaded taskless chapter', async () => {
  for (const className of ['loading', 'error-page']) {
    const h = emptyChapter();
    const indicator = h.chapterBody.append(new Element('div', { class: className }));
    indicator.style.display = 'none';
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 1, className);
  }
});

test('visible loading and error indicators still block when they are noninteractive or aria-hidden', async () => {
  for (const className of ['loading', 'error-page']) {
    for (const mode of ['pointer-events-none', 'disabled-property', 'disabled-attribute', 'disabled-class', 'aria-hidden']) {
      const h = emptyChapter();
      const indicator = h.chapterBody.append(new Element('div', { class: className }));
      if (mode === 'pointer-events-none') indicator.style.pointerEvents = 'none';
      if (mode === 'disabled-property') indicator.disabled = true;
      if (mode === 'disabled-attribute') indicator.setAttribute('disabled', '');
      if (mode === 'disabled-class') indicator.className += ' disabled';
      if (mode === 'aria-hidden') indicator.setAttribute('aria-hidden', 'true');
      await settle(h);
      await h.complete();
      assert.equal(clicks(h), 0, className + ' ' + mode);
    }
  }
});

test('a cards iframe whose actual document is about:srcdoc cannot be confirmed empty', async () => {
  const h = emptyChapter();
  h.rootFrame.contentDocument.URL = 'about:srcdoc';
  await settle(h);
  await h.complete();
  assert.equal(clicks(h), 0);
  assert.equal(h.canAdvanceChapter(h.root), false);
});

test('a loaded redirect away from the cards document remains blocked', async () => {
  for (const url of ['https://course.test/login', 'https://course.test/error', 'https://course.test/unknown']) {
    const h = emptyChapter();
    h.rootFrame.contentDocument.URL = url;
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, url);
  }
});

test('changing taskless chapter markup restarts observation and never exports that content into logs', async () => {
  const h = emptyChapter();
  h.chapterBody.innerHTML = '<p>private-before-empty-content</p>';
  await h.complete();
  h.advanceTime(4000);
  h.chapterBody.innerHTML = '<p>private-after-empty-content</p>';
  await h.complete();
  h.advanceTime(2000);
  await h.complete();
  assert.equal(clicks(h), 0, 'Two seconds of unchanged new markup is not enough');
  h.advanceTime(4000);
  await h.complete();
  assert.equal(clicks(h), 1);
  assert.ok(!h.logs.some(message => /private-(?:before|after)-empty-content/.test(message)));
});

test('a reused document cannot carry its old empty observation window into another chapter URL', async () => {
  for (const mode of ['iframe-src', 'document-url']) {
    const h = emptyChapter();
    await h.complete();
    h.advanceTime(10000);
    const nextUrl = 'https://course.test/mooc-ans/knowledge/cards?knowledgeid=2&courseid=1';
    if (mode === 'iframe-src') h.rootFrame.src = nextUrl;
    else h.rootFrame.contentDocument.URL = nextUrl;
    await h.complete();
    assert.equal(clicks(h), 0, mode);
    h.advanceTime(10000);
    await h.complete();
    assert.equal(clicks(h), 1, mode);
  }
});

test('markup changing during the navigation interval cancels the pending empty route', async () => {
  let release;
  const h = emptyChapter({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.chapterBody.innerHTML = '<p>New content is still arriving.</p>';
  release();
  await pending;
  assert.equal(clicks(h), 0);
});

test('the real Chaoxing empty marker and hidden source-less audition helper advance once after five seconds', async () => {
  const h = platformEmptyWithAudition();
  const initial = h.inspectChapterCompletion(h.root);
  assert.equal(initial.empty, true);
  assert.equal(initial.emptyReady, false);
  assert.equal(initial.tasks.length, 0);
  await h.complete();
  h.advanceTime(4999);
  await h.complete();
  assert.equal(clicks(h), 0);
  h.advanceTime(1);
  await h.complete();
  await h.complete();
  assert.equal(h.focus.clicks, 1);
  assert.equal(h.next.clicks, 0);
});

test('auditionAudio is not exempt without a visible platform empty marker', async () => {
  for (const mode of ['missing', 'hidden']) {
    const h = platformEmptyWithAudition();
    if (mode === 'missing') h.marker.remove();
    else h.marker.style.display = 'none';
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, mode);
    assert.equal(h.inspectChapterCompletion(h.root).empty, false, mode);
  }
});

test('the audition exception requires the observed empty-page structure and exact rendered text', async () => {
  for (const mode of ['wrong-wrapper', 'indirect-marker', 'helper-outside-wrapper', 'wrong-marker-text', 'wrong-dd-text', 'missing-dd']) {
    const h = platformEmptyWithAudition();
    if (mode === 'wrong-wrapper') h.wrap.className = 'other-wrapper';
    if (mode === 'indirect-marker') {
      const intermediary = h.content.append(new Element('section'));
      h.marker.remove();
      intermediary.append(h.marker);
    }
    if (mode === 'helper-outside-wrapper') {
      h.audio.remove();
      h.chapterBody.append(h.audio);
    }
    if (mode === 'wrong-marker-text') h.marker.innerText = '暂无内容，正在加载';
    if (mode === 'wrong-dd-text') h.message.innerText = '暂无任务';
    if (mode === 'missing-dd') h.message.remove();
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, mode);
  }
});

test('visible audio and differently named hidden helpers remain resources despite an empty marker', async () => {
  for (const mode of ['visible', 'wrong-id']) {
    const h = platformEmptyWithAudition();
    if (mode === 'visible') h.audio.style.display = '';
    else h.audio.setAttribute('id', 'differentAudio');
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, mode);
  }
});

test('an audition helper with any actual or declared source cannot be skipped', async () => {
  for (const mode of ['src', 'source-child', 'currentSrc', 'srcObject']) {
    const h = platformEmptyWithAudition();
    if (mode === 'src') h.audio.setAttribute('src', 'https://course.test/real-audio.mp3');
    if (mode === 'source-child') h.audio.append(new Element('source'));
    if (mode === 'currentSrc') h.audio.currentSrc = 'https://course.test/selected-audio.mp3';
    if (mode === 'srcObject') h.audio.srcObject = { active: true };
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, mode);
  }
});

test('an audition helper placed in a task wrapper cannot use the empty-page exception', async () => {
  for (const attributes of [{ class: 'ans-attach-ct' }, { class: 'ans-job-icon' }, { 'data-module': 'audio' }, { 'data-objectid': 'audio-task' }]) {
    const h = platformEmptyWithAudition();
    const task = h.wrap.append(new Element('div', attributes));
    h.audio.remove();
    task.append(h.audio);
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, JSON.stringify(attributes));
  }
});

test('other resources or unfinished tasks still block beside the genuine empty marker and audition helper', async () => {
  for (const resource of ['video', 'audio', 'object', 'embed', 'task-frame']) {
    const h = platformEmptyWithAudition();
    if (resource === 'task-frame') addVideo(h.wrap);
    else h.wrap.append(new Element(resource));
    await settle(h);
    await h.complete();
    assert.equal(clicks(h), 0, resource);
  }
});

test('a hidden audition helper acquiring a source during the operation delay cancels navigation', async () => {
  let release;
  const h = platformEmptyWithAudition({ wait: () => new Promise(resolve => { release = resolve; }) });
  await settle(h);
  const pending = h.complete();
  assert.equal(typeof release, 'function');
  h.audio.setAttribute('src', 'https://course.test/private-late-helper.mp3');
  release();
  await pending;
  assert.equal(clicks(h), 0);
  assert.ok(!h.logs.some(message => message.includes('private-late-helper.mp3')));
});
