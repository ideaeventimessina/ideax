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
const kindOf = (task) => (task === 'animation' ? 'animation' : VIDEO_TASKS.includes(task) ? 'video' : 'image');
const KIND_NAME = { image: 'Immagine', video: 'Video', animation: 'Animazione' };

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
  if (page === 'impostazioni') { renderEngine($('#engine-card')); loadNetwork(); }
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
  if (files.length && $('#page-studio').classList.contains('active')) addAttachments(files);
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
    const media = !r ? '' : r.type.startsWith('video/')
      ? `<video src="${esc(r.url)}" muted loop playsinline preload="metadata"></video>`
      : `<img src="${esc(r.url)}" alt="" loading="lazy">`;
    return `<button class="tile" data-id="${h.id}">
      <div class="frame">${media}${kind !== 'image' ? `<span class="chip">${KIND_NAME[kind]}</span>` : ''}</div>
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
  if (onStudio()) $('#idea').classList.add('over');
  else $('#dropmask').classList.add('show');
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropmask').classList.remove('show'); $('#idea').classList.remove('over'); }
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropmask').classList.remove('show');
  $('#idea').classList.remove('over');
  const files = [...e.dataTransfer.files];
  const models = files.filter((f) => MODEL_FILE.test(f.name));
  const media = files.filter((f) => /^(image|video)\//.test(f.type));
  if (models.length) {
    if (!['#modelli', '#primi-passi'].includes(location.hash)) location.hash = 'modelli';
    models.forEach(uploadModel);
  }
  if (media.length) {
    if (!onStudio()) location.hash = 'studio';
    addAttachments(media);
  }
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
  const meta = [fmtSize(m.size), m.kind === 'checkpoint' ? `Priorità ${m.priority}` : '', m.kind === 'lora' ? `peso ${m.loraWeight}${m.loraAlways ? ' · sempre attiva' : ''}` : ''].filter(Boolean).join(' · ');
  const warn = m.error || m.note || (m.kind === 'checkpoint' && m.arch === 'unknown' ? 'Indica l\'architettura per usarlo.' : '')
    || (m.flags?.transformerOnly ? 'Flux "solo transformer": VAE ed encoder vengono dal modello base, scaricato una volta.' : '');
  return `<article class="mcard ${m.enabled ? '' : 'off'}">
    <div class="head"><span class="chip">${esc(m.format === 'gguf' && m.kind === 'llm' ? 'GGUF' : state.meta.archs[m.arch] || m.arch)}</span>
      <span class="state"><i class="dot ${m.enabled ? 'on' : ''}"></i>${m.enabled ? 'Attivo' : 'Disattivato'}</span></div>
    <h3>${esc(m.name)}</h3>
    ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    ${warn ? `<p class="warn">${esc(warn)}</p>` : ''}
    <p class="path">${esc(m.path)}</p>
    <div class="row">
      <button class="btn small" data-edit="${m.id}">Modifica</button>
      <button class="btn small" data-toggle="${m.id}">${m.enabled ? 'Disattiva' : 'Attiva'}</button>
      <button class="btn small ${internal ? 'danger' : ''}" data-del="${m.id}" data-internal="${internal}">${internal ? 'Elimina' : 'Scollega'}</button>
    </div>
  </article>`;
}

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
  mForm.params.value = Object.keys(m.params || {}).length ? JSON.stringify(m.params, null, 2) : '';
  $$('#mf-caps input').forEach((i) => { i.checked = m.capabilities.includes(i.value); });
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
      ${w.loadedName ? `<span class="chip">In memoria: ${esc(w.loadedName)}</span>` : ''}
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
    const t = setInterval(async () => {
      await refreshSetup();
      renderLlmSupport();
      if (state.setup.llm?.status !== 'running') clearInterval(t);
    }, 2000);
  }
});

function renderLlmSupport() {
  const el = $('#llm-support');
  const llm = state.setup?.llm;
  if (!state.worker.online) { el.innerHTML = ''; return; }
  if (state.worker.llm_available) { el.innerHTML = '<p class="ok-text small">✓ Supporto per i file .gguf installato.</p>'; return; }
  el.innerHTML = `<div class="note"><h3>Supporto per i file .gguf</h3>
    <p class="muted">Serve per usare un cervello .gguf caricato in ideax. In alternativa puoi usare Ollama o LM Studio.</p>
    ${llm?.status === 'error' ? `<p class="error-text">${esc(llm.error)}</p>` : ''}
    <div class="row"><button type="button" class="btn" data-install-llm ${llm?.status === 'running' ? 'disabled' : ''}>${llm?.status === 'running' ? 'Installazione in corso…' : 'Installa il supporto .gguf'}</button></div></div>`;
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
    <span class="item hide-sm">In memoria: ${esc(w.loadedName || 'nessun modello')}</span>
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
  setForm.token.value = s.network.token || '';
  syncBrainFields();
}

$('#gen-token').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  setForm.token.value = 'ideax_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
});

setForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (setForm.lan.checked && !setForm.token.value.trim()) $('#gen-token').click();
  await api('/api/settings', {
    method: 'POST',
    body: {
      workerUrl: setForm.workerUrl.value.trim() || 'http://127.0.0.1:7861',
      manageWorker: setForm.manageWorker.checked,
      extraModelDirs: setForm.extraModelDirs.value.split('\n'),
      brain: { mode: setForm.mode.value, gguf: setForm.gguf.value, serverUrl: setForm.serverUrl.value.trim(), serverModel: setForm.serverModel.value.trim() },
      network: { lan: setForm.lan.checked, token: setForm.token.value.trim() },
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
    ? `Raggiungibile dalla rete su ${n.addresses.map((a) => `http://${a}:${n.port}`).join(', ')}${n.tokenActive ? ' · token attivo' : ''}.`
    : wanted ? 'Riavvia ideax per attivare l\'accesso dalla rete.' : 'Ora ideax è raggiungibile solo da questo PC.';
  renderApiDocs(n);
}

// ======================= Collega app =======================

function renderApiDocs(net) {
  const base = location.origin;
  $('#base-url').textContent = base;
  $('#base-v1').textContent = `${base}/v1`;
  $('.base-card [data-copy-text]').dataset.copyText = base;
  if (net?.lan && net.addresses.length) $('#base-help').textContent = `Dagli altri dispositivi della rete: ${net.addresses.map((a) => `http://${a}:${net.port}`).join(', ')}${net.tokenActive ? ', con il token delle impostazioni' : ''}.`;
  const samples = [
    ['curl', `curl -X POST ${base}/v1/generate \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Un lago alpino all\\u0027alba"}'`],
    ['JavaScript', `const res = await fetch('${base}/v1/generate', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    prompt: 'Anima questa foto, le foglie si muovono col vento',\n    attachments: [{ url: 'https://esempio.it/foto.jpg' }],\n  }),\n});\nconst job = await res.json();\nconsole.log(job.results[0].url); // il file è pronto`],
    ['Python', `import requests\n\njob = requests.post("${base}/v1/generate", json={\n    "prompt": "Banner per un negozio di bici, stile flat",\n    "params": {"aspect": "16:9", "seed": 42},\n}).json()\nprint(job["results"][0]["url"])`],
  ];
  $('#code-samples').innerHTML = samples.map(([name, code]) => `
    <div class="card code-card"><div class="head"><h3>${name}</h3><button class="btn small" data-copy-code>Copia</button></div><pre class="code">${esc(code)}</pre></div>`).join('');
}
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
    location.hash = 'studio';
  }
  const ex = e.target.closest('[data-example]');
  if (ex) {
    const [format, prompt] = EXAMPLES[Number(ex.dataset.example)];
    try { localStorage.setItem('ideax-onboarded', '1'); } catch {}
    location.hash = 'studio';
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

  let onboarded = false;
  try { onboarded = localStorage.getItem('ideax-onboarded') === '1'; } catch {}
  if (!location.hash && !onboarded && (!state.worker.online || !state.models.generators.length)) {
    state.step = state.worker.online ? 2 : 1;
    location.hash = 'primi-passi';
  }
  showPage();
  setInterval(refreshStatus, 5000);
  setInterval(() => { if (!state.models.local.length) loadModels(); }, 15000);
})();
