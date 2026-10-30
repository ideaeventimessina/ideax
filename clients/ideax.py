"""Client per usare ideax da qualsiasi sistema Python (solo libreria standard).

    from ideax import Ideax
    ai = Ideax("http://192.168.1.10:7800", "ideax_sk_…")
    job = ai.generate("Un faro al tramonto, stile acquerello", params={"aspect": "16:9"})
    ai.download(job, "risultati/")

    # Con un file e un webhook
    ai.generate("Mettilo su una spiaggia", files=["foto.jpg"], callback_url="https://…/ideax-webhook")
"""
import hashlib
import hmac
import json
import mimetypes
import os
import time
import urllib.parse
import urllib.request
import uuid


class Ideax:
    def __init__(self, base_url="http://127.0.0.1:7800", api_key=""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self, extra=None):
        h = dict(extra or {})
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _request(self, path, method="GET", body=None, content_type="application/json"):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method,
                                     headers=self._headers({"Content-Type": content_type} if data else {}))
        try:
            with urllib.request.urlopen(req, timeout=3600) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            payload = err.read().decode()
            if err.code == 500:  # lavoro fallito: la risposta contiene comunque il lavoro con "error"
                return json.loads(payload)
            raise RuntimeError(f"ideax HTTP {err.code}: {payload}") from None

    def generate(self, prompt, files=(), **options):
        """options: task, model, params, metadata, callback_url, wait, inline, attachments."""
        if not files:
            return self._request("/v1/generate", "POST", {"prompt": prompt, **options})
        boundary = uuid.uuid4().hex
        parts = []

        def field(name, value):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())

        field("prompt", prompt)
        for k, v in options.items():
            field(k, json.dumps(v) if isinstance(v, (dict, list, bool)) else v)
        for path in files:
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            with open(path, "rb") as fh:
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{os.path.basename(path)}"\r\n'
                             f"Content-Type: {mime}\r\n\r\n".encode() + fh.read() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self._request("/v1/generate", "POST", b"".join(parts), f"multipart/form-data; boundary={boundary}")

    def job(self, job_id):
        return self._request(f"/v1/jobs/{job_id}")

    def cancel(self, job_id):
        return self._request(f"/v1/jobs/{job_id}/cancel", "POST", b"")

    def wait_for(self, job_id, every=1.5):
        while True:
            j = self.job(job_id)
            if j["status"] in ("done", "error", "cancelled"):
                return j
            time.sleep(every)

    def models(self):
        return self._request("/v1/models")

    def health(self):
        return self._request("/v1/health")

    def creations(self, **query):
        """query: type (image|video|animation), q, limit, offset."""
        qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        return self._request(f"/v1/creations?{qs}")

    def creation(self, creation_id):
        return self._request(f"/v1/creations/{creation_id}")

    def delete_creation(self, creation_id):
        return self._request(f"/v1/creations/{creation_id}", "DELETE")

    def download(self, job, folder="."):
        os.makedirs(folder, exist_ok=True)
        paths = []
        for r in job["results"]:
            dest = os.path.join(folder, r["url"].rsplit("/", 1)[-1])
            req = urllib.request.Request(r["url"], headers=self._headers())
            with urllib.request.urlopen(req) as res, open(dest, "wb") as out:
                out.write(res.read())
            paths.append(dest)
        return paths


def verify_webhook(body: bytes, signature: str, secret: str) -> bool:
    """Verifica la firma di un webhook: body = corpo grezzo, signature = intestazione X-Ideax-Signature."""
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")
