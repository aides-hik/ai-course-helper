"""Build an unpacked Chromium MV3 extension and zip from local, pinned sources."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import zipfile
from build_ai import ROOT, VERSION, render

SOURCE = ROOT / "extension"
TARGET = ROOT / "dist" / "ai-course-helper-extension"


def replace_once(text, before, after):
    count = text.count(before)
    if count != 1:
        raise ValueError(f"Extension adapter expected one match, found {count}: {before[:95]}")
    return text.replace(before, after, 1)


def extension_application():
    text = render()
    text = text.split("// ==/UserScript==", 1)[1].lstrip()
    # The business logic stays in its original closure, with isolated adapters.
    hooks = (ROOT / "page-hooks.js").read_text(encoding="utf-8").rstrip()
    text = replace_once(text, hooks, "// Page hooks are installed by the extension's MAIN script.")
    bridge = (SOURCE / "page-bridge.js").read_text(encoding="utf-8")
    text = replace_once(text, "  var __defProp = Object.defineProperty;", bridge + "\n  var __defProp = Object.defineProperty;")
    editor_start = text.index("  const aiExistingEditorForField =")
    editor_end = text.index("  const aiAnswerFields =", editor_start)
    text = text[:editor_start] + '''  const aiExistingEditorForField = (field, pageWindow = field?.ownerDocument?.defaultView) => {
    return aiControlWritable(field) ? extensionPageBridge.editorForField(field) : null;
  };
''' + text[editor_end:]
    for name in ("element", "node"):
        text = text.replace(f"{name}.__Ivue__?._data?.shadowDom", f"extensionPageBridge.shadow({name})")
    text = replace_once(text,
        'const shadowDom = (_b = (_a = titleElement == null ? void 0 : titleElement.__Ivue__) == null ? void 0 : _a._data) == null ? void 0 : _b.shadowDom;',
        'const shadowDom = extensionPageBridge.shadow(titleElement);')
    for method in ("noSubmit", "btnBlueSubmit", "submitCheckTimes"):
        before = f"await iframeWindow.{method}()"
        if before not in text:
            raise ValueError(f"Missing chapter adapter: {method}")
        text = text.replace(before, f'await extensionPageBridge.call(iframeWindow, "{method}")')
    text = replace_once(text, '_unsafeWindow.top.onchangepage(iframeWindow.getFrameAttr("end"));', 'await extensionPageBridge.book(iframeWindow);')
    text = replace_once(text,
        'if (typeof _unsafeWindow.getTheNextQuestion === "function") _unsafeWindow.getTheNextQuestion(1);',
        'if (extensionPageBridge.nextQuestion()) { /* Platform acknowledged the action. */ }')
    text = replace_once(text,
        'onClick: () => {persistConfig(config); window.location.reload();}',
        'onClick: async () => {persistConfig(config); try {await extensionFlushStorage(); window.location.reload();} catch {extensionReportError("配置尚未保存，请稍后点击保存重试。");}}')
    text = replace_once(text, '    app.mount(mountNode);', '''    app.mount(mountNode);
    extensionPanelController = () => {
      const panel = mountNode.querySelector(".main-page");
      if (!panel || getComputedStyle(panel).display === "none") return false;
      const config = useConfigStore();
      config.isMinus = false;
      config.position.x = "32px"; config.position.y = "80px";
      return true;
    };''')
    return text


def build():
    lock = json.loads((SOURCE / "vendor" / "lock.json").read_text(encoding="utf-8"))
    for entry in lock:
        path = SOURCE / "vendor" / entry["file"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Vendored dependency hash changed: {entry['file']}")
    TARGET.mkdir(parents=True, exist_ok=True)
    # Copy only known source files. No profiles, private configuration or tests.
    names = ["background.js", "network-policy.js", "network-worker.js", "offscreen.html", "offscreen.js", "popup.html", "popup.css", "popup.js", "update-service.js", "THIRD_PARTY_NOTICES.md"]
    for name in names:
        shutil.copyfile(SOURCE / name, TARGET / name)
    assets = {"vendor": [entry["file"] for entry in lock] + ["lock.json"],
              "icons": [f"icon{size}.png" for size in (16, 48, 128)]}
    for folder, filenames in assets.items():
        (TARGET / folder).mkdir(exist_ok=True)
        for filename in filenames:
            shutil.copyfile(SOURCE / folder / filename, TARGET / folder / filename)
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    manifest["version"] = VERSION
    (TARGET / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    resources = {key: (SOURCE / "vendor" / filename).read_text(encoding="utf-8") for key, filename in {
        "ElementPlus": "element-plus.css", "ElementPlusStyle": "element-plus-shadow.css", "ttf": "font-table.json"
    }.items()}
    content = '"use strict";\n(async () => {\nconst extensionResources = ' + json.dumps(resources, ensure_ascii=False) + ";\n"
    content += (SOURCE / "bootstrap.js").read_text(encoding="utf-8") + "\n" + extension_application()
    content += '\n})().catch(() => {console.error("[AI 学习助手] 扩展初始化失败，请刷新页面或重新加载扩展。");});\n'
    (TARGET / "content.js").write_text(content, encoding="utf-8", newline="\n")
    main = '"use strict";\n(() => {\nconst _unsafeWindow = window;\n'
    main += (ROOT / "page-hooks.js").read_text(encoding="utf-8") + "\n" + (SOURCE / "page-main.js").read_text(encoding="utf-8") + "\n})();\n"
    (TARGET / "page-main.js").write_text(main, encoding="utf-8", newline="\n")
    expected = set(names + ["manifest.json", "content.js", "page-main.js"])
    expected.update(folder + "/" + filename for folder, filenames in assets.items() for filename in filenames)
    archive = ROOT / "dist" / f"ai-course-helper-extension-{VERSION}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(expected):
            data = (TARGET / name).read_bytes()
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, data)
    print(f"Built extension {VERSION}: {TARGET}")
    print(f"ZIP: {archive} ({archive.stat().st_size:,} bytes)")
    print(f"SHA256: {hashlib.sha256(archive.read_bytes()).hexdigest().upper()}")


if __name__ == "__main__":
    build()
