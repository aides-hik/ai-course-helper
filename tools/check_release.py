"""Verify the tagged offline build and prepare public GitHub release assets."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from build_ai import VERSION, render  # noqa: E402


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_asset_name(value):
    if not isinstance(value, str) or not value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts and \
        not re.search(r"[\\:\x00-\x1f\x7f]", value) and path.as_posix() == value


def check_release(tag=None):
    tag = tag if tag is not None else os.environ.get("RELEASE_TAG", "")
    parts = VERSION.split(".")
    require(bool(re.fullmatch(r"(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}", VERSION)) and
            all(int(part) <= 65535 for part in parts) and any(int(part) for part in parts), "Invalid release version")
    require(tag == "v" + VERSION, "Release tag must exactly match build_ai.VERSION")
    dist = ROOT / "dist"
    extension = dist / "ai-course-helper-extension"
    manifest_source = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    manifest_built = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    require(manifest_source["version"] == VERSION, "Source manifest version differs from release")
    require(manifest_built == manifest_source, "Built manifest differs from the checked-in source")
    require(manifest_built["manifest_version"] == 3, "Expected Manifest V3")
    script = (ROOT / "ai-course-helper.user.js").read_bytes()
    require(script == render().encode("utf-8"), "Userscript differs from the current source build")

    lock = json.loads((ROOT / "extension" / "vendor" / "lock.json").read_text(encoding="utf-8"))
    expected = {"manifest.json", "content.js", "page-main.js", "background.js", "network-policy.js",
                "network-worker.js", "offscreen.html", "offscreen.js", "popup.html", "popup.css",
                "popup.js", "update-service.js", "THIRD_PARTY_NOTICES.md", "vendor/lock.json"}
    for entry in lock:
        require(safe_asset_name(entry["file"]) and "/" not in entry["file"], "Invalid vendor filename")
        expected.add("vendor/" + entry["file"])
        require(sha256((ROOT / "extension" / "vendor" / entry["file"]).read_bytes()) == entry["sha256"],
                "Source vendor hash differs from lock: " + entry["file"])
        require(sha256((extension / "vendor" / entry["file"]).read_bytes()) == entry["sha256"],
                "Packaged vendor hash differs from lock: " + entry["file"])
    expected.update("icons/icon" + str(size) + ".png" for size in (16, 48, 128))
    archive = dist / f"ai-course-helper-extension-{VERSION}.zip"
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)), "Archive contains duplicate filenames")
        require(set(names) == expected, "Archive contains missing or unexpected files")
        require(all(safe_asset_name(name) for name in names), "Unsafe archive path")
        for entry in entries:
            require(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16) and
                    entry.file_size <= 32 * 1024 * 1024, "Unexpected archive entry")
            require(bundle.read(entry.filename) == (extension / entry.filename).read_bytes(),
                    "Archive differs from unpacked build: " + entry.filename)
        packed_manifest = json.loads(bundle.read("manifest.json"))
        require(packed_manifest == manifest_built, "Archive manifest mismatch")

    sums = "\n".join([
        f"{sha256(archive.read_bytes())}  {archive.name}",
        f"{sha256(script)}  ai-course-helper.user.js",
    ]) + "\n"
    (dist / "SHA256SUMS").write_text(sums, encoding="utf-8", newline="\n")
    notes = f"""浏览器扩展 **{VERSION}**，支持 Chrome / Edge（Chromium 116+），无需篡改猴。

视频、文档与章节切换无需 API Key；需要 AI 解题时再配置模型服务。

下载 `ai-course-helper-extension-{VERSION}.zip`，解压后在浏览器扩展管理页启用开发者模式，并加载包含 `manifest.json` 的文件夹。升级请替换原目录中的文件，点击「重新加载」并刷新课程页，以保留本地配置。

扩展会定期检查本仓库的稳定版，并提示下载。未上架的已解压扩展需要手动替换安装文件，不会把“发现新版”显示成“已安装新版”。

`ai-course-helper.user.js` 是可选的用户脚本版；与扩展版选择一个启用。`SHA256SUMS` 包含两个安装文件的校验值。

本次发布从标签 `{tag}` 的源码与本地锁定依赖构建，安装包不包含浏览器配置目录或模型密钥。

[使用说明](https://github.com/aides-hik/ai-course-helper/blob/{tag}/%E6%89%A9%E5%B1%95%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E.md) · [更新记录](https://github.com/aides-hik/ai-course-helper/blob/{tag}/%E4%BF%AE%E5%A4%8D%E8%AF%B4%E6%98%8E.md)
"""
    (dist / "release-notes.md").write_text(notes, encoding="utf-8", newline="\n")
    return {"version": VERSION, "tag": tag, "files": len(expected), "archive": archive.name,
            "archive_sha256": sha256(archive.read_bytes()), "userscript_sha256": sha256(script)}


if __name__ == "__main__":
    print(json.dumps(check_release(), ensure_ascii=False))
