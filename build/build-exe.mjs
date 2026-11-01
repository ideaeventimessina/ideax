// Crea la versione Windows pronta da estrarre: dist/ideax/ (con ideax.exe) e dist/ideax-windows.zip.
// ideax.exe contiene Node.js e tutto il server: sul PC dell'utente non serve installare Node.
// Uso: npm install && npm run build:exe
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';
import * as PE from 'pe-library';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'ideax');
const CACHE = path.join(ROOT, 'build', '.cache');
const NODE_VERSION = process.version; // il blob SEA deve essere creato con la stessa versione di node.exe
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const target = process.argv.includes('--linux') ? 'linux' : 'win';

// Inserisce il blob nell'eseguibile Node (stesso meccanismo per Windows e Linux)
function inject(file) {
  console.log('4/5 Creo l\'eseguibile');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), file, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite',
  ], { stdio: 'inherit' });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// 1. Un unico file JavaScript con server e librerie
console.log('1/5 Unisco il codice del server');
const bundle = path.join(DIST, 'ideax.cjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  define: { __IDEAX_SEA__: 'true', __IDEAX_VERSION__: JSON.stringify(VERSION) },
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});

// 1b. Prova d'avvio: il pacchetto deve restare acceso. Un errore al caricamento (es. import.meta.url, che nel
// pacchetto non esiste) chiude ideax.exe subito e senza finestra: meglio fermare qui la release che farlo scoprire all'utente.
console.log('1b/5 Provo ad avviare il pacchetto');
{
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-prova-'));
  const child = spawn(process.execPath, [bundle], { env: { ...process.env, IDEAX_HOME: home, PORT: '7979', IDEAX_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code ?? 1); });
  });
  if (exited !== null) {
    const log = fs.existsSync(path.join(home, 'data', 'ideax.log')) ? fs.readFileSync(path.join(home, 'data', 'ideax.log'), 'utf8') : '';
    throw new Error(`Il pacchetto si chiude all'avvio (codice ${exited}):\n${(out + log).slice(-3000)}`);
  }
  child.kill();
  console.log('   resta acceso: ok');
}

// 2. Blob per l'eseguibile "single executable application" di Node
console.log('2/5 Preparo il blob dell\'eseguibile');
const blob = path.join(DIST, 'ideax.blob');
const seaConfig = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. node.exe ufficiale della stessa versione
console.log(`3/5 Scarico Node.js ${NODE_VERSION} per ${target === 'win' ? 'Windows' : 'Linux'}`);
let exe;
if (target === 'win') {
  const nodeExe = path.join(CACHE, `node-${NODE_VERSION}-win-x64.exe`);
  if (!fs.existsSync(nodeExe)) {
    const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`);
    if (!res.ok) throw new Error(`Download di node.exe non riuscito: ${res.status}`);
    fs.writeFileSync(nodeExe, Buffer.from(await res.arrayBuffer()));
  }
  exe = path.join(OUT, 'ideax.exe');

  fs.copyFileSync(nodeExe, exe);
  inject(exe);

  // 5. Icona e dati del programma: dopo l'inserimento, perché postject non accetta file già modificati (la firma di node.exe va rimossa: il file viene modificato)
  console.log('5/5 Icona e informazioni del programma');
  const pe = PE.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(pe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')));
  const group = res.entries.find((e) => e.type === 14);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group ? group.id : 1, group ? group.lang : 1033, iconFile.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [major, minor, patch] = VERSION.split('.').map(Number);
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(lang, {
      ProductName: 'ideax',
      FileDescription: 'ideax - studio creativo AI locale',
      CompanyName: 'ideax',
      InternalName: 'ideax',
      OriginalFilename: 'ideax.exe',
      ProductVersion: VERSION,
      FileVersion: VERSION,
      LegalCopyright: 'Contiene Node.js (licenza MIT)',
    });
  }
  vi.setFileVersion(major, minor, patch, 0);
  vi.setProductVersion(major, minor, patch, 0);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  // Programma "a finestre" e non da terminale: all'avvio non compare la finestra nera (i messaggi vanno in data/ideax.log)
  pe.newHeader.optionalHeader.subsystem = 2;
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
} else {
  // Solo per provare l'eseguibile su Linux durante lo sviluppo
  exe = path.join(OUT, 'ideax');
  fs.copyFileSync(process.execPath, exe);
  inject(exe);
  fs.chmodSync(exe, 0o755);
  console.log('5/5 (Linux: nessuna icona)');
}

// File che restano accanto all'eseguibile
for (const dir of ['public', 'worker', 'clients']) fs.cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true, filter: (src) => !src.includes('__pycache__') });
for (const dir of ['models', 'outputs', 'data']) fs.mkdirSync(path.join(OUT, dir), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'build', 'LEGGIMI.txt'), path.join(OUT, 'LEGGIMI.txt'));
fs.writeFileSync(path.join(OUT, 'models', 'METTI-QUI-I-MODELLI.txt'),
  'Puoi trascinare i modelli nella pagina Modelli di ideax, oppure copiarli qui.\r\nideax li riconosce da solo (checkpoint, LoRA, moduli di movimento, cervello .gguf).\r\n');

for (const f of [bundle, blob, seaConfig]) fs.rmSync(f, { force: true });

// Nelle note del rilascio il nome dell'installatore deve avere la versione giusta
const notes = path.join(ROOT, 'build', 'NOVITA.md');
fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace(/ideax-setup-[\d.]+\.exe/g, `ideax-setup-${VERSION}.exe`));

if (target === 'win') {
  const zip = path.join(DIST, 'ideax-windows.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-q', '-9', zip, 'ideax'], { cwd: DIST });
  console.log(`\nVersione portatile: ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);

  // Installatore (serve NSIS: "apt install nsis" su Linux, oppure NSIS per Windows)
  const setup = path.join(DIST, `ideax-setup-${VERSION}.exe`);
  try {
    execFileSync('makensis', ['-V2', `-DVERSION=${VERSION}`, `-DSRC=${OUT}`, `-DOUTFILE=${setup}`, path.join(ROOT, 'build', 'installer.nsi')], { stdio: 'inherit' });
    console.log(`Installatore: ${setup} (${(fs.statSync(setup).size / 1e6).toFixed(0)} MB)`);
  } catch (err) {
    console.log(`Installatore non creato (${err.code === 'ENOENT' ? 'NSIS non installato' : err.message})`);
  }
} else {
  console.log(`\nPronto: ${exe}`);
}
