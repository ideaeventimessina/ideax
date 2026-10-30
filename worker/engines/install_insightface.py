"""Installa insightface 0.7.3 senza compilare niente.

Su Windows insightface esiste solo come sorgente da compilare (serve Visual Studio), ma a LatentSync serve
solo la parte in Python: il rilevatore di volti e i punti del viso, che girano con onnxruntime.
Scarichiamo il sorgente ufficiale da PyPI (controllando l'impronta), copiamo il pacchetto senza la parte
da compilare (thirdparty/face3d e il "mask renderer" che la usa) e lo mettiamo nell'ambiente del motore.
"""
from __future__ import annotations

import hashlib
import io
import shutil
import sys
import sysconfig
import tarfile
import urllib.request
from pathlib import Path

URL = "https://files.pythonhosted.org/packages/0b/8d/0f4af90999ca96cf8cb846eb5ae27c5ef5b390f9c090dd19e4fa76364c13/insightface-0.7.3.tar.gz"
SHA256 = "f191f719612ebb37018f41936814500544cd0f86e6fcd676c023f354c668ddf7"
SKIP = ("insightface/thirdparty/", "insightface/app/mask_renderer.py", "insightface/commands/")


def main() -> None:
    target = Path(sysconfig.get_paths()["purelib"])
    print(f"[ideax] scarico insightface 0.7.3 da PyPI", flush=True)
    data = urllib.request.urlopen(URL, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        sys.exit("insightface: l'impronta del file scaricato non corrisponde, installazione fermata")
    dest = target / "insightface"
    shutil.rmtree(dest, ignore_errors=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            rel = m.name.split("/", 1)[1] if "/" in m.name else ""
            if not rel.startswith("insightface/") or not m.isfile() or rel.startswith(SKIP):
                continue
            out = target / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(m).read())
    init = dest / "__init__.py"
    init.write_text(init.read_text(encoding="utf-8").replace("from . import thirdparty\n", ""), encoding="utf-8")
    app = dest / "app" / "__init__.py"
    app.write_text(app.read_text(encoding="utf-8").replace("from .mask_renderer import *\n", ""), encoding="utf-8")
    info = target / "insightface-0.7.3.dist-info"
    info.mkdir(exist_ok=True)
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: insightface\nVersion: 0.7.3\n", encoding="utf-8")
    (info / "INSTALLER").write_text("ideax\n", encoding="utf-8")
    (info / "RECORD").write_text("", encoding="utf-8")
    print(f"[ideax] insightface pronto in {dest}", flush=True)


if __name__ == "__main__":
    main()
