// GitHub per il cervello: cercare repository, leggerli, scaricarli sul PC e (se permesso) modificarli.
// Usa il token delle impostazioni; senza token funzionano solo i repository pubblici (con un limite orario).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, getSettings } from './store.js';

export const REPOS_DIR = path.join(DATA_DIR, 'repository');
const API = 'https://api.github.com';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'vendor']);

function cleanRepo(repo) {
  const m = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error(`Repository non valido: "${repo}" (scrivi proprietario/nome)`);
  return `${m[1]}/${m[2]}`;
}

async function gh(pathname, { method = 'GET', body, raw = false } = {}) {
  const { token } = getSettings().github;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'User-Agent': 'ideax',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('GitHub: token non valido (controllalo in Cervello → GitHub)');
    if (res.status === 403 && /rate limit/i.test(data.message || '')) throw new Error('GitHub: limite di richieste raggiunto. Aggiungi un token in Cervello → GitHub.');
    if (res.status === 404) throw new Error(`GitHub: non trovato (${pathname.split('?')[0]})${token ? '' : '. Se è privato serve un token.'}`);
    throw new Error(`GitHub: ${data.message || `HTTP ${res.status}`}`);
  }
  return raw ? res.text() : res.json();
}

function requireWrite() {
  if (!getSettings().github.allowWrite) throw new Error('Le modifiche su GitHub sono disattivate: attivale in Cervello → GitHub ("Permetti modifiche").');
  if (!getSettings().github.token) throw new Error('Per modificare GitHub serve un token (Cervello → GitHub).');
}

export async function whoami() {
  if (!getSettings().github.token) return null;
  const u = await gh('/user');
  return { login: u.login, name: u.name };
}

export async function searchRepos(query) {
  const r = await gh(`/search/repositories?q=${encodeURIComponent(query)}&per_page=8`);
  return r.items.map((x) => ({ repo: x.full_name, description: x.description, stars: x.stargazers_count, language: x.language, updated: x.pushed_at?.slice(0, 10), private: x.private }));
}

export async function myRepos() {
  if (!getSettings().github.token) throw new Error('Per vedere i tuoi repository serve un token (Cervello → GitHub).');
  const r = await gh('/user/repos?per_page=50&sort=pushed');
  return r.map((x) => ({ repo: x.full_name, description: x.description, language: x.language, updated: x.pushed_at?.slice(0, 10), private: x.private }));
}

export async function repoInfo(repo) {
  const full = cleanRepo(repo);
  const r = await gh(`/repos/${full}`);
  const readme = await gh(`/repos/${full}/readme`, { raw: true }).catch(() => '');
  return {
    repo: r.full_name, description: r.description, private: r.private, defaultBranch: r.default_branch,
    language: r.language, stars: r.stargazers_count, openIssues: r.open_issues_count, updated: r.pushed_at?.slice(0, 10),
    readme: readme.slice(0, 6000),
  };
}

export async function readRemote(repo, filePath = '', ref = '') {
  const full = cleanRepo(repo);
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const p = String(filePath).replace(/^\/+/, '');
  const data = await gh(`/repos/${full}/contents/${p.split('/').map(encodeURIComponent).join('/')}${q}`);
  if (Array.isArray(data)) return { repo: full, path: p || '/', type: 'cartella', items: data.map((x) => `${x.type === 'dir' ? '📁' : '📄'} ${x.path}`) };
  const text = data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : String(data.content || '');
  return { repo: full, path: data.path, type: 'file', size: data.size, content: text.slice(0, 12000), truncated: text.length > 12000 };
}

export async function searchCode(repo, query) {
  if (!getSettings().github.token) throw new Error('La ricerca nel codice di GitHub richiede un token (Cervello → GitHub).');
  const full = cleanRepo(repo);
  const r = await gh(`/search/code?q=${encodeURIComponent(`${query} repo:${full}`)}&per_page=15`);
  return r.items.map((x) => x.path);
}

export async function listIssues(repo, state = 'open') {
  const full = cleanRepo(repo);
  const r = await gh(`/repos/${full}/issues?state=${state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open'}&per_page=20`);
  return r.map((x) => ({ number: x.number, title: x.title, type: x.pull_request ? 'pull request' : 'issue', state: x.state, author: x.user?.login, updated: x.updated_at?.slice(0, 10) }));
}

// ----- Copia sul PC -----

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} è terminato con codice ${code}`))));
  });
}

const localDir = (full) => path.join(REPOS_DIR, full.replace('/', '__'));

export async function download(repo, ref = '') {
  const full = cleanRepo(repo);
  const { token } = getSettings().github;
  const res = await fetch(`${API}/repos/${full}/tarball${ref ? `/${encodeURIComponent(ref)}` : ''}`, {
    headers: { 'User-Agent': 'ideax', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`GitHub: download non riuscito (HTTP ${res.status})${token ? '' : '. Se è privato serve un token.'}`);
  const dir = localDir(full);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(REPOS_DIR, `${full.replace('/', '__')}.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  try {
    await run('tar', ['-xzf', archive, '-C', dir, '--strip-components=1']);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  const files = walk(dir);
  return { repo: full, folder: dir, files: files.length, sample: files.slice(0, 60) };
}

function walk(root, rel = '', out = []) {
  if (out.length > 3000) return out;
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, path.join(rel, e.name), out);
    } else out.push(path.join(rel, e.name).replace(/\\/g, '/'));
  }
  return out;
}

function localRoot(repo) {
  const dir = localDir(cleanRepo(repo));
  if (!fs.existsSync(dir)) throw new Error(`"${repo}" non è ancora scaricato sul PC: usa prima github_scarica.`);
  return dir;
}

export function listDownloaded() {
  try {
    return fs.readdirSync(REPOS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name.replace('__', '/'));
  } catch {
    return [];
  }
}

export function localFiles(repo, folder = '') {
  const root = localRoot(repo);
  const files = walk(root).filter((f) => !folder || f.startsWith(folder.replace(/^\/+/, '')));
  return { repo, total: files.length, files: files.slice(0, 300) };
}

export function localRead(repo, filePath) {
  const root = localRoot(repo);
  const full = path.join(root, path.normalize(String(filePath)).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(root) || !fs.existsSync(full)) throw new Error(`File non trovato: ${filePath}`);
  const text = fs.readFileSync(full, 'utf8');
  return { repo, path: filePath, content: text.slice(0, 12000), truncated: text.length > 12000 };
}

export function localSearch(repo, query) {
  const root = localRoot(repo);
  const needle = String(query).toLowerCase();
  const hits = [];
  for (const f of walk(root)) {
    const full = path.join(root, f);
    if (fs.statSync(full).size > 1_000_000) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((l, i) => { if (hits.length < 40 && l.toLowerCase().includes(needle)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`); });
    if (hits.length >= 40) break;
  }
  return hits;
}

// ----- Modifiche (solo se permesse nelle impostazioni) -----

export async function writeFile(repo, filePath, content, message, branch = '') {
  requireWrite();
  const full = cleanRepo(repo);
  const p = String(filePath).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const existing = await gh(`/repos/${full}/contents/${p}${q}`).catch(() => null);
  const r = await gh(`/repos/${full}/contents/${p}`, {
    method: 'PUT',
    body: { message: message || `Aggiorna ${filePath} (da ideax)`, content: Buffer.from(String(content)).toString('base64'), ...(existing?.sha ? { sha: existing.sha } : {}), ...(branch ? { branch } : {}) },
  });
  return { repo: full, path: filePath, commit: r.commit?.html_url, created: !existing };
}

export async function createBranch(repo, branch, from = '') {
  requireWrite();
  const full = cleanRepo(repo);
  const base = from || (await gh(`/repos/${full}`)).default_branch;
  const ref = await gh(`/repos/${full}/git/ref/heads/${encodeURIComponent(base)}`);
  await gh(`/repos/${full}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });
  return { repo: full, branch, from: base };
}

export async function createIssue(repo, title, body = '') {
  requireWrite();
  const r = await gh(`/repos/${cleanRepo(repo)}/issues`, { method: 'POST', body: { title, body } });
  return { number: r.number, url: r.html_url };
}

export async function comment(repo, number, body) {
  requireWrite();
  const r = await gh(`/repos/${cleanRepo(repo)}/issues/${Number(number)}/comments`, { method: 'POST', body: { body } });
  return { url: r.html_url };
}

export async function createPullRequest(repo, title, head, base = '', body = '') {
  requireWrite();
  const full = cleanRepo(repo);
  const target = base || (await gh(`/repos/${full}`)).default_branch;
  const r = await gh(`/repos/${full}/pulls`, { method: 'POST', body: { title, head, base: target, body } });
  return { number: r.number, url: r.html_url };
}
