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
