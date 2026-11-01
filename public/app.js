// ideax · interfaccia
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth)$/i;
const VIDEO_TASKS = ['image_to_video', 'video_generate', 'video_edit'];

const state = {
  meta: { tasks: {}, archs: {}, kinds: {} },
  models: { local: [], servers: [], generators: [], dirs: [], brain: '' },
  history: [],
  worker: { online: false },
  setup: null,
  settings: null,
  format: 'auto',
  filter: 'all',
  attachments: [],
  job: null, // lavoro in corso
  shown: null, // creazione mostrata nel riquadro grande
  lastRequest: null,
  step: 1,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

const fmtSize = (b) => (b == null ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const kindOf = (task) => (['reel', 'talk'].includes(task) ? 'video' : ['speech', 'music'].includes(task) ? 'audio' : task === 'animation' ? 'animation' : VIDEO_TASKS.includes(task) ? 'video' : 'image');
const KIND_NAME = { image: 'Immagine', video: 'Video', animation: 'Animazione', audio: 'Audio' };
const MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
// Barre decorative "a onda", sempre uguali per lo stesso id
function waveBars(seed, n = 48) {
  let x = [...String(seed)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) >>> 0; return `<i style="height:${18 + (x % 72)}%"></i>`; }).join('');
}

function when(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return `Oggi, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ieri, ${time}`;
  return `${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}, ${time}`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copiato ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

// ======================= Navigazione =======================

function showPage() {
  const page = location.hash.slice(1) || 'studio';
  const exists = $(`#page-${page}`);
  $$('.page').forEach((p) => p.classList.toggle('active', p === (exists || $('#page-studio'))));
  $$('.nav a').forEach((a) => (a.dataset.page === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (page === 'primi-passi') renderOnboarding();
  if (page === 'impostazioni') { renderEngine($('#engine-card')); loadNetwork(); loadEngines(); loadHfToken(); }
  if (page === 'voce') { loadEngines(); loadVoices(); loadVoiceLib(); }
  if (page === 'musica') loadEngines();
  if (page === 'reel') { loadReelForm(); loadCatena(); }
  if (page === 'cervello') loadBrainPage();
  if (page === 'collega') loadSystems();
  if (page === 'regia') loadRegia();
  if (page === 'modelli') { loadEngines(); loadFixes(); refreshSetup().then(() => { renderLlmSupport(); if (state.engines) renderEngines(); }); }
  if (page === 'gemello') { loadEngines(); loadTwin(); loadPersonaggi(); }
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', showPage);

$$('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ideax-theme', next); } catch {}
}));

$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ======================= Studio: composizione =======================

const CREATE_LABEL = { auto: 'Crea', image: 'Crea immagine', video: 'Crea video', animation: 'Crea animazione' };

function setFormat(f) {
  state.format = f;
  $$('.formats button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.format === f)));
  $('#create-label').textContent = CREATE_LABEL[f];
}
$$('.formats button').forEach((b) => b.addEventListener('click', () => setFormat(b.dataset.format)));

function taskForFormat() {
  const img = state.attachments.some((a) => a.type.startsWith('image/'));
  const vid = state.attachments.some((a) => a.type.startsWith('video/'));
  if (state.format === 'image') return img ? 'image_edit' : 'image_generate';
  if (state.format === 'video') return vid ? 'video_edit' : img ? 'image_to_video' : 'video_generate';
  if (state.format === 'animation') return 'animation';
  return undefined;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, dataUrl: r.result });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const f of files) if (/^(image|video)\//.test(f.type)) state.attachments.push(await readFile(f));
  renderAttachments();
}

function renderAttachments() {
  $('#attachments').innerHTML = state.attachments.map((a, i) => `
    <div class="thumb">
      ${a.type.startsWith('video/') ? `<video src="${a.dataUrl}" muted></video>` : `<img src="${a.dataUrl}" alt="${esc(a.name)}">`}
      <button data-rm="${i}" aria-label="Rimuovi ${esc(a.name)}">✕</button>
    </div>`).join('');
}
$('#attachments').addEventListener('click', (e) => {
  const i = e.target.dataset.rm;
  if (i !== undefined) { state.attachments.splice(Number(i), 1); renderAttachments(); }
});
$('#file').addEventListener('change', (e) => { addAttachments(e.target.files); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && $('#page-studio').classList.contains('active')) {
    if (chatMode()) addChatAttachments(files);
    else addAttachments(files);
  }
});
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#create').click(); });

function updateChoicesSummary() {
  const parts = [];
  const m = state.models.generators.find((x) => x.id === $('#model-override').value);
  if (m) parts.push(m.name);
  if ($('#aspect').value) parts.push($('#aspect').selectedOptions[0].textContent.split(' · ')[0]);
  if ($('#seed').value) parts.push(`seme ${$('#seed').value}`);
  $('#choices-summary').textContent = parts.length ? parts.join(' · ') : 'Scelte per te, in automatico';
}
['#model-override', '#aspect', '#seed'].forEach((s) => $(s).addEventListener('change', updateChoicesSummary));

// ======================= Studio: generazione =======================

$('#create').addEventListener('click', () => {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return; }
  const params = {};
  if ($('#aspect').value) params.aspect = $('#aspect').value;
  if ($('#seed').value) params.seed = Number($('#seed').value);
  submit({
    prompt,
    attachments: state.attachments,
    model: $('#model-override').value || undefined,
    task: taskForFormat(),
    params,
  });
});

async function submit(request) {
  if (state.job && !['done', 'error', 'cancelled'].includes(state.job.status)) return;
  state.lastRequest = request;
  $('#create').disabled = true;
  state.job = { status: 'queued', prompt: request.prompt, log: [] };
  renderStage();
  try {
    const { id } = await api('/api/generate', { method: 'POST', body: request });
    $('#prompt').value = '';
    state.attachments = [];
    renderAttachments();
    await poll(id);
  } catch (err) {
    state.job = { status: 'error', error: err.message, prompt: request.prompt, log: [] };
    renderStage();
  } finally {
    $('#create').disabled = false;
  }
}

async function poll(id) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    state.job = job;
    if (job.status === 'done') {
      await loadHistory();
      state.shown = state.history.find((h) => h.id === job.id) || job;
      state.job = null;
      renderStage();
      return;
    }
    renderStage();
    if (job.status === 'error' || job.status === 'cancelled') return;
    await new Promise((r) => setTimeout(r, 800));
  }
}

function errorAdvice(msg) {
  if (/Memoria della GPU/i.test(msg)) {
    return { title: 'Memoria della GPU esaurita', text: 'Prova una risoluzione più bassa oppure meno fotogrammi.', actions: ['retry-small', 'retry'] };
  }
  if (/contattare|ECONNREFUSED|è avviato|worker HTTP/i.test(msg)) {
    return { title: 'Il motore non risponde', text: 'Il worker che usa la scheda video è spento o si sta ancora avviando.', actions: ['restart', 'settings'] };
  }
  if (/Nessun modello collegato|Nessun modello attivo|sa fare/i.test(msg)) {
    return { title: 'Manca un modello adatto', text: msg, actions: ['models'] };
  }
  return { title: 'Qualcosa non è andato', text: msg, actions: ['retry'] };
}

const ART = `<svg class="art" viewBox="0 0 320 220" aria-hidden="true">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7055dd" stop-opacity=".55"/><stop offset="1" stop-color="#b6a5ff" stop-opacity=".08"/></linearGradient></defs>
  <rect width="320" height="220" rx="24" fill="url(#sky)"/>
  <circle cx="160" cy="88" r="38" fill="#f6d8b8" opacity=".9"/>
  <path d="M0 170 L70 110 L120 150 L180 95 L250 150 L320 120 L320 220 L0 220Z" fill="#14151b" opacity=".75"/>
  <path d="M0 190 L90 150 L160 185 L240 155 L320 180 L320 220 L0 220Z" fill="#0d0e12" opacity=".8"/>
</svg>`;

function renderStage() {
  const stage = $('#stage');
  const meta = $('#stage-meta');
  const how = $('#how');
  const job = state.job;
  const active = job && !['done', 'error', 'cancelled'].includes(job.status);
  if (!active) delete stage.dataset.sig;

  if (job && !['done'].includes(job.status)) {
    how.hidden = true;
    meta.innerHTML = '';
    if (job.status === 'error' || job.status === 'cancelled') {
      if (job.status === 'cancelled') {
        stage.innerHTML = `<div class="stage-glow"></div><div class="stage-state"><span class="chip">Annullato</span><h2>Lavoro annullato</h2><p class="muted">Puoi modificare l'idea e riprovare quando vuoi.</p></div>`;
        return;
      }
      const a = errorAdvice(job.error || '');
      const buttons = {
        'retry-small': '<button class="btn" data-act="retry-small">Riprova a 768 × 768</button>',
        retry: '<button class="btn" data-act="retry">Riprova</button>',
        restart: '<button class="btn" data-act="restart">Riavvia il worker</button>',
        settings: '<a class="btn" href="#impostazioni">Apri impostazioni</a>',
        models: '<a class="btn" href="#modelli">Vai ai modelli</a>',
      };
      stage.innerHTML = `<div class="stage-state"><div class="note error"><h3>${esc(a.title)}</h3><p>${esc(a.text)}</p>
        <div class="row">${a.actions.map((x) => buttons[x]).join('')}</div></div>
        ${job.log?.length ? `<details><summary class="muted small">Dettagli</summary><div class="log">${job.log.map((l) => esc(l.msg)).join('\n')}</div></details>` : ''}</div>`;
      return;
    }
    let chip, title, text, pct = null;
    if (job.status === 'queued' || job.status === 'routing') {
      chip = '01 · Interpretazione';
      title = 'Sto capendo cosa ti serve…';
      text = 'Scelgo il modello e preparo il prompt.';
    } else if (job.waiting) {
      chip = 'In fila';
      title = 'La GPU sta finendo un altro lavoro';
      text = 'Partiremo appena sarà libera. Puoi continuare a usare ideax.';
    } else {
      chip = '02 · Generazione';
      title = 'Il modello sta lavorando…';
      const p = job.progress;
      if (p?.total) {
        pct = Math.round((p.step / p.total) * 100);
        const elapsed = job.log?.length ? (Date.now() - job.log[job.log.length - 1].t) / 1000 : 0;
        const eta = p.step > 1 && elapsed > 0 ? Math.round((elapsed / p.step) * (p.total - p.step)) : null;
        text = `${p.step} di ${p.total} passi${eta ? ` · circa ${eta} s rimanenti` : ''}`;
      } else {
        text = p?.phase === 'Carico il modello in memoria' ? 'Carico il modello in memoria: la prima volta può richiedere un minuto.' : `${job.model ? `${job.model} · ` : ''}preparazione in corso.`;
      }
    }
    // Se la fase non cambia aggiorniamo solo testo e barra: il pulsante Annulla resta cliccabile
    const sig = `${job.id}|${chip}|${pct == null}`;
    if (stage.dataset.sig === sig) {
      $('.stage-text', stage).textContent = text;
      $('.progress > div', stage).style.width = `${pct ?? 0}%`;
      return;
    }
    stage.dataset.sig = sig;
    stage.innerHTML = `<div class="stage-glow"></div><div class="stage-state">
      <span class="chip">${esc(chip)}</span><h2>${esc(title)}</h2><p class="muted stage-text">${esc(text)}</p>
      <div class="progress ${pct == null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div>
      ${job.id ? '<div class="row"><button class="btn" data-act="cancel">Annulla questo lavoro</button></div>' : ''}
      ${job.reason ? `<p class="muted small">${esc(job.reason)}</p>` : ''}</div>`;
    return;
  }

  const item = state.shown;
  if (!item || !item.results?.length) {
    how.hidden = true;
    meta.innerHTML = '';
    stage.innerHTML = `<div class="stage-empty">${ART}<strong>La tua prima creazione apparirà qui</strong><span class="small">Scrivi un'idea a sinistra e premi Crea.</span></div>`;
    return;
  }
  const kind = kindOf(item.task);
  if (kind === 'audio') {
    const a = item.results[0];
    stage.innerHTML = `<div class="stage-glow"></div><div class="audio-stage">
      <span class="chip">${MIC.replace('<svg', '<svg style="width:14px;height:14px"')} ${esc(item.modelName || 'Audio')}${a.seconds ? ` · ${String(a.seconds).replace('.', ',')} s` : ''}</span>
      <h2>${esc(item.title || item.prompt)}</h2>
      <div class="wave">${waveBars(item.id)}</div>
      <audio src="${esc(a.url)}" controls></audio>
      <div class="row"><a class="btn light small" href="${esc(a.url)}" download>↓ Scarica ${a.type === 'audio/wav' ? 'WAV' : 'MP3'}</a>
        <button class="btn small" data-act="delete" data-id="${esc(item.id)}">Elimina</button></div></div>`;
    $('#stage-meta').innerHTML = `<span>✓ <strong>Completato</strong>${item.seconds != null ? ` · ${item.seconds} secondi` : ''}</span><span>${esc(item.modelName || '')}</span>`;
    $('#how').hidden = false;
    $('#how-body').innerHTML = `<dl><dt>Testo letto</dt><dd>${esc(item.prompt)}</dd>${item.client ? `<dt>Richiesto da</dt><dd>${esc(item.client)}</dd>` : ''}</dl>`;
    return;
  }
  const main = item.results.find((r) => r.type.startsWith('video/')) || item.results[0];
  const gif = item.results.find((r) => r.type === 'image/gif');
  const media = main.type.startsWith('video/')
    ? `<video class="media contain" src="${esc(main.url)}" autoplay loop muted playsinline></video>`
    : `<img class="media ${kind === 'image' ? '' : 'contain'}" src="${esc(main.url)}" alt="${esc(item.title || item.prompt)}">`;
  stage.innerHTML = `${media}
    <span class="badge-top">✦ ${state.history[0]?.id === item.id ? 'La tua ultima creazione' : esc(when(item.createdAt))}</span>
    <button class="expand" data-act="expand" aria-label="Apri a schermo intero"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>
    <div class="overlay">
      <h2>${esc(item.title || item.prompt)}</h2>
      <p id="stage-dims">${KIND_NAME[kind]}</p>
      <div class="row">
        <a class="btn light small" href="${esc(main.url)}" download>↓ Scarica${main.type.startsWith('video/') ? ' MP4' : ''}</a>
        ${gif && gif !== main ? `<a class="btn glass small" href="${esc(gif.url)}" download>↓ GIF</a>` : ''}
        ${/^image\/(png|jpeg|webp)/.test(main.type) ? `<button class="btn glass small" data-act="reuse" data-url="${esc(main.url)}">Modifica ancora ↗</button>` : ''}
        <button class="btn glass small" data-act="delete" data-id="${esc(item.id)}" aria-label="Elimina questa creazione">Elimina</button>
      </div>
    </div>`;
  const el = $('.media', stage);
  const setDims = () => {
    const w = el.naturalWidth || el.videoWidth;
    const h = el.naturalHeight || el.videoHeight;
    if (w) $('#stage-dims').textContent = `${KIND_NAME[kind]} · ${w} × ${h}`;
  };
  el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', setDims);
  if (el.complete) setDims();

  meta.innerHTML = `<span>✓ <strong>Completato</strong>${item.seconds != null ? ` · ${item.seconds} secondi` : ''}</span>
    <span>${esc(item.modelName || item.model || '')}${item.loras?.length ? ` + ${esc(item.loras.join(', '))}` : ''}</span>`;
  how.hidden = false;
  const rows = [
    ['La tua idea', item.prompt],
    ['Compito', state.meta.tasks[item.task]],
    ['Modello', item.modelName || item.model],
    ['LoRA', item.loras?.length ? item.loras.join(', ') : 'nessuna'],
    ['Cervello', item.brain],
    ['Prompt per il modello', item.routedPrompt],
    ['Da evitare', item.negativePrompt],
    ['Perché', item.reason],
  ].filter(([, v]) => v);
  $('#how-body').innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

$('#stage').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'cancel' && state.job?.id) {
    btn.disabled = true;
    await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => {});
  }
  if (act === 'retry' && state.lastRequest) submit(state.lastRequest);
  if (act === 'retry-small' && state.lastRequest) submit({ ...state.lastRequest, params: { ...state.lastRequest.params, width: 768, height: 768, aspect: undefined } });
  if (act === 'restart') {
    btn.disabled = true;
    btn.textContent = 'Riavvio…';
    await api('/api/worker/restart', { method: 'POST' }).catch(() => {});
    setTimeout(refreshStatus, 3000);
  }
  if (act === 'delete' && confirm('Eliminare questa creazione e i suoi file?')) {
    await api(`/api/history/${btn.dataset.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    state.shown = null;
    await loadHistory();
    renderStage();
  }
  if (act === 'expand') {
    const m = $('.media', $('#stage'));
    $('#lightbox-body').innerHTML = m.tagName === 'VIDEO'
      ? `<video src="${esc(m.getAttribute('src'))}" controls autoplay loop></video>`
      : `<img src="${esc(m.getAttribute('src'))}" alt="">`;
    $('#lightbox').showModal();
  }
  if (act === 'reuse') {
    const url = btn.dataset.url;
    const blob = await (await fetch(url)).blob();
    await addAttachments([new File([blob], url.split('/').pop(), { type: blob.type })]);
    setFormat('image');
    $('#prompt').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
$('#lightbox').addEventListener('close', () => { $('#lightbox-body').innerHTML = ''; });

// ======================= Studio: creazioni =======================

async function loadHistory() {
  state.history = await api('/api/history');
  if (!state.shown || !state.history.some((h) => h.id === state.shown.id)) state.shown = state.history.find((h) => h.status === 'done') || null;
  renderGallery();
}

function renderGallery() {
  const items = state.history.filter((h) => h.status === 'done' && (state.filter === 'all' || kindOf(h.task) === state.filter));
  $('#gallery').innerHTML = items.length ? items.map((h) => {
    const r = h.results?.find((x) => x.type.startsWith('video/')) || h.results?.[0];
    const kind = kindOf(h.task);
    const media = !r ? '' : r.type.startsWith('audio/') ? MIC : r.type.startsWith('video/')
      ? `<video src="${esc(r.url)}" muted loop playsinline preload="metadata"></video>`
      : `<img src="${esc(r.url)}" alt="" loading="lazy">`;
    return `<button class="tile" data-id="${h.id}">
      <div class="frame${kind === 'audio' ? ' audio' : ''}">${media}${kind !== 'image' ? `<span class="chip">${KIND_NAME[kind]}</span>` : ''}</div>
      <div><strong>${esc(h.title || h.prompt)}</strong><span>${esc(when(h.createdAt))} · ${esc(h.modelName || '')}</span></div>
    </button>`;
  }).join('') : `<div class="empty">${state.history.length ? 'Nessuna creazione di questo tipo.' : 'Le tue creazioni compariranno qui.'}</div>`;
}

$$('.filters button').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  $$('.filters button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderGallery();
}));
$('#gallery').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  state.shown = state.history.find((h) => h.id === tile.dataset.id);
  if (state.job && ['done', 'error', 'cancelled'].includes(state.job.status)) state.job = null;
  setStudioMode('crea');
  renderStage();
  $('#stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#gallery').addEventListener('mouseover', (e) => e.target.closest('.tile')?.querySelector('video')?.play().catch(() => {}));
$('#gallery').addEventListener('mouseout', (e) => e.target.closest('.tile')?.querySelector('video')?.pause());

// ======================= Trascinamento file =======================

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const onStudio = () => $('#page-studio').classList.contains('active');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (onStudio()) $(chatMode() ? '#chat-drop' : '#idea').classList.add('over');
  else $('#dropmask').classList.add('show');
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropmask').classList.remove('show'); $('#idea').classList.remove('over'); $('#chat-drop').classList.remove('over'); }
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropmask').classList.remove('show');
  $('#idea').classList.remove('over');
  $('#chat-drop').classList.remove('over');
  const files = [...e.dataTransfer.files];
  const models = files.filter((f) => MODEL_FILE.test(f.name));
  const media = files.filter((f) => /^(image|video)\//.test(f.type));
  if (models.length) {
    if (!['#modelli', '#primi-passi'].includes(location.hash)) location.replace('#modelli');
    models.forEach(uploadModel);
  }
  if (media.length) {
    if (!onStudio()) location.replace('#studio');
    if (chatMode()) addChatAttachments(media);
    else addAttachments(media);
  }
  // Testi trascinati nella chat: li legge il cervello
  const texts = files.filter((f) => !models.includes(f) && !media.includes(f) && /\.(txt|md|csv|json|html?)$/i.test(f.name));
  if (texts.length && onStudio() && chatMode()) addChatAttachments(texts);
});
$$('[data-model-input]').forEach((input) => input.addEventListener('change', (e) => {
  [...e.target.files].forEach(uploadModel);
  e.target.value = '';
}));

function uploadModel(file) {
  const row = document.createElement('div');
  row.className = 'upload';
  row.innerHTML = `<div class="top"><strong>${esc(file.name)}</strong><span class="muted pct">${fmtSize(file.size)} · 0%</span></div>
    <div class="progress"><div style="width:0%"></div></div><span class="muted small status">Caricamento…</span>`;
  const containers = $$('.uploads').filter((u) => u.offsetParent !== null);
  (containers[0] || $$('.uploads')[0]).prepend(row);
  const xhr = new XMLHttpRequest();
  const started = Date.now();
  xhr.open('PUT', `/api/upload?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('.progress div', row).style.width = pct + '%';
    $('.pct', row).textContent = `${fmtSize(file.size)} · ${pct}%`;
    const secs = (Date.now() - started) / 1000;
    const left = e.loaded ? Math.round((secs / e.loaded) * (e.total - e.loaded)) : 0;
    $('.status', row).textContent = left > 2 ? `circa ${left} s rimanenti` : 'Quasi fatto…';
  };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) {
      $('.status', row).innerHTML = `<span class="fail">${esc(body.error || 'Errore')}</span>`;
      return;
    }
    const what = [state.meta.kinds[body.kind], state.meta.archs[body.arch]].filter(Boolean).join(' · ');
    $('.status', row).innerHTML = `<span class="done">✓ Collegato${what ? `: ${esc(what)}` : ''}</span>`;
    loadModels();
    setTimeout(() => row.remove(), 10000);
  };
  xhr.onerror = () => { $('.status', row).innerHTML = '<span class="fail">Caricamento interrotto</span>'; };
  xhr.send(file);
}

// ======================= Modelli =======================

const GROUPS = [
  ['checkpoint', 'Modelli'],
  ['lora', 'LoRA'],
  ['motion', 'Moduli di movimento'],
  ['llm', 'Cervello'],
  ['vae', 'VAE'],
];
const KIND_TAGS = { motion: ['Animazione/GIF'], llm: ['Comprensione · Prompt'], vae: ['Decodifica immagini'] };

function modelCard(m) {
  const internal = m.path.startsWith(state.models.dirs[0]);
  const tags = m.kind === 'checkpoint' ? m.capabilities.map((c) => state.meta.tasks[c])
    : m.kind === 'lora' ? (m.triggerWords ? m.triggerWords.split(',').map((x) => x.trim()).filter(Boolean) : ['Nessuna parola chiave'])
      : KIND_TAGS[m.kind] || [];
  const style = m.kind === 'checkpoint' && m.styleAuto !== undefined ? (m.promptStyle && m.promptStyle !== 'auto' ? m.promptStyle : m.styleAuto) : null;
  const meta = [fmtSize(m.size), m.kind === 'checkpoint' ? `Priorità ${m.priority}` : '', style && style !== 'plain' ? `Stile ${state.meta.styles[style]}` : '', m.kind === 'lora' ? `peso ${m.loraWeight}${m.loraAlways ? ' · sempre attiva' : ''}` : ''].filter(Boolean).join(' · ');
  // Avvisi (gialli): qualcosa impedisce di usare il modello. Note (grigie): solo informazioni.
  const fixed = m.fix && state.fixes?.[m.fix]?.status === 'done';
  const warn = fixed ? '' : m.error || m.warn || m.note || (m.kind === 'checkpoint' && m.arch === 'unknown' ? 'Indica l\'architettura per usarlo.' : '');
  const info = !warn && m.arch === 'flux'
    ? `Flux ${m.flags?.fluxVariant || ''}${m.flags?.fp8 ? ' · FP8' : m.flags?.gguf ? ' · GGUF' : ''} · solo immagini. VAE ed encoder di testo arrivano dal modello base: la prima volta vengono scaricati (circa 10 GB).`
    : '';
  return `<article class="mcard ${m.enabled ? '' : 'off'}">
    <div class="head"><span class="chip">${esc(m.format === 'gguf' && m.kind === 'llm' ? 'GGUF' : state.meta.archs[m.arch] || m.arch)}</span>
      <span class="state"><i class="dot ${m.enabled ? 'on' : ''}"></i>${m.enabled ? 'Attivo' : 'Disattivato'}</span></div>
    <h3>${esc(m.name)}</h3>
    ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    ${warn ? `<p class="warn">${esc(warn)}</p>` : ''}
    ${m.fix ? fixBlock(m.fix) : ''}
    ${m.kind === 'llm' && m.size > 10e9 ? '<p class="warn">Questo cervello è molto grande per una scheda da 16 GB: rallenta e non lascia spazio a immagini e video. Scarica la stessa versione in formato Q4_K_M o Q8_0 (circa 3–8 GB): stessa intelligenza, molto più veloce.</p>' : ''}
    ${info ? `<p class="desc">${esc(info)}</p>` : ''}
    <p class="path">${esc(m.path)}</p>
    <div class="row">
      <button class="btn small" data-edit="${m.id}">Modifica</button>
      <button class="btn small" data-toggle="${m.id}">${m.enabled ? 'Disattiva' : 'Attiva'}</button>
      <button class="btn small ${internal ? 'danger' : ''}" data-del="${m.id}" data-internal="${internal}">${internal ? 'Elimina' : 'Scollega'}</button>
    </div>
  </article>`;
}

// Riparazioni automatiche (es. Stable Video Diffusion): stato e pulsante dentro la scheda del modello
let fixTimer = null;
function fixBlock(kind) {
  const f = state.fixes?.[kind] || { status: 'idle' };
  if (f.status === 'done') return '<p class="desc">✓ Sistemato: al suo posto lavora la versione completa scaricata da Hugging Face, che trovi tra i modelli attivi.</p>';
  if (f.status === 'running') {
    const pct = f.total ? Math.round((f.done / f.total) * 100) : null;
    return `<div class="fix"><p class="small">Scarico i file che mancano… ${f.done ? `${fmtSize(f.done)}` : ''}${f.file ? ` · ${esc(f.file)}` : ''}</p>
      <div class="progress ${pct == null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div></div>`;
  }
  return `<div class="fix">${f.status === 'error' ? `<p class="error-text small">${esc(f.error)}</p>` : ''}
    <button class="btn small primary" data-fix="${kind}">${f.status === 'error' ? 'Riprova' : 'Sistemalo ora'}</button></div>`;
}
async function loadFixes() {
  state.fixes = await api('/api/fixes').catch(() => ({}));
  clearTimeout(fixTimer);
  if (Object.values(state.fixes).some((f) => f.status === 'running')) fixTimer = setTimeout(loadFixes, 2500);
  // Le schede dei modelli mostrano lo stato della riparazione: si ridisegnano
  if (state.models.local?.some((m) => m.fix)) loadModels();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fix]');
  if (!b) return;
  b.disabled = true;
  await api(`/api/fixes/${b.dataset.fix}`, { method: 'POST' }).catch((err) => alert(err.message));
  await loadFixes();
  loadModels();
});

async function loadModels() {
  state.models = await api('/api/models');
  const { local, servers } = state.models;
  const empty = !local.length && !servers.length;
  $('#models-empty').hidden = !empty;
  $('#models-full').hidden = empty;

  $('#model-warnings').innerHTML = local.filter((m) => m.kind === 'checkpoint' && m.arch === 'unknown' && !m.note).map((m) => `
    <div class="note warn"><h3>Checkpoint da riconoscere · ${esc(m.file)}</h3>
      <p>Indica l'architettura per usarlo. Il file è collegato, ma non verrà scelto per generare.</p>
      <div class="row"><button class="btn small" data-edit="${m.id}">Indica l'architettura</button></div></div>`).join('');

  $('#model-groups').innerHTML = GROUPS.map(([kind, title]) => {
    const items = local.filter((m) => m.kind === kind);
    if (!items.length) return '';
    return `<section class="group"><h2>${title}</h2><div class="grid-cards">${items.map(modelCard).join('')}</div></section>`;
  }).join('');

  $('#server-list').innerHTML = servers.length ? servers.map((s) => `
    <div class="srv"><div><strong>${esc(s.name)}</strong> <span class="chip">${s.enabled ? 'Collegato' : 'Disattivato'}</span>
      <p class="path mono small muted">${esc(s.endpoint)}</p>
      <p class="muted small">${s.capabilities.map((c) => esc(state.meta.tasks[c])).join(' · ')}${s.description ? ` · ${esc(s.description)}` : ''}</p></div>
      <div class="row"><button class="btn small" data-srv-edit="${s.id}">Modifica collegamento</button><button class="btn small danger" data-srv-del="${s.id}">Elimina</button></div></div>`).join('')
    : '<p class="muted small">Nessun server collegato.</p>';

  const sel = $('#model-override');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Lo sceglie ideax</option>' + state.models.generators.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  sel.value = cur;

  const gg = $('#settings-form').gguf;
  const gcur = gg.value || state.settings?.brain.gguf || '';
  gg.innerHTML = '<option value="">Il primo disponibile</option>' + local.filter((m) => m.kind === 'llm').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  gg.value = gcur;
  renderStatus();
  if ($('#page-primi-passi').classList.contains('active')) renderOnboarding();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-edit],[data-toggle],[data-del],[data-srv-edit],[data-srv-del]');
  if (!t) return;
  const find = (id) => state.models.local.find((m) => m.id === id);
  if (t.dataset.edit) openModel(find(t.dataset.edit));
  if (t.dataset.toggle) {
    await api(`/api/models/${t.dataset.toggle}`, { method: 'PATCH', body: { enabled: !find(t.dataset.toggle).enabled } });
    loadModels();
  }
  if (t.dataset.del) {
    const internal = t.dataset.internal === 'true';
    if (!confirm(internal ? 'Eliminare il file del modello dal disco?' : 'Scollegare questo modello? Il file resta nella sua cartella.')) return;
    await api(`/api/models/${t.dataset.del}`, { method: 'DELETE' });
    loadModels();
  }
  if (t.dataset.srvEdit) openServer(state.models.servers.find((s) => s.id === t.dataset.srvEdit));
  if (t.dataset.srvDel && confirm('Eliminare questo collegamento?')) {
    await api(`/api/servers/${t.dataset.srvDel}`, { method: 'DELETE' });
    loadModels();
  }
});

// ----- Modifica modello -----
const mForm = $('#model-form');
let editing = null;
function syncModelForm() {
  $$('[data-for]', mForm).forEach((el) => { el.hidden = el.dataset.for !== mForm.kind.value; });
}
mForm.kind.addEventListener('change', syncModelForm);

function openModel(m) {
  editing = m;
  $('#mf-error').textContent = '';
  $('#mf-title').textContent = m.name;
  $('#mf-chip').textContent = `${state.meta.kinds[m.kind]} · ${state.meta.archs[m.arch] || m.arch}`;
  $('#mf-path').textContent = `${m.path.startsWith(state.models.dirs[0]) ? 'File in ideax' : 'File esterno'}: ${m.path}`;
  mForm.name.value = m.name;
  mForm.kind.value = m.kind;
  mForm.arch.value = m.arch;
  mForm.description.value = m.description || '';
  mForm.triggerWords.value = m.triggerWords || '';
  mForm.loraWeight.value = m.loraWeight;
  mForm.loraAlways.checked = !!m.loraAlways;
  mForm.priority.value = m.priority;
  mForm.enabled.checked = m.enabled;
  mForm.promptStyle.innerHTML = `<option value="auto">Automatico${m.styleAuto ? ` · ${esc(state.meta.styles[m.styleAuto])}` : ''}</option>`
    + Object.entries(state.meta.styles).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  mForm.promptStyle.value = m.promptStyle || 'auto';
  mForm.negativePrompt.value = m.negativePrompt || '';
  mForm.params.value = Object.keys(m.params || {}).length ? JSON.stringify(m.params, null, 2) : '';
  // Si possono scegliere solo le capacità che l'architettura ha davvero (Flux e SDXL non fanno video)
  const allowed = m.allowedCapabilities || Object.keys(state.meta.tasks);
  $$('#mf-caps label').forEach((l) => {
    const i = $('input', l);
    i.checked = m.capabilities.includes(i.value);
    i.disabled = !allowed.includes(i.value);
    l.title = i.disabled ? 'Questo tipo di modello non può farlo' : '';
    l.classList.toggle('off', i.disabled);
  });
  $('#mf-caps-note').textContent = allowed.length && allowed.length < Object.keys(state.meta.tasks).length
    ? `${state.meta.archs[m.arch] || 'Questo modello'} crea solo immagini. Per i video serve un modello video (Wan, LTX, CogVideoX in cartella diffusers) oppure ComfyUI collegato a ideax. Le animazioni dei modelli SD 1.5 arrivano dai moduli di movimento.`
    : '';
  syncModelForm();
  $('#model-dialog').showModal();
}

mForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/models/${editing.id}`, {
      method: 'PATCH',
      body: {
        name: mForm.name.value.trim(),
        kind: mForm.kind.value,
        arch: mForm.arch.value,
        description: mForm.description.value.trim(),
        triggerWords: mForm.triggerWords.value.trim(),
        loraWeight: Number(mForm.loraWeight.value) || 0.8,
        loraAlways: mForm.loraAlways.checked,
        priority: Number(mForm.priority.value) || 0,
        enabled: mForm.enabled.checked,
        capabilities: $$('#mf-caps input:checked').map((i) => i.value),
        params: mForm.params.value.trim() ? JSON.parse(mForm.params.value) : {},
        promptStyle: mForm.promptStyle.value,
        negativePrompt: mForm.negativePrompt.value.trim(),
      },
    });
    $('#model-dialog').close();
    loadModels();
  } catch (err) {
    $('#mf-error').textContent = err instanceof SyntaxError ? 'Parametri predefiniti: il JSON non è valido.' : err.message;
  }
});

// ----- Server esterni -----
const sForm = $('#server-form');
const SERVER_HELP = {
  comfyui: ['Workflow ComfyUI · formato API', 'In ComfyUI attiva le opzioni sviluppatore e usa "Save (API Format)". Incolla qui il JSON e sostituisci il testo del prompt con {{prompt}}, il negativo con {{negative_prompt}}, il seme con {{seed}} e il nome del file in LoadImage con {{image}}.', 'http://127.0.0.1:8188'],
  a1111: ['Parametri extra · JSON, facoltativo', 'Avvia Automatic1111 o Forge con --api. Esempio: {"steps": 30, "cfg_scale": 6, "sampler_name": "DPM++ 2M"}', 'http://127.0.0.1:7860'],
  custom: ['Corpo della richiesta · JSON', 'Segnaposto: {{prompt}}, {{negative_prompt}}, {{task}}, {{image}}, {{video}}, {{images}}. Il server può rispondere col file oppure con un JSON che contiene URL o base64.', 'http://127.0.0.1:9000/generate'],
};
function syncServerForm() {
  const [label, help, ph] = SERVER_HELP[sForm.type.value];
  $('#sf-template-label').textContent = label;
  $('#sf-help').textContent = help;
  sForm.endpoint.placeholder = ph;
}
sForm.type.addEventListener('change', syncServerForm);

function openServer(s = {}) {
  sForm.reset();
  $('#sf-error').textContent = '';
  sForm.id.value = s.id || '';
  sForm.name.value = s.name || '';
  sForm.type.value = s.type || 'comfyui';
  sForm.endpoint.value = s.endpoint || '';
  sForm.description.value = s.description || '';
  sForm.priority.value = s.priority ?? 0;
  sForm.template.value = s.template ? JSON.stringify(s.template, null, 2) : '';
  sForm.headers.value = s.headers && Object.keys(s.headers).length ? JSON.stringify(s.headers) : '';
  sForm.enabled.checked = s.enabled !== false;
  $$('#sf-caps input').forEach((i) => { i.checked = (s.capabilities || []).includes(i.value); });
  syncServerForm();
  $('#server-dialog').showModal();
}
$('#add-server').addEventListener('click', () => openServer());
sForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/servers', {
      method: 'POST',
      body: {
        id: sForm.id.value || undefined,
        name: sForm.name.value.trim(),
        type: sForm.type.value,
        endpoint: sForm.endpoint.value.trim(),
        description: sForm.description.value.trim(),
        priority: sForm.priority.value,
        template: sForm.template.value,
        headers: sForm.headers.value,
        enabled: sForm.enabled.checked,
        capabilities: $$('#sf-caps input:checked').map((i) => i.value),
      },
    });
    $('#server-dialog').close();
    loadModels();
  } catch (err) {
    $('#sf-error').textContent = err.message;
  }
});

// ======================= Motore (installazione e worker) =======================

let setupTimer = null;
async function refreshSetup() {
  state.setup = await api('/api/setup').catch(() => state.setup);
  if (state.setup?.status === 'running' && !setupTimer) {
    setupTimer = setInterval(async () => {
      await refreshSetup();
      if (state.setup.status !== 'running') { clearInterval(setupTimer); setupTimer = null; refreshStatus(); }
    }, 1000);
  }
  $$('[data-engine]').forEach((el) => renderEngine(el));
  if ($('#page-primi-passi').classList.contains('active')) renderOnboarding();
  return state.setup;
}

function gpuText(gpu) {
  if (!gpu) return 'Sto controllando la scheda video…';
  if (gpu.vendor === 'nvidia') return `${gpu.name} · ${gpu.vramGb} GB di memoria video`;
  if (gpu.vendor === 'apple') return 'Mac con Apple Silicon';
  return 'Nessuna scheda NVIDIA trovata: ideax funzionerà sul processore, molto più lentamente.';
}

function renderEngine(el) {
  if (!el) return;
  el.dataset.engine = '1';
  const s = state.setup;
  const w = state.worker;
  if (!s) { el.innerHTML = '<p class="muted">Controllo del motore…</p>'; refreshSetup(); return; }

  if (s.status === 'running' || s.status === 'error') {
    const d = s.download;
    el.innerHTML = `<h2>${s.status === 'error' ? 'Installazione interrotta' : 'Installo il motore…'}</h2>
      <p class="muted">${esc(gpuText(s.gpu))}${s.variant ? ` · PyTorch ${esc(s.variant.label)}` : ''}</p>
      <ul class="engine-steps">${s.steps.map((x) => `<li class="${x.status}">${esc(x.label)}</li>`).join('')}</ul>
      ${d ? `<div class="progress"><div style="width:${d.total ? Math.round((d.done / d.total) * 100) : 0}%"></div></div>
        <p class="muted small">${fmtSize(d.done)}${d.total ? ` di ${fmtSize(d.total)}` : ''}</p>` : ''}
      ${s.status === 'running' ? `<p class="muted small">${esc(s.detail || '')}</p><p class="muted small">Puoi lasciare aperta questa pagina: ci vogliono da 5 a 20 minuti, in base alla connessione.</p>` : ''}
      ${s.status === 'error' ? `<div class="note error"><h3>Errore</h3><p>${esc(s.error)}</p><div class="row"><button class="btn primary" data-install>Riprova</button></div></div>` : ''}
      <details><summary class="muted small">Registro</summary><div class="log">${s.log.map(esc).join('\n')}</div></details>`;
    return;
  }

  if (!s.installed && !w.online) {
    if (s.platform !== 'win32') {
      el.innerHTML = `<h2>Il motore non è installato</h2><p class="muted">Su Linux e macOS esegui <code>./install.sh</code> nella cartella di ideax, poi riavvia ideax.</p>`;
      return;
    }
    el.innerHTML = `<h2>Installa il motore</h2>
      <p class="muted">È la parte che fa girare i modelli sulla scheda video. Si installa una volta sola, dentro la cartella di ideax, senza toccare il resto del PC.</p>
      <ul class="check-list"><li class="${s.gpu?.vendor === 'nvidia' ? 'ok' : 'ko'}">${s.gpu?.vendor === 'nvidia' ? '✓' : '!'} ${esc(gpuText(s.gpu))}</li></ul>
      <div class="facts"><span class="chip">Python portatile</span><span class="chip">PyTorch ${esc(s.variant?.label || '')}</span><span class="chip">Librerie per immagini e video</span><span class="chip">Circa 4–5 GB da scaricare</span></div>
      <div class="row"><button class="btn primary" data-install>Installa il motore</button></div>`;
    return;
  }

  const online = w.online;
  el.innerHTML = `<div class="section-head"><div><h2>${online ? (w.demo ? 'Motore in modalità demo' : 'Motore pronto') : 'Il motore non risponde'}</h2>
      <p class="muted">${!online ? 'Il worker è spento o si sta avviando. Se non parte, guarda il registro qui sotto.'
        : w.demo ? 'Il worker genera immagini di prova, senza usare la scheda video.'
          : esc(w.gpu ? `${w.gpu} · ${w.vram_gb} GB di memoria video` : gpuText(s.gpu))}</p></div>
      <button class="btn" data-restart>${online ? 'Riavvia il worker' : 'Avvia il worker'}</button></div>
    <div class="facts">
      ${w.device ? `<span class="chip">Dispositivo: ${esc(w.device)}</span>` : ''}
      ${w.vram_gb ? `<span class="chip">${w.vram_gb} GB · ${w.vram_free_gb ?? '?'} GB liberi</span>` : ''}
      ${w.offload ? '<span class="chip">Risparmio memoria attivo</span>' : ''}
      ${w.loadedName ? `<span class="chip">Modello caricato: ${esc(w.loadedName)}</span>` : ''}
    </div>
    ${w.log?.length ? `<details><summary class="muted small">Registro del worker</summary><div class="log">${w.log.map(esc).join('\n')}</div></details>` : ''}`;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-install]')) {
    e.target.disabled = true;
    await api('/api/setup', { method: 'POST' }).catch((err) => alert(err.message));
    refreshSetup();
  }
  if (e.target.closest('[data-restart]')) {
    e.target.disabled = true;
    e.target.textContent = 'Riavvio…';
    await api('/api/worker/restart', { method: 'POST' }).catch(() => {});
    setTimeout(refreshStatus, 2500);
    setTimeout(refreshStatus, 8000);
  }
  if (e.target.closest('[data-install-llm]')) {
    e.target.disabled = true;
    e.target.textContent = 'Installazione in corso…';
    await api('/api/setup/llm', { method: 'POST' }).catch((err) => alert(err.message));
    await refreshSetup();
    renderLlmSupport();
  }
});

function renderLlmSupport() {
  const el = $('#llm-support');
  const llm = state.setup?.llm;
  if (!llm) { el.innerHTML = ''; return; }
  if (llm.installed && llm.status !== 'installing') {
    el.innerHTML = `<p class="ok-text small">✓ Motore del cervello pronto: llama.cpp ${esc(llm.version || '')}${llm.status === 'running' ? ' · acceso' : ''}</p>`;
    return;
  }
  el.innerHTML = `<div class="note"><h3>Motore del cervello (llama.cpp)</h3>
    <p class="muted">Fa girare il file .gguf sulla scheda video. ideax lo scarica da solo al primo messaggio in chat; puoi anche prepararlo adesso (circa 300–600 MB).</p>
    ${llm.status === 'error' ? `<p class="error-text">${esc(llm.error)}</p>` : ''}
    ${llm.status === 'installing' ? `<p class="small">${esc(llm.step || 'Preparazione…')}</p>` : ''}
    <div class="row"><button type="button" class="btn" data-install-llm ${llm.status === 'installing' ? 'disabled' : ''}>${llm.status === 'installing' ? 'Scarico…' : 'Prepara il motore del cervello'}</button></div></div>`;
  if (llm.status === 'installing') setTimeout(async () => { await refreshSetup(); renderLlmSupport(); }, 2000);
}

// ======================= Barra di stato =======================

async function refreshStatus() {
  state.worker = await api('/api/worker').catch(() => ({ online: false }));
  renderStatus();
  if ($('#page-impostazioni').classList.contains('active')) { renderEngine($('#engine-card')); renderLlmSupport(); }
}

function renderStatus() {
  const w = state.worker;
  let engine;
  if (w.online && w.demo) engine = '<span class="item"><i class="dot warn"></i>Modalità demo · immagini di prova</span>';
  else if (w.online) {
    const gpu = w.gpu || (w.device === 'cpu' ? 'Processore' : w.device);
    engine = `<span class="item good"><i class="dot on"></i>${esc(gpu)}${w.vram_gb ? ` · ${w.vram_gb} GB` : ''}${w.vram_free_gb != null ? ` · ${String(w.vram_free_gb).replace('.', ',')} GB liberi` : ''}</span>`;
  } else if (w.installed === false) engine = '<span class="item"><i class="dot warn"></i>Motore da installare <button onclick="location.hash=\'primi-passi\'">Installa</button></span>';
  else if (w.process === 'starting') engine = '<span class="item"><i class="dot warn"></i>Avvio del motore…</span>';
  else engine = '<span class="item bad"><i class="dot off"></i>Motore spento <button data-restart>Avvia</button></span>';
  const brain = state.models.brain || '';
  const working = state.job && !['done', 'error', 'cancelled'].includes(state.job.status);
  $('#statusbar').innerHTML = `${engine}
    <span class="item">Cervello <span class="${/regole/.test(brain) ? '' : 'good'}">${esc(brain || '…')}</span></span>
    <span class="item hide-sm" title="Il modello di immagini caricato ora nella scheda video. Si carica da solo alla prima creazione.">Modello caricato: ${esc(w.loadedName || 'nessuno, si carica alla prima creazione')}</span>
    <span class="item end">${working ? '<i class="dot warn"></i>Sto creando…' : w.online ? 'Worker acceso' : ''}</span>`;
}

// ======================= Impostazioni =======================

const setForm = $('#settings-form');
function syncBrainFields() {
  $$('[data-mode]', setForm).forEach((el) => { el.hidden = !el.dataset.mode.split(' ').includes(setForm.mode.value); });
}
setForm.mode.addEventListener('change', syncBrainFields);

async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  setForm.mode.value = s.brain.mode;
  setForm.gguf.value = s.brain.gguf || '';
  setForm.serverUrl.value = s.brain.serverUrl || '';
  setForm.serverModel.value = s.brain.serverModel || '';
  setForm.workerUrl.value = s.workerUrl;
  setForm.manageWorker.checked = s.manageWorker !== false;
  setForm.extraModelDirs.value = (s.extraModelDirs || []).join('\n');
  setForm.lan.checked = !!s.network.lan;
  syncBrainFields();
}


setForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/settings', {
    method: 'POST',
    body: {
      workerUrl: setForm.workerUrl.value.trim() || 'http://127.0.0.1:7861',
      manageWorker: setForm.manageWorker.checked,
      extraModelDirs: setForm.extraModelDirs.value.split('\n'),
      brain: { mode: setForm.mode.value, gguf: setForm.gguf.value, serverUrl: setForm.serverUrl.value.trim(), serverModel: setForm.serverModel.value.trim() },
      network: { lan: setForm.lan.checked },
    },
  });
  $('#settings-ok').textContent = 'Salvato ✓';
  setTimeout(() => { $('#settings-ok').textContent = ''; }, 2500);
  await loadSettings();
  loadModels();
  loadNetwork();
});

async function loadNetwork() {
  const n = await api('/api/network').catch(() => null);
  if (!n) return;
  const wanted = state.settings?.network.lan;
  $('#net-info').textContent = n.lan
    ? `Raggiungibile dalla rete su ${n.addresses.map((a) => `http://${a}:${n.port}`).join(', ')}${n.keys ? ` · ${n.keys} chiavi API attive` : ' · crea una chiave API in Collega app'}.`
    : wanted ? 'Riavvia ideax per attivare l\'accesso dalla rete.' : 'Ora ideax è raggiungibile solo da questo PC.';
  renderApiDocs(n);
}

// ======================= Collega app =======================

function renderApiDocs(net) {
  const lan = net?.lan && net.addresses?.length ? `http://${net.addresses[0]}:${net.port}` : null;
  const base = location.origin;
  const api = lan || base;
  $('#base-url').textContent = api;
  $('#base-v1').textContent = `${api}/v1`;
  $('.base-card [data-copy-text]').dataset.copyText = api;
  $('#base-help').textContent = lan
    ? `Dagli altri computer e server della rete usa ${net.addresses.map((a) => `http://${a}:${net.port}`).join(' oppure ')} con una chiave API. Da questo PC va bene anche ${base}, senza chiave.`
    : 'Dalle app su questo PC non serve la chiave. Per altri computer e server attiva l\'accesso dalla rete nelle impostazioni e usa una chiave API.';
  const K = 'LA_TUA_CHIAVE';
  const samples = [
    ['curl · testo', `curl ${api}/v1/generate \\
  -H "Authorization: Bearer ${K}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Un lago alpino all\\u0027alba", "params": {"aspect": "16:9"}}'`],
    ['curl · con un file da modificare', `curl ${api}/v1/generate \\
  -H "Authorization: Bearer ${K}" \\
  -F prompt="Metti questa foto su una spiaggia al tramonto" \\
  -F files=@foto.jpg \\
  -F 'metadata={"ordine": "A-17"}'`],
    ['JavaScript · con webhook', `const res = await fetch('${api}/v1/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${K}' },
  body: JSON.stringify({
    prompt: 'Anima questa foto, le foglie si muovono col vento',
    attachments: [{ url: 'https://esempio.it/foto.jpg' }],
    callback_url: 'https://il-tuo-server.it/ideax-webhook', // ideax chiama qui a lavoro finito
    metadata: { prodotto: 123 },
  }),
});
const { id, status_url } = await res.json(); // risposta immediata`],
    ['Python · aspetta il risultato', `import requests

job = requests.post("${api}/v1/generate",
    headers={"Authorization": "Bearer ${K}"},
    json={"prompt": "Banner per un negozio di bici, stile flat", "params": {"aspect": "16:9", "seed": 42}},
    timeout=600,
).json()

immagine = requests.get(job["results"][0]["url"], headers={"Authorization": "Bearer ${K}"}).content
open("banner.png", "wb").write(immagine)`],
    ['Verifica del webhook · Node.js', `import crypto from 'node:crypto';

// corpo = il testo grezzo della richiesta, segreto = "Segreto dei webhook" di ideax
function firmaValida(corpo, intestazione, segreto) {
  const attesa = 'sha256=' + crypto.createHmac('sha256', segreto).update(corpo).digest('hex');
  return intestazione?.length === attesa.length
    && crypto.timingSafeEqual(Buffer.from(intestazione), Buffer.from(attesa));
}
// Evento: req.headers['x-ideax-event'] → job.completed, job.failed, job.cancelled, ping
// Dati: JSON.parse(corpo).data → lavoro con results[] e i vostri metadata`],
    ['Verifica del webhook · PHP', `<?php
$corpo = file_get_contents('php://input');
$firma = $_SERVER['HTTP_X_IDEAX_SIGNATURE'] ?? '';
$attesa = 'sha256=' . hash_hmac('sha256', $corpo, 'SEGRETO_DEI_WEBHOOK');
if (!hash_equals($attesa, $firma)) { http_response_code(401); exit; }

$evento = json_decode($corpo, true);
if ($evento['event'] === 'job.completed') {
    $url = $evento['data']['results'][0]['url'];
    $ordine = $evento['data']['metadata']['ordine'] ?? null;
    // ... salva il file nel vostro sistema
}`],
  ];
  $('#code-samples').innerHTML = samples.map(([name, code]) => `
    <div class="card code-card"><div class="head"><h3>${esc(name)}</h3><button class="btn small" data-copy-code>Copia</button></div><pre class="code">${esc(code)}</pre></div>`).join('');
}

// ----- Chiavi API -----
async function loadKeys() {
  const keys = await api('/api/keys').catch(() => []);
  $('#key-list').innerHTML = keys.length ? keys.map((k) => `
    <div class="key-row"><div><strong>${esc(k.name)}</strong>
      <span class="muted small mono">${esc(k.prefix)}…</span>
      <span class="muted small"> · creata ${esc(when(k.createdAt))} · ${k.uses ? `${k.uses} richieste, ultima ${esc(when(k.lastUsedAt))}` : 'mai usata'}</span></div>
      <button class="btn small danger" data-key-revoke="${k.id}" data-name="${esc(k.name)}">Revoca</button></div>`).join('')
    : '<p class="muted small">Nessuna chiave. Le app su questo PC funzionano anche senza.</p>';
}
$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const k = await api('/api/keys', { method: 'POST', body: { name: e.target.name.value } });
    e.target.reset();
    const box = $('#new-key');
    box.hidden = false;
    box.innerHTML = `<div class="new-key"><strong>Chiave per "${esc(k.name)}"</strong>
      <code id="new-key-value">${esc(k.key)}</code>
      <span class="small">Copiala adesso e mettila nel sistema: per sicurezza non verrà più mostrata.</span>
      <div class="row"><button class="btn small primary" data-copy-text="${esc(k.key)}">Copia la chiave</button><button class="btn small" data-hide-key>Fatto</button></div></div>`;
    loadKeys();
  } catch (err) {
    alert(err.message);
  }
});

// ----- Webhook -----
let whSecret = '';
async function loadWebhook() {
  whSecret = (await api('/api/webhook').catch(() => ({}))).secret || '';
  $('#wh-secret').value = whSecret ? `${whSecret.slice(0, 10)}${'•'.repeat(20)}` : '';
}

document.addEventListener('click', async (e) => {
  const rv = e.target.closest('[data-key-revoke]');
  if (rv && confirm(`Revocare la chiave "${rv.dataset.name}"? Il sistema che la usa smetterà subito di funzionare.`)) {
    await api(`/api/keys/${rv.dataset.keyRevoke}`, { method: 'DELETE' });
    loadKeys();
  }
  if (e.target.closest('[data-hide-key]')) { $('#new-key').hidden = true; $('#new-key').innerHTML = ''; }
  if (e.target.closest('[data-wh-show]')) {
    const shown = $('#wh-secret').value === whSecret;
    $('#wh-secret').value = shown ? `${whSecret.slice(0, 10)}${'•'.repeat(20)}` : whSecret;
    e.target.textContent = shown ? 'Mostra' : 'Nascondi';
  }
  if (e.target.closest('[data-wh-copy]')) copy(whSecret, e.target);
  if (e.target.closest('[data-wh-rotate]') && confirm('Rigenerare il segreto? I sistemi che verificano la firma andranno aggiornati con quello nuovo.')) {
    whSecret = (await api('/api/webhook/rotate', { method: 'POST' })).secret;
    $('#wh-secret').value = whSecret;
  }
  if (e.target.closest('[data-wh-test]')) {
    const out = $('#wh-test-result');
    out.className = 'small muted';
    out.textContent = 'Invio in corso…';
    try {
      const r = await api('/api/webhook/test', { method: 'POST', body: { url: $('#wh-test-url').value.trim() } });
      out.className = `small ${r.status === 'delivered' ? 'ok-text' : 'error-text'}`;
      out.textContent = r.status === 'delivered'
        ? `✓ Consegnato (risposta ${r.lastStatus}).`
        : `Non consegnato dopo ${r.attempts} tentativi${r.lastStatus ? ` (risposta ${r.lastStatus})` : r.lastError ? ` (${r.lastError})` : ''}.`;
    } catch (err) {
      out.className = 'small error-text';
      out.textContent = err.message;
    }
  }
});
window.addEventListener('hashchange', () => { if (location.hash === '#collega') { loadKeys(); loadWebhook(); loadNetwork(); } });
if (location.hash === '#collega') { loadKeys(); loadWebhook(); }

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy-code]');
  if (c) copy(c.closest('.code-card').querySelector('pre').textContent, c);
  const t = e.target.closest('[data-copy-text]');
  if (t) copy(t.dataset.copyText, t);
});

// ======================= Primi passi =======================

const EXAMPLES = [
  ['image', 'Un viaggiatore davanti a un lago alpino all\'alba, luce morbida, come in un film'],
  ['image', 'Ritratto di una guerriera elfica, stile illustrazione fantasy, colori caldi'],
  ['animation', 'Un gatto che salta su un divano, stile cartone animato'],
  ['image', 'Logo minimal di una volpe arancione su sfondo bianco'],
];

function stepDone(n) {
  if (n === 1) return !!state.worker.online;
  if (n === 2) return state.models.generators.length > 0;
  return false;
}

function renderOnboarding() {
  const n = state.step;
  $$('#steps li').forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle('active', i === n);
    li.classList.toggle('done', i !== n && stepDone(i));
  });
  const box = $('#onboarding');
  if (n === 1) {
    const ready = stepDone(1);
    box.innerHTML = `<div class="card"><p class="eyebrow">Passo 1 di 3</p><div id="ob-engine" style="margin-top:14px"></div>
      ${state.setup?.installed || state.worker.online ? `<ul class="check-list" style="margin-top:12px">
        <li class="${state.worker.online ? 'ok' : 'ko'}">${state.worker.online ? '✓ Motore raggiungibile' : '! Il motore si sta avviando o non risponde'}</li></ul>` : ''}
      <div class="row" style="margin-top:18px">
        <button class="btn primary" data-step-go="2" ${ready ? '' : 'disabled'}>Continua →</button>
        <button class="btn" data-skip>Configura più tardi</button></div></div>
      <div class="note"><h3>Ti serve aiuto?</h3><p>Il motore usa la scheda video. Se non parte, apri le impostazioni e guarda il registro del worker.</p>
        <div class="row"><a class="btn" href="#impostazioni">Apri impostazioni</a></div></div>`;
    if (state.worker.online) {
      $('#ob-engine').innerHTML = `<h2>${state.worker.demo ? 'Il motore è in modalità demo' : 'La tua GPU è pronta'}</h2><p class="muted">${esc(state.worker.gpu ? `${state.worker.gpu} · ${state.worker.vram_gb} GB di memoria video` : gpuText(state.setup?.gpu))}</p>`;
    } else if (state.setup?.installed) {
      $('#ob-engine').innerHTML = `<h2>Avvio del motore…</h2><p class="muted">${esc(gpuText(state.setup.gpu))}</p>`;
    } else renderEngine($('#ob-engine'));
  } else if (n === 2) {
    const gens = state.models.generators;
    box.innerHTML = `<div class="card"><p class="eyebrow">Passo 2 di 3</p><h2 style="margin:14px 0 8px">Collega il primo modello</h2>
      <p class="muted">Scarica un checkpoint da Civitai (per iniziare va benissimo un SDXL in formato .safetensors) e trascinalo qui.</p>
      <label class="dropzone" data-dropzone style="margin-top:18px"><input type="file" accept=".safetensors,.gguf,.ckpt" multiple hidden data-ob-input>
        <strong>Trascina qui il modello</strong><span class="muted">ideax riconosce da solo il tipo</span><span class="btn">Scegli un file</span></label>
      <div class="uploads"></div>
      ${gens.length ? `<ul class="check-list" style="margin-top:16px">${gens.map((g) => `<li class="ok">✓ ${esc(g.name)}</li>`).join('')}</ul>` : ''}
      <div class="row" style="margin-top:18px"><button class="btn primary" data-step-go="3" ${gens.length ? '' : 'disabled'}>Continua →</button>
        <button class="btn" data-step-go="1">← Indietro</button></div></div>`;
    $('[data-ob-input]', box).addEventListener('change', (e) => { [...e.target.files].forEach(uploadModel); e.target.value = ''; });
  } else {
    box.innerHTML = `<div class="card"><p class="eyebrow">Passo 3 di 3</p><h2 style="margin:14px 0 8px">Crea qualcosa</h2>
      <p class="muted">Scegli un esempio oppure scrivi la tua idea nello Studio.</p>
      <div class="examples">${EXAMPLES.map(([f, p], i) => `<button data-example="${i}">${esc(p)}</button>`).join('')}</div>
      <div class="row" style="margin-top:18px"><button class="btn primary" data-skip>Vai allo Studio</button><button class="btn" data-step-go="2">← Indietro</button></div></div>`;
  }
}

$('#steps').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) { state.step = Number(li.dataset.step); renderOnboarding(); }
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-step-go]');
  if (go) { state.step = Number(go.dataset.stepGo); renderOnboarding(); }
  if (e.target.closest('[data-skip]')) {
    try { localStorage.setItem('ideax-onboarded', '1'); } catch {}
    location.replace('#studio');
  }
  const ex = e.target.closest('[data-example]');
  if (ex) {
    const [format, prompt] = EXAMPLES[Number(ex.dataset.example)];
    try { localStorage.setItem('ideax-onboarded', '1'); } catch {}
    location.replace('#studio');
    setStudioMode('crea');
    setFormat(format);
    $('#prompt').value = prompt;
    $('#prompt').focus();
  }
});

// ======================= Avvio =======================

(async () => {
  state.meta = await api('/api/meta');
  const caps = Object.entries(state.meta.tasks).map(([k, v]) => `<label><input type="checkbox" value="${k}"> ${esc(v)}</label>`).join('');
  $('#mf-caps').innerHTML = caps;
  $('#sf-caps').innerHTML = caps;
  mForm.kind.innerHTML = Object.entries(state.meta.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  mForm.arch.innerHTML = Object.entries(state.meta.archs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  renderApiDocs();
  await Promise.all([loadSettings(), loadModels(), loadHistory(), refreshStatus(), refreshSetup()]);
  renderStage();
  renderLlmSupport();
  if (typeof renderChat === 'function' && !chat.current) renderChat();

  let onboarded = false;
  try { onboarded = localStorage.getItem('ideax-onboarded') === '1'; } catch {}
  if (!location.hash && !onboarded && (!state.worker.online || !state.models.generators.length)) {
    state.step = state.worker.online ? 2 : 1;
    location.replace('#primi-passi');
  }
  showPage();
  setInterval(refreshStatus, 5000);
  setInterval(() => { if (!state.models.local.length) loadModels(); }, 15000);
})();

// ======================= Programma e aggiornamenti =======================

let about = null;
let updatePoll = null;

async function loadUpdate() {
  const u = await api('/api/update').catch(() => null);
  if (!u) {
    // ideax non risponde mentre scaricava o installava: si sta aggiornando, aspettiamo che torni
    if (['downloading', 'installing'].includes(state.update?.status)) {
      state.update = { ...state.update, status: 'installing' };
      renderUpdateBanner();
      waitForRestart();
    }
    return;
  }
  state.update = u;
  renderUpdateBanner();
  if ($('#page-impostazioni').classList.contains('active')) renderAbout();
  const busy = u.status === 'downloading' || u.status === 'installing' || u.status === 'checking';
  if (busy && !updatePoll) updatePoll = setInterval(loadUpdate, 1000);
  if (!busy && updatePoll) { clearInterval(updatePoll); updatePoll = null; }
  if (u.status === 'installing') waitForRestart();
}

// Durante l'aggiornamento ideax si chiude e si riapre: ricarichiamo la pagina quando torna con la nuova versione
let waiting = false;
function waitForRestart() {
  if (waiting) return;
  waiting = true;
  // La nuova versione riapre ideax da sola: questa pagina si chiude. Se il browser non lo permette, resta e si ricarica
  $('#update-banner').hidden = false;
  $('#update-banner').innerHTML = '<span class="grow"><strong>Aggiorno ideax…</strong> Questa finestra si chiude: ideax si riapre da solo con la nuova versione tra poco.</span>';
  setTimeout(() => window.close(), 2500);
  const old = about?.version;
  const started = Date.now();
  const t = setInterval(async () => {
    const a = await api('/api/about').catch(() => null);
    if (a && a.version !== old) { clearInterval(t); location.reload(); return; }
    // Dopo 3 minuti senza risposta diamo istruzioni invece di lasciare la pagina ferma
    if (Date.now() - started > 180000) {
      clearInterval(t);
      $('#update-banner').hidden = false;
      $('#update-banner').innerHTML = `<span class="grow"><strong>ideax non si è riaperto da solo.</strong> Aprilo dal menu Start. Se la versione non è cambiata, scarica l'installatore dalla <a href="${esc(state.update?.pageUrl || 'https://github.com/ideaeventimessina/ideax/releases/latest')}" target="_blank" rel="noopener">pagina del rilascio</a> e aprilo: i tuoi dati restano dove sono.</span>`;
    }
  }, 2000);
}

function renderUpdateBanner() {
  const u = state.update;
  const el = $('#update-banner');
  let dismissed = '';
  try { dismissed = localStorage.getItem('ideax-update-dismissed') || ''; } catch {}
  if (u.status === 'available' && dismissed !== u.latest) {
    el.innerHTML = `<span>✦</span><span class="grow"><strong>È disponibile ideax ${esc(u.latest)}</strong> · ora hai la ${esc(u.current)}</span>
      <a class="btn small" href="#impostazioni">Novità</a>
      ${u.canInstall && u.assetUrl ? '<button class="btn primary small" data-update-install>Aggiorna ora</button>' : `<a class="btn primary small" href="${esc(u.pageUrl)}" target="_blank" rel="noopener">Scarica</a>`}
      <button class="btn small" data-update-later>Più tardi</button>`;
  } else if (u.status === 'downloading') {
    const d = u.download;
    const pct = d?.total ? Math.round((d.done / d.total) * 100) : 0;
    el.innerHTML = `<span class="grow"><strong>Scarico ideax ${esc(u.latest)}…</strong> ${pct}%</span><div class="progress"><div style="width:${pct}%"></div></div>`;
  } else if (u.status === 'installing') {
    el.innerHTML = '<span class="grow"><strong>Installo l\'aggiornamento…</strong> ideax si chiude e si riapre da solo tra pochi secondi. I tuoi modelli e le tue creazioni restano dove sono.</span>';
  } else {
    el.hidden = true;
    return;
  }
  el.hidden = false;
}

function renderAbout() {
  const el = $('#about-card');
  if (!about || !state.update) { el.innerHTML = '<p class="muted">…</p>'; return; }
  const u = state.update;
  const s = state.settings?.update || {};
  const statusText = {
    idle: 'Non ancora controllato.',
    checking: 'Controllo in corso…',
    none: u.error ? esc(u.error) : 'Hai l\'ultima versione.',
    available: `Disponibile la versione ${esc(u.latest)}.`,
    downloading: 'Scarico l\'aggiornamento…',
    installing: 'Installazione in corso…',
    error: `Controllo non riuscito: ${esc(u.error)}`,
  }[u.status];
  const win = about.platform === 'win32';
  el.innerHTML = `<div class="section-head"><div><h2>Programma e aggiornamenti</h2>
      <p class="muted">ideax ${esc(about.version)} · ${about.installed ? 'installato' : 'versione portatile'}</p></div>
      <div class="row">
        <button class="btn" data-update-check ${u.status === 'checking' ? 'disabled' : ''}>Controlla aggiornamenti</button>
        ${u.status === 'available' && u.canInstall && u.assetUrl ? '<button class="btn primary" data-update-install>Aggiorna ora</button>' : ''}
      </div></div>
    <p>${statusText}${u.checkedAt ? ` <span class="muted small">· controllato ${esc(when(u.checkedAt))}</span>` : ''}</p>
    ${u.status === 'available' && u.notes ? `<div class="release-notes">${esc(u.notes)}</div>` : ''}
    <div class="facts">
      <span class="chip">I tuoi dati: ${esc(about.home)}</span>
      <button class="btn small" data-open-folder="home">Apri la cartella dei dati</button>
      <button class="btn small" data-open-folder="outputs">Apri le creazioni</button>
    </div>
    <label class="check"><input type="checkbox" data-update-auto ${s.auto !== false ? 'checked' : ''}> Controlla gli aggiornamenti da solo</label>
    <details><summary class="muted small">Opzioni avanzate</summary>
      <label style="margin-top:12px">Repository GitHub degli aggiornamenti <span class="row"><input class="grow" data-update-repo value="${esc(s.repo || '')}" placeholder="utente/ideax"><button class="btn small" data-update-save>Salva</button></span></label>
    </details>
    <p class="muted small" style="margin-top:14px">${about.installed
      ? 'Per disinstallare: Impostazioni di Windows → App → App installate → ideax → Disinstalla.'
      : win ? 'Stai usando la versione portatile. Con "Aggiorna ora" ideax si installa come un normale programma e continua a usare questa cartella per i tuoi dati.' : ''}</p>`;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-update-install]')) {
    e.target.disabled = true;
    await api('/api/update/install', { method: 'POST' }).catch((err) => alert(err.message));
    loadUpdate();
  }
  if (e.target.closest('[data-update-later]')) {
    try { localStorage.setItem('ideax-update-dismissed', state.update.latest); } catch {}
    renderUpdateBanner();
  }
  if (e.target.closest('[data-update-check]')) {
    e.target.disabled = true;
    await api('/api/update/check', { method: 'POST' }).catch(() => {});
    loadUpdate();
  }
  if (e.target.closest('[data-update-save]')) {
    await api('/api/settings', { method: 'POST', body: { update: { repo: $('[data-update-repo]').value.trim() } } });
    await loadSettings();
    await api('/api/update/check', { method: 'POST' }).catch(() => {});
    loadUpdate();
  }
  const f = e.target.closest('[data-open-folder]');
  if (f) api('/api/open-folder', { method: 'POST', body: { which: f.dataset.openFolder } });
});
document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-update-auto]')) {
    await api('/api/settings', { method: 'POST', body: { update: { auto: e.target.checked } } });
    loadSettings();
  }
});
window.addEventListener('hashchange', () => { if (location.hash === '#impostazioni') renderAbout(); });

(async () => {
  about = await api('/api/about').catch(() => null);
  await loadUpdate();
  setInterval(loadUpdate, 60000);
})();


// ======================= Motori (voce, musica…) =======================

let enginesPoll = null;
state.engines = [];

async function loadEngines() {
  state.engines = await api('/api/engines').catch(() => []);
  renderEngines();
  const busy = state.engines.some((e) => e.status === 'installing');
  if (busy && !enginesPoll) enginesPoll = setInterval(loadEngines, 1500);
  if (!busy && enginesPoll) { clearInterval(enginesPoll); enginesPoll = null; loadVoices(); }
}

function engineBlock(e, compact = false) {
  const actions = !e.available ? '<span class="chip">In arrivo</span>'
    : e.status === 'installing' ? '<button class="btn small" disabled>Installazione…</button>'
      : e.status === 'installed' ? `${e.running ? '<span class="chip"><i class="dot on"></i> acceso</span> <button class="btn small" data-engine-stop="' + e.id + '">Spegni</button>' : '<span class="chip">pronto, si accende quando serve</span>'}
        ${compact ? '' : `<button class="btn small danger" data-engine-remove="${e.id}" data-name="${esc(e.name)}">Disinstalla</button>`}`
        : `<button class="btn ${compact ? 'primary' : 'small'}" data-engine-install="${e.id}">${e.status === 'error' ? 'Riprova l\'installazione' : `Installa · circa ${e.sizeGb} GB`}</button>`;
  return `<div class="engine-row"><div><strong>${esc(e.name)}</strong> <span class="muted small">· ${esc(e.model)}${e.license ? ` · ${esc(e.license)}` : ''}</span>
      <p class="desc">${esc(e.description)}</p>
      ${e.status === 'installing' ? `<div class="progress indeterminate" style="margin-top:10px"><div></div></div><p class="muted small">${esc(e.step || '')} · ${esc(e.log.at(-1) || '')}</p>
        <p class="muted small">La prima volta scarica qualche GB: possono servire 10–30 minuti. Puoi continuare a usare ideax.</p>` : ''}
      ${e.status === 'error' ? `<p class="error-text small">${esc(e.error)}</p>` : ''}
      ${(!compact || e.status === 'error') && e.log?.length && e.status !== 'missing' ? `<details><summary class="muted small">Registro</summary><div class="log">${e.log.map(esc).join('\n')}</div></details>` : ''}</div>
    <div class="row">${actions}</div></div>`;
}

function renderEngines() {
  const all = $('#engines-card');
  if (all) {
    all.innerHTML = `<h2>Motori</h2><p class="muted">Ogni motore ha il suo ambiente separato dentro la cartella dei dati di ideax. Si installa con un clic, si accende quando serve e si spegne da solo dopo 10 minuti di inattività per liberare la scheda video.</p>
      ${state.engines.map((e) => engineBlock(e)).join('')}`;
  }
  const mu = state.engines.find((e) => e.id === 'music');
  const mbox = $('#music-engine');
  if (mbox && mu) {
    mbox.hidden = mu.status === 'installed';
    mbox.innerHTML = mu.status === 'installed' ? '' : `<h2>Installa il motore musica</h2>${engineBlock(mu, true)}`;
    $$('#music-form button').forEach((b) => { if (!b.type || b.type === 'submit') b.disabled = mu.status !== 'installed'; });
  }
  const me = $('#models-engines');
  if (me) {
    const llm = state.setup?.llm;
    me.innerHTML = `<h2>Motori</h2><p class="muted">I programmi che fanno lavorare i modelli: si installano con un clic, si accendono quando servono e si spengono da soli per liberare la scheda video.</p>
      <div class="engine-row"><div><strong>Cervello</strong> <span class="muted small">· llama.cpp ufficiale · MIT</span>
        <p class="desc">Fa girare il cervello .gguf (chat, memoria, scelta dei modelli). Si scarica da solo al primo messaggio in chat.</p></div>
        <div class="row">${llm?.installed ? `<span class="chip">${llm.status === 'running' ? '<i class="dot on"></i> acceso' : 'pronto'} · ${esc(llm.version || '')}</span>` : llm?.status === 'installing' ? `<span class="chip">${esc(llm.step || 'Scarico…')}</span>` : '<button class="btn small" data-install-llm>Prepara adesso</button>'}</div></div>
      ${(state.engines || []).map((e) => engineBlock(e)).join('')}`;
  }
  for (const id of ['twin', 'lipsync']) {
    const en = state.engines.find((e) => e.id === id);
    const el = $(`#${id}-engine`);
    if (el && en) el.innerHTML = en.status === 'installed' ? `<p class="ok-text small">✓ Motore ${esc(en.model)} installato${en.running ? ' · acceso' : ''}</p>` : engineBlock(en, true);
  }
  const v = state.engines.find((e) => e.id === 'voice');
  const box = $('#voice-engine');
  if (box && v) {
    box.hidden = v.status === 'installed';
    box.innerHTML = v.status === 'installed' ? '' : `<h2>Installa il motore voce</h2>${engineBlock(v, true)}`;
    $$('#speak-form button, #voice-form button').forEach((b) => { if (!b.type || b.type === 'submit') b.disabled = v.status !== 'installed'; });
  }
}

document.addEventListener('click', async (e) => {
  const ins = e.target.closest('[data-engine-install]');
  if (ins) {
    ins.disabled = true;
    await api(`/api/engines/${ins.dataset.engineInstall}/install`, { method: 'POST' }).catch((err) => alert(err.message));
    loadEngines();
  }
  const st = e.target.closest('[data-engine-stop]');
  if (st) { await api(`/api/engines/${st.dataset.engineStop}/stop`, { method: 'POST' }); loadEngines(); }
  const rm = e.target.closest('[data-engine-remove]');
  if (rm && confirm(`Disinstallare il motore "${rm.dataset.name}"? Le tue voci restano salvate: potrai reinstallarlo.`)) {
    await api(`/api/engines/${rm.dataset.engineRemove}`, { method: 'DELETE' });
    loadEngines();
  }
});

// ----- Token Hugging Face -----
async function loadHfToken() {
  const s = await api('/api/settings').catch(() => ({}));
  $('#hf-token').value = s.hfToken || '';
}
$('#hf-save').addEventListener('click', async () => {
  await api('/api/settings', { method: 'POST', body: { hfToken: $('#hf-token').value.trim() } });
  $('#hf-ok').textContent = 'Salvato ✓';
  setTimeout(() => { $('#hf-ok').textContent = ''; }, 2500);
});

// ======================= Voce =======================

const LANGS = { it: 'Italiano', en: 'Inglese', es: 'Spagnolo', fr: 'Francese', de: 'Tedesco', pt: 'Portoghese', nl: 'Olandese', pl: 'Polacco', ru: 'Russo', tr: 'Turco', ar: 'Arabo', zh: 'Cinese', ja: 'Giapponese', ko: 'Coreano', hi: 'Hindi', el: 'Greco', sv: 'Svedese', da: 'Danese', no: 'Norvegese', fi: 'Finlandese', he: 'Ebraico', ms: 'Malese', sw: 'Swahili' };
$$('#speak-form select[name=language], #voice-form select[name=language]').forEach((sel) => {
  sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
});
state.voices = [];

async function loadVoices() {
  const r = await api('/v1/voices').catch(() => ({ voices: [] }));
  state.voices = r.voices;
  const sel = $('#speak-form').voice;
  const cur = sel.value;
  sel.innerHTML = state.voices.length ? state.voices.map((v) => `<option value="${v.id}">${esc(v.name)}${v.gender ? ` · ${esc(v.gender)}` : ''}</option>`).join('') : '<option value="">Crea prima una voce o aggiungila dalla libreria</option>';
  if (cur) sel.value = cur;
  syncSpeakLanguage();
  $('#voice-list').innerHTML = state.voices.length ? state.voices.map((v) => `
    <article class="mcard"><div class="head"><span class="chip">${esc(LANGS[v.language] || v.language)}</span><span class="state"><i class="dot on"></i>Pronta</span></div>
      <h3>${esc(v.name)}</h3>
      <p class="meta">Campione di ${String(v.seconds).replace('.', ',')} s · creata ${esc(when(v.createdAt))}</p>
      <audio src="/v1/voices/${v.id}/sample" controls preload="none"></audio>
      ${v.origin ? `<p class="path">${v.gender ? `${esc(v.gender)} · ` : ''}${esc(v.description || '')} · voce sintetica (${esc(v.origin.source || 'Kokoro')})</p>` : `<p class="path">Consenso: ${esc(v.consent?.by || '')}, ${esc(new Date(v.consent?.at).toLocaleDateString('it-IT'))}</p>`}
      <div class="row"><button class="btn small" data-voice-use="${v.id}">Usa</button>
        <button class="btn small danger" data-voice-del="${v.id}" data-name="${esc(v.name)}">Elimina</button></div></article>`).join('')
    : '<div class="empty">Nessuna voce ancora. Registra 15–30 secondi qui sopra e crea la tua.</div>';
}

// ----- Libreria voci (personaggi sintetici) -----
const vlState = { filter: '', timer: null, data: null };
async function loadVoiceLib() {
  clearTimeout(vlState.timer);
  const d = await api('/api/voicelib').catch(() => null);
  if (!d) return;
  const wasRunning = vlState.data?.job.status === 'running';
  vlState.data = d;
  const j = d.job;
  const pct = j.total ? ` ${Math.round((j.done / j.total) * 100)}%` : '';
  $('#voicelib-status').innerHTML = j.status === 'running' ? `${esc(j.phase || 'Preparo')}${pct}…`
    : j.status === 'error' ? `<span class="error-text">${esc(j.error)}</span>`
    : d.ready ? '' : 'La prima voce scarica il modello (circa 340 MB), le altre sono quasi istantanee.';
  $('#voicelib-list').innerHTML = d.voices.filter((v) => !vlState.filter || v.gender === vlState.filter).map((v) => `
    <div class="vl-item${v.added ? ' added' : ''}">
      <span class="vl-icon" aria-hidden="true">${v.gender === 'donna' ? '♀' : '♂'}</span>
      <div class="grow"><strong>${esc(v.name)}</strong><span class="small muted" title="${esc(v.desc)} · ${esc(v.language)}">${esc(v.desc)} · ${esc(v.language)}</span></div>
      ${v.added ? `<span class="small ok-text">Nelle tue voci ✓</span>` : `<button class="btn small" type="button" data-vl-add="${esc(v.key)}" ${j.status === 'running' ? 'disabled' : ''}>${j.status === 'running' && j.key === v.key ? 'Preparo…' : 'Aggiungi'}</button>`}
    </div>`).join('');
  const opts = d.voices.map((v) => `<option value="${esc(v.key)}">${esc(v.name)} · ${esc(v.gender)}, ${esc(v.desc)}</option>`).join('');
  const f = $('#voicemix-form');
  if (!f.a.options.length) { f.a.innerHTML = opts; f.b.innerHTML = opts; f.b.selectedIndex = 1; }
  if (wasRunning && j.status !== 'running') loadVoices();
  if (j.status === 'running' && $('#page-voce').classList.contains('active')) vlState.timer = setTimeout(loadVoiceLib, 1500);
}
$('#voicelib-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vl-filter]');
  if (!b) return;
  vlState.filter = b.dataset.vlFilter;
  $$('#voicelib-filter [data-vl-filter]').forEach((x) => x.classList.toggle('active', x === b));
  loadVoiceLib();
});
async function startVoiceLib(body, errEl) {
  try {
    await api('/api/voicelib', { method: 'POST', body });
    if (errEl) errEl.textContent = '';
  } catch (err) {
    if (errEl) errEl.textContent = err.message; else { $('#voicelib-status').innerHTML = `<span class="error-text">${esc(err.message)}</span>`; return; }
  }
  loadVoiceLib();
}
$('#voicelib-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vl-add]');
  if (b) startVoiceLib({ key: b.dataset.vlAdd });
});
$('#voicemix-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.a.value === f.b.value) { $('[data-mix-err]').textContent = 'Scegli due voci diverse'; return; }
  const w = Number(f.w.value);
  const lang = vlState.data?.voices.find((v) => v.key === f.a.value)?.lang;
  startVoiceLib({ mix: `${f.a.value}:${w.toFixed(1)},${f.b.value}:${(1 - w).toFixed(1)}`, name: f.name.value, gender: f.gender.value, lang }, $('[data-mix-err]'));
});

function syncSpeakLanguage() {
  const v = state.voices.find((x) => x.id === $('#speak-form').voice.value);
  if (v) $('#speak-form').language.value = v.language;
}
$('#speak-form').voice.addEventListener('change', syncSpeakLanguage);

const LEVELS = {
  exaggeration: (x) => (x < 0.4 ? 'pacata' : x < 0.65 ? 'naturale' : x < 0.9 ? 'vivace' : 'teatrale'),
  cfg_weight: (x) => (x < 0.35 ? 'lento e calmo' : x < 0.6 ? 'normale' : 'deciso'),
};
$$('#speak-form input[type=range]').forEach((r) => r.addEventListener('input', () => {
  $(`[data-out="${r.name}"]`).textContent = `${Number(r.value).toFixed(2).replace('.', ',')} · ${LEVELS[r.name](Number(r.value))}`;
}));

$('#speak-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const out = $('#speak-result');
  const btn = $('button.primary', f);
  btn.disabled = true;
  out.innerHTML = '<div class="audio-result"><span class="muted">Preparo la lettura…</span><div class="progress indeterminate"><div></div></div></div>';
  try {
    const { id } = await api('/v1/speech', {
      method: 'POST',
      body: {
        text: f.text.value, voice: f.voice.value, language: f.language.value, wait: false,
        exaggeration: Number(f.exaggeration.value), cfg_weight: Number(f.cfg_weight.value),
        ...(f.seed.value ? { seed: Number(f.seed.value) } : {}),
      },
    });
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      if (j.status === 'done') {
        const r = j.results[0];
        out.innerHTML = `<div class="audio-result"><strong>${esc(j.title)}</strong><audio src="${esc(r.url)}" controls autoplay></audio>
          <div class="row"><a class="btn small" href="${esc(r.url)}" download>↓ Scarica MP3</a><span class="muted small">${String(r.seconds).replace('.', ',')} s di audio · creato in ${j.seconds ?? '?'} s</span></div></div>`;
        loadHistory();
        break;
      }
      if (j.status === 'error' || j.status === 'cancelled') { out.innerHTML = `<p class="error-text">${esc(j.error)}</p>`; break; }
      const p = j.progress;
      out.innerHTML = `<div class="audio-result"><span class="muted">${j.waiting ? 'In fila: la GPU sta finendo un altro lavoro…' : p?.total ? `Leggo la frase ${p.step} di ${p.total}…` : 'Accendo il motore voce (la prima volta carica il modello)…'}</span>
        <div class="progress ${p?.total ? '' : 'indeterminate'}"><div style="width:${p?.total ? Math.round((p.step / p.total) * 100) : 0}%"></div></div>
        <div class="row"><button type="button" class="btn small" data-cancel-job="${id}">Annulla</button></div></div>`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    out.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

// ----- Registrazione e creazione della voce -----
let recorder = null;
let recorded = null;
let recTimer = null;

$('#rec-btn').addEventListener('click', async () => {
  const btn = $('#rec-btn');
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => chunks.push(ev.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      recorded = new File([new Blob(chunks, { type: recorder.mimeType })], `registrazione.${recorder.mimeType.includes('ogg') ? 'ogg' : 'webm'}`, { type: recorder.mimeType });
      $('#rec-preview').src = URL.createObjectURL(recorded);
      $('#rec-preview').hidden = false;
      btn.classList.remove('recording');
      btn.textContent = '● Registra di nuovo';
      $('#rec-status').textContent = 'Registrazione pronta: ascoltala prima di creare la voce.';
    };
    recorder.start();
    const t0 = Date.now();
    btn.classList.add('recording');
    btn.textContent = '■ Ferma';
    recTimer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      $('#rec-status').textContent = `Sto registrando… ${s} s ${s < 15 ? '(continua fino a 15–30 s)' : '✓ va bene, puoi fermare'}`;
      if (s >= 45) recorder.stop();
    }, 500);
  } catch {
    $('#rec-status').textContent = 'Non riesco a usare il microfono: controlla i permessi del browser, oppure carica un file.';
  }
});
$('#voice-file').addEventListener('change', (e) => {
  recorded = e.target.files[0] || null;
  if (recorded) {
    $('#rec-preview').src = URL.createObjectURL(recorded);
    $('#rec-preview').hidden = false;
    $('#rec-status').textContent = `File: ${recorded.name}`;
  }
});

$('#voice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#voice-error').textContent = '';
  if (!recorded) { $('#voice-error').textContent = 'Registra la tua voce o carica un file audio.'; return; }
  const btn = $('button.primary', f);
  btn.disabled = true;
  btn.textContent = 'Preparo la voce…';
  try {
    const form = new FormData();
    form.append('name', f.name.value.trim());
    form.append('language', f.language.value);
    form.append('consent', f.consent.checked ? 'true' : 'false');
    form.append('file', recorded, recorded.name);
    const res = await fetch('/v1/voices', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    f.reset();
    recorded = null;
    $('#rec-preview').hidden = true;
    $('#rec-status').textContent = `✓ Voce "${data.name}" creata.`;
    await loadVoices();
    $('#speak-form').voice.value = data.id;
    syncSpeakLanguage();
  } catch (err) {
    $('#voice-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crea la voce';
  }
});

document.addEventListener('click', async (e) => {
  const use = e.target.closest('[data-voice-use]');
  if (use) {
    $('#speak-form').voice.value = use.dataset.voiceUse;
    syncSpeakLanguage();
    $('#speak-form').text.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const del = e.target.closest('[data-voice-del]');
  if (del && confirm(`Eliminare la voce "${del.dataset.name}"? Il campione verrà cancellato.`)) {
    await api(`/v1/voices/${del.dataset.voiceDel}`, { method: 'DELETE' });
    loadVoices();
  }
  const c = e.target.closest('[data-cancel-job]');
  if (c) { c.disabled = true; api(`/api/jobs/${c.dataset.cancelJob}/cancel`, { method: 'POST' }); }
});

if (location.hash === '#voce') { loadEngines(); loadVoices(); }


// ======================= Musica =======================

const MUSIC_IDEAS = [
  ['instrumental', 30, 'Lo-fi rilassata con pianoforte elettrico e batteria morbida, 80 BPM, atmosfera serale, sottofondo per un reel'],
  ['instrumental', 20, 'Corporate motivazionale, chitarra acustica e archi leggeri, crescendo positivo, 110 BPM'],
  ['instrumental', 15, 'Jingle allegro e brillante per un brand di caffè, ukulele e fischietto, 120 BPM'],
  ['instrumental', 45, 'Cinematica epica con orchestra e percussioni potenti, tensione che cresce fino al finale'],
  ['auto', 60, 'Canzone pop estiva in italiano, voce femminile, ritmo ballabile, ritornello facile da ricordare'],
];
$('#music-ideas').innerHTML = MUSIC_IDEAS.map(([, d, p], i) => `<button type="button" data-music-idea="${i}">${esc(p)}<br><span class="muted small">${d} secondi</span></button>`).join('');
$('#music-form').language.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

function syncMusicForm() {
  const f = $('#music-form');
  const mode = f.mode.value;
  $$('[data-music="lyrics"]').forEach((el) => { el.hidden = mode !== 'lyrics'; });
  $$('[data-music="vocals"]').forEach((el) => { el.hidden = mode === 'instrumental'; });
  const d = Number(f.duration.value);
  $('[data-out-music="duration"]').textContent = d >= 60 ? `${Math.floor(d / 60)} min${d % 60 ? ` ${d % 60} s` : ''}` : `${d} secondi`;
}
$('#music-form').addEventListener('input', syncMusicForm);
syncMusicForm();

document.addEventListener('click', (e) => {
  const idea = e.target.closest('[data-music-idea]');
  if (!idea) return;
  const [mode, dur, prompt] = MUSIC_IDEAS[Number(idea.dataset.musicIdea)];
  const f = $('#music-form');
  f.prompt.value = prompt;
  f.mode.value = mode;
  f.duration.value = dur;
  syncMusicForm();
  f.prompt.focus();
});

$('#music-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const out = $('#music-result');
  const btn = $('button.primary', f);
  btn.disabled = true;
  out.innerHTML = '<div class="audio-result"><span class="muted">Preparo la composizione…</span><div class="progress indeterminate"><div></div></div></div>';
  const mode = f.mode.value;
  try {
    const { id } = await api('/v1/music', {
      method: 'POST',
      body: {
        prompt: f.prompt.value,
        instrumental: mode === 'instrumental',
        lyrics: mode === 'lyrics' ? f.lyrics.value : '',
        language: f.language.value,
        duration: Number(f.duration.value),
        quality: f.quality.value,
        ...(f.bpm.value ? { bpm: Number(f.bpm.value) } : {}),
        ...(f.key.value.trim() ? { key: f.key.value.trim() } : {}),
        ...(f.seed.value ? { seed: Number(f.seed.value) } : {}),
        wait: false,
      },
    });
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      if (j.status === 'done') {
        const r = j.results[0];
        const m = r.metas || {};
        out.innerHTML = `<div class="audio-result"><strong>${esc(j.title)}</strong><div class="wave">${waveBars(j.id, 36)}</div><audio src="${esc(r.url)}" controls autoplay></audio>
          <div class="row"><a class="btn small" href="${esc(r.url)}" download>↓ Scarica</a>
          <span class="muted small">${String(r.seconds).replace('.', ',')} s${m.bpm ? ` · ${m.bpm} BPM` : ''}${m.keyscale ? ` · ${esc(m.keyscale)}` : ''} · composto in ${j.seconds ?? '?'} s</span></div></div>`;
        loadHistory();
        break;
      }
      if (j.status === 'error' || j.status === 'cancelled') { out.innerHTML = `<p class="error-text">${esc(j.error)}</p>`; break; }
      const el = j.progress?.elapsed;
      const pr = j.progress || {};
      const note = pr.coldStart ? '<br><span class="small">Primo brano dopo l\'avvio: il motore carica i modelli in memoria. I brani successivi sono molto più veloci.</span>' : '';
      const detail = pr.detail ? `<br><span class="small mono">${esc(pr.detail)}</span>` : '';
      out.innerHTML = `<div class="audio-result"><span class="muted">${j.waiting ? 'In fila: la GPU sta finendo un altro lavoro…' : el != null ? `Compongo… ${el} s${note}${detail}` : 'Accendo il motore musica…'}</span>
        <div class="progress indeterminate"><div></div></div>
        <div class="row"><button type="button" class="btn small" data-cancel-job="${id}">Annulla</button></div></div>`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    out.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

if (location.hash === '#musica') loadEngines();


// ======================= Reel =======================

const PHASES = ['Scrivo il testo', 'Registro la voce', 'Creo le immagini', 'Compongo la musica', 'Monto il reel'];

async function loadReelForm() {
  const f = $('#reel-form');
  const [v, models, settings, eng] = await Promise.all([
    api('/v1/voices').catch(() => ({ voices: [] })),
    api('/api/models').catch(() => ({ generators: [], brain: '' })),
    api('/api/settings').catch(() => ({})),
    api('/api/engines').catch(() => []),
  ]);
  const cur = f.voice.value;
  f.voice.innerHTML = v.voices.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('') + '<option value="none">Senza voce (solo sottotitoli)</option>';
  if (cur) f.voice.value = cur;
  const mcur = f.model.value;
  f.model.innerHTML = '<option value="">Lo sceglie ideax</option>' + models.generators.filter((m) => m.capabilities.includes('image_generate')).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  f.model.value = mcur;
  // Cosa manca per un reel completo
  const needs = [];
  if (/regole/.test(models.brain || '')) needs.push('Senza cervello attivo serve il testo ("Ho già il testo"); con Ollama o un .gguf lo scrive ideax.');
  if (!v.voices.length) needs.push('Nessuna voce: creala nella pagina Voce, oppure il reel sarà solo con sottotitoli.');
  if (!eng.find((e) => e.id === 'music' && e.status === 'installed')) needs.push('Motore musica non installato: il reel sarà senza musica.');
  if (!models.generators.some((m) => m.capabilities.includes('image_generate'))) needs.push('Serve un modello di immagini (pagina Modelli).');
  $('#reel-needs').textContent = needs.join(' ');
  if (/regole/.test(models.brain || '')) $('#reel-script-box').open = true;
}

$('#reel-form').addEventListener('input', (e) => {
  if (e.target.name === 'music') $$('[data-reel="music-desc"]').forEach((el) => { el.hidden = e.target.value !== 'custom'; });
});

function renderReelProgress(j) {
  const cur = j.progress?.phase;
  const idx = PHASES.indexOf(cur);
  return `<div class="phone"><ul class="phases">${PHASES.map((p, i) => {
    const cls = i < idx ? 'ok' : i === idx ? 'now' : '';
    const n = i === idx && j.progress?.total ? ` ${j.progress.step}/${j.progress.total}` : '';
    return `<li class="${cls}">${esc(p)}${n}</li>`;
  }).join('')}</ul></div>
  <div class="reel-meta"><span class="muted small">${j.waiting ? 'In fila: la GPU sta finendo un altro lavoro…' : 'Un reel richiede qualche minuto: puoi continuare a usare ideax.'}</span>
    <div class="row"><button type="button" class="btn small" data-cancel-job="${j.id}">Annulla</button></div></div>`;
}

function renderReelResult(j) {
  const v = j.results.find((r) => r.type === 'video/mp4');
  const cover = j.results.find((r) => r.role === 'cover');
  const srt = j.results.find((r) => r.role === 'subtitles');
  const caption = [j.reel?.caption, (j.reel?.hashtags || []).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')].filter(Boolean).join('\n\n');
  return `<div class="phone"><video src="${esc(v.url)}" ${cover ? `poster="${esc(cover.url)}"` : ''} controls autoplay playsinline></video></div>
    <div class="reel-meta"><strong>${esc(j.title || 'Reel')}</strong><span class="muted small">${esc(j.reason || '')}</span>
      <div class="row"><a class="btn small primary" href="${esc(v.url)}" download>↓ Scarica MP4</a>
        ${cover ? `<a class="btn small" href="${esc(cover.url)}" download>Copertina</a>` : ''}
        ${srt ? `<a class="btn small" href="${esc(srt.url)}" download>Sottotitoli .srt</a>` : ''}</div>
      ${caption ? `<div class="caption-box">${esc(caption)}</div><button type="button" class="btn small" data-copy-text="${esc(caption)}">Copia didascalia e hashtag</button>` : ''}</div>`;
}

// ----- Video montato con Impagino (catena di clip) -----
async function loadCatena() {
  const st = await api('/api/catena/montatore').catch(() => ({ online: false }));
  $('#catena-montatore').innerHTML = st.online ? '<span class="ok-text">● Montatore di Impagino acceso</span>' : '<span class="muted">○ Montatore di Impagino spento: le clip restano pronte in una cartella</span>';
  const sel = $('#catena-form').stile;
  if (st.stili?.length && sel.options.length < 2) sel.innerHTML += st.stili.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
}
async function watchCatena(id) {
  const out = $('#catena-result');
  for (;;) {
    const j = await api(`/v1/jobs/${id}`).catch(() => null);
    if (!j) return;
    if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
      const vids = (j.results || []).filter((r) => r.type === 'video/mp4');
      const montato = vids.find((v) => /montato/.test(v.url));
      out.innerHTML = j.status !== 'done' ? `<p class="error-text">${esc(j.error || 'Non riuscito')}</p>`
        : `${montato ? `<div class="row"><video src="${esc(montato.url)}" controls style="max-height:420px;border-radius:12px"></video></div><div class="row"><a class="btn small primary" href="${esc(montato.url)}" download>↓ Scarica il montato</a></div>` : '<p class="muted">Clip pronte: il montatore di Impagino era spento, accendilo e aprile da lì (la cartella è nel registro qui sotto).</p>'}
          <div class="vl-grid">${vids.filter((v) => v !== montato).map((v, i) => `<div><video src="${esc(v.url)}" controls muted style="width:100%;border-radius:10px"></video><a class="small" href="${esc(v.url)}" download>Clip ${i + 1}</a></div>`).join('')}</div>
          <details class="choices"><summary>Registro</summary><pre class="small">${esc((j.log || []).map((l) => l.msg || l).join('\n'))}</pre></details>`;
      return;
    }
    out.innerHTML = `<p>${esc(j.progress?.phase || 'Preparo')}${j.progress?.total ? ` · ${j.progress.step + 1}/${j.progress.total}` : ''}…</p><p class="muted small">Ogni clip richiede qualche minuto. Puoi continuare a usare ideax.</p><button type="button" class="btn small" data-cancel-job="${esc(id)}">Annulla</button>`;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
$('#catena-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('[data-catena-err]').textContent = '';
  try {
    const { id } = await api('/v1/catena', { method: 'POST', body: { prompt: f.prompt.value, clip: Number(f.clip.value), formato: f.formato.value, stile: f.stile.value || undefined, musica_provenienza: f.musica_provenienza.value, veloce: f.veloce.checked } });
    watchCatena(id);
  } catch (err) {
    $('[data-catena-err]').textContent = err.message;
  }
});

$('#reel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.prompt.value.trim() && !f.script.value.trim()) { f.prompt.focus(); return; }
  const out = $('#reel-result');
  const btn = $('button.primary', f);
  btn.disabled = true;
  try {
    const { id } = await api('/v1/reels', {
      method: 'POST',
      body: {
        prompt: f.prompt.value.trim(),
        ...(f.script.value.trim() ? { script: f.script.value.trim() } : {}),
        duration: Number(f.duration.value),
        voice: f.voice.value === 'none' ? false : f.voice.value || undefined,
        style: f.style.value.trim() || undefined,
        music: f.music.value === 'none' ? false : f.music.value === 'custom' ? f.musicDesc.value.trim() || true : true,
        captions: f.captions.checked,
        model: f.model.value || undefined,
      },
    });
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      if (j.status === 'done') { out.innerHTML = renderReelResult(j); loadHistory(); break; }
      if (j.status === 'error' || j.status === 'cancelled') {
        out.innerHTML = `<div class="phone"><div class="phone-empty">${j.status === 'cancelled' ? 'Annullato' : 'Il reel non è riuscito'}</div></div><p class="error-text">${esc(j.error || '')}</p>`;
        break;
      }
      out.innerHTML = renderReelProgress(j);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    out.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

if (location.hash === '#reel') loadReelForm();

// ======================= Studio: conversazione =======================

const chat = { list: [], current: null, attachments: [], jobs: {}, polling: null, sending: false };

function setStudioMode(mode) {
  try { localStorage.setItem('ideax-studio-mode', mode); } catch {}
  $$('[data-studio-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.studioMode === mode)));
  $('#chat-wrap').hidden = mode !== 'chat';
  $('#studio-crea').hidden = mode !== 'crea';
  if (mode === 'chat') setTimeout(() => $('#chat-input').focus(), 50);
}
$$('[data-studio-mode]').forEach((b) => b.addEventListener('click', () => setStudioMode(b.dataset.studioMode)));
const chatMode = () => !$('#chat-wrap').hidden;

// Markdown essenziale e sicuro: prima si fa l'escape, poi si aggiunge la formattazione
function md(text) {
  const blocks = [];
  let t = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return t.split(/\n{2,}/).map((para) => {
    const block = para.match(/^\u0000(\d+)\u0000$/);
    if (block) return blocks[Number(block[1])];
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    const h = para.match(/^#{1,4}\s+(.+)$/);
    if (h && lines.length === 1) return `<h4>${inline(h[1])}</h4>`;
    return `<p>${inline(para).replace(/\n/g, '<br>').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)])}</p>`;
  }).join('');
}

async function loadChats() {
  chat.list = await api('/api/chats').catch(() => []);
  renderChatList();
}

function renderChatList() {
  $('#chat-list').innerHTML = chat.list.length ? chat.list.map((c) => `
    <button class="chat-item" role="listitem" data-chat="${esc(c.id)}" aria-current="${c.id === chat.current?.id}">
      <span class="t">${c.mode === 'intervista' ? '◎ ' : c.mode === 'lezione' ? '✦ ' : ''}${esc(c.title || 'Nuova chat')}</span>
      <span class="p">${esc(when(c.updatedAt))}${c.preview ? ` · ${esc(c.preview.replace(/[*_`#>]+/g, ''))}` : ''}</span>
    </button>`).join('') : '<p class="empty">Le tue conversazioni appariranno qui.</p>';
}

$('#chat-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chat]');
  if (b) { openChat(b.dataset.chat); $('#chat-wrap').classList.remove('side-open'); }
});
$('#chat-toggle').addEventListener('click', () => $('#chat-wrap').classList.toggle('side-open'));
$('#chat-new').addEventListener('click', () => { newChat(); $('#chat-wrap').classList.remove('side-open'); });

function newChat() {
  stopChatPoll();
  chat.current = null;
  renderChat();
  renderChatList();
  $('#chat-input').focus();
}

async function openChat(id) {
  stopChatPoll();
  chat.current = await api(`/api/chats/${id}`).catch(() => null);
  try { localStorage.setItem('ideax-chat', id); } catch {}
  renderChat();
  renderChatList();
  if (chat.current?.busy) pollChat();
}

const SUGGESTIONS = [
  ['interview', 'Fammi qualche domanda per conoscermi'],
  ['', 'Cosa sai di me?'],
  ['', 'Mostrami i miei repository su GitHub'],
  ['', 'Crea un\'immagine di una spiaggia siciliana al tramonto, stile fotografico'],
  ['', 'Componi una base lo-fi rilassata di 30 secondi'],
];

function renderChat() {
  const c = chat.current;
  const name = state.settings?.assistant?.name || 'ideax';
  $('#chat-title').textContent = c?.title || 'Nuova chat';
  $('#chat-sub').textContent = c ? `${c.mode === 'intervista' ? 'Intervista · ' : ''}${c.messages.length} messaggi` : `Cervello: ${state.models.brain || '…'}`;
  $('#chat-rename').hidden = !c;
  $('#chat-delete').hidden = !c;
  const thread = $('#chat-thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  if (!c || (!c.messages.length && !c.pending)) {
    thread.innerHTML = `<div class="chat-empty">
      <p class="eyebrow">Il tuo cervello</p>
      <h2>Ciao, sono ${esc(name)}. Di cosa parliamo?</h2>
      <p class="muted">Parlami di te e dei tuoi progetti: imparo e me lo ricordo in tutte le chat. Posso anche creare immagini, video, voce, musica e reel, e lavorare sui tuoi repository GitHub.</p>
      <div class="suggest">${SUGGESTIONS.map(([k, t], i) => `<button type="button" data-suggest="${i}">${esc(t)}</button>`).join('')}</div>
    </div>`;
    return;
  }
  thread.innerHTML = c.messages.map((m) => messageHtml(m, name)).join('') + (c.pending ? pendingHtml(c.pending, name) : '');
  $$('[data-job]', thread).forEach((el) => renderJobCard(el));
  if (atBottom || c.pending) thread.scrollTop = thread.scrollHeight;
}

function messageHtml(m, name) {
  if (m.role === 'user') {
    const atts = [...(m.attachments || []).map((a) => (a.type.startsWith('video/') ? `<video src="${esc(a.url)}" muted playsinline></video>` : a.type.startsWith('audio/') ? `<span class="file">♪ ${esc(a.name)}</span>` : `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-zoom>`)),
      ...(m.files || []).map((f) => `<span class="file">📄 ${esc(f.name)}</span>`)];
    return `<div class="msg user">${atts.length ? `<div class="atts">${atts.join('')}</div>` : ''}${m.content ? `<div class="bubble">${esc(m.content)}</div>` : ''}</div>`;
  }
  const who = m.from ? esc(m.from) : esc(name);
  return `<div class="msg assistant">
    <div class="who"><b>${who}</b>${m.ts ? `<span>${esc(when(m.ts))}</span>` : ''}</div>
    ${m.steps?.length ? `<div class="steps-line">${m.steps.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    <div class="bubble${m.error ? ' error' : ''}">${md(m.content || '')}</div>
    ${(m.jobs || []).map((id) => `<div class="job-card" data-job="${esc(id)}"></div>`).join('')}
    ${m.needsBrain ? '<div class="row"><a class="btn small" href="#cervello">Dammi un cervello</a></div>' : ''}
    ${m.remembered?.length ? `<div class="remembered">✓ Mi segno: ${m.remembered.map(esc).join(' · ')}</div>` : ''}
  </div>`;
}

function pendingHtml(p, name) {
  return `<div class="msg assistant">
    <div class="who"><b>${esc(name)}</b><span>sta pensando…</span></div>
    ${p.steps?.length ? `<div class="steps-line">${p.steps.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    ${p.text ? `<div class="bubble muted">${md(p.text)}</div>` : ''}
    <div class="typing" aria-label="Sta scrivendo"><i></i><i></i><i></i></div>
  </div>`;
}

// Le creazioni avviate dalla chat: si aggiornano da sole finché non sono pronte
async function fetchJob(id) {
  const j = await api(`/api/jobs/${id}`).catch(() => null);
  if (j) return j;
  return api(`/api/history/${id}`).catch(() => ({ id, status: 'error', error: 'Creazione non più disponibile' }));
}

function renderJobCard(el) {
  const id = el.dataset.job;
  const j = chat.jobs[id];
  if (!j) {
    el.innerHTML = '<div class="jc-wait"><span class="muted">Preparo…</span><div class="progress indeterminate"><div></div></div></div>';
    refreshJob(id);
    return;
  }
  if (j.status === 'error' || j.status === 'cancelled') {
    el.innerHTML = `<div class="jc-wait error">${esc(j.status === 'cancelled' ? 'Annullato' : errorAdvice(j.error || '').title)}<span class="small muted">${esc(j.error || '')}</span></div>`;
    return;
  }
  if (j.status !== 'done') {
    const p = j.progress || {};
    const pct = p.total ? Math.round((p.step / p.total) * 100) : null;
    const text = j.waiting ? 'In fila: la GPU sta finendo un altro lavoro' : p.total ? `${p.phase || 'Genero'} · ${p.step} di ${p.total}` : p.elapsed != null ? `${p.phase || 'Lavoro'}… ${p.elapsed} s` : p.phase || (j.status === 'routing' ? 'Scelgo il modello…' : 'Il modello sta lavorando…');
    const sig = `${j.status}|${pct == null}`;
    if (el.dataset.sig === sig) {
      $('.jc-text', el).textContent = text;
      $('.progress > div', el).style.width = `${pct ?? 0}%`;
    } else {
      el.dataset.sig = sig;
      el.innerHTML = `<div class="jc-wait"><span class="jc-text">${esc(text)}</span><div class="progress ${pct == null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div>
        <div class="row"><button class="btn small" type="button" data-job-cancel="${esc(id)}">Annulla</button></div></div>`;
    }
    setTimeout(() => refreshJob(id), 1200);
    return;
  }
  delete el.dataset.sig;
  const r = j.results?.find((x) => x.type.startsWith('video/')) || j.results?.[0];
  if (!r) { el.innerHTML = '<div class="jc-wait muted">Nessun risultato</div>'; return; }
  const media = r.type.startsWith('audio/') ? `<audio src="${esc(r.url)}" controls></audio>`
    : r.type.startsWith('video/') ? `<video src="${esc(r.url)}" controls loop playsinline></video>`
      : `<img src="${esc(r.url)}" alt="${esc(j.title || j.prompt)}" data-zoom>`;
  el.innerHTML = `${media}<div class="jc-foot"><span class="muted">${esc(j.title || '')}${j.model || j.modelName ? ` · ${esc(j.model || j.modelName)}` : ''}</span>
    <a class="btn small" href="${esc(r.url)}" download>↓ Scarica</a></div>`;
}

async function refreshJob(id) {
  const before = chat.jobs[id]?.status;
  chat.jobs[id] = await fetchJob(id);
  $$(`[data-job="${CSS.escape(id)}"]`).forEach(renderJobCard);
  if (before && before !== 'done' && chat.jobs[id].status === 'done') loadHistory();
}

$('#chat-thread').addEventListener('click', async (e) => {
  const s = e.target.closest('[data-suggest]');
  if (s) {
    const [kind, text] = SUGGESTIONS[Number(s.dataset.suggest)];
    if (kind === 'interview') return startInterview();
    return sendChat(text);
  }
  const z = e.target.closest('[data-zoom]');
  if (z) {
    $('#lightbox-body').innerHTML = `<img src="${esc(z.getAttribute('src'))}" alt="">`;
    $('#lightbox').showModal();
  }
  const cancel = e.target.closest('[data-job-cancel]');
  if (cancel) { cancel.disabled = true; await api(`/api/jobs/${cancel.dataset.jobCancel}/cancel`, { method: 'POST' }).catch(() => {}); }
});

async function startInterview() {
  location.replace('#studio');
  setStudioMode('chat');
  stopChatPoll();
  chat.current = await api('/api/chats', { method: 'POST', body: { title: 'Ti conosco meglio', mode: 'intervista' } });
  await sendChat('Iniziamo! Fammi la prima domanda per conoscermi.');
}

async function sendChat(text) {
  if (chat.sending || chat.current?.busy) return;
  const message = String(text ?? $('#chat-input').value).trim();
  if (!message && !chat.attachments.length) return;
  chat.sending = true;
  $('#chat-send').disabled = true;
  try {
    if (!chat.current) chat.current = await api('/api/chats', { method: 'POST', body: {} });
    const attachments = chat.attachments;
    $('#chat-input').value = '';
    autosize();
    chat.attachments = [];
    renderChatAttachments();
    chat.current = await api(`/api/chats/${chat.current.id}/messages`, { method: 'POST', body: { message, attachments } });
    try { localStorage.setItem('ideax-chat', chat.current.id); } catch {}
    renderChat();
    loadChats();
    pollChat();
  } catch (err) {
    alert(err.message);
  } finally {
    chat.sending = false;
    $('#chat-send').disabled = false;
  }
}

function stopChatPoll() { clearTimeout(chat.polling); chat.polling = null; }
function pollChat() {
  stopChatPoll();
  const id = chat.current?.id;
  chat.polling = setTimeout(async () => {
    const c = await api(`/api/chats/${id}`).catch(() => null);
    if (!c || chat.current?.id !== id) return;
    const changed = JSON.stringify([c.messages.length, c.pending]) !== JSON.stringify([chat.current.messages.length, chat.current.pending]);
    chat.current = c;
    if (changed) renderChat();
    if (c.busy) pollChat();
    else {
      if (changed) { loadChats(); loadMemoryCount(); }
      // Piano piano si continua a guardare: una risposta può arrivare dopo (es. dopo il download del cervello scrittore)
      chat.polling = setTimeout(() => { if (chat.current?.id === id) pollChat(); }, 5000);
    }
  }, 700);
}

$('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
function autosize() {
  const t = $('#chat-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
}
$('#chat-input').addEventListener('input', autosize);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});

async function addChatAttachments(files) {
  for (const f of files) {
    if (f.size > 200 * 1024 * 1024) { alert(`${f.name}: file troppo grande`); continue; }
    chat.attachments.push(await readFile(f));
  }
  renderChatAttachments();
}
function renderChatAttachments() {
  $('#chat-attachments').innerHTML = chat.attachments.map((a, i) => `
    <div class="thumb">
      ${a.type.startsWith('video/') ? `<video src="${a.dataUrl}" muted></video>` : a.type.startsWith('image/') ? `<img src="${a.dataUrl}" alt="${esc(a.name)}">` : `<span class="small" style="display:grid;place-items:center;height:100%;padding:6px;text-align:center;color:#fff">${esc(a.name)}</span>`}
      <button type="button" data-rm="${i}" aria-label="Rimuovi ${esc(a.name)}">✕</button>
    </div>`).join('');
}
$('#chat-attachments').addEventListener('click', (e) => {
  const i = e.target.dataset.rm;
  if (i !== undefined) { chat.attachments.splice(Number(i), 1); renderChatAttachments(); }
});
$('#chat-file').addEventListener('change', (e) => { addChatAttachments([...e.target.files]); e.target.value = ''; });

$('#chat-rename').addEventListener('click', async () => {
  const title = prompt('Nuovo nome della chat', chat.current?.title || '');
  if (!title) return;
  chat.current = { ...chat.current, ...(await api(`/api/chats/${chat.current.id}`, { method: 'PATCH', body: { title } })) };
  renderChat();
  loadChats();
});
$('#chat-delete').addEventListener('click', async () => {
  if (!confirm('Eliminare questa chat? I ricordi che ha imparato restano.')) return;
  await api(`/api/chats/${chat.current.id}`, { method: 'DELETE' }).catch(() => {});
  newChat();
  loadChats();
});

async function loadMemoryCount() {
  const m = await api('/api/memory').catch(() => null);
  if (m) $('#mem-count').textContent = m.total;
  return m;
}

// ======================= Cervello =======================

const brainPage = { memory: null, filter: 'all', teachers: [], learnTimer: null };

async function loadBrainPage() {
  const [mem, settings, gh, learn] = await Promise.all([
    loadMemoryCount(), api('/api/settings').catch(() => ({})), api('/api/github').catch(() => ({})), api('/api/learn').catch(() => null),
  ]);
  brainPage.memory = mem;
  brainPage.teachers = settings.teachers || [];
  renderBrainStatus();
  renderMemory();
  renderTeachers();
  renderGithub(gh);
  const pf = $('#persona-form');
  pf.name.value = settings.assistant?.name || '';
  pf.style.value = settings.assistant?.style || '';
  pf.adult.checked = !!settings.assistant?.adult;
  if (learn) renderLearn(learn);
}

let brainsTimer = null;
async function renderBrainStatus() {
  clearTimeout(brainsTimer);
  const b = await api('/api/brains').catch(() => null);
  const el = $('#brain-status');
  if (!b) { el.innerHTML = ''; return; }
  const gb = (x) => (x?.size ? fmtSize(x.size) : '');
  const big = b.primary && b.primary.size > 8e9;
  const opts = (sel, none) => (none ? `<option value="none" ${!sel ? 'selected' : ''}>Nessuno</option>` : '') + b.llms.map((m) => `<option value="${esc(m.id)}" ${sel?.id === m.id ? 'selected' : ''}>${esc(m.name)} · ${gb(m)}</option>`).join('');
  const job = b.job;
  const jobHtml = job.status === 'running'
    ? `<div class="note"><h3>${job.kind === 'lighten' ? 'Alleggerisco' : 'Scarico'} ${esc(job.name)}</h3><p class="small">${esc(job.step || '')}${job.total ? ` · ${job.kind === 'download' ? `${fmtSize(job.done)} di ${fmtSize(job.total)}` : `${job.done} di ${job.total}`}` : ''}</p>
        <div class="progress ${job.total ? '' : 'indeterminate'}"><div style="width:${job.total ? Math.round((job.done / job.total) * 100) : 0}%"></div></div></div>`
    : job.status === 'error' ? `<div class="note error"><h3>Non è andata</h3><p class="small">${esc(job.error)}</p></div>`
      : job.status === 'done' ? `<div class="note"><h3>Fatto ✓</h3><p class="small">${esc(job.name)} è pronto: ora è il cervello per parlare.</p></div>` : '';
  el.innerHTML = `
    <h2>I cervelli</h2>
    <p class="muted">Uno <strong>veloce</strong> per parlare con te, e uno <strong>grande di riserva</strong> per i lavori pesanti (bozze di Mathis, ricordi da testi lunghi, "pensaci a fondo"). Girano sul tuo PC, senza censure se scegli modelli senza censure.</p>
    ${b.llms.length ? `<div class="grid2">
      <label>Per parlare (veloce)<select data-brain-primary>${opts(b.primary)}</select></label>
      <label>Di riserva (lavori pesanti)<select data-brain-reserve>${opts(b.reserve, true)}</select></label>
    </div>` : '<p class="small">Non hai ancora un cervello: scaricane uno qui sotto.</p>'}
    ${big ? `<div class="note warn"><h3>Il cervello per parlare è troppo grande</h3>
      <p class="small">${esc(b.primary.name)} pesa ${gb(b.primary)}: su una scheda da 16 GB è lento e lascia poco spazio a immagini e video. Posso crearne una versione leggera (stesso modello, stesse risposte senza censure, circa un terzo della dimensione) e usare l'originale come riserva.</p>
      <div class="row"><button class="btn primary small" type="button" data-brain-lighten="${esc(b.primary.id)}" data-type="Q4_K_M">Alleggerisci · Q4_K_M (più veloce)</button>
        <button class="btn small" type="button" data-brain-lighten="${esc(b.primary.id)}" data-type="Q8_0">Q8_0 (più fedele)</button></div></div>` : ''}
    ${jobHtml}
    <h3 style="margin-top:18px">Cervelli veloci senza censure</h3>
    <div class="stack-sm">${b.recommended.map((r) => `<div class="teacher"><div class="grow"><strong>${esc(r.name)}</strong><p class="muted small">${esc(r.note)}</p></div>
      <button class="btn small" type="button" data-brain-download="${esc(r.key)}" ${job.status === 'running' ? 'disabled' : ''}>Scarica e usa</button></div>`).join('')}</div>
    <p class="muted small" style="margin-top:12px">Motore: llama.cpp ${b.engine.installed ? esc(b.engine.version || '') : '(si scarica da solo al primo messaggio)'}${b.engine.status === 'running' ? ' · acceso' : ''}${b.engine.error ? ` · <span class="error-text">${esc(b.engine.error)}</span>` : ''}</p>`;
  if (job.status === 'running') brainsTimer = setTimeout(() => { if ($('#page-cervello').classList.contains('active')) renderBrainStatus(); }, 2000);
  if (job.status === 'done') loadModels();
}

$('#brain-status').addEventListener('change', async (e) => {
  const prim = e.target.closest('[data-brain-primary]');
  const res = e.target.closest('[data-brain-reserve]');
  if (!prim && !res) return;
  await api('/api/brains/select', { method: 'POST', body: prim ? { gguf: prim.value } : { reserve: res.value } });
  await loadModels();
  renderBrainStatus();
});
$('#brain-status').addEventListener('click', async (e) => {
  const l = e.target.closest('[data-brain-lighten]');
  const d = e.target.closest('[data-brain-download]');
  if (!l && !d) return;
  e.target.disabled = true;
  try {
    if (l) await api('/api/brains/lighten', { method: 'POST', body: { id: l.dataset.brainLighten, type: l.dataset.type } });
    else await api('/api/brains/download', { method: 'POST', body: { key: d.dataset.brainDownload } });
  } catch (err) { alert(err.message); }
  renderBrainStatus();
});

function renderMemory() {
  const m = brainPage.memory;
  if (!m) return;
  const cats = m.categories;
  $('#mem-summary').textContent = m.total ? `${m.total} ricordi. Li usa in tutte le chat e li aggiorna mentre parlate.` : 'Ancora niente: parla con ideax, fai l\'intervista o insegnagli con un testo.';
  $('#mem-filters').innerHTML = [['all', 'Tutti'], ...Object.entries(cats).filter(([k]) => m.byCategory[k])].map(([k, v]) => `<button type="button" data-mem-filter="${k}" aria-selected="${brainPage.filter === k}">${esc(v)}${k !== 'all' ? ` · ${m.byCategory[k]}` : ''}</button>`).join('');
  $('#mem-add').category.innerHTML = Object.entries(cats).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  const facts = m.facts.filter((f) => brainPage.filter === 'all' || f.category === brainPage.filter);
  $('#mem-list').innerHTML = facts.map((f) => `<div class="mem-item" data-fact="${esc(f.id)}">
      <span class="txt">${esc(f.text)}</span><span class="src">${esc(cats[f.category] || '')} · ${esc(f.source === 'chat' ? 'dalla chat' : f.source)}</span>
      <button class="btn small" type="button" data-fact-edit>Modifica</button><button class="btn small danger" type="button" data-fact-del aria-label="Dimentica">✕</button></div>`).join('');
}

$('#mem-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mem-filter]');
  if (b) { brainPage.filter = b.dataset.memFilter; renderMemory(); }
});
$('#mem-list').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-fact]');
  if (!item) return;
  const id = item.dataset.fact;
  if (e.target.closest('[data-fact-del]')) {
    await api(`/api/memory/${id}`, { method: 'DELETE' }).catch(() => {});
  } else if (e.target.closest('[data-fact-edit]')) {
    const f = brainPage.memory.facts.find((x) => x.id === id);
    const text = prompt('Modifica il ricordo', f.text);
    if (!text) return;
    await api(`/api/memory/${id}`, { method: 'PATCH', body: { text } });
  } else return;
  brainPage.memory = await loadMemoryCount();
  renderMemory();
});
$('#mem-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.text.value.trim()) return;
  await api('/api/memory', { method: 'POST', body: { text: f.text.value, category: f.category.value, source: 'manuale' } });
  f.text.value = '';
  brainPage.memory = await loadMemoryCount();
  renderMemory();
});
$('#mem-clear').addEventListener('click', async () => {
  if (!confirm('Dimenticare tutto quello che ideax sa di te? Non si può annullare.')) return;
  await api('/api/memory', { method: 'DELETE' });
  brainPage.memory = await loadMemoryCount();
  renderMemory();
});

$('#start-interview').addEventListener('click', startInterview);

const importForm = $('#import-form');
importForm.file.addEventListener('change', () => {
  $('[data-import-files]').textContent = [...importForm.file.files].map((f) => f.name).join(', ');
});
importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('[data-import-out]');
  const btn = $('button.primary', importForm);
  const attachments = await Promise.all([...importForm.file.files].map(readFile));
  if (!importForm.text.value.trim() && !attachments.length) { out.textContent = 'Incolla un testo o allega un file.'; return; }
  btn.disabled = true;
  out.className = 'small muted';
  out.textContent = 'Leggo e imparo… (con testi lunghi ci vuole qualche minuto)';
  try {
    const r = await api('/api/memory/import', { method: 'POST', body: { text: importForm.text.value, attachments, source: attachments[0]?.name || 'testo incollato' } });
    out.className = 'small ok-text';
    out.textContent = `Imparato: ${r.saved.length} nuovi ricordi.`;
    importForm.reset();
    $('[data-import-files]').textContent = '';
    brainPage.memory = await loadMemoryCount();
    renderMemory();
  } catch (err) {
    out.className = 'small error-text';
    out.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function renderTeachers() {
  $('#teacher-list').innerHTML = brainPage.teachers.map((t) => `<div class="teacher" data-teacher-id="${esc(t.id)}">
    <strong>${esc(t.name)}</strong>
    <button class="btn small primary" type="button" data-teacher-learn>Impara da ${esc(t.name)}</button>
    <button class="btn small" type="button" data-teacher-test>Prova</button>
    <button class="btn small" type="button" data-teacher-edit>Modifica</button>
    <span class="small muted" data-teacher-out style="flex-basis:100%"></span></div>`).join('');
}

const tForm = $('#teacher-form');
function openTeacher(t = {}) {
  tForm.reset();
  for (const k of ['id', 'name', 'type', 'url', 'model', 'apiKey']) if (t[k] != null) tForm[k].value = t[k];
  if (!t.type) tForm.type.value = 'openai';
  if (!t.name) tForm.name.value = 'Axel';
  syncTeacherForm();
  $('[data-teacher-err]').textContent = '';
  $('#teacher-dialog').showModal();
}
function syncTeacherForm() { $('[data-teacher="openai"]').hidden = tForm.type.value !== 'openai'; }
tForm.type.addEventListener('change', syncTeacherForm);
$('#teacher-add').addEventListener('click', () => openTeacher());
tForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  try {
    await api('/api/teachers', { method: 'POST', body: Object.fromEntries(new FormData(tForm)) });
    $('#teacher-dialog').close();
    brainPage.teachers = await api('/api/teachers');
    renderTeachers();
  } catch (err) {
    $('[data-teacher-err]').textContent = err.message;
  }
});
$('#teacher-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-teacher-id]');
  if (!row) return;
  const t = brainPage.teachers.find((x) => x.id === row.dataset.teacherId);
  const out = $('[data-teacher-out]', row);
  if (e.target.closest('[data-teacher-edit]')) return openTeacher(t);
  if (e.target.closest('[data-teacher-test]')) {
    out.textContent = 'Provo a parlarci…';
    try {
      const r = await api(`/api/teachers/${t.id}/test`, { method: 'POST' });
      out.textContent = `Risponde: "${r.reply}"`;
    } catch (err) {
      out.textContent = err.message;
    }
  }
  if (e.target.closest('[data-teacher-learn]')) {
    try {
      renderLearn(await api('/api/learn', { method: 'POST', body: { teacher: t.id } }));
    } catch (err) {
      out.textContent = err.message;
    }
  }
});

function renderLearn(l) {
  clearTimeout(brainPage.learnTimer);
  const el = $('#learn-progress');
  if (l.status === 'idle') { el.innerHTML = ''; return; }
  const pct = l.total ? Math.round((l.step / l.total) * 100) : 0;
  el.innerHTML = l.status === 'running'
    ? `<div class="note"><h3>Sto imparando da ${esc(l.teacher)} · ${l.step} di ${l.total}</h3><p class="muted small">${esc(l.current)}</p>
        <div class="progress"><div style="width:${pct}%"></div></div><p class="small">${l.learned} ricordi nuovi finora</p></div>`
    : `<div class="note ${l.status === 'error' ? 'error' : ''}"><h3>${l.status === 'error' ? `${esc(l.teacher)} non ha risposto` : `Lezione da ${esc(l.teacher)} finita`}</h3>
        <p class="small">${l.status === 'error' ? esc(l.error) : `${l.learned} ricordi nuovi. La conversazione completa è nella chat "Lezione da ${esc(l.teacher)}".`}</p></div>`;
  if (l.status === 'running') {
    brainPage.learnTimer = setTimeout(async () => {
      const next = await api('/api/learn').catch(() => null);
      if (next) renderLearn(next);
      if (next?.status !== 'running') { brainPage.memory = await loadMemoryCount(); renderMemory(); loadChats(); }
    }, 1500);
  }
}

function renderGithub(gh) {
  $('#gh-write').checked = !!gh.allowWrite;
  $('#gh-token').placeholder = gh.hasToken ? 'Token salvato · incollane uno nuovo per cambiarlo' : 'github_pat_… oppure ghp_…';
  $('#gh-status').innerHTML = gh.user ? `<span class="ok-text">Collegato come ${esc(gh.user.login)} ✓</span>` : gh.error ? `<span class="error-text">${esc(gh.error)}</span>` : '';
  $('#gh-repos').textContent = gh.downloaded?.length ? `Repository scaricati sul PC: ${gh.downloaded.join(', ')}` : '';
}
$('#gh-save').addEventListener('click', async () => {
  await api('/api/github', { method: 'POST', body: { token: $('#gh-token').value } });
  $('#gh-token').value = '';
  renderGithub(await api('/api/github'));
});
$('#gh-write').addEventListener('change', async (e) => {
  await api('/api/github', { method: 'POST', body: { allowWrite: e.target.checked } });
});
$('#persona-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  state.settings = await api('/api/settings', { method: 'POST', body: { assistant: { name: f.name.value.trim() || 'ideax', style: f.style.value.trim(), adult: f.adult.checked } } });
  $('[data-persona-ok]').textContent = 'Salvato ✓';
  setTimeout(() => { $('[data-persona-ok]').textContent = ''; }, 1500);
});

(async () => {
  let mode = 'chat';
  try { mode = localStorage.getItem('ideax-studio-mode') || 'chat'; } catch {}
  setStudioMode(mode);
  await loadChats();
  let last = null;
  try { last = localStorage.getItem('ideax-chat'); } catch {}
  if (last && chat.list.some((c) => c.id === last)) await openChat(last);
  else renderChat();
  loadMemoryCount();
})();

// ======================= Sistemi online =======================

const SYS_STATUS = { online: ['on', 'Collegato'], errore: ['off', 'Non raggiungibile'], spento: ['', 'Spento'], 'in collegamento': ['warn', 'Mi collego…'], 'in attesa': ['warn', 'In attesa'], 'attesa chiave': ['warn', 'In attesa dell\'app'] };
let systemsTimer = null;

async function loadSystems() {
  clearTimeout(systemsTimer);
  const data = await api('/api/systems').catch(() => null);
  if (!data) return;
  $('#systems-list').innerHTML = data.systems.length ? data.systems.map((s) => {
    const st = s.state || {};
    const [dot, label] = SYS_STATUS[st.status] || ['', st.status || ''];
    const hint = st.status === 'attesa chiave' || st.status === 'errore' ? st.error : '';
    return `<div class="teacher" data-system="${esc(s.id)}">
      <span class="dot ${dot}"></span><strong>${esc(s.name)}</strong>
      <span class="small muted grow">${esc(label)}${st.current ? ` · sto facendo ${esc(st.current)}` : ''}${st.done ? ` · ${st.done} lavori fatti` : ''}</span>
      <button class="btn small" type="button" data-system-key>Chiave</button>
      <button class="btn small danger" type="button" data-system-del aria-label="Scollega ${esc(s.name)}">✕</button>
      <span class="small muted" style="flex-basis:100%">${esc(s.url)}${hint ? ` · <span class="${st.status === 'errore' ? 'error-text' : ''}">${esc(hint)}</span>` : ''}</span>
      <span class="small" data-system-out style="flex-basis:100%"></span></div>`;
  }).join('') : '<p class="muted">Nessuna app collegata: scrivi un indirizzo qui sopra e premi Crea ponte.</p>';
  if ($('#page-collega').classList.contains('active')) systemsTimer = setTimeout(loadSystems, 4000);
}

function showBridgeKey(r) {
  const box = $('#bridge-result');
  box.hidden = false;
  box.innerHTML = `<p><strong>${esc(r.name)}</strong> ${r.existing ? 'era già collegato: ecco la sua chiave.' : 'è pronto.'} Copia la chiave e incollala nei <strong>Secrets</strong> dell'app con il nome <code>${esc(r.secret)}</code>, poi ripubblica l'app. ideax si collega da solo.</p>
    <div class="row"><input class="mono grow" readonly value="${esc(r.key)}"><button class="btn primary" type="button" data-copy-text="${esc(r.key)}">Copia chiave</button></div>
    <div class="row small muted"><span>Nome del secret:</span><code>${esc(r.secret)}</code><button class="btn small" type="button" data-copy-text="${esc(r.secret)}">Copia nome</button></div>`;
}

$('#bridge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('[data-bridge-err]').textContent = '';
  try {
    const r = await api('/api/systems/ponte', { method: 'POST', body: { url: f.url.value } });
    f.reset();
    showBridgeKey(r);
    loadSystems();
  } catch (err) {
    $('[data-bridge-err]').textContent = err.message;
  }
});

$('#system-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/systems', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
    f.reset();
    $('[data-system-err]').textContent = '';
    loadSystems();
  } catch (err) {
    $('[data-system-err]').textContent = err.message;
  }
});

$('#systems-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-system]');
  if (!row) return;
  const id = row.dataset.system;
  const out = $('[data-system-out]', row);
  if (e.target.closest('[data-system-key]')) {
    const { systems: list } = await api('/api/systems');
    const sys = list.find((x) => x.id === id);
    const k = await api(`/api/systems/${id}/chiave`);
    showBridgeKey({ name: sys?.name || '', key: k.key, secret: k.secret, existing: true });
    $('#bridge-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (e.target.closest('[data-system-test]')) {
    out.textContent = 'Provo…';
    try {
      await api(`/api/systems/${id}/test`, { method: 'POST' });
      out.innerHTML = '<span class="ok-text">Collegamento riuscito ✓</span>';
    } catch (err) {
      out.innerHTML = `<span class="error-text">${esc(err.message)}</span>`;
    }
  }
  if (e.target.closest('[data-system-toggle]')) {
    const { systems: list } = await api('/api/systems');
    const s = list.find((x) => x.id === id);
    await api('/api/systems', { method: 'POST', body: { ...s, enabled: s.enabled === false } });
    loadSystems();
  }
  if (e.target.closest('[data-system-del]') && confirm('Scollegare questo sistema? Non riceverà più lavori da ideax.')) {
    await api(`/api/systems/${id}`, { method: 'DELETE' });
    loadSystems();
  }
});

// ======================= Gemello =======================

const twinState = { photos: [], video: null, timer: null };

async function loadTwin() {
  clearTimeout(twinState.timer);
  const [t, vs] = await Promise.all([api('/api/twin').catch(() => null), api('/v1/voices').catch(() => ({ voices: [] }))]);
  if (!t) return;
  const voiceOpts = vs.voices.length ? vs.voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('') : '<option value="">Nessuna voce: creala nella pagina Voce</option>';
  $$('#twin-video-form select[name=voice], #talk-form select[name=voice]').forEach((sel) => { const keep = sel.value; sel.innerHTML = voiceOpts; if (keep) sel.value = keep; });
  $('#twin-photo-list').innerHTML = t.photo.map((g) => {
    const pr = g.progress;
    const pct = pr?.total ? Math.round((pr.step / pr.total) * 100) : null;
    const status = g.status === 'ready' ? '<span class="chip"><i class="dot on"></i> pronto</span>'
      : g.status === 'error' ? `<span class="error-text small">${esc(g.error || 'non riuscito')}</span>`
        : `<span class="small">${esc(pr?.phase || 'In addestramento')}${pr?.total ? ` · passo ${pr.step} di ${pr.total}` : ''}</span>`;
    return `<div class="teacher" data-twin-photo="${esc(g.id)}"><strong>${esc(g.name)}</strong><span class="muted small">${g.photos} foto</span>${status}
      ${g.status === 'training' ? '<button class="btn small" type="button" data-twin-cancel>Annulla</button>' : ''}
      ${g.status === 'ready' ? `<a class="btn small primary" href="#studio" data-twin-try="${esc(g.name)}">Prova in Studio</a>` : ''}
      <button class="btn small danger" type="button" data-twin-del aria-label="Elimina il gemello ${esc(g.name)}">✕</button>
      ${g.status === 'training' ? `<div class="progress ${pct == null ? 'indeterminate' : ''}" style="flex-basis:100%"><div style="width:${pct ?? 0}%"></div></div>` : ''}</div>`;
  }).join('');
  $('#twin-video-list').innerHTML = t.video.map((g) => `<div class="teacher" data-twin-video-id="${esc(g.id)}">
      <video src="/api/twin/video/${esc(g.id)}/file" muted playsinline preload="metadata" style="width:72px;height:72px;object-fit:cover;border-radius:10px"></video>
      <strong>${esc(g.name)}</strong><button class="btn small danger" type="button" data-twin-video-del aria-label="Elimina il video ${esc(g.name)}">✕</button></div>`).join('');
  $('#talk-form').hidden = !t.video.length;
  const sel = $('#talk-form select[name=twin]');
  const keep = sel.value;
  sel.innerHTML = t.video.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  if (keep) sel.value = keep;
  if (t.photo.some((g) => g.status === 'training') && $('#page-gemello').classList.contains('active')) twinState.timer = setTimeout(loadTwin, 5000);
}

const twinForm = $('#twin-photo-form');
twinForm.photos.addEventListener('change', async () => {
  twinState.photos = await Promise.all([...twinForm.photos.files].slice(0, 40).map(readFile));
  $('[data-twin-count]').textContent = `${twinState.photos.length} foto`;
  $('#twin-thumbs').innerHTML = twinState.photos.map((p) => `<div class="thumb"><img src="${p.dataUrl}" alt=""></div>`).join('');
});
twinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('[data-twin-err]');
  const btn = $('button.primary', twinForm);
  btn.disabled = true;
  err.textContent = '';
  try {
    await api('/api/twin/photo', { method: 'POST', body: { name: twinForm.name.value, photos: twinState.photos, consent: twinForm.consent.checked } });
    twinForm.reset();
    twinState.photos = [];
    $('#twin-thumbs').innerHTML = '';
    $('[data-twin-count]').textContent = 'nessuna';
    loadTwin();
  } catch (x) {
    err.textContent = x.message;
  } finally {
    btn.disabled = false;
  }
});

const videoForm = $('#twin-video-form');
videoForm.video.addEventListener('change', async () => {
  const f = videoForm.video.files[0];
  twinState.video = f ? await readFile(f) : null;
  $('[data-twin-video]').textContent = f ? f.name : 'nessuno';
});
videoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('[data-twin-video-err]');
  err.textContent = '';
  try {
    await api('/api/twin/video', { method: 'POST', body: { name: videoForm.name.value, video: twinState.video, voice: videoForm.voice.value, consent: videoForm.consent.checked } });
    videoForm.reset();
    twinState.video = null;
    $('[data-twin-video]').textContent = 'nessuno';
    loadTwin();
  } catch (x) {
    err.textContent = x.message;
  }
});

$('#page-gemello').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-twin-photo]');
  if (row && e.target.closest('[data-twin-cancel]')) { await api('/api/twin/photo/cancel', { method: 'POST' }); loadTwin(); }
  if (row && e.target.closest('[data-twin-del]') && confirm('Eliminare questo gemello e le sue foto?')) {
    await api(`/api/twin/photo/${row.dataset.twinPhoto}`, { method: 'DELETE' }).catch((x) => alert(x.message));
    loadTwin();
  }
  const tr = e.target.closest('[data-twin-try]');
  if (tr) {
    setTimeout(() => { setStudioMode('chat'); $('#chat-input').value = `Fammi una foto di me in barca al tramonto, stile fotografico`; autosize(); $('#chat-input').focus(); }, 50);
  }
  const vrow = e.target.closest('[data-twin-video-id]');
  if (vrow && e.target.closest('[data-twin-video-del]') && confirm('Eliminare questo video di base?')) {
    await api(`/api/twin/video/${vrow.dataset.twinVideoId}`, { method: 'DELETE' });
    loadTwin();
  }
});

$('#talk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const out = $('#talk-result');
  const btn = $('button.primary', f);
  btn.disabled = true;
  try {
    const { id } = await api('/api/twin/talk', { method: 'POST', body: { text: f.text.value, twin: f.twin.value, voice: f.voice.value } });
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      if (j.status === 'done') {
        const r = j.results[0];
        out.innerHTML = `<div class="job-card"><video src="${esc(r.url)}" controls playsinline></video><div class="jc-foot"><span class="muted">${esc(j.title || '')}</span><a class="btn small" href="${esc(r.url)}" download>↓ Scarica</a></div></div>`;
        loadHistory();
        break;
      }
      if (j.status === 'error' || j.status === 'cancelled') { out.innerHTML = `<p class="error-text">${esc(j.error || 'Annullato')}</p>`; break; }
      const p = j.progress || {};
      out.innerHTML = `<div class="note"><h3>${esc(p.phase || 'Preparo…')}</h3>${p.total ? `<div class="progress"><div style="width:${Math.round((p.step / p.total) * 100)}%"></div></div>` : '<div class="progress indeterminate"><div></div></div>'}</div>`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (x) {
    out.innerHTML = `<p class="error-text">${esc(x.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

$('#hf-check').addEventListener('click', async (e) => {
  const out = $('#hf-result');
  e.target.disabled = true;
  out.innerHTML = '<p class="muted small">Controllo il token e i modelli protetti…</p>';
  try {
    const r = await api('/api/hf/check', { method: 'POST' });
    out.innerHTML = r.problem ? `<div class="note error"><p class="small">${esc(r.problem)}</p></div>`
      : `<div class="note ${r.ok ? '' : 'warn'}"><p class="small">Token di <strong>${esc(r.user)}</strong> · tipo ${esc(r.role === 'fineGrained' ? 'fine-grained' : r.role)}</p>
        ${r.repos.map((x) => `<div class="small" style="margin-top:8px">${x.access ? '<span class="ok-text">✓</span>' : '<span class="error-text">✕</span>'} <strong>${esc(x.repo)}</strong> · ${esc(x.usedBy)}${x.fix ? `<br><span class="muted">${esc(x.fix)}</span>
          <div class="row" style="margin-top:6px"><button type="button" class="btn small primary" data-hf-gate="${esc(x.repo)}">Accetta la licenza per me</button></div><div data-hf-form="${esc(x.repo)}"></div>` : ''}</div>`).join('')}</div>`;
  } catch (err) {
    out.innerHTML = `<p class="error-text small">${esc(err.message)}</p>`;
  } finally {
    e.target.disabled = false;
  }
});

// Accettare la licenza di un modello protetto da ideax: si mostra il modulo di Hugging Face già compilato e si conferma
$('#hf-result').addEventListener('click', async (e) => {
  const g = e.target.closest('[data-hf-gate]');
  const send = e.target.closest('[data-hf-send]');
  if (g) {
    const box = $(`[data-hf-form="${CSS.escape(g.dataset.hfGate)}"]`);
    box.innerHTML = '<p class="muted small">Leggo il modulo della licenza…</p>';
    try {
      const info = await api('/api/hf/gate', { method: 'POST', body: { repo: g.dataset.hfGate } });
      box.innerHTML = `<form class="stack-sm" data-hf-repo="${esc(info.repo)}">
        ${info.prompt ? `<p class="muted small">${esc(info.prompt.replace(/<[^>]+>/g, '').slice(0, 600))}</p>` : ''}
        ${info.fields.map((f, i) => f.type === 'checkbox'
          ? `<label class="check"><input type="checkbox" name="f${i}" data-label="${esc(f.label)}" checked> ${esc(f.label)}</label>`
          : `<label>${esc(f.label)} <input name="f${i}" data-label="${esc(f.label)}" value="${esc(f.value)}" required></label>`).join('')}
        <label class="check"><input type="checkbox" name="consent"> Ho letto e accetto la licenza di <a href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.repo)}</a> per l'account ${esc(info.user || '')}</label>
        <div class="row"><button class="btn small primary" type="button" data-hf-send>Accetta e chiedi l'accesso</button><span class="small" data-hf-out></span></div></form>`;
    } catch (err) {
      box.innerHTML = `<p class="error-text small">${esc(err.message)}</p>`;
    }
  }
  if (send) {
    const form = send.closest('form');
    const out = $('[data-hf-out]', form);
    if (!form.consent.checked) { out.innerHTML = '<span class="error-text">Spunta l\'accettazione della licenza</span>'; return; }
    const values = {};
    $$('[data-label]', form).forEach((i) => { values[i.dataset.label] = i.type === 'checkbox' ? i.checked : i.value; });
    send.disabled = true;
    out.textContent = 'Invio la richiesta a Hugging Face…';
    try {
      const r = await api('/api/hf/request', { method: 'POST', body: { repo: form.dataset.hfRepo, values, consent: true } });
      out.innerHTML = r.ok ? '<span class="ok-text">Accesso ottenuto ✓</span>'
        : '<span class="muted">Hugging Face vuole il clic dal sito: ti ho aperto la pagina nel browser. Premi "Agree and access repository", poi Verifica.</span>';
      if (r.ok) setTimeout(() => $('#hf-check').click(), 800);
    } catch (err) {
      out.innerHTML = `<span class="error-text">${esc(err.message)}</span>`;
    } finally {
      send.disabled = false;
    }
  }
});

// ======================= Finestra senza terminale =======================

// La navigazione sostituisce l'indirizzo invece di aggiungerne uno: con una sola voce nella cronologia
// il browser permette alla pagina di chiudersi da sola (aggiornamento, "Esci da ideax")
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target) return;
  e.preventDefault();
  location.replace(a.getAttribute('href'));
});

// Segnale di vita: all'avvio ideax apre il browser solo se nessuna pagina è già aperta
const ping = () => fetch('/api/ping').catch(() => {});
ping();
setInterval(ping, 3000);

$('#quit-ideax').addEventListener('click', async () => {
  if (!confirm('Chiudere ideax? I lavori in corso si interrompono. Lo riapri dal menu Start o dall\'icona sul desktop.')) return;
  await api('/api/quit', { method: 'POST' }).catch(() => {});
  document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;font:16px system-ui;color:#a6a6b6;background:#0d0e12;text-align:center;padding:16px">ideax è chiuso. Puoi chiudere questa scheda.<br>Per riaprirlo usa il menu Start o l\'icona sul desktop.</div>';
  window.close();
});

// ======================= Regia =======================

let regiaTimer = null;
const STEP_STATES = ['da fare', 'in corso', 'fatto', 'bloccato'];

async function loadRegia() {
  clearTimeout(regiaTimer);
  const r = await api('/api/regia').catch(() => null);
  if (!r) return;
  const st = r.study;
  $('#regia-summary').textContent = r.projects.length
    ? `${r.projects.length} progetti${r.studiedAt ? ` · studiati ${when(r.studiedAt)}` : ''}. Quelli "solo da conoscere" ideax non li usa nei piani.`
    : 'ideax legge da GitHub la scheda, il README e le note di ogni progetto e scrive a cosa serve. Serve il token di GitHub (Cervello → GitHub).';
  $('#regia-study').disabled = st.status === 'running';
  $('#regia-study-state').innerHTML = st.status === 'running'
    ? `<div class="note"><h3>${esc(st.step || 'Studio…')}</h3><div class="progress ${st.total ? '' : 'indeterminate'}"><div style="width:${st.total ? Math.round((st.done / st.total) * 100) : 0}%"></div></div><p class="small">${st.done} di ${st.total || '?'}</p></div>`
    : st.status === 'error' || st.error ? `<p class="error-text small">${esc(st.error)}</p>` : '';
  $('#regia-projects').innerHTML = r.projects.map((p) => {
    const s = p.summary || {};
    return `<div class="rcard ${p.knowOnly ? 'known' : ''}" data-project="${esc(p.id)}">
      <h3><span>${esc(p.name)}</span><span class="chip">${esc(s.categoria || '—')}</span></h3>
      ${p.url ? `<a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ''))}</a>` : ''}
      <p class="small">${esc(s.a_cosa_serve || p.description || 'Da descrivere')}</p>
      ${(s.cosa_sa_fare || []).length ? `<ul>${s.cosa_sa_fare.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${s.come_ideax_lo_usa ? `<p class="small muted">Per ideax: ${esc(s.come_ideax_lo_usa)}</p>` : ''}
      <p class="small muted">${esc(s.stato || '')}${p.lastCommit ? ` · ultimo lavoro ${esc(p.lastCommit)}` : ''}</p>
      ${p.note ? `<p class="small">Nota: ${esc(p.note)}</p>` : ''}
      <div class="row"><label class="check small"><input type="checkbox" data-know ${p.knowOnly ? 'checked' : ''}> Solo da conoscere</label>
        <button class="btn small" type="button" data-note>${p.note ? 'Modifica nota' : 'Aggiungi nota'}</button></div></div>`;
  }).join('');
  const th = r.thinking;
  $('#regia-thinking').innerHTML = th.status === 'running' ? '<div class="note"><h3>Studio le idee…</h3><p class="small">Il cervello di riserva incrocia tutti i progetti: può volerci qualche minuto.</p><div class="progress indeterminate"><div></div></div></div>'
    : th.status === 'error' ? `<p class="error-text small">${esc(th.error)}</p>` : '';
  $('#regia-ideas').innerHTML = r.ideas.map((i) => `<div class="idea" data-idea="${esc(i.id)}">
    <h3>${esc(i.titolo)}</h3><p>${esc(i.idea)}</p>
    <dl><dt>Chi paga</dt><dd>${esc(i.clienti)}</dd><dt>Offerta e prezzo</dt><dd>${esc(i.offerta_e_prezzo)}</dd>
      <dt>Ricavo stimato</dt><dd>${esc(i.ricavo_mensile_stimato)}</dd><dt>Primo incasso</dt><dd>${esc(i.tempo_al_primo_incasso)}</dd>
      <dt>Progetti usati</dt><dd>${(i.progetti || []).map((x) => `<strong>${esc(x.progetto)}</strong>: ${esc(x.ruolo)}`).join(' · ')}</dd>
      <dt>Rischi</dt><dd>${esc(i.rischi)}</dd></dl>
    <ol class="steps-list">${(i.passi || []).map((p) => `<li><span class="tool">${esc(p.strumento)}</span>${esc(p.cosa)}</li>`).join('')}</ol>
    <div class="row"><button class="btn primary small" type="button" data-mission>Fanne una missione</button><button class="btn small danger" type="button" data-idea-del>Scarta</button></div></div>`).join('')
    || (r.projects.length ? '<p class="muted small">Premi "Proponi business" e ideax ti propone le idee più promettenti.</p>' : '');
  $('#regia-missions').innerHTML = r.missions.map((m) => {
    const done = m.steps.filter((x) => x.status === 'fatto').length;
    return `<div class="idea" data-mission-id="${esc(m.id)}"><h3>${esc(m.title)} <span class="chip">${done} di ${m.steps.length} fatti</span></h3>
      <ol class="steps-list">${m.steps.map((x) => `<li class="${x.status.replace(' ', '-')}" data-step="${esc(x.id)}"><span class="tool">${esc(x.tool)}</span><span class="grow">${esc(x.what)}</span>
        <select data-step-status aria-label="Stato del passo">${STEP_STATES.map((v) => `<option ${v === x.status ? 'selected' : ''}>${v}</option>`).join('')}</select></li>`).join('')}</ol>
      <div class="row"><button class="btn small danger" type="button" data-mission-del>Elimina missione</button></div></div>`;
  }).join('') || '<p class="muted small">Nessuna missione ancora.</p>';
  if ((st.status === 'running' || th.status === 'running') && $('#page-regia').classList.contains('active')) regiaTimer = setTimeout(loadRegia, 2500);
}

$('#regia-study').addEventListener('click', async () => {
  await api('/api/regia/study', { method: 'POST' }).catch((err) => alert(err.message));
  loadRegia();
});
$('#regia-ideas-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/regia/ideas', { method: 'POST', body: { focus: e.target.focus.value } }).catch((err) => alert(err.message));
  loadRegia();
});
$('#page-regia').addEventListener('change', async (e) => {
  const card = e.target.closest('[data-project]');
  if (card && e.target.matches('[data-know]')) await api(`/api/regia/projects/${card.dataset.project}`, { method: 'PATCH', body: { knowOnly: e.target.checked } });
  const step = e.target.closest('[data-step]');
  if (step && e.target.matches('[data-step-status]')) {
    const m = step.closest('[data-mission-id]').dataset.missionId;
    await api(`/api/regia/missions/${m}/steps/${step.dataset.step}`, { method: 'PATCH', body: { status: e.target.value } });
  }
  loadRegia();
});
$('#page-regia').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-project]');
  if (card && e.target.closest('[data-note]')) {
    const note = prompt('Nota per ideax su questo progetto (es. "è il nostro prodotto principale", "fermo, non usarlo")');
    if (note != null) { await api(`/api/regia/projects/${card.dataset.project}`, { method: 'PATCH', body: { note } }); loadRegia(); }
  }
  const idea = e.target.closest('[data-idea]');
  if (idea && e.target.closest('[data-mission]')) { await api(`/api/regia/ideas/${idea.dataset.idea}/mission`, { method: 'POST' }); loadRegia(); }
  if (idea && e.target.closest('[data-idea-del]')) { await api(`/api/regia/ideas/${idea.dataset.idea}`, { method: 'DELETE' }); loadRegia(); }
  const m = e.target.closest('[data-mission-id]');
  if (m && e.target.closest('[data-mission-del]') && confirm('Eliminare questa missione?')) { await api(`/api/regia/missions/${m.dataset.missionId}`, { method: 'DELETE' }); loadRegia(); }
});

// Quando torni su ideax: se l'ultimo controllo degli aggiornamenti è vecchio di 10 minuti, si ricontrolla
let lastUpdateFocus = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastUpdateFocus < 10 * 60 * 1000) return;
  lastUpdateFocus = Date.now();
  api('/api/update/check', { method: 'POST' }).catch(() => {});
});

// ----- Personaggi inventati -----
let personaggiTimer = null;
async function loadPersonaggi() {
  clearTimeout(personaggiTimer);
  const d = await api('/api/personaggi').catch(() => null);
  if (!d) return;
  const tr = d.training || {};
  const busy = tr.status === 'running';
  $('#personaggi-list').innerHTML = (d.personaggi || []).map((p) => {
    const t = tr.id === p.id ? tr : null;
    const stato = p.status === 'ready' ? '<span class="ok-text">Pronto ✓</span>'
      : p.status === 'error' ? `<span class="error-text">${esc(p.error || 'errore')}</span>`
      : t ? `${esc(t.phase || 'Preparo')}${t.total ? ` · ${Math.min(100, Math.round((t.step / t.total) * 100))}%` : ''}…` : 'In preparazione…';
    return `<article class="mcard"><div class="head"><span class="chip">${p.nsfw ? 'adulti' : 'generale'}</span><span class="state">${stato}</span></div>
      <h3>${esc(p.nome)}</h3><p class="meta">${esc(p.descrizione || '')}</p>
      ${p.status === 'ready' ? `<p class="muted small">Scrivi "${esc(p.nome)}" in Studio per usarlo in foto e video.</p>` : ''}
      <div class="row">${p.status !== 'ready' && t ? '<button class="btn small" type="button" data-personaggio-cancel>Annulla</button>' : ''}
        <button class="btn small danger" type="button" data-personaggio-del="${esc(p.id)}" data-nome="${esc(p.nome)}">Elimina</button></div></article>`;
  }).join('') || '<div class="empty">Nessun personaggio. Creane uno qui sopra.</div>';
  if (busy && $('#page-gemello').classList.contains('active')) personaggiTimer = setTimeout(loadPersonaggi, 3000);
}
$('#personaggio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('[data-personaggio-err]').textContent = '';
  try {
    await api('/api/personaggi', { method: 'POST', body: { nome: f.nome.value, descrizione: f.descrizione.value, nsfw: f.nsfw.checked } });
    f.reset(); loadPersonaggi();
  } catch (err) { $('[data-personaggio-err]').textContent = err.message; }
});
$('#personaggi-list').addEventListener('click', async (e) => {
  if (e.target.closest('[data-personaggio-cancel]')) { await api('/api/personaggi/cancel', { method: 'POST' }); loadPersonaggi(); }
  const del = e.target.closest('[data-personaggio-del]');
  if (del && confirm(`Eliminare il personaggio "${del.dataset.nome}"?`)) { await api(`/api/personaggi/${del.getAttribute('data-personaggio-del')}`, { method: 'DELETE' }); loadPersonaggi(); }
});
