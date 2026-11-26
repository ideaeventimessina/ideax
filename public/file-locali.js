const get = id => document.getElementById(id);
const file = get('percorso');
const prima = get('prima');
const dopo = get('dopo');
const stato = get('stato');
const conferma = get('conferma');
const buttons = ['apri', 'proponi', 'anteprima', 'analizza', 'proponi-progetto', 'intervento'].map(get);
let attesa = null;

function invalida() {
  attesa = null;
  get('anteprima-progetto').replaceChildren();
  conferma.disabled = true;
}
file.addEventListener('input', invalida);
dopo.addEventListener('input', invalida);
get('richiesta').addEventListener('input', invalida);
get('test-progetto').addEventListener('input', invalida);

async function richiesta(azione, body) {
  const response = await fetch('/api/file-locali/' + azione, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-IDEAX-File-UI': '1' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function esegui(work) {
  invalida();
  buttons.forEach(b => { b.disabled = true; });
  const fields = [file, dopo, cartella, get('richiesta'), get('test-progetto')];
  fields.forEach(f => { f.readOnly = true; });
  elenco.disabled = true;
  stato.textContent = 'In corso…';
  try { await work(); }
  catch (err) { stato.textContent = err.message; }
  finally {
    buttons.forEach(b => { b.disabled = false; });
    fields.forEach(f => { f.readOnly = false; });
    elenco.disabled = false;
  }
}
function mostra(p) {
  file.value = p.file;
  prima.value = p.before;
  dopo.value = p.after;
  get('motivo').textContent = p.motivo || '';
  attesa = p;
  conferma.disabled = false;
  stato.textContent = 'Anteprima pronta per ' + p.file + '. Validità 10 minuti.';
}

get('apri').onclick = () => esegui(async () => {
  const result = await richiesta('apri', { file: file.value.trim() });
  file.value = result.file;
  prima.value = dopo.value = result.text;
  stato.textContent = 'File aperto.';
});
get('proponi').onclick = () => esegui(async () => mostra(await richiesta('proponi', {
  file: file.value.trim(), instruction: get('richiesta').value,
})));
get('anteprima').onclick = () => esegui(async () => mostra(await richiesta('anteprima', {
  file: file.value.trim(), text: dopo.value,
})));
conferma.onclick = () => {
  const p = attesa;
  if (p?.changes) {
    if (!window.confirm('Applicare tutte le modifiche mostrate ed eseguire: ' + p.tests.join(', ') + '?')) return;
    esegui(async () => {
      stato.textContent = 'Applico le modifiche approvate e avvio i test…';
      const result = await richiesta('progetto/applica', { id: p.id, confirmed: true });
      get('test-esito').textContent = result.output + '\n' + result.written.map(f => f.backup).join('\n');
      if (result.repair) {
        mostraIntervento(result.repair);
        return;
      }
      stato.textContent = result.passed
        ? 'Test superato. ' + (result.remembered ? 'Metodo salvato.' : 'Salvataggio del metodo non riuscito.')
        : result.remaining.length
          ? 'Test o scrittura falliti. Da ripristinare dai backup: ' + result.remaining.join(', ')
          : 'Test o scrittura falliti. Originali ripristinati.' +
            (result.repairError ? ' Correzione non pronta: ' + result.repairError : '');
    });
    return;
  }
  if (!p || !window.confirm('Applicare la modifica mostrata a questo file?\n' + p.file)) return;
  esegui(async () => {
    const result = await richiesta('conferma', { id: p.id, confirmed: true });
    prima.value = dopo.value;
    stato.textContent = 'Salvato. Copia di sicurezza: ' + result.backup;
  });
};


let progetto = null;
const elenco = get('progetto-file');
const cartella = get('cartella');
cartella.addEventListener('input', () => { progetto = null; elenco.replaceChildren(); get('collegamenti').textContent = ''; invalida(); });
elenco.addEventListener('change', () => {
  invalida();
  const f = progetto?.files.find(f => f.file === elenco.value);
  const entranti = progetto?.files.filter(x => x.links.includes(f?.file)).map(x => x.file) || [];
  get('collegamenti').textContent = f ? ('Dipende da: ' + (f.links.join(', ') || '—') +
    ' · Usato da: ' + (entranti.join(', ') || '—')) : '';
});
get('analizza').onclick = () => esegui(async () => {
  progetto = await richiesta('progetto', { folder: cartella.value.trim() });
  elenco.replaceChildren(...progetto.files.map(f => {
    const option = new Option(f.file + (f.read ? '' : ' · solo inventario'), f.file);
    option.disabled = !f.read;
    return option;
  }));
  elenco.dispatchEvent(new Event('change'));
  stato.textContent = progetto.files.length + ' file censiti, ' + progetto.files.filter(f => f.read).length +
    ' letti, ' + progetto.skipped.length + ' percorsi esclusi.';
});
get('proponi-progetto').onclick = () => esegui(async () => {
  if (!progetto || !elenco.value) throw new Error('Analizza il progetto e seleziona un file.');
  const result = await richiesta('progetto/proponi', {
    folder: progetto.root, selected: elenco.value, instruction: get('richiesta').value,
  });
  mostra(result);
});

get('intervento').onclick = () => esegui(async () => {
  get('test-esito').textContent = '';
  const proposal = await richiesta('progetto/intervento', {
    folder: cartella.value.trim(), instruction: get('richiesta').value, test: get('test-progetto').value.trim(),
  });
  mostraIntervento(proposal);
});

function mostraIntervento(proposal) {
  const panel = get('anteprima-progetto');
  const plan = document.createElement('p');
  plan.textContent = 'Obiettivo: ' + proposal.obiettivo;
  const tests = document.createElement('p');
  tests.textContent = 'Test dopo conferma: node --test ' + proposal.tests.join(' ');
  panel.append(plan, tests);
  if (proposal.memoria) {
    const memory = document.createElement('p');
    memory.textContent = (proposal.memoria.stessoProgetto ? 'Metodo recuperato per questo progetto: ' : 'Metodo recuperato da un altro progetto: ') + proposal.memoria.testo;
    panel.append(memory);
  }
  for (const change of proposal.changes) {
    const section = document.createElement('details');
    section.open = true;
    const heading = document.createElement('summary');
    heading.textContent = change.relative;
    const diff = change.differenza;
    const details = document.createElement('p');
    details.textContent = 'Dalla riga ' + diff.line + ', blocco originale di ' + diff.beforeCount +
      ' righe → blocco proposto di ' + diff.afterCount + ' righe.';
    section.append(heading, details);
    if (!change.replacements.length) {
      const excerpt = document.createElement('pre');
      excerpt.textContent = [...diff.before.map(line => '− ' + line), ...diff.after.map(line => '+ ' + line)].join('\n');
      section.append(excerpt);
    }
    for (const replacement of change.replacements) {
      const excerpt = document.createElement('pre');
      excerpt.style.whiteSpace = 'pre-wrap';
      excerpt.textContent = (replacement.occorrenze > 1 ? replacement.occorrenze + ' occorrenze\n' : '') +
        '− ' + replacement.prima + '\n+ ' + replacement.dopo;
      section.append(excerpt);
    }
    for (const [label, content] of [['Originale', change.before], ['Proposta', change.after]]) {
      const field = document.createElement('label');
      field.textContent = label;
      const view = document.createElement('textarea');
      view.value = content;
      view.readOnly = true;
      view.rows = 7;
      field.append(view);
      section.append(field);
    }
    panel.append(section);
  }
  attesa = proposal;
  conferma.disabled = false;
  stato.textContent = proposal.isRepair
    ? 'Test fallito. Originali ripristinati. Correzione pronta da confermare.'
    : 'Anteprima pronta. Controlla le modifiche e il test prima di confermare.';
}
