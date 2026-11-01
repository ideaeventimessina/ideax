// Verifica del token di Hugging Face: chi sei, che tipo di token è e se puoi scaricare i modelli protetti
// che ideax usa. Dice esattamente cosa manca (licenza non accettata, token "fine-grained" senza il permesso giusto…).
import { getSettings } from './store.js';

const HF = process.env.IDEAX_HF_BASE || 'https://huggingface.co';
const GATED = [
  { repo: 'black-forest-labs/FLUX.1-dev', file: 'model_index.json', usedBy: 'Gemello foto e Flux' },
  { repo: 'stabilityai/stable-video-diffusion-img2vid-xt-1-1', file: 'model_index.json', usedBy: 'Stable Video Diffusion' },
];

export async function check() {
  const token = getSettings().hfToken;
  if (!token) return { ok: false, problem: 'Non hai ancora inserito il token di Hugging Face.' };
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ideax' };
  const who = await fetch(`${HF}/api/whoami-v2`, { headers, signal: AbortSignal.timeout(15_000) });
  if (who.status === 401) return { ok: false, problem: 'Il token non è valido o è stato cancellato: creane uno nuovo su huggingface.co/settings/tokens (tipo "Read").' };
  if (!who.ok) return { ok: false, problem: `Hugging Face non risponde (${who.status}): riprova fra poco.` };
  const me = await who.json();
  const role = me.auth?.accessToken?.role || 'sconosciuto';
  const repos = [];
  for (const g of GATED) {
    const r = await fetch(`${HF}/${g.repo}/resolve/main/${g.file}`, { method: 'HEAD', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const access = r.status < 400;
    let fix = null;
    if (!access) {
      fix = role === 'fineGrained'
        ? `Il tuo token è di tipo "fine-grained": aprilo su huggingface.co/settings/tokens, spunta "Read access to contents of all public gated repos you can access" e salva (oppure crea un token di tipo "Read"). Se non l'hai ancora fatto, accetta anche la licenza su huggingface.co/${g.repo}.`
        : `Accetta la licenza: apri huggingface.co/${g.repo} con l'account ${me.name}, premi "Agree and access repository" e aspetta il messaggio "You have been granted access". Se l'hai appena fatto, riprova fra un minuto.`;
    }
    repos.push({ ...g, access, status: r.status, fix });
  }
  return { ok: repos.every((r) => r.access), user: me.name, role, repos };
}

// ---------- Richiesta di accesso a un modello protetto ----------
// Su Hugging Face si "accetta la licenza" con il modulo della pagina del modello. ideax invia lo stesso modulo
// con il tuo token, solo dopo la tua conferma esplicita nell'interfaccia. Se Hugging Face non lo accetta
// (alcuni modelli vogliono il clic dal sito), chi chiama apre la pagina nel browser.

async function hasAccess(repo, headers) {
  const r = await fetch(`${HF}/${repo}/resolve/main/model_index.json`, { method: 'HEAD', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  return r.status < 400;
}

// I campi che il modulo chiede (nome, email, paese…) con i valori che conosciamo già
export async function gateInfo(repo) {
  const token = getSettings().hfToken;
  if (!GATED.some((g) => g.repo === repo)) throw new Error('Modello non previsto');
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ideax' };
  const [info, who] = await Promise.all([
    fetch(`${HF}/api/models/${repo}`, { headers }).then((r) => r.json()).catch(() => ({})),
    fetch(`${HF}/api/whoami-v2`, { headers }).then((r) => r.json()).catch(() => ({})),
  ]);
  const raw = info.cardData?.extra_gated_fields || {};
  const fields = Object.entries(raw).map(([label, type]) => {
    const t = typeof type === 'object' ? type.type || 'text' : String(type);
    const l = label.toLowerCase();
    const guess = /email/.test(l) ? who.email || '' : /first name|^name|full name|nome/.test(l) ? (who.fullname || who.name || '').split(' ')[0] : /last name|cognome/.test(l) ? (who.fullname || '').split(' ').slice(1).join(' ') : '';
    return { label, type: t === 'checkbox' ? 'checkbox' : 'text', options: type?.options, value: guess };
  });
  return { repo, gated: info.gated || false, prompt: info.cardData?.extra_gated_prompt || '', fields, url: `https://huggingface.co/${repo}`, user: who.name };
}

export async function requestAccess(repo, values = {}) {
  const token = getSettings().hfToken;
  if (!token) throw new Error('Inserisci prima il token di Hugging Face');
  if (!GATED.some((g) => g.repo === repo)) throw new Error('Modello non previsto');
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ideax' };
  if (await hasAccess(repo, headers)) return { ok: true, already: true };
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) form.append(k, v === true ? 'on' : String(v ?? ''));
  const r = await fetch(`${HF}/${repo}/ask-access`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => ({ status: 0, error: err.message }));
  // Alcuni modelli danno l'accesso subito, altri dopo l'approvazione dell'autore
  for (let i = 0; i < 5; i++) {
    if (await hasAccess(repo, headers)) return { ok: true };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ok: false, status: r.status, url: `https://huggingface.co/${repo}` };
}
