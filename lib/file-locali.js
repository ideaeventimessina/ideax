import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX = 256 * 1024;
const TTL = 10 * 60_000;
const proposals = new Map();
const textTypes = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sql']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('\\\\') ||
      !textTypes.has(path.extname(file).toLowerCase())) throw new Error('Indica il percorso assoluto di un file di testo locale.');
  const absolute = path.resolve(file);
  const real = fs.realpathSync(absolute);
  if (absolute.toLowerCase() !== real.toLowerCase()) throw new Error('Apri il percorso reale del file.');
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX || stat.nlink > 1) throw new Error('Serve un file di testo singolo fino a 256 KB.');
  const bytes = fs.readFileSync(real);
  if (bytes.length > MAX || bytes.includes(0)) throw new Error('Il file non è un testo supportato.');
  return { real, bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), stat };
}

export function apriFileLocale(file) {
  const { real, text } = readFile(file);
  return { file: real, text };
}

export function anteprimaFileLocale(file, updated) {
  const { real, bytes, text, stat } = readFile(file);
  if (typeof updated !== 'string' || Buffer.byteLength(updated) > MAX || updated.includes('\0')) throw new Error('Testo modificato non valido.');
  if (text === updated) throw new Error('Il testo è identico, non ci sono modifiche.');
  if (path.extname(real).toLowerCase() === '.json') JSON.parse(updated);
  const now = Date.now();
  for (const [key, value] of proposals) if (value.expires < now) proposals.delete(key);
  if (proposals.size >= 64) throw new Error('Troppe anteprime ancora in attesa.');
  const id = crypto.randomUUID();
  const expires = now + TTL;
  const crlf = text.includes('\r\n');
  const output = Buffer.from((bytes.subarray(0, 3).equals(Buffer.from([239,187,191])) ? '\uFEFF' : '') +
    (crlf ? updated.replace(/\r?\n/g, '\r\n') : updated), 'utf8');
  proposals.set(id, { real, output, original: hash(bytes), expires, dev: stat.dev, ino: stat.ino });
  return { id, file: real, before: text, after: updated, expires };
}

export function verificaFileLocale(id) {
  const proposal = proposals.get(id);
  if (!proposal || proposal.expires < Date.now()) throw new Error('Anteprima scaduta o già usata.');
  const { real, bytes, stat } = readFile(proposal.real);
  if (hash(bytes) !== proposal.original || stat.dev !== proposal.dev || stat.ino !== proposal.ino) {
    throw new Error('Il file è cambiato. Riaprilo per una nuova anteprima.');
  }
  return { proposal, real, bytes, stat };
}

export function confermaFileLocale(id, { ripristinabile = false } = {}) {
  const { proposal, real, bytes, stat } = verificaFileLocale(id);
  proposals.delete(id);
  const backup = real + '.ideax-' + id + '.bak';
  const temp = real + '.ideax-' + id + '.tmp';
  try {
    fs.writeFileSync(temp, proposal.output, { flag: 'wx', mode: stat.mode });
    fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, real);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  const result = { file: real, backup };
  if (ripristinabile) Object.defineProperty(result, 'output', { value: proposal.output });
  return result;
}

export function ripristinaFileLocale(saved) {
  const { bytes, stat } = readFile(saved.file);
  if (!bytes.equals(saved.output)) throw Error('Il file è cambiato dopo la scrittura.');
  const temp = saved.backup + '.restore';
  try {
    fs.writeFileSync(temp, fs.readFileSync(saved.backup), { flag: 'wx', mode: stat.mode });
    fs.renameSync(temp, saved.file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
