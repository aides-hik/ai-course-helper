"""Build the installable userscript from checked-in sources; no network is required."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "0.9.2"
MODULES = {
    "CONFIG_STORAGE": "config-storage.js",
    "TEXT_EXTRACTORS": "text-extraction.js",
    "IMAGES": "ai-images.js",
    "ENDPOINTS": "ai-endpoints.js",
    "MODELS": "ai-models.js",
    "ADAPTER": "ai-adapter.js",
    "INTEGRATION": "ai-integration.js",
    "CHAPTER": "chapter-logic.js",
    "EXAM": "exam-logic.js",
    "PAGE_HOOKS": "page-hooks.js",
    "UI_STYLES": "ui-panel.css",
    "LOG_PRESENTATION": "log-presentation.js",
}


def render():
    text = (ROOT / "userscript.template.js.in").read_text(encoding="utf-8")
    if text.count("@AI_HELPER_VERSION@") != 1:
        raise ValueError("Expected one version marker in userscript template")
    text = text.replace("@AI_HELPER_VERSION@", VERSION)
    for marker_name, filename in MODULES.items():
        marker = f"/* @ai-helper:{marker_name}@ */"
        if text.count(marker) != 1:
            raise ValueError(f"Expected one {marker_name} marker in userscript template")
        text = text.replace(marker, (ROOT / filename).read_text(encoding="utf-8").rstrip())
    if "/* @ai-helper:" in text:
        raise ValueError("Unresolved source marker in userscript template")
    return text


def build():
    text = render()
    target = ROOT / "ai-course-helper.user.js"
    target.write_text(text, encoding="utf-8", newline="\n")
    print(f"Built {target.name} {VERSION} ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    build()
