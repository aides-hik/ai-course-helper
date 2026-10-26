"""Create an isolated page for a real-browser mount check, without API access."""
from pathlib import Path
from urllib.request import urlopen
import re
import json

root = Path(__file__).resolve().parent.parent
fixture = root / "tests" / "browser-fixture" / "mooc2" / "work"
fixture.mkdir(parents=True, exist_ok=True)
source = (root / "ai-course-helper.user.js").read_text(encoding="utf-8")
dependencies = re.findall(r"^// @require\s+(https://\S+)", source, re.M)
tags = []
for index, url in enumerate(dependencies):
    path = fixture / f"dependency-{index}.js"
    if not path.exists():
        with urlopen(url, timeout=30) as response:
            path.write_bytes(response.read())
    tags.append(f'<script src="{path.name}"></script>')

resources = {}
for name, url in re.findall(r"^// @resource\s+(ElementPlus\S*)\s+(https://\S+)", source, re.M):
    path = fixture / f"{name}.css"
    if not path.exists():
        with urlopen(url, timeout=30) as response:
            path.write_bytes(response.read())
    resources[name] = path.read_text(encoding="utf-8")

setup = '''
window.__smokeErrors = [];
window.__smokeRequests = 0;
window.addEventListener("error", event => window.__smokeErrors.push(event.message));
window.addEventListener("unhandledrejection", event => window.__smokeErrors.push(String(event.reason)));
window.GM_info = {script: {name:"AI helper test",author:"test",namespace:"test",version:"0.3.1",description:"test"}};
const smokeStorage = new Map();
window.GM_getValue = key => smokeStorage.get(key);
window.GM_setValue = (key, value) => smokeStorage.set(key, value);
window.GM_addStyle = css => {const style=document.createElement("style");style.textContent=css;document.head.append(style);return style;};
window.GM_getResourceText = name => window.__smokeResources[name] || "";
window.GM_xmlhttpRequest = () => {window.__smokeRequests++; throw new Error("Unexpected network request");};
window.unsafeWindow = window;
const originalShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(options) {return originalShadow.call(this, {...options,mode:"open"});};
setTimeout(async () => {
  const root = [...document.querySelectorAll("body > div")].map(el=>el.shadowRoot).find(Boolean);
  const select = root?.querySelector(".ai-provider-select");
  const options = [...select?.options || []].map(option=>option.value);
  const passwordInput = () => root?.querySelector('input[type="password"]');
  const modelInput = () => root?.querySelector('input[placeholder="deepseek-flash"],input[placeholder*="模型"]');
  const input = (element,value) => {
    if (!element) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,value);
    element.dispatchEvent(new Event("input",{bubbles:true}));
  };
  const changeProvider = async value => {
    if (!select) return;
    select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));
    await Promise.resolve();await Promise.resolve();
  };
  input(passwordInput(),"FAKE-OPENAI-UI-KEY");input(modelInput(),"openai-ui-test-model");
  await Promise.resolve();await changeProvider("deepseek");
  const deepseekDefaults = {key:passwordInput()?.value,model:modelInput()?.value};
  input(passwordInput(),"FAKE-DEEPSEEK-UI-KEY");input(modelInput(),"deepseek-ui-test-model");
  await Promise.resolve();await changeProvider("openai");
  const openaiRestored = passwordInput()?.value === "FAKE-OPENAI-UI-KEY" && modelInput()?.value === "openai-ui-test-model";
  await changeProvider("deepseek");
  const deepseekRestored = passwordInput()?.value === "FAKE-DEEPSEEK-UI-KEY" && modelInput()?.value === "deepseek-ui-test-model";
  const concurrentSwitch = root?.querySelector(".ai-concurrent-switch");
  const switchInput = () => concurrentSwitch?.querySelector('[role="switch"]');
  const concurrencyInput = () => root?.querySelector(".ai-concurrency-count input");
  const concurrencyDefault = switchInput()?.getAttribute("aria-checked") === "false" && concurrencyInput()?.disabled && concurrencyInput()?.value === "3";
  concurrentSwitch?.click();
  await Promise.resolve();await Promise.resolve();
  const concurrencyEnabled = switchInput()?.getAttribute("aria-checked") === "true" && !concurrencyInput()?.disabled;
  input(concurrencyInput(), "2500");
  concurrencyInput()?.dispatchEvent(new Event("change", {bubbles:true}));
  concurrencyInput()?.dispatchEvent(new FocusEvent("blur", {bubbles:true}));
  await Promise.resolve();await Promise.resolve();
  concurrentSwitch?.click();
  await Promise.resolve();await Promise.resolve();
  const concurrencyDisabled = concurrencyInput()?.disabled;
  concurrentSwitch?.click();
  await Promise.resolve();await Promise.resolve();
  const concurrencyRetained = concurrencyInput()?.value === "2500" && !concurrencyInput()?.disabled && concurrencyInput()?.max === "2500";
  const save = [...root?.querySelectorAll("button") || []].find(button=>button.textContent.includes("保存并刷新"));
  save?.scrollIntoView({block:"nearest"});
  await new Promise(resolve => setTimeout(resolve, 0));
  const bounds = save?.getBoundingClientRect();
  const result = {
    mounted: !!root?.querySelector(".ai-config"),
    keyInput: !!root?.querySelector('input[type="password"]'),
    modelInput: !!modelInput(),
    providerOptions: options,
    deepseekDefaults,
    independentSettings: openaiRestored && deepseekRestored,
    concurrencyControls: !!(concurrencyDefault && concurrencyEnabled && concurrencyDisabled && concurrencyRetained),
    concurrencyState: {concurrencyDefault,concurrencyEnabled,concurrencyDisabled,concurrencyRetained},
    saveButton: [...root?.querySelectorAll("button") || []].some(button=>button.textContent.includes("保存并刷新")),
    saveVisible: !!bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight,
    bounds: bounds?.toJSON(), viewport: [window.innerWidth,window.innerHeight],
    errors: window.__smokeErrors,
    requests: window.__smokeRequests
  };
  const node = document.createElement("pre");node.id="smoke-result";node.textContent=JSON.stringify(result);document.body.append(node);
}, 2500);
'''
script_url = (root / "ai-course-helper.user.js").as_uri()
page = '<!doctype html><html><head><meta charset="utf-8"><title>AI helper smoke</title></head><body>' + ''.join(tags) + '<script>window.__smokeResources=' + json.dumps(resources) + ';' + setup + '</script><script src="' + script_url + '"></script></body></html>'
(fixture / "dowork.html").write_text(page, encoding="utf-8")
print((fixture / "dowork.html").as_uri())
