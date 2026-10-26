"""Verify the complete userscript mounts and keeps provider settings independent."""
from pathlib import Path
import html
import json
import re
import runpy
import subprocess

ROOT = Path(__file__).resolve().parent.parent
runpy.run_path(str(ROOT / "tests" / "prepare_browser_smoke.py"))
fixture = ROOT / "tests" / "browser-fixture" / "mooc2" / "work" / "dowork.html"
browser = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
result = subprocess.run([
    str(browser), "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--allow-file-access-from-files",
    "--user-data-dir=" + str(ROOT / "tests" / ".browser-profile"),
    "--window-size=1280,900", "--virtual-time-budget=5000", "--dump-dom", fixture.as_uri()
], capture_output=True, text=True, encoding="utf-8", timeout=25)
match = re.search(r'<pre id="smoke-result">(.*?)</pre>', result.stdout, re.S)
if not match:
    raise RuntimeError("Browser did not emit UI smoke result: " + result.stderr[-1000:])
output = json.loads(html.unescape(match[1]))
for key in ["mounted", "keyInput", "modelInput", "independentSettings", "concurrencyControls", "saveButton", "saveVisible"]:
    assert output[key] is True, (key, output)
assert output["providerOptions"] == ["openai", "deepseek"], output
assert output["requests"] == 0 and output["errors"] == [], output
print(json.dumps(output, ensure_ascii=False))
