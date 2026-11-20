"""LA MEMORIA ETERNA DI IDEAX — un database vettoriale LOCALE (ChromaDB).

Perché vettoriale e non una tabella SQL: una ricerca per parole trova solo le parole ESATTE. Un database vettoriale
trasforma ogni testo in un "embedding" — un elenco di numeri che cattura il SIGNIFICATO — e cerca per VICINANZA di
significato. Così «chiudere un gap di sicurezza» ritrova una soluzione archiviata come «sanare una falla», anche senza
una parola in comune. È questo che fa dire a ideax: «ho già visto qualcosa che somiglia a questo problema?».

Due collezioni, perché il "come si fa" tecnico e il "come appare" estetico vivono in spazi di significato diversi, e
tenerli separati rende ogni ricerca più pulita (un prompt di posa non deve mai inquinare la ricerca di un fix di codice):
  - tech_core:       snippet, fix, pattern di codice, logiche di auto-miglioramento.  Il "COME FARE".
  - creative_assets: prompt, stili, configurazioni di modelli, decisioni sui contenuti. Il "COME APPARE".

Tutto sul PC: gli embedding li calcola un modello LOCALE (all-MiniLM-L6-v2, ~80 MB, gira su CPU), niente cloud, niente
chiamate a pagamento, la conoscenza non esce di casa. I dati stanno in ~/.ideax/memoria.

Regola di casa (ripiego che URLA, mai muto): se ChromaDB o il modello non ci sono, si prova a installarli una volta; se
non riesce, la memoria si SPEGNE e lo dice — ideax continua a lavorare, solo senza ricordare. Una funzione senza memoria
è meno brava, non morta.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

COLLEZIONI = ("tech_core", "creative_assets")
BASE = Path(os.path.expanduser("~")) / ".ideax" / "memoria"
MODELLO_EMBED = "all-MiniLM-L6-v2"  # piccolo, veloce su CPU, locale: l'equilibrio giusto per una memoria che gira sempre

# Routing contestuale: a quale collezione appartiene un testo. Non è un modello, è un conteggio di indizi — basta e non
# sbaglia in modo costoso (nel dubbio si cerca in tutte e due). I pattern sono volutamente larghi.
_TECNICO = re.compile(r"\b(cod(?:ice|e)|bug|fix|error|errore|funzione|function|python|javascript|typescript|\.js|\.py|"
                      r"traceback|eccezione|exception|refactor|endpoint|snippet|pipeline|git|commit|regex|sql|query|"
                      r"classe|import|async|await|promise|crash|stack|deploy|build|test|vettor|chromadb|embedding|server)\b", re.I)
_CREATIVO = re.compile(r"\b(prompt|stile|style|lora|checkpoint|modell[oi]|facefusion|forge|face|volto|foto|immagine|"
                       r"\bvae\b|posa|pose|scena|colore?|luce|ritratto|incarnato|negativ|sampler|\bcfg\b|passi|steps|"
                       r"seed|realistico|esplicit|personaggio|gemello|sfondo|pelle)\b", re.I)

_stato = {"client": None, "ef": None, "coll": {}, "acceso": None, "motivo": None, "provato_install": False}


def _assicura_pacchetti() -> bool:
    """Rende disponibili chromadb + il modello di embedding. Una volta sola, best-effort, non solleva mai."""
    try:
        import chromadb  # noqa: F401
        from chromadb.utils import embedding_functions  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        pass
    if _stato["provato_install"]:
        return False
    _stato["provato_install"] = True
    try:
        print("[ideax] Memoria: installo ChromaDB e il modello di embedding (la prima volta)…", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                        "chromadb", "sentence-transformers"], check=False)
        import importlib
        importlib.invalidate_caches()
        import chromadb  # noqa: F401
        return True
    except Exception as err:  # noqa: BLE001
        _stato["motivo"] = f"installazione non riuscita: {err}"
        print(f"[ideax] Memoria spenta ({_stato['motivo']})", flush=True)
        return False


def _accendi() -> bool:
    """Apre il database e le due collezioni, una volta. Torna False (e spiega in _stato['motivo']) se non ci riesce."""
    if _stato["acceso"] is not None:
        return _stato["acceso"]
    if not _assicura_pacchetti():
        _stato["acceso"] = False
        return False
    try:
        import chromadb
        from chromadb.utils import embedding_functions
        BASE.mkdir(parents=True, exist_ok=True)
        # Il modello di embedding gira in locale; il primo uso lo scarica (~80 MB) e poi resta.
        _stato["ef"] = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=MODELLO_EMBED)
        _stato["client"] = chromadb.PersistentClient(path=str(BASE))
        for nome in COLLEZIONI:
            _stato["coll"][nome] = _stato["client"].get_or_create_collection(name=nome, embedding_function=_stato["ef"])
        _stato["acceso"] = True
        print(f"[ideax] Memoria accesa · {BASE} · collezioni: {', '.join(COLLEZIONI)}", flush=True)
        return True
    except Exception as err:  # noqa: BLE001
        _stato["motivo"] = str(err)
        _stato["acceso"] = False
        print(f"[ideax] Memoria spenta ({err})", flush=True)
        return False


def collezione_per(testo: str) -> Optional[str]:
    """La collezione giusta per un testo, dal contesto. None = ambiguo → si cerca in tutte e due."""
    t = len(_TECNICO.findall(testo or ""))
    c = len(_CREATIVO.findall(testo or ""))
    if t > c:
        return "tech_core"
    if c > t:
        return "creative_assets"
    return None


def stato() -> dict:
    acceso = _accendi()
    conteggi = {}
    if acceso:
        for nome, coll in _stato["coll"].items():
            try:
                conteggi[nome] = coll.count()
            except Exception:  # noqa: BLE001
                conteggi[nome] = None
    return {"acceso": acceso, "motivo": _stato["motivo"], "percorso": str(BASE), "conteggi": conteggi}


def ricorda(testo: str, ambito: Optional[str] = None, metadati: Optional[dict] = None, id_: Optional[str] = None) -> dict:
    """Archivia un ricordo nella collezione giusta. ambito: 'tech_core' | 'creative_assets' | None (dal contesto)."""
    if not _accendi():
        return {"ok": False, "motivo": _stato["motivo"] or "memoria non disponibile"}
    testo = (testo or "").strip()
    if not testo:
        return {"ok": False, "motivo": "niente da ricordare"}
    nome = ambito if ambito in COLLEZIONI else (collezione_per(testo) or "tech_core")  # nel dubbio il tecnico
    import hashlib
    rid = id_ or hashlib.sha1(f"{nome}|{testo}".encode("utf-8")).hexdigest()[:20]  # stesso testo = stesso id: niente doppioni
    meta = {k: v for k, v in (metadati or {}).items() if isinstance(v, (str, int, float, bool))}
    meta.setdefault("quando", time.strftime("%Y-%m-%d %H:%M"))
    try:
        _stato["coll"][nome].upsert(ids=[rid], documents=[testo], metadatas=[meta])
        return {"ok": True, "collezione": nome, "id": rid}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "motivo": str(err)}


def ricava(query: str, ambito: Optional[str] = None, quanti: int = 4) -> dict:
    """Ritrova i ricordi più VICINI per significato. ambito None/'auto' → sceglie la collezione dal contesto (o tutte e
    due se ambiguo). Torna i documenti con la loro distanza (più piccola = più pertinente) e i metadati."""
    if not _accendi():
        return {"ok": False, "motivo": _stato["motivo"] or "memoria non disponibile", "risultati": []}
    query = (query or "").strip()
    if not query:
        return {"ok": True, "risultati": []}
    if ambito in COLLEZIONI:
        nomi = [ambito]
    else:
        scelta = collezione_per(query)
        nomi = [scelta] if scelta else list(COLLEZIONI)  # ambiguo: cerca in tutte e due e fonde per distanza
    out = []
    for nome in nomi:
        try:
            r = _stato["coll"][nome].query(query_texts=[query], n_results=max(1, min(20, quanti)))
            docs = (r.get("documents") or [[]])[0]
            dists = (r.get("distances") or [[]])[0]
            metas = (r.get("metadatas") or [[]])[0]
            for i, d in enumerate(docs):
                out.append({"testo": d, "collezione": nome,
                            "distanza": float(dists[i]) if i < len(dists) else None,
                            "metadati": metas[i] if i < len(metas) else {}})
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "motivo": str(err), "risultati": []}
    out.sort(key=lambda x: (x["distanza"] if x["distanza"] is not None else 9e9))
    return {"ok": True, "risultati": out[:quanti], "cercato_in": nomi}
