"""Refresh pinned extension dependencies. The ordinary build never downloads code."""
from pathlib import Path
from urllib.request import urlopen
import hashlib
import io
import json
import tarfile
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "vendor"
PACKAGES = [
    ("vue", "3.4.31", {"dist/vue.runtime.global.prod.js": "vue.runtime.global.prod.js"}),
    ("vue-demi", "0.14.7", {"lib/index.iife.js": "vue-demi.js"}),
    ("element-plus", "2.7.2", {"dist/index.full.min.js": "element-plus.js", "dist/index.css": "element-plus.css"}),
    ("element-plus", "2.8.2", {"dist/index.css": "element-plus-shadow.css"}),
    ("pinia", "2.3.1", {"dist/pinia.iife.prod.js": "pinia.js"}),
    ("rxjs", "7.8.2", {"dist/bundles/rxjs.umd.min.js": "rxjs.js"}),
    ("blueimp-md5", "2.19.0", {"js/md5.min.js": "md5.js"}),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(url):
    for attempt in range(4):
        try:
            with urlopen(url, timeout=60) as response:
                return response.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    for name, version, files in PACKAGES:
        url = f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz"
        archive = download(url)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
            licenses = [member for member in package.getmembers() if member.isfile() and
                        member.name.count("/") == 1 and member.name.split("/")[-1].lower().startswith("license")]
            if not licenses:
                if name != "element-plus":
                    raise ValueError(f"No package license: {name}@{version}")
                license_url = f"https://raw.githubusercontent.com/element-plus/element-plus/{version}/LICENSE"
                license_data = download(license_url)
                license_file = f"LICENSE-{name}-{version}.txt"
                (OUT / license_file).write_bytes(license_data)
                records.append({"file": license_file, "package": name, "version": version,
                                "source": license_url, "sha256": digest(license_data)})
            for member in licenses:
                files[member.name.removeprefix("package/")] = f"LICENSE-{name}-{version}.txt"
            for source, target in files.items():
                data = package.extractfile("package/" + source).read()
                (OUT / target).write_bytes(data)
                records.append({"file": target, "package": name, "version": version,
                                "source": url, "member": "package/" + source, "sha256": digest(data)})
        print(f"Vendored {name}@{version}")
    table_url = "https://www.forestpolice.org/ttf/2.0/table.json"
    data = download(table_url)
    if not isinstance(json.loads(data), dict):
        raise ValueError("Invalid font mapping")
    (OUT / "font-table.json").write_bytes(data)
    records.append({"file": "font-table.json", "source": table_url, "sha256": digest(data)})
    (OUT / "lock.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
