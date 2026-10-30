const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth)$/i;

let META = { tasks: {}, archs: {}, kinds: {} };
let DATA = { local: [], servers: [], generators: [] };
let attachments = [];

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

const fmtSize = (b) => (b == null ? '' : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

function showTab(name) {
  $$('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function capsCheckboxes(container) {
  container.innerHTML = Object.entries(META.tasks)
    .map(([k, v]) => `<label><input type="checkbox" value="${k}"> ${esc(v)}</label>`).join('');
}

// ---------- Stato worker e cervello ----------
async function loadStatus() {
  const w = await api('/api/worker').catch(() => ({ online: false }));
  const worker = !w.online
    ? '<span><span class="dot off"></span>Worker spento</span>'
    : w.demo
      ? '<span><span class="dot demo"></span>Worker in modalità demo</span>'
      : `<span><span class="dot on"></span>Worker: ${esc(w.gpu || w.device)}${w.vram_gb ? ` · ${w.vram_gb} GB` : ''}</span>`;
  $('#status').innerHTML = `${worker}<span class="badge">Cervello: ${esc(DATA.brain || '…')}</span>`;
}

// ---------- Allegati (Studio) ----------
function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, dataUrl: r.result });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const f of files) if (/^(image|video)\//.test(f.type)) attachments.push(await readFile(f));
  renderAttachments();
}

function renderAttachments() {
  $('#attachments').innerHTML = attachments.map((a, i) => `
    <div class="thumb">
      ${a.type.startsWith('video/') ? `<video src="${a.dataUrl}" muted></video>` : `<img src="${a.dataUrl}" alt="">`}
      <button data-rm="${i}" title="Rimuovi">✕</button>
    </div>`).join('');
}
$('#attachments').addEventListener('click', (e) => {
  const i = e.target.dataset.rm;
  if (i !== undefined) { attachments.splice(Number(i), 1); renderAttachments(); }
});
$('#file').addEventListener('change', (e) => { addAttachments(e.target.files); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addAttachments(files);
});

// ---------- Drag & drop globale: modelli → collegamento, immagini/video → allegati ----------
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (!$('#tab-studio').classList.contains('active')) $('#dropmask').classList.add('show');
  else $('#drop').classList.add('over');
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropmask').classList.remove('show'); $('#drop').classList.remove('over'); }
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropmask').classList.remove('show');
  $('#drop').classList.remove('over');
  const files = [...e.dataTransfer.files];
  const models = files.filter((f) => MODEL_FILE.test(f.name));
  const media = files.filter((f) => /^(image|video)\//.test(f.type));
  if (models.length) { showTab('models'); models.forEach(uploadModel); }
  if (media.length) { showTab('studio'); addAttachments(media); }
});
$('#model-file').addEventListener('change', (e) => { [...e.target.files].forEach(uploadModel); e.target.value = ''; });

function uploadModel(file) {
  const row = document.createElement('div');
  row.className = 'upload card';
  row.innerHTML = `<div><strong>${esc(file.name)}</strong> <span class="muted">${fmtSize(file.size)}</span></div>
    <div class="bar"><div></div></div><span class="pct muted">0%</span>`;
  $('#uploads').prepend(row);
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/upload?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('.bar div', row).style.width = pct + '%';
    $('.pct', row).textContent = pct + '%';
  };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) {
      $('.pct', row).innerHTML = `<span class="error">${esc(body.error || 'Errore')}</span>`;
      return;
    }
    const what = [META.kinds[body.kind], META.archs[body.arch]].filter(Boolean).join(' · ');
    $('.pct', row).innerHTML = `<span class="badge ok">Collegato${what ? ': ' + esc(what) : ''}</span>`;
    loadModels();
    setTimeout(() => row.remove(), 8000);
  };
  xhr.onerror = () => { $('.pct', row).innerHTML = '<span class="error">Caricamento interrotto</span>'; };
  xhr.send(file);
}

// ---------- Generazione ----------
function mediaTag(r, controls = true) {
  return r.type.startsWith('video/')
    ? `<video src="${esc(r.url)}" ${controls ? 'controls' : ''} loop autoplay muted playsinline></video>`
    : `<img src="${esc(r.url)}" alt="">`;
}

function renderJob(el, job) {
  const label = { queued: 'In coda', routing: 'Sto capendo cosa ti serve…', running: 'Il modello sta lavorando…', done: 'Completato', error: 'Errore' }[job.status];
  const cls = job.status === 'done' ? 'ok' : job.status === 'error' ? 'err' : 'run';
  el.innerHTML = `
    <div class="meta">
      <span class="badge ${cls}">${label}</span>
      ${job.task ? `<span class="badge">${esc(META.tasks[job.task])}</span>` : ''}
      ${job.model ? `<span class="badge">${esc(job.model)}</span>` : ''}
      ${job.loras?.length ? `<span class="badge">LoRA: ${esc(job.loras.join(', '))}</span>` : ''}
    </div>
    <div class="prompt">${esc(job.prompt)}</div>
    ${job.routedPrompt && job.routedPrompt !== job.prompt ? `<div class="routed">Prompt per il modello: ${esc(job.routedPrompt)}</div>` : ''}
    ${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}
    <div class="results">${(job.results || []).map((r) => `
      <figure>${mediaTag(r)}
        <figcaption>
          <a class="button" href="${esc(r.url)}" download>Scarica</a>
          ${/^image\/(png|jpeg|webp)/.test(r.type) ? `<button data-reuse="${esc(r.url)}">Modifica ancora</button>` : ''}
        </figcaption>
      </figure>`).join('')}</div>
    <details ${job.status === 'error' ? 'open' : ''}><summary class="muted">Dettagli</summary>
      <div class="log">${(job.log || []).map((l) => esc(l.msg)).join('\n')}</div>
    </details>`;
}

async function pollJob(id, el) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    renderJob(el, job);
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

$('#go').addEventListener('click', async () => {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return; }
  const el = document.createElement('div');
  el.className = 'job card';
  $('#jobs').prepend(el);
  el.innerHTML = '<span class="badge run">Invio…</span>';
  try {
    const { id } = await api('/api/generate', {
      method: 'POST',
      body: { prompt, attachments, model: $('#model-override').value || undefined, task: $('#task-override').value || undefined },
    });
    $('#prompt').value = '';
    attachments = [];
    renderAttachments();
    await pollJob(id, el);
    loadHistory();
  } catch (err) {
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#go').click(); });

document.addEventListener('click', async (e) => {
  const url = e.target.dataset?.reuse;
  if (!url) return;
  const blob = await (await fetch(url)).blob();
  await addAttachments([new File([blob], url.split('/').pop(), { type: blob.type })]);
  $('#prompt').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function loadHistory() {
  const items = await api('/api/history');
  $('#history').innerHTML = items.length ? items.map((h) => {
    const r = h.results?.[0];
    return `<div class="hist" title="${esc(h.reason || h.error || '')}">
      <div class="media">${r ? mediaTag(r, false) : (h.status === 'error' ? 'Errore' : '—')}</div>
      <div class="txt"><div>${esc(h.prompt)}</div><div class="muted">${esc(h.modelName || '')}</div></div>
    </div>`;
  }).join('') : '<div class="empty">Ancora nessuna creazione.</div>';
}
$('#history').addEventListener('click', (e) => {
  const media = e.target.closest('.hist')?.querySelector('img, video');
  if (media) window.open(media.getAttribute('src'), '_blank');
});

// ---------- Modelli ----------
const GROUPS = [
  ['checkpoint', 'Modelli', 'generano e modificano'],
  ['lora', 'LoRA', 'si applicano ai modelli della stessa architettura'],
  ['motion', 'Moduli di movimento', 'aggiungono le animazioni ai modelli SD 1.5'],
  ['llm', 'Cervello', 'interpreta i prompt'],
  ['vae', 'VAE', 'non usati direttamente'],
];

function modelCard(m) {
  const caps = m.kind === 'checkpoint' ? m.capabilities.map((c) => `<span class="badge">${esc(META.tasks[c])}</span>`).join('') : '';
  const warn = m.error || m.note || (m.kind === 'checkpoint' && m.arch === 'unknown' ? 'Indica l\'architettura per usarlo.' : '');
  return `<div class="model card ${m.enabled ? '' : 'off'}">
    <div>
      <strong>${esc(m.name)}</strong>
      <span class="muted">· ${esc(META.archs[m.arch] || m.arch)}${m.size ? ' · ' + fmtSize(m.size) : ''}</span>
      ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ''}
      ${m.kind === 'lora' && m.triggerWords ? `<div class="desc">Parole chiave: ${esc(m.triggerWords)} · peso ${m.loraWeight}${m.loraAlways ? ' · sempre attiva' : ''}</div>` : ''}
      ${m.flags?.transformerOnly ? '<div class="desc">Flux solo transformer: VAE ed encoder vengono dal modello base (scaricato una volta).</div>' : ''}
      ${warn ? `<div class="desc error">${esc(warn)}</div>` : ''}
      <div class="caps-list">${caps}${m.priority ? `<span class="badge">priorità ${m.priority}</span>` : ''}</div>
      <div class="desc mono">${esc(m.path)}</div>
    </div>
    <div class="row">
      <button data-edit="${m.id}">Modifica</button>
      <button data-toggle="${m.id}">${m.enabled ? 'Disattiva' : 'Attiva'}</button>
      <button data-del="${m.id}" class="danger">${m.path.startsWith(DATA.dirs[0]) ? 'Elimina' : 'Scollega'}</button>
    </div>
  </div>`;
}

async function loadModels() {
  DATA = await api('/api/models');
  $('#models-dir').textContent = DATA.dirs[0];
  $('#model-groups').innerHTML = GROUPS.map(([kind, title, sub]) => {
    const items = DATA.local.filter((m) => m.kind === kind);
    if (!items.length && kind !== 'checkpoint') return '';
    return `<div class="group"><h2>${title} <small>${sub}</small></h2>
      ${items.length ? items.map(modelCard).join('') : '<div class="empty">Nessun modello ancora: trascinane uno qui sopra.</div>'}</div>`;
  }).join('');

  $('#server-list').innerHTML = DATA.servers.length ? DATA.servers.map((s) => `
    <div class="model card ${s.enabled ? '' : 'off'}">
      <div><strong>${esc(s.name)}</strong> <span class="muted">· ${esc(s.type)} · ${esc(s.endpoint)}</span>
        ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
        <div class="caps-list">${s.capabilities.map((c) => `<span class="badge">${esc(META.tasks[c])}</span>`).join('')}</div></div>
      <div class="row"><button data-srv-edit="${s.id}">Modifica</button><button data-srv-del="${s.id}" class="danger">Elimina</button></div>
    </div>`).join('') : '';

  const sel = $('#model-override');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Automatico</option>' + DATA.generators.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  sel.value = cur;
  const gg = $('#settings-form').gguf;
  const gcur = gg.value;
  gg.innerHTML = '<option value="">Il primo disponibile</option>' + DATA.local.filter((m) => m.kind === 'llm').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  gg.value = gcur;
  loadStatus();
}

const mDialog = $('#model-dialog');
const mForm = $('#model-form');
let editing = null;

function syncModelForm() {
  const kind = mForm.kind.value;
  $$('[data-for]', mForm).forEach((el) => { el.hidden = el.dataset.for !== kind; });
}

function openModel(m) {
  editing = m;
  $('#mf-error').textContent = '';
  $('#mf-path').textContent = m.path;
  mForm.name.value = m.name;
  mForm.kind.value = m.kind;
  mForm.arch.value = m.arch;
  mForm.description.value = m.description;
  mForm.triggerWords.value = m.triggerWords || '';
  mForm.loraWeight.value = m.loraWeight;
  mForm.loraAlways.checked = m.loraAlways;
  mForm.priority.value = m.priority;
  mForm.enabled.checked = m.enabled;
  mForm.params.value = Object.keys(m.params || {}).length ? JSON.stringify(m.params, null, 2) : '';
  $$('#mf-caps input').forEach((i) => { i.checked = m.capabilities.includes(i.value); });
  syncModelForm();
  mDialog.showModal();
}
mForm.kind.addEventListener('change', syncModelForm);

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
    mDialog.close();
    loadModels();
  } catch (err) {
    $('#mf-error').textContent = err instanceof SyntaxError ? 'Parametri: JSON non valido' : err.message;
  }
});

$('#model-groups').addEventListener('click', async (e) => {
  const { edit, toggle, del } = e.target.dataset;
  const find = (id) => DATA.local.find((m) => m.id === id);
  if (edit) openModel(find(edit));
  if (toggle) { await api(`/api/models/${toggle}`, { method: 'PATCH', body: { enabled: !find(toggle).enabled } }); loadModels(); }
  if (del && confirm(e.target.textContent === 'Elimina' ? 'Eliminare il file del modello dal disco?' : 'Scollegare questo modello?')) {
    await api(`/api/models/${del}`, { method: 'DELETE' });
    loadModels();
  }
});

// ---------- Server esterni ----------
const sDialog = $('#server-dialog');
const sForm = $('#server-form');
const TEMPLATE_HELP = {
  comfyui: 'In ComfyUI: abilita le opzioni sviluppatore, poi "Save (API Format)". Incolla qui il JSON e sostituisci il testo del prompt con {{prompt}}, il negativo con {{negative_prompt}}, il seed con {{seed}}, il nome dell\'immagine in LoadImage con {{image}}.',
  a1111: 'Facoltativo: parametri extra, es. {"steps": 30, "cfg_scale": 6, "width": 832, "height": 1216, "sampler_name": "DPM++ 2M"}.',
  custom: 'JSON inviato al tuo server. Segnaposto: {{prompt}}, {{negative_prompt}}, {{task}}, {{image}}, {{video}}, {{images}}. Può rispondere col file oppure con JSON contenente URL/base64.',
};
function syncServerForm() {
  $('#sf-template-help').textContent = TEMPLATE_HELP[sForm.type.value];
  $('#sf-template-label').textContent = sForm.type.value === 'comfyui' ? 'Workflow ComfyUI (formato API)' : 'Template (JSON)';
  sForm.endpoint.placeholder = { comfyui: 'http://127.0.0.1:8188', a1111: 'http://127.0.0.1:7860', custom: 'http://127.0.0.1:9000/generate' }[sForm.type.value];
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
  sDialog.showModal();
}
$('#new-server').addEventListener('click', () => openServer());
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
    sDialog.close();
    loadModels();
  } catch (err) {
    $('#sf-error').textContent = err.message;
  }
});
$('#server-list').addEventListener('click', async (e) => {
  const { srvEdit, srvDel } = e.target.dataset;
  if (srvEdit) openServer(DATA.servers.find((s) => s.id === srvEdit));
  if (srvDel && confirm('Eliminare questo server?')) { await api(`/api/servers/${srvDel}`, { method: 'DELETE' }); loadModels(); }
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- Impostazioni ----------
const setForm = $('#settings-form');
function syncBrainFields() {
  $$('[data-mode]', setForm).forEach((el) => { el.hidden = !el.dataset.mode.split(' ').includes(setForm.mode.value); });
}
setForm.mode.addEventListener('change', syncBrainFields);

async function loadSettings() {
  const s = await api('/api/settings');
  setForm.mode.value = s.brain.mode;
  setForm.gguf.value = s.brain.gguf || '';
  setForm.serverUrl.value = s.brain.serverUrl || '';
  setForm.serverModel.value = s.brain.serverModel || '';
  setForm.workerUrl.value = s.workerUrl;
  setForm.extraModelDirs.value = (s.extraModelDirs || []).join('\n');
  syncBrainFields();
}
setForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/settings', {
    method: 'POST',
    body: {
      workerUrl: setForm.workerUrl.value.trim() || 'http://127.0.0.1:7861',
      extraModelDirs: setForm.extraModelDirs.value.split('\n'),
      brain: {
        mode: setForm.mode.value,
        gguf: setForm.gguf.value,
        serverUrl: setForm.serverUrl.value.trim(),
        serverModel: setForm.serverModel.value.trim(),
      },
    },
  });
  $('#settings-ok').textContent = 'Salvato ✓';
  setTimeout(() => { $('#settings-ok').textContent = ''; }, 2000);
  loadModels();
});

// ---------- Collega app ----------
function renderApiDocs() {
  const base = location.origin;
  $$('.base').forEach((el) => { el.textContent = base; });
  $$('.base-v1').forEach((el) => { el.textContent = base + '/v1'; });
  $('#ex-curl').textContent = `curl ${base}/v1/generate \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "logo minimal di una volpe arancione"}'`;
  $('#ex-js').textContent = `const res = await fetch('${base}/v1/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'anima questa foto, le foglie si muovono col vento',
    attachments: [{ url: 'https://.../foto.jpg' }],
  }),
});
const job = await res.json();
console.log(job.results[0].url); // file pronto da usare`;
  $('#ex-py').textContent = `import requests

job = requests.post("${base}/v1/generate", json={
    "prompt": "banner per un negozio di bici, stile flat",
    "params": {"width": 1216, "height": 832, "seed": 42},
}).json()
print(job["results"][0]["url"])`;
}

// ---------- Avvio ----------
(async () => {
  META = await api('/api/meta');
  capsCheckboxes($('#mf-caps'));
  capsCheckboxes($('#sf-caps'));
  mForm.kind.innerHTML = Object.entries(META.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  mForm.arch.innerHTML = Object.entries(META.archs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#task-override').innerHTML += Object.entries(META.tasks).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  renderApiDocs();
  await Promise.all([loadSettings(), loadModels(), loadHistory()]);
  setInterval(loadStatus, 10000);
})();
