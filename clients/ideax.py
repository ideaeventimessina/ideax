"""Client minimo per usare ideax da qualsiasi app Python.

    from ideax import Ideax
    ai = Ideax("http://192.168.1.10:7800")
    job = ai.generate("un gatto astronauta ad acquerello")
    ai.download(job, "risultati/")
"""
import base64
import json
import mimetypes
import os
import urllib.request


class Ideax:
    def __init__(self, base_url="http://127.0.0.1:7800", token=""):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, path, body=None):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=3600) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"ideax: {err.read().decode()}") from None

    def generate(self, prompt, files=(), **options):
        """files: percorsi di immagini/video da allegare. options: task, model, params, wait."""
        attachments = options.pop("attachments", [])
        for path in files:
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            with open(path, "rb") as fh:
                attachments.append({"name": os.path.basename(path), "type": mime, "base64": base64.b64encode(fh.read()).decode()})
        return self._request("/v1/generate", {"prompt": prompt, "attachments": attachments, **options})

    def job(self, job_id):
        return self._request(f"/v1/jobs/{job_id}")

    def models(self):
        return self._request("/v1/models")

    def download(self, job, folder="."):
        os.makedirs(folder, exist_ok=True)
        paths = []
        for r in job["results"]:
            dest = os.path.join(folder, r["url"].rsplit("/", 1)[-1])
            urllib.request.urlretrieve(r["url"], dest)
            paths.append(dest)
        return paths
