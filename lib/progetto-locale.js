import fs from 'node:fs';
import path from 'node:path';
import { apriFileLocale, anteprimaFileLocale } from './file-locali.js';

const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', 'coverage']);
const SOURCES = /\.(?:[cm]?[jt]sx?|py|css|html|json|ya?ml|md|txt)$/i;

export function analizzaProgetto(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.startsWith('\\\\')) {
    throw new Error('Indica il percorso assoluto della cartella progetto.');
  }
  const root = fs.realpathSync(folder);
  if (path.parse(root).root === root || !fs.statSync(root).isDirectory()) throw new Error('Scegli una cartella progetto.');
  const files = [], skipped = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (files.length + skipped.length >= 5000) throw new Error('Progetto troppo esteso: scegli un modulo o una cartella più specifica.');
      if (entry.isSymbolicLink() || IGNORE.has(entry.name) || entry.name.toLowerCase().startsWith('.env')) {
        skipped.push(relative);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      const refs = [];
      let read = false;
      if (SOURCES.test(relative) && stat.size <= 128 * 1024) {
        try {
          const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full));
          if (!source.includes('\0')) {
            read = true;
            for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*|@import\s*|\b(?:src|href)\s*=\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
              refs.push(m[1]);
            }
            if (/\.html$/i.test(relative)) {
              for (const m of source.matchAll(/\b(?:src|href)\s*=\s*['"]([^'":?#]+)['"]/gi)) {
                if (!m[1].startsWith('/') && !m[1].startsWith('.')) refs.push('./' + m[1]);
              }
            }
            if (relative.endsWith('.py')) {
              for (const m of source.matchAll(/^\s*from[ \t]+(\.+)([\w.]*)[ \t]+import\b/gm)) {
                refs.push('../'.repeat(m[1].length - 1) + './' + m[2].replaceAll('.', '/'));
              }
            }
          }
        } catch { /* Il file resta visibile nell’inventario. */ }
      }
      files.push({ file: relative, bytes: stat.size, read, refs });
    }
  };
  walk(root);
  const paths = new Set(files.map(f => f.file));
  const editions = ['','.js','.mjs','.ts','.tsx','.jsx','.py','/index.js','/index.ts','/__init__.py'];
  for (const f of files) {
    const candidates = f.refs.map(ref => path.posix.normalize(path.posix.join(path.posix.dirname(f.file), ref)));
    f.links = [...new Set(candidates.map(c => editions.map(ext => c + ext).find(p => paths.has(p)) ??
      (c.endsWith('.js') && paths.has(c.slice(0, -3) + '.ts') ? c.slice(0, -3) + '.ts' : null)).filter(Boolean))];
    delete f.refs;
  }
  return { root, files, skipped };
}

export async function proponiNelProgetto(folder, selected, instruction, propose) {
  const project = analizzaProgetto(folder);
  const target = project.files.find(f => f.file === selected && f.read);
  if (!target) throw new Error('Seleziona un file di testo letto nel progetto.');
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) throw new Error('Descrivi la modifica richiesta.');
  const candidate = path.join(project.root, target.file);
  const { file, text } = apriFileLocale(candidate);
  if (text.length > 6000) throw new Error('Il file selezionato supera il limite di 6.000 caratteri per la proposta AI.');
  const related = project.files.filter(f => target.links.includes(f.file) || f.links.includes(target.file)).slice(0, 12);
  const contesto = related.map(({file: rel, read}) => {
    let snippet = '';
    if (read) {
      try { snippet = apriFileLocale(path.join(project.root, rel)).text.slice(0, 900); } catch {}
    }
    return { file: rel, snippet };
  });
  const result = await propose({ instruction, target: selected, text, contesto });
  if (apriFileLocale(file).text !== text) throw new Error('Il file è cambiato mentre preparavo la proposta.');
  if (typeof result?.motivo !== 'string' || !result.motivo.trim()) throw new Error('IDEAX non ha spiegato la modifica. Nessuna scrittura eseguita.');
  return { ...anteprimaFileLocale(file, result.text), motivo: result.motivo, collegati: related.map(f => f.file) };
}
