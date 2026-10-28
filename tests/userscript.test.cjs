'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const scriptPath = path.resolve(__dirname, '..', 'ai-course-helper.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const endpointSource = fs.readFileSync(path.resolve(__dirname, '..', 'ai-endpoints.js'), 'utf8');
const metadata = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);

function section(start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `Missing source section: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `Missing source section boundary: ${end}`);
  return source.slice(first, last);
}

function evaluate(code, context = {}) {
  const sandbox = vm.createContext({ URL, ...context });
  vm.runInContext(endpointSource + '\n' + code, sandbox, { timeout: 1000 });
  return sandbox;
}

test('the installable userscript has valid JavaScript syntax', () => {
  assert.ok(metadata, 'Userscript metadata must be present');
  assert.doesNotThrow(() => new vm.Script(source, { filename: scriptPath }));
});

test('network metadata permits the official providers and user-configured endpoints without original updates', () => {
  const connections = [...metadata[1].matchAll(/^\/\/\s*@connect\s+(\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(connections.sort(), ['*', 'api.deepseek.com', 'api.openai.com']);
  assert.doesNotMatch(metadata[1], /^\/\/\s*@(downloadURL|updateURL)\b/gm);
  assert.match(metadata[1], /^\/\/\s*@namespace\s+local\.openai\.course-helper\s*$/m);
});

test('the shipped script contains no original question-bank or announcement endpoints', () => {
  assert.doesNotMatch(source, /(?:search|api)\.tikuhai\.com|cx\.icodef\.com|62\.234\.36\.191/i);
});

test('the installable artifact embeds the adapter exercised by its dedicated tests', () => {
  const adapter = fs.readFileSync(path.resolve(__dirname, '..', 'ai-adapter.js'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(source.replace(/\r\n/g, '\n').includes(adapter), 'Embedded adapter has drifted from the tested adapter');
});

function configurationHarness(seed = {}) {
  const values = new Map(Object.entries(seed));
  const reads = [];
  const writes = [];
  const pageStorageWrites = [];
  const context = evaluate(
    `${section('  const CONFIG_STORAGE_KEY = ', '  const formatDateTime = ')}
     globalThis.configuration = { useConfigStore, persistConfig, storageKey: CONFIG_STORAGE_KEY };`,
    {
      VIDEO_QUIZ_SETTING: '视频弹题自动处理',
      console,
      getScriptInfo: () => ({ version: 'test-version' }),
      _GM_getValue(key, fallback) {
        reads.push(key);
        return values.has(key) ? values.get(key) : fallback;
      },
      _GM_setValue(key, value) {
        writes.push({ key, value });
        values.set(key, value);
      },
      localStorage: {
        getItem: () => null,
        setItem: (...args) => pageStorageWrites.push(args)
      },
      pinia: {
        defineStore(_name, definition) {
          let state;
          return () => state ??= definition.state();
        }
      }
    }
  );
  const config = context.configuration.useConfigStore();
  return { ...context.configuration, config, reads, writes, pageStorageWrites, values };
}

test('fresh configuration stores the API key only in independent userscript storage', () => {
  const harness = configurationHarness();
  assert.ok(harness.storageKey);
  assert.ok(!['config', 'globalConfig'].includes(harness.storageKey));
  assert.equal(harness.config.ai.apiKey, '');
  assert.equal(harness.config.ai.provider, 'openai');
  assert.equal(harness.config.ai.deepseekApiKey, '');
  assert.equal(harness.config.ai.deepseekModel, 'deepseek-flash');
  assert.equal(harness.config.ai.reasoningEffort, 'default');
  assert.equal(harness.config.ai.deepseekReasoningEffort, 'default');
  assert.equal(harness.config.ai.apiUrl, 'https://api.openai.com/v1/responses');
  assert.equal(harness.config.ai.modelsUrl, '');
  assert.equal(harness.config.ai.deepseekApiUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(harness.config.ai.deepseekModelsUrl, '');
  harness.config.ai.apiKey = 'SENTINEL-API-KEY-DO-NOT-LEAK';
  harness.config.ai.deepseekApiKey = 'SENTINEL-DEEPSEEK-KEY-DO-NOT-LEAK';
  harness.persistConfig(harness.config);
  assert.ok(harness.writes.some(({ value }) => JSON.stringify(value).includes('SENTINEL-API-KEY-DO-NOT-LEAK')));
  assert.ok(harness.writes.some(({ value }) => JSON.stringify(value).includes('SENTINEL-DEEPSEEK-KEY-DO-NOT-LEAK')));
  assert.ok(harness.writes.every(({ key }) => key.startsWith(harness.storageKey + ':field:')));
  assert.deepEqual(harness.pageStorageWrites, []);
});

test('upgrading existing userscript settings preserves OpenAI credentials and adds independent DeepSeek defaults', () => {
  const storageKey = 'openai-course-helper:config:v1';
  const olderConfiguration = {
    version: '0.1.0',
    ai: { apiKey: 'EXISTING-OPENAI-KEY', model: 'existing-openai-model', timeoutSeconds: 180, maxOutputTokens: 4096 }
  };
  const harness = configurationHarness({ [storageKey]: JSON.stringify(olderConfiguration) });
  assert.equal(harness.storageKey, storageKey);
  assert.equal(harness.config.ai.apiKey, 'EXISTING-OPENAI-KEY');
  assert.equal(harness.config.ai.model, 'existing-openai-model');
  assert.equal(harness.config.ai.timeoutSeconds, 180);
  assert.equal(harness.config.ai.maxOutputTokens, 4096);
  assert.equal(harness.config.ai.provider, 'openai');
  assert.equal(harness.config.ai.deepseekApiKey, '');
  assert.equal(harness.config.ai.deepseekModel, 'deepseek-flash');
  assert.equal(harness.config.ai.reasoningEffort, 'default');
  assert.equal(harness.config.ai.deepseekReasoningEffort, 'default');
  assert.equal(harness.config.ai.apiUrl, 'https://api.openai.com/v1/responses');
  assert.equal(harness.config.ai.modelsUrl, '');
  assert.equal(harness.config.ai.deepseekApiUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(harness.config.ai.deepseekModelsUrl, '');
  assert.equal(harness.config.version, 'test-version');
  assert.deepEqual(harness.pageStorageWrites, []);
});

test('saving and restoring DeepSeek settings preserves both providers without copying credentials', () => {
  const harness = configurationHarness();
  Object.assign(harness.config.ai, {
    provider: 'deepseek', apiKey: 'OPENAI-ONLY', model: 'openai-model',
    deepseekApiKey: 'DEEPSEEK-ONLY', deepseekModel: 'custom-deepseek-model',
    reasoningEffort: 'medium', deepseekReasoningEffort: 'max',
    apiUrl: 'https://openai-gateway.example/v1/responses', modelsUrl: 'https://openai-gateway.example/catalog',
    deepseekApiUrl: 'https://deepseek-gateway.example/v1/chat/completions', deepseekModelsUrl: ''
  });
  harness.persistConfig(harness.config);
  const restored = configurationHarness(Object.fromEntries(harness.values));
  assert.equal(restored.config.ai.provider, 'deepseek');
  assert.equal(restored.config.ai.apiKey, 'OPENAI-ONLY');
  assert.equal(restored.config.ai.model, 'openai-model');
  assert.equal(restored.config.ai.deepseekApiKey, 'DEEPSEEK-ONLY');
  assert.equal(restored.config.ai.deepseekModel, 'custom-deepseek-model');
  assert.equal(restored.config.ai.reasoningEffort, 'medium');
  assert.equal(restored.config.ai.deepseekReasoningEffort, 'max');
  assert.equal(restored.config.ai.apiUrl, 'https://openai-gateway.example/v1/responses');
  assert.equal(restored.config.ai.modelsUrl, 'https://openai-gateway.example/catalog');
  assert.equal(restored.config.ai.deepseekApiUrl, 'https://deepseek-gateway.example/v1/chat/completions');
  assert.equal(restored.config.ai.deepseekModelsUrl, '');
});

test('legacy configuration cannot silently import a credential or enable submission', () => {
  const legacy = JSON.stringify({
    ai: { apiKey: 'LEGACY-CREDENTIAL' },
    queryApis: [{ token: 'LEGACY-CREDENTIAL' }],
    platformParams: { cx: { parts: [{ name: '章节设置', params: [{ name: '章节作业自动提交', value: true }] }] } }
  });
  const harness = configurationHarness({ config: legacy, globalConfig: legacy });
  assert.doesNotMatch(JSON.stringify(harness.config), /LEGACY-CREDENTIAL/);
  assert.ok(harness.reads.every((key) => !['config', 'globalConfig'].includes(key)));
  const submissionSettings = harness.config.platformParams.cx.parts.flatMap((part) => part.params).filter((param) => /自动提交/.test(param.name));
  assert.ok(submissionSettings.length > 0, 'There must be an explicit submission setting');
  assert.ok(submissionSettings.every((param) => param.value === false));
});

test('all automatic submission and question switching controls start disabled', () => {
  const { config } = configurationHarness();
  const controls = Object.values(config.platformParams).flatMap((platform) => platform.parts.flatMap((part) => part.params));
  const automatic = controls.filter((param) => /自动提交|自动切换|自动下一章节|视频弹题自动处理/.test(param.name));
  assert.ok(automatic.length >= 5, 'Submission, chapter navigation, exam navigation and video quiz controls must be explicit');
  for (const control of automatic) assert.equal(control.value, false, `${control.name} must require explicit opt-in`);
});

function questionHandlerHarness() {
  const context = evaluate(
    `${section('  class BaseQuestionHandler {', '  class CxQuestionHandler extends BaseQuestionHandler {')}
     globalThis.handler = new BaseQuestionHandler();`,
    {
      document: {},
      _unsafeWindow: {},
      __publicField: (object, key, value) => { object[key] = value; },
      useConfigStore: () => ({ otherParams: { params: [{ name: '答案相似度', value: 85 }] } }),
      useLogStore: () => ({ addLog() {} }),
      useQuestionStore: () => ({ addQuestion() {} })
    }
  );
  return context.handler;
}

test('exact answer selection preserves opposite inequality signs', () => {
  const handler = questionHandlerHarness();
  const positive = { id: 'positive' };
  const negative = { id: 'negative' };
  const options = { 'x>0': positive, 'x<0': negative };
  assert.equal(handler.findMatchedOption(options, 'x>0'), positive);
  assert.equal(handler.findMatchedOption(options, 'x<0'), negative);
});

test('exact answer selection preserves encoded comparison operators', () => {
  const handler = questionHandlerHarness();
  const positive = { id: 'positive' };
  const negative = { id: 'negative' };
  const options = { 'x&gt;0': positive, 'x&lt;0': negative };
  assert.equal(handler.findMatchedOption(options, 'x&gt;0'), positive);
  assert.equal(handler.findMatchedOption(options, 'x&lt;0'), negative);
});

test('ambiguous normalized options are left for manual handling', () => {
  const handler = questionHandlerHarness();
  const first = { id: 'first' };
  const second = { id: 'second' };
  assert.equal(handler.findMatchedOption({ 'AB': first, 'ab': second }, 'aB'), null);
});

function renderQuestionTable(row) {
  const node = (type, props, children) => ({ type, props: props || {}, children });
  const vue = {
    defineComponent: (component) => component,
    createStaticVNode: (html) => node('static', {}, html),
    createElementVNode: node,
    createElementBlock: node,
    createVNode: node,
    createTextVNode: (text) => node('text', {}, text),
    Fragment: 'fragment',
    ref: (value) => ({ value }),
    unref: (value) => value,
    openBlock() {},
    renderList: (list, renderItem) => Array.from(list, (item, index) => renderItem(item, index)),
    withCtx: (callback) => callback,
    withDirectives: (vnode) => vnode,
    normalizeClass: (value) => value,
    resolveComponent: (name) => name,
    toDisplayString: String,
    vShow: 'show'
  };
  const context = evaluate(
    `${section('  const _hoisted_1$3 = ', '  const _export_sfc = ')}
     globalThis.table = _sfc_main$6;`,
    { vue, useConfigStore: () => configurationHarness().config }
  );
  const render = context.table.setup({ questionList: [row] });
  const tree = render({ questionList: [row] }, []);
  const nodes = [];
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    if ('type' in value) nodes.push(value);
    if (value.children && typeof value.children === 'object' && !Array.isArray(value.children)) {
      for (const slot of Object.values(value.children)) {
        if (typeof slot === 'function') collect(slot({ row }));
      }
    } else collect(value.children);
  }
  collect(tree);
  return nodes;
}

function aiSettingsHarness(ai) {
  const node = (type, props, children) => ({ type, props: props || {}, children });
  const vue = {
    defineComponent: (component) => component,
    reactive: (value) => value,
    watch: () => () => {},
    onBeforeUnmount: () => {},
    createElementVNode: node,
    createVNode: node,
    createTextVNode: (text) => node('text', {}, text),
    resolveComponent: (name) => name,
    computed: (getter) => ({ get value() { return getter(); } }),
    unref: (value) => value && 'value' in value ? value.value : value
  };
  const context = evaluate(
    `${section('  const _sfc_ai_config = ', '  const _sfc_main$6 = ')}
     globalThis.settings = _sfc_ai_config;`,
    { vue, useConfigStore: () => ({ ai }) }
  );
  const render = context.settings.setup();
  function nodes() {
    const result = [];
    function collect(value) {
      if (Array.isArray(value)) return value.forEach(collect);
      if (!value || typeof value !== 'object') return;
      if ('type' in value) result.push(value);
      if (value.children && typeof value.children === 'object' && !Array.isArray(value.children)) {
        for (const slot of Object.values(value.children)) if (typeof slot === 'function') collect(slot());
      } else collect(value.children);
    }
    collect(render());
    return result;
  }
  return { nodes };
}

test('the provider selector shows independent editable credentials and models without overwriting either provider', () => {
  const ai = {
    provider: 'openai', apiKey: 'OPENAI-ORIGINAL-KEY', model: 'openai-original-model',
    deepseekApiKey: 'DEEPSEEK-ORIGINAL-KEY', deepseekModel: 'deepseek-flash',
    timeoutSeconds: 120, maxOutputTokens: 8192
  };
  const harness = aiSettingsHarness(ai);
  const initial = harness.nodes();
  const selector = initial.find((node) => node.type === 'select' && node.props.value === 'openai');
  assert.ok(selector, 'A visible provider selector is required');
  const options = Array.from(selector.children, (node) => node.props.value).sort();
  assert.deepEqual(options, ['deepseek', 'openai']);
  selector.props.onChange({ target: { value: 'deepseek' } });
  assert.equal(ai.provider, 'deepseek');
  const deepseek = harness.nodes();
  const key = deepseek.find((node) => node.type === 'el-input' && node.props.modelValue === 'DEEPSEEK-ORIGINAL-KEY');
  const model = deepseek.find((node) => node.type === 'el-input' && node.props.modelValue === 'deepseek-flash');
  assert.ok(key, 'DeepSeek must expose its own key input');
  assert.ok(model, 'DeepSeek model must remain editable');
  assert.equal(key.props.type, 'password');
  assert.ok(!deepseek.some((node) => node.type === 'el-input' && node.props.modelValue === 'OPENAI-ORIGINAL-KEY'));
  key.props['onUpdate:modelValue']('DEEPSEEK-EDITED-KEY');
  model.props['onUpdate:modelValue']('custom-deepseek-model');
  assert.equal(ai.apiKey, 'OPENAI-ORIGINAL-KEY');
  assert.equal(ai.model, 'openai-original-model');
  const deepseekSelector = harness.nodes().find((node) => node.type === 'select');
  deepseekSelector.props.onChange({ target: { value: 'openai' } });
  const openai = harness.nodes();
  const openaiKey = openai.find((node) => node.type === 'el-input' && node.props.modelValue === 'OPENAI-ORIGINAL-KEY');
  const openaiModel = openai.find((node) => node.type === 'el-input' && node.props.modelValue === 'openai-original-model');
  assert.ok(openaiKey);
  assert.ok(openaiModel);
  openaiKey.props['onUpdate:modelValue']('OPENAI-EDITED-KEY');
  openaiModel.props['onUpdate:modelValue']('custom-openai-model');
  assert.equal(ai.deepseekApiKey, 'DEEPSEEK-EDITED-KEY');
  assert.equal(ai.deepseekModel, 'custom-deepseek-model');
});

test('editable request and model-list URLs switch independently and reset only the current service', () => {
  const ai = configurationHarness().config.ai;
  const harness = aiSettingsHarness(ai);
  const input = (className) => harness.nodes().find((node) => node.type === 'el-input' && node.props.class === className);
  const provider = () => harness.nodes().find((node) => node.type === 'select' && node.props.class === 'ai-provider-select');
  assert.equal(input('ai-request-url').props.modelValue, 'https://api.openai.com/v1/responses');
  input('ai-request-url').props['onUpdate:modelValue']('https://openai-gateway.example/v1/responses');
  input('ai-models-url').props['onUpdate:modelValue']('https://openai-gateway.example/catalog');
  provider().props.onChange({target:{value:'deepseek'}});
  assert.equal(input('ai-request-url').props.modelValue, 'https://api.deepseek.com/chat/completions');
  input('ai-request-url').props['onUpdate:modelValue']('http://localhost:8000/v1/chat/completions');
  input('ai-models-url').props['onUpdate:modelValue']('http://localhost:8000/catalog');
  const reset = harness.nodes().find((node) => node.props.class === 'ai-reset-urls');
  reset.props.onClick();
  assert.equal(ai.deepseekApiUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(ai.deepseekModelsUrl, '');
  assert.equal(ai.apiUrl, 'https://openai-gateway.example/v1/responses');
  assert.equal(ai.modelsUrl, 'https://openai-gateway.example/catalog');
  provider().props.onChange({target:{value:'openai'}});
  assert.equal(input('ai-request-url').props.modelValue, ai.apiUrl);
});

test('the installed DeepSeek adapter works with an empty OpenAI key and sends only the DeepSeek credential', async () => {
  const config = configurationHarness().config;
  Object.assign(config.ai, { provider: 'deepseek', apiKey: '', model: '', deepseekApiKey: 'DEEPSEEK-ONLY-KEY' });
  const calls = [];
  const answer = { answerable: true, choice_indices: [1], text_answers: [], judgement: 'unknown', explanation: '<b>literal explanation</b>' };
  const context = evaluate(
    `${section('  const isObject = ', '  function extractRawTextFromElement(')}
     ${section('  const AI_RESPONSES_URL = ', '  const _sfc_main$8 = ')}
     globalThis.answerQuestion = getAnswer;`,
    {
      useConfigStore: () => config,
      sleep: async () => {},
      setTimeout,
      clearTimeout,
      extractRawTextFromHtml: (text) => String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      _GM_xmlhttpRequest(request) {
        calls.push(request);
        request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }], usage: { total_tokens: 0 } }) });
        return { abort() {} };
      }
    }
  );
  const result = await context.answerQuestion({ title: '选择正确表达式', type: '0', optionsText: ['x>0', 'x<0'] }, { skipDelay: true });
  assert.equal(result.success, true, result.error?.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer DEEPSEEK-ONLY-KEY');
  const requestBody = JSON.parse(calls[0].data);
  assert.equal(requestBody.model, 'deepseek-flash');
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.items[0].answer.values)), ['x<0']);
  assert.equal(result.meta.provider, 'deepseek');
  assert.ok(!calls[0].data.includes('DEEPSEEK-ONLY-KEY'));
});

test('page entry starts ordinary task logic without credentials or changing the selected tab', () => {
  function enter(ai) {
    const events = [];
    let starts = 0;
    const configStore = { ai, menuIndex: '0' };
    const context = evaluate(
      `${section('      const executeLogicByUrl = ', '      executeLogicByUrl(url2);')}
       globalThis.enter = executeLogicByUrl;`,
      {
        configStore,
        ANSWER_TAB_NAME: '1',
        urlLogicPairs: [{ keyword: '/studentstudy', logic: () => { starts += 1; } }],
        updateVisible: (visible) => events.push(visible),
        logStore: { addLog() {} }
      }
    );
    context.enter('https://example.chaoxing.com/studentstudy');
    return { starts, events, configStore };
  }
  const deepseek = enter({ provider: 'deepseek', apiKey: '', model: '', deepseekApiKey: 'DEEPSEEK-KEY', deepseekModel: 'deepseek-flash' });
  assert.equal(deepseek.starts, 1);
  assert.deepEqual(deepseek.events, [true]);
  const defaultDeepseekModel = enter({ provider: 'deepseek', deepseekApiKey: 'DEEPSEEK-KEY', deepseekModel: '' });
  assert.equal(defaultDeepseekModel.starts, 1);
  const missingDeepseekModel = enter({ provider: 'deepseek', deepseekApiKey: 'DEEPSEEK-KEY' });
  assert.equal(missingDeepseekModel.starts, 1);
  const openai = enter({ provider: 'openai', apiKey: 'OPENAI-KEY', model: 'openai-model', deepseekApiKey: '', deepseekModel: '' });
  assert.equal(openai.starts, 1);
  const wrongKey = enter({ provider: 'deepseek', apiKey: 'OPENAI-KEY', model: 'openai-model', deepseekApiKey: '', deepseekModel: 'deepseek-flash' });
  assert.equal(wrongKey.starts, 1);
  assert.equal(wrongKey.configStore.menuIndex, '0');
  for (const ai of [{}, {provider:'openai',apiKey:'',model:''}, {provider:'deepseek',deepseekApiKey:''}, {provider:'other'}]) {
    const page = enter(ai);
    assert.equal(page.starts, 1);
    assert.deepEqual(page.events, [true]);
    assert.equal(page.configStore.menuIndex, '0');
  }
});

test('model answers, explanations, errors and question titles render as text', () => {
  const hostile = '<img src=x onerror="globalThis.unwantedExecution=true">';
  const row = {
    title: hostile,
    searchText: { stem: hostile },
    answer: [hostile],
    aiExplanation: hostile,
    fillError: hostile,
    answerStatus: 'success'
  };
  const nodes = renderQuestionTable(row);
  const textNodes = nodes.filter((node) => typeof node.props.textContent === 'string' && node.props.textContent.includes(hostile));
  assert.ok(textNodes.length >= 2, 'Question title and answer must both use safe text output');
  assert.ok(textNodes.some((node) => node.props.textContent.split(hostile).length >= 4), 'Answer, explanation and fill error must all remain text');
  for (const node of nodes) {
    assert.ok(!String(node.props.innerHTML || '').includes(hostile), 'Untrusted data must never reach innerHTML');
  }
});

test('failed page filling is not counted toward the submission threshold', async () => {
  const harness = solverHarness();
  const handler = harness.makeHandler([liveQuestion('cannot-fill'), liveQuestion('can-fill')]);
  const fillQuestion = handler.fillQuestion;
  handler.fillQuestion = async (question, current) => question.title === 'can-fill' && fillQuestion(question, current);
  assert.equal(await harness.solve(handler), 50);
  assert.equal(harness.rows[0].answerStatus, 'error');
  assert.equal(harness.rows[1].answerStatus, 'success');
  assert.equal(handler.lastSolveResult.total,2);
  assert.equal(handler.lastSolveResult.filled,1);
  assert.equal(handler.lastSolveResult.complete,false);
  assert.equal(handler.lastSolveResult.cancelled,false);
  assert.equal(handler.lastSolveResult.isCurrent(),true);
  assert.equal(harness.timers.size, 0);
});

function applicationHarness() {
  const context = evaluate(
    `${section('  const aiControlVisible = ', '  const aiBlankCount = ')}
     ${section('  const aiHasConfiguredKey = ', '  class BaseQuestionHandler {')}
     globalThis.applyAnswers = applyAiAnswers;`,
    { sleep: async () => {} }
  );
  return context.applyAnswers;
}

function choiceControl(overrides = {}) {
  return {
    isConnected: true,
    selected: false,
    clicks: 0,
    matches: () => false,
    querySelector: () => null,
    getAttribute(name) { return name === 'aria-checked' ? String(this.selected) : null; },
    click() { this.clicks += 1; this.selected = !this.selected; },
    ...overrides
  };
}

function textControl(overrides = {}) {
  return {
    name: 'answer-field',
    tagName: 'TEXTAREA',
    isConnected: true,
    disabled: false,
    hidden: false,
    value: '',
    events: [],
    getAttribute: () => null,
    dispatchEvent(event) { this.events.push(event.type); },
    set innerHTML(_value) { throw new Error('Untrusted answer must not be assigned to innerHTML'); },
    ...overrides
  };
}

function textQuestion(field, answer) {
  return { type: '2', answer: [answer], element: { isConnected: true, querySelectorAll: () => [field] } };
}

const pageWindow = { Event: class Event { constructor(type) { this.type = type; } } };

test('detached questions and detached options receive no clicks', async () => {
  const applyAnswers = applicationHarness();
  const control = choiceControl();
  const question = { type: '0', answer: ['selected'], options: { selected: control }, element: { isConnected: false } };
  const match = (options, answer) => options[answer];
  assert.equal(await applyAnswers(question, pageWindow, 'zj', match), false);
  assert.equal(control.clicks, 0);
  question.element.isConnected = true;
  control.isConnected = false;
  assert.equal(await applyAnswers(question, pageWindow, 'zj', match), false);
  assert.equal(control.clicks, 0);
});

test('a control exception becomes an unfilled result instead of rejecting the run', async () => {
  const applyAnswers = applicationHarness();
  const control = choiceControl({ click() { throw new Error('Page component is unavailable'); } });
  const question = { type: '0', answer: ['selected'], options: { selected: control }, element: { isConnected: true } };
  assert.equal(await applyAnswers(question, pageWindow, 'zj', (options, answer) => options[answer]), false);
});

test('an already selected choice inside a disabled fieldset is not accepted as a valid answer', async () => {
  const applyAnswers = applicationHarness();
  const input = {checked: true, disabled: false, matches: (selector) => selector === ':disabled'};
  const option = choiceControl({selected: true, querySelector: () => input, querySelectorAll: () => [input]});
  const question = {type: '0', answer: ['answer'], options: {answer: option}, element: {isConnected: true}};
  assert.equal(await applyAnswers(question, pageWindow, 'zj', (options, answer) => options[answer]), false);
  assert.equal(option.clicks, 0);
});

test('visible native text controls do not instantiate an unavailable rich editor', async () => {
  const applyAnswers = applicationHarness();
  const field = textControl();
  const unavailableEditor = { ...pageWindow, UE: { getEditor() { throw new Error('Editor not initialized'); } } };
  assert.equal(await applyAnswers(textQuestion(field, 'literal answer'), unavailableEditor, 'zj'), true);
  assert.equal(field.value, 'literal answer');
  assert.deepEqual(field.events, ['input', 'change']);
});

test('model HTML stays literal in native and contenteditable text fields', async () => {
  const applyAnswers = applicationHarness();
  const hostile = '<img src=x onerror="unwantedExecution()"> & text';
  const textarea = textControl();
  assert.equal(await applyAnswers(textQuestion(textarea, hostile), pageWindow, 'zj'), true);
  assert.equal(textarea.value, hostile);
  const editable = textControl({ tagName: 'DIV', textContent: '', getAttribute: (name) => name === 'contenteditable' ? 'true' : null });
  assert.equal(await applyAnswers(textQuestion(editable, hostile), pageWindow, 'zhs'), true);
  assert.equal(editable.textContent, hostile);
});

test('model HTML is escaped before entering a rich editor', async () => {
  const applyAnswers = applicationHarness();
  const hostile = '<img src=x onerror="unwantedExecution()"> & text\nnext line';
  const field = textControl();
  let markup;
  const body = {isConnected:true, textContent:''};
  const editor = {body, setContent: (value) => { markup = value; body.textContent=hostile; }, getContentTxt: () => hostile};
  const editorWindow = {...pageWindow, UE: {instants:{'answer-field':editor}, getEditor:()=>{throw new Error('Must not create an editor');}}};
  assert.equal(await applyAnswers(textQuestion(field, hostile), editorWindow, 'zj'), true);
  assert.ok(markup.includes('&lt;img'));
  assert.ok(markup.includes('&amp; text'));
  assert.ok(markup.includes('<br>next line'));
  assert.doesNotMatch(markup, /<img\b/);
});

test('hidden rich editor source fields are never written when no existing visible editor is available', async () => {
  const applyAnswers = applicationHarness();
  const field = textControl({getClientRects:()=>[]});
  let creations = 0;
  const editorWindow = {...pageWindow,UE:{getEditor(){creations+=1;throw new Error('Unavailable editor');}}};
  assert.equal(await applyAnswers(textQuestion(field, 'answer'), editorWindow, 'zj'), false);
  assert.equal(field.value, '');
  assert.equal(creations, 0);
});

test('an existing rich editor is found by source id and its visible content is verified', async () => {
  const applyAnswers = applicationHarness();
  const field = textControl({id:'existing-editor',name:'different-form-name',getClientRects:()=>[]});
  const body = {isConnected:true,textContent:'old text'};
  let writes = 0;
  const editor = {
    body, key:'existing-editor',
    setContent(value){writes+=1;body.textContent=value;},
    getContentTxt:()=>body.textContent
  };
  const editorWindow = {...pageWindow,UE:{instants:{registryEntry:editor},getEditor:()=>{throw new Error('Must not instantiate');}}};
  assert.equal(await applyAnswers(textQuestion(field,'new text'),editorWindow,'zj'),true);
  assert.equal(body.textContent,'new text');
  assert.equal(writes,1);
  assert.equal(field.value,'');
});

test('a rich editor that reports a value without changing its visible body is not counted as filled', async () => {
  const applyAnswers = applicationHarness();
  const field = textControl({getClientRects:()=>[]});
  const editor = {body:{isConnected:true,textContent:'old visible text'},setContent(){},getContentTxt:()=> 'new answer'};
  const editorWindow = {...pageWindow,UE:{instants:{'answer-field':editor}}};
  assert.equal(await applyAnswers(textQuestion(field,'new answer'),editorWindow,'zj'),false);
  assert.equal(field.value,'');
});

function liveQuestion(title = 'question', optionClass = '.answer_p') {
  const titleNode = { textContent: title };
  const optionNode = { textContent: 'original option' };
  return {
    title,
    type: '0',
    options: {answer: choiceControl()},
    answer: [],
    titleNode,
    optionNode,
    element: {
      isConnected: true,
      getAttribute: () => null,
      querySelector: () => titleNode,
      querySelectorAll: (selector) => selector.split(',').includes(optionClass) ? [optionNode] : []
    }
  };
}

function modelAnswer(question) {
  return {
    success: true,
    data: { items: [{ stem: question.title, answer: { kind: 'choice', values: ['answer'] } }] },
    meta: { model: 'offline-test', usage: { total_tokens: 0 } }
  };
}

function solverHarness(overrides = {}) {
  const rows = [];
  const timers = new Map();
  const location = { href: 'https://example.chaoxing.com/exam-ans/exam?question=1' };
  let nextTimer = 1;
  const context = evaluate(
    `${section('  const getAnswerValues = ', '  function extractRawTextFromElement(')}
     ${section('  const aiControlVisible = ', '  const aiBlankCount = ')}
     ${section('  const aiHasConfiguredKey = ', '  class BaseQuestionHandler {')}
     globalThis.solve = solveAiQuestions;
     globalThis.applyAnswers = applyAiAnswers;
     globalThis.questionContext = createAiQuestionContext;`,
    {
      AbortController,
      window: { location },
      setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearInterval: (id) => timers.delete(id),
      sleep: async () => {},
      aiWaitForDelay: async (_seconds, context) => context.isCurrent(),
      vue: { reactive: (value) => value },
      useConfigStore: () => {const config=configurationHarness().config; config.ai.apiKey='FAKE-SOLVER-TEST-KEY'; return config;},
      getAnswer: async (question) => modelAnswer(question),
      ...overrides
    }
  );
  return {
    ...context,
    rows,
    timers,
    location,
    tick() { for (const callback of [...timers.values()]) callback(); },
    makeHandler(questions) {
      return {
        questions: [],
        parseHtml() { this.questions = questions; },
        addQuestion: (row) => rows.push(row),
        addLog() {},
        _window: pageWindow,
        fillQuestion: (question, current) => context.applyAnswers(question, pageWindow, 'zj', (options, answer) => options[answer], current)
      };
    }
  };
}

test('a URL change during model inference cancels the old answer before filling', async () => {
  let release;
  let pendingContext;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = solverHarness({ getAnswer: async (_question, context) => { pendingContext = context; return pending; } });
  const question = liveQuestion();
  const handler = harness.makeHandler([question]);
  let fills = 0;
  handler.fillQuestion = async () => { fills += 1; return true; };
  const result = harness.solve(handler);
  harness.location.href += '&changed=1';
  harness.tick();
  assert.equal(pendingContext.signal.aborted, true);
  release(modelAnswer(question));
  assert.equal(await result, 0);
  assert.equal(fills, 0);
  assert.equal(harness.rows[0].answerStatus, 'error');
  assert.equal(harness.timers.size, 0);
});

test('parent cancellation aborts model inference and prevents answer application', async () => {
  let release;
  let pendingContext;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = solverHarness({ getAnswer: async (_question, context) => { pendingContext = context; return pending; } });
  const question = liveQuestion();
  const handler = harness.makeHandler([question]);
  let fills = 0;
  handler.fillQuestion = async () => { fills += 1; return true; };
  const parent = new AbortController();
  const result = harness.solve(handler, { signal: parent.signal });
  parent.abort();
  assert.equal(pendingContext.signal.aborted, true);
  release(modelAnswer(question));
  assert.equal(await result, 0);
  assert.equal(fills, 0);
  assert.equal(harness.timers.size, 0);
});

test('reused question DOM invalidates an answer when its title or platform options change', () => {
  for (const optionClass of ['.answer_p', '.fl.after', '.node_detail']) {
    const harness = solverHarness();
    const question = liveQuestion('unchanged title', optionClass);
    const context = harness.questionContext(question);
    assert.equal(context.isCurrent(), true);
    question.optionNode.textContent = 'a different option';
    assert.equal(context.isCurrent(), false, `${optionClass} option changes must invalidate the question`);
    harness.tick();
    assert.equal(context.signal.aborted, true);
    context.dispose();
    assert.equal(harness.timers.size, 0);
  }
  const harness = solverHarness();
  const question = liveQuestion();
  const context = harness.questionContext(question);
  question.titleNode.textContent = 'a new question';
  assert.equal(context.isCurrent(), false);
  context.dispose();
});

test('a page change during filling cannot be counted as a successful result', async () => {
  const harness = solverHarness();
  const handler = harness.makeHandler([liveQuestion()]);
  handler.fillQuestion = async () => { harness.location.href += '&changed=1'; return true; };
  assert.equal(await harness.solve(handler), 0);
  assert.equal(handler.correctNum, 0);
  assert.equal(harness.rows[0].answerStatus, 'error');
  assert.equal(handler.lastSolveResult.cancelled,true);
  assert.equal(handler.lastSolveResult.complete,false);
  assert.equal(handler.lastSolveResult.isCurrent(),false);
  assert.equal(harness.timers.size, 0);
});

test('later queued questions are bound to their parsed identity before any model request', async () => {
  const first = liveQuestion('first question');
  const second = liveQuestion('second question');
  const requests = [];
  const harness = solverHarness({getAnswer:async(question)=>{
    requests.push(question.title);
    second.titleNode.textContent='replacement question';
    return modelAnswer(question);
  }});
  const handler = harness.makeHandler([first,second]);
  let fills = 0;
  handler.fillQuestion=async()=>{fills+=1;return true;};
  assert.equal(await harness.solve(handler),0);
  assert.deepEqual(requests,['first question']);
  assert.equal(fills,0);
  assert.equal(handler.lastSolveResult.cancelled,true);
  assert.equal(handler.lastSolveResult.total,2);
  assert.equal(handler.lastSolveResult.filled,0);
  assert.equal(handler.lastSolveResult.isCurrent(),false);
  assert.equal(harness.timers.size,0);
});

test('a completed solve retains a live identity check for submission after a delay', async () => {
  const question = liveQuestion();
  const harness=solverHarness();
  const handler=harness.makeHandler([question]);
  assert.equal(await harness.solve(handler),100);
  assert.equal(handler.lastSolveResult.complete,true);
  assert.equal(handler.lastSolveResult.filled,1);
  assert.equal(handler.lastSolveResult.isCurrent(),true);
  question.titleNode.textContent='a different question';
  assert.equal(handler.lastSolveResult.isCurrent(),false);
  assert.equal(harness.timers.size,0);
});

test('dynamic verification rereads immutable answer expectations without resending a model request', async () => {
  const field=textControl();
  const question=liveQuestion('A text answer');
  question.type='2';question.options={};
  question.element.querySelectorAll=(selector)=>selector==='input, textarea, [contenteditable="true"]'?[field]:[];
  let requests=0;
  const harness=solverHarness({getAnswer:async(entry)=>{requests+=1;return modelAnswer(entry);}});
  const handler=harness.makeHandler([question]);
  assert.equal(await harness.solve(handler),100);
  assert.equal(field.value,'answer');
  harness.rows[0].answer[0]='changed presentation only';
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  field.value='';
  assert.equal(handler.lastSolveResult.verifyFilled(),false);
  assert.equal(handler.lastSolveResult.filled,0);
  assert.equal(handler.lastSolveResult.rate,0);
  assert.equal(handler.lastSolveResult.complete,false);
  assert.equal(handler.lastSolveResult.isCurrent(),true);
  assert.equal(harness.rows[0].answerStatus,'error');
  field.value='answer';
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  assert.equal(handler.lastSolveResult.rate,100);
  assert.equal(harness.rows[0].answerStatus,'success');
  assert.equal(requests,1);
});

test('turning off Wisdom Tree automatic switching during its delay prevents navigation', async () => {
  const config=configurationHarness().config;
  config.ai.apiKey='FAKE-WISDOM-TREE-TEST-KEY';
  config.platformParams.zhs.parts[0].params[0].value=true;
  const question=liveQuestion('A Wisdom Tree question');
  question.workType='zhs';
  let clicks=0,waits=0;
  const harness=solverHarness({
    useConfigStore:()=>config,
    aiWaitForDelay:async(_seconds,context)=>{
      waits+=1;
      config.platformParams.zhs.parts[0].params[0].value=false;
      return context.isCurrent();
    }
  });
  const handler=harness.makeHandler([question]);
  handler._document={querySelectorAll:()=>[{}, {click(){clicks+=1;}}]};
  assert.equal(await harness.solve(handler),100);
  assert.equal(waits,1);
  assert.equal(clicks,0);
  assert.equal(handler.lastSolveResult.verifyFilled(),true);
  assert.equal(handler.lastSolveResult.cancelled,false);
});

test('answer control changes and selection markers do not invalidate the original question identity', () => {
  const text=(nodeValue)=>({nodeType:3,nodeValue});
  const titleNode={tagName:'H3',childNodes:[text('stable title')],getAttribute:()=>null};
  const optionNode={tagName:'SPAN',childNodes:[text('stable option')],getAttribute:()=>null};
  const field={tagName:'TEXTAREA',value:'old answer',getAttribute:()=>null};
  const editable={tagName:'DIV',childNodes:[text('old answer')],getAttribute:(key)=>key==='contenteditable'?'true':null};
  const root={tagName:'DIV',isConnected:true,childNodes:[titleNode,optionNode,field,editable],getAttribute:()=>null,
    querySelector:()=>null,querySelectorAll:()=>[]};
  const question={title:'stable title',element:root};
  const harness=solverHarness();
  const context=harness.questionContext(question);
  assert.equal(context.isCurrent(),true);
  field.value='new answer';
  editable.childNodes=[text('new answer')];
  optionNode.childNodes.push({tagName:'SPAN',childNodes:[text('selected')],getAttribute:()=>null,matches:()=>true});
  assert.equal(context.isCurrent(),true);
  titleNode.childNodes=[text('different title')];
  assert.equal(context.isCurrent(),false);
  context.dispose();
  assert.equal(harness.timers.size,0);
});

test('the answer applicator stops before touching a stale question or the next option', async () => {
  const applyAnswers = applicationHarness();
  let current = false;
  const first = choiceControl();
  const second = choiceControl();
  const question = { type: '1', answer: ['first', 'second'], options: { first, second }, element: { isConnected: true } };
  const match = (options, answer) => options[answer];
  assert.equal(await applyAnswers(question, pageWindow, 'zj', match, () => current), false);
  assert.equal(first.clicks, 0);
  assert.equal(second.clicks, 0);
  current = true;
  first.click = function() { this.clicks += 1; this.selected = true; current = false; };
  assert.equal(await applyAnswers(question, pageWindow, 'zj', match, () => current), false);
  assert.equal(first.clicks, 1);
  assert.equal(second.clicks, 0);
});
