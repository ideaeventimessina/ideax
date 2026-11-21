// Test end-to-end dell'anello di autopotenziamento, con un cervello FINTO (server OpenAI locale).
// Prova per davvero: avvia → studio → pronto → conferma → registra a caldo → esegui → fatto, con python3.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-test-'));
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
process.env.IDEAX_HOME = HOME;
process.env.IDEAX_NO_OPEN = '1';

// La skill che il "cervello" consegna: legge richiesta, conta le parole e risponde. Risultato verificabile.
const SKILL_PY = [
  'import sys, json',
  'try:',
  '    d = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)',
  'except Exception:',
  '    d = {}',
  'r = d.get("richiesta", "")',
  'print(json.dumps({"risposta": f"Ho contato {len(r.split())} parole nella richiesta.", "parole": len(r.split())}, ensure_ascii=False))',
].join('\n');

const RISPOSTA_CERVELLO = {
  nome: 'Conta parole',
  descrizione: 'Conta quante parole ci sono nel testo passato.',
  args: [{ nome: 'richiesta', descrizione: 'il testo da analizzare' }],
  codice_python: SKILL_PY,
  come_si_usa: '{"richiesta":"ciao come stai"}',
};

// Finto server compatibile OpenAI: a /v1/chat/completions risponde col JSON della skill.
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(RISPOSTA_CERVELLO) } }] }));
  });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const porta = fake.address().port;

// Impostazioni: usa il cervello "server" (il nostro finto).
fs.writeFileSync(path.join(HOME, 'data', 'settings.json'),
  JSON.stringify({ brain: { mode: 'server', serverUrl: `http://127.0.0.1:${porta}/v1`, serverModel: 'finto' } }, null, 2));

const autopotenzia = await import('../lib/autopotenzia.js');
const skills = await import('../lib/skills.js');

function esci(ok, msg) { console.log(ok ? `✅ ${msg}` : `❌ ${msg}`); if (!ok) { fake.close(); process.exit(1); } }

// 1) avvia
let v = autopotenzia.avvia('contare le parole di una frase');
esci(v.stato === 'studio', `avviato (stato=${v.stato}, id=${v.id})`);

// 2) attendi lo studio fino a "pronto"
let giri = 0;
while (v.stato === 'studio' && giri++ < 60) { await new Promise((r) => setTimeout(r, 500)); v = autopotenzia.stato(v.id); }
if (v.stato !== 'pronto') { console.log('log:', JSON.stringify(v.log?.slice(-5))); }
esci(v.stato === 'pronto', `studio concluso → pronto (skill="${v.skill?.nome}")`);
esci(!!v.inAttesa, 'il cancello è attivo (inAttesa=true): aspetta la conferma');

// 3) la skill NON è ancora attiva prima della conferma
esci(!skills.esiste(v.skill.slug), 'prima della conferma la skill NON è registrata (giusto: serve il tuo sì)');

// 4) conferma (il tocco) → registra a caldo → esegui
v = await autopotenzia.conferma(v.id, true);
esci(v.stato === 'fatto', `confermato → eseguito (stato=${v.stato})`);
esci(v.attivata === true, 'la skill è stata attivata a caldo');
esci(skills.esiste(v.skill.slug), 'ora la skill è nel registro (caricata senza riavviare)');
esci(/parole/i.test(String(v.risultato)), `ha dato un risultato reale: ${String(v.risultato).replace(/\n/g, ' ').slice(0, 120)}`);

// 5) richiamo diretto della skill imparata (la ricorsione: la volta dopo si usa, non si re-impara)
const r = await skills.esegui(v.skill.slug, { richiesta: 'una due tre quattro cinque' });
esci(r.ok && r.risultato?.parole === 5, `richiamo diretto skill: ${JSON.stringify(r.risultato)}`);

// 6) rifiuto su un altro giro: la skill resta proposta, non si attiva
let v2 = autopotenzia.avvia('un altro obiettivo di prova qualsiasi');
giri = 0; while (v2.stato === 'studio' && giri++ < 60) { await new Promise((r) => setTimeout(r, 500)); v2 = autopotenzia.stato(v2.id); }
v2 = await autopotenzia.conferma(v2.id, false);
esci(v2.stato === 'rifiutato', 'su "No grazie" il potenziamento resta rifiutato, niente si attiva');

console.log('\n🎉 Anello completo: studio → cancello → conferma → attivazione a caldo → esecuzione → risultati. OK.');
fake.close();
process.exit(0);
