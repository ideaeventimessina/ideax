/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// La busta della posta interna, oro/ambra come in Bill e Jarvis. Qui si legge soltanto.
// All'avvio non chiama nessuno e non ha giri a orologio (terrebbero accese le app online, e si paga): si controlla
// quando si usa ideax (un clic, un tasto, si torna sulla finestra), al massimo ogni cinque minuti. Testi e nomi entrano solo come testo, mai come HTML.
(() => {
  const NON_PRIMA_DI_MS = 5 * 60_000;
  let ultimo = 0;
  let stato = null;

  const nodo = (tag, classe, testo) => {
    const n = document.createElement(tag);
    if (classe) n.className = classe;
    if (testo != null) n.textContent = testo;
    return n;
  };

  const radice = nodo('div', 'pi');
  const busta = nodo('button', 'pi-busta');
  busta.type = 'button';
  busta.hidden = true;
  busta.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.5 8l8.5 5.5L20.5 8"/></svg>';
  const conta = nodo('span', 'pi-conta');
  busta.append(conta);

  const velo = nodo('div', 'pi-velo');
  const cassetto = nodo('aside', 'pi-cassetto');
  cassetto.setAttribute('role', 'dialog');
  cassetto.setAttribute('aria-modal', 'true');
  cassetto.setAttribute('aria-label', 'Lo spazio nostro');
  const testa = nodo('div', 'pi-testa');
  const titoli = nodo('div');
  const sotto = nodo('div', 'pi-sotto');
  titoli.append(nodo('div', 'pi-titolo', 'Lo spazio nostro'), sotto);
  const chiudi = nodo('button', 'pi-x', '✕');
  chiudi.type = 'button';
  chiudi.setAttribute('aria-label', 'Chiudi');
  testa.append(titoli, chiudi);
  const corpo = nodo('div', 'pi-corpo');
  cassetto.append(testa, corpo, nodo('div', 'pi-piede', 'Qui si legge soltanto. Per rispondere: Bill o il gestionale.'));
  velo.hidden = cassetto.hidden = true;
  radice.append(busta, velo, cassetto);

  function quando(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'poco fa';
    if (s < 3600) return `${Math.round(s / 60)} min fa`;
    if (s < 86400) return `${Math.round(s / 3600)} h fa`;
    const g = Math.round(s / 86400);
    return g === 1 ? 'ieri' : `${g} giorni fa`;
  }

  function disegnaMail(m) {
    const nota = nodo('article', m.letta ? 'pi-nota' : 'pi-nota nuova');
    const capo = nodo('header');
    capo.append(nodo('b', '', m.da));
    if (m.ambito !== 'persona') capo.append(nodo('span', 'pi-tag', m.ambito === 'tutti' ? 'a tutti' : 'al settore'));
    if (m.richiesta) capo.append(nodo('span', 'pi-tag', 'richiesta'));
    capo.append(nodo('time', '', quando(m.quando)));
    nota.append(capo);
    if (m.testo) nota.append(nodo('p', '', m.testo));
    if (m.richiesta) nota.append(nodo('p', 'pi-richiesta', `🗓️ ${m.richiesta}`));
    for (const l of m.link || []) {
      if (!/^https:\/\//i.test(l.url || '')) continue;
      const a = nodo('a', '', `🔗 ${l.nome}`);
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      nota.append(a);
    }
    return nota;
  }

  function disegna() {
    busta.hidden = !stato?.configurata || !cassetto.hidden;
    if (!stato?.configurata) return;
    const nuove = stato.nonLette || 0;
    conta.textContent = stato.errore ? '!' : nuove > 99 ? '99+' : String(nuove);
    conta.hidden = !stato.errore && !nuove;
    busta.setAttribute('aria-label', `Posta interna${nuove ? `, ${nuove} non lette` : ''}${stato.errore ? ', da controllare' : ''}`);
    sotto.textContent = nuove ? `${nuove} da leggere` : 'posta interna';
    corpo.replaceChildren();
    if (stato.errore) {
      const nota = nodo('div', 'pi-nota', `${stato.errore} `);
      nota.setAttribute('role', 'alert');
      const riprova = nodo('button', 'pi-riprova', 'Riprova');
      riprova.type = 'button';
      riprova.onclick = () => leggi();
      nota.append(riprova);
      corpo.append(nota);
    } else if (!stato.mail?.length) corpo.append(nodo('div', 'pi-vuoto', 'Nessun messaggio.'));
    else corpo.append(...stato.mail.map(disegnaMail));
  }

  async function leggi() {
    ultimo = Date.now();
    try {
      const r = await fetch('/api/posta-interna');
      // Da un altro dispositivo la posta non si mostra (403): la busta semplicemente non c'è.
      stato = r.ok ? await r.json() : null;
    } catch { return; }
    disegna();
  }

  function seServe() {
    if (document.visibilityState === 'visible' && Date.now() - ultimo >= NON_PRIMA_DI_MS) leggi();
  }

  function apri(si) {
    velo.hidden = cassetto.hidden = !si;
    disegna();
    if (si) { chiudi.focus({ preventScroll: true }); leggi(); } else busta.focus();
  }

  busta.onclick = () => apri(true);
  chiudi.onclick = velo.onclick = () => apri(false);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !cassetto.hidden) apri(false); });
  for (const n of ['pointerdown', 'keydown', 'focus']) window.addEventListener(n, seServe);
  document.addEventListener('visibilitychange', seServe);
  document.body.append(radice);
})();
