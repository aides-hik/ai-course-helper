"""Check the log component's copy and manual fallback paths in offline Edge."""
from pathlib import Path
import html
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
template = (ROOT / "userscript.template.js.in").read_text(encoding="utf-8")


def section(start, end):
    a = template.index(start)
    return template[a:template.index(end, a + len(start))]


store = section("  const formatDateTime = ", "  const useQuestionStore = ")
component = section("  const getNotice = ", "  const _hoisted_1$4 = ")
cache = ROOT / "tests" / "browser-fixture" / "mooc2" / "work"
tags = []
for index in range(4):
    dependency = cache / f"dependency-{index}.js"
    assert dependency.exists(), dependency
    tags.append('<script src="' + dependency.as_uri() + '"></script>')
styles = (cache / "ElementPlusStyle.css").read_text(encoding="utf-8")
styles += (ROOT / "ui-panel.css").read_text(encoding="utf-8")

checks = r'''
window.__logXss=0;
const errors=[];let copyCalls=0,copied='';
window.addEventListener('error',event=>errors.push(event.message));
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
const vue=Vue,pinia=Pinia;
const getScriptInfo=()=>({version:'fixture-version'});
const config={ai:{apiKey:'DO-NOT-COPY-KEY'},menuIndex:'0'};
const useConfigStore=()=>config;
const _sfc_main$9={render:()=>null};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copyCalls++;copied=text;}}});
'''
exercise = r'''
(async()=>{try{
  const state=pinia.createPinia();pinia.setActivePinia(state);
  const store=useLogStore(),original=store.logList;
  for(let index=0;index<520;index++)store.addLog('fixture-line-'+index,'warning');
  const literal='<img src=x onerror="window.__logXss=1">';store.addLog(literal,'primary');
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  assert(store.logList===original&&store.logList.length===500,'History must stay bounded without replacing its array');
  assert(store.logList[0].message==='fixture-line-21'&&store.logList.at(-1).message===literal,'History must retain the newest entries unchanged');
  const app=vue.createApp({setup:()=>()=>vue.h(_sfc_main$8,{logList:store.logList})});
  app.use(state);app.use(ElementPlus);app.mount('#app');
  const tick=async()=>{await vue.nextTick();await Promise.resolve();await vue.nextTick();};await tick();
  const button=document.querySelector('.ai-copy-logs');
  assert(button?.matches('button[type="button"]'),'Copy action must be a native button');
  button.focus();assert(document.activeElement===button,'Copy action must be keyboard focusable');
  assert(!document.querySelector('.log img')&&document.querySelector('.log').textContent.includes(literal)&&window.__logXss===0,'Log HTML must render as literal text');
  button.click();await tick();
  assert(copyCalls===1&&document.querySelector('.ai-log-copy-status').textContent==='日志已复制','Successful copy needs visible feedback');
  assert(copied.includes('vfixture-version')&&copied.includes('导出时间：')&&copied.includes(literal)&&copied.includes('fixture-line-21'),'Export needs version, time and current entries');
  assert(!copied.split('\n').some(line=>line.endsWith(' fixture-line-20'))&&!copied.includes('DO-NOT-COPY-KEY')&&!copied.includes('DO-NOT-COPY-PAGE-QUERY'),'Export must omit evicted entries and must not read API settings or page URL');
  assert(!document.querySelector('.ai-log-export'),'Successful copy must not show manual fallback');
  navigator.clipboard.writeText=async()=>{copyCalls++;throw Error('denied');};
  button.click();await tick();await tick();
  const manual=document.querySelector('.ai-log-export');
  assert(manual?.readOnly&&manual.value.includes(literal)&&manual.value.includes('vfixture-version'),'Denied clipboard must expose a readonly copy field');
  assert(document.querySelector('.ai-log-copy-status').textContent.includes('自动复制未成功'),'Denied clipboard must explain manual copy');
  assert(document.activeElement===manual&&manual.selectionStart===0&&manual.selectionEnd===manual.value.length,'Manual fallback must be focused and selected');
  assert(manual.getBoundingClientRect().right<=innerWidth,'Manual copy field must fit the viewport');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
  button.click();await tick();await tick();
  assert(document.querySelector('.ai-log-export')?.value.includes('fixture-line-519'),'Unavailable clipboard must retain the manual path');
  assert(!button.disabled&&window.__logXss===0&&errors.length===0,'Copy failures must not leave a disabled action or browser error');
  document.querySelector('#copy-log-result').textContent=JSON.stringify({passed:true,clipboardSuccess:true,deniedFallback:true,unavailableFallback:true,manualTextSelected:true,literalLogs:true,historyLimit:500,arrayIdentity:true,noSettingsOrUrlExport:true,errors});
}catch(error){document.querySelector('#copy-log-result').textContent=JSON.stringify({passed:false,error:String(error),stack:error.stack,errors});}})();
'''
page = ('<!doctype html><meta charset="utf-8"><title>Offline log copy review</title><style>'
        + styles + '</style><main class="main-page" style="width:300px;margin:8px"><div id="app"></div></main>'
        '<pre id="copy-log-result">{"stage":"starting"}</pre>' + ''.join(tags)
        + '<script>' + checks + store + component + exercise + '</script>')
fixture_dir = ROOT / "tests" / "browser-fixture" / "copy-logs"
fixture_dir.mkdir(parents=True, exist_ok=True)
fixture = fixture_dir / "copy.html"
fixture.write_text(page, encoding="utf-8")
run = subprocess.run([
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--allow-file-access-from-files",
    "--user-data-dir=" + str(ROOT / "tests" / ".copy-logs-profile"),
    "--window-size=600,900", "--virtual-time-budget=5000", "--dump-dom",
    fixture.as_uri() + "?enc=DO-NOT-COPY-PAGE-QUERY"
], capture_output=True, text=True, encoding="utf-8", timeout=25)
match = re.search(r'<pre id="copy-log-result"[^>]*>(.*?)</pre>', run.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit log review: " + run.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
assert output.get("passed") is True, output
print(json.dumps(output, ensure_ascii=False))
