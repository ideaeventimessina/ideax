import { myRepos, readRemote, repoInfo } from './github.js';

export function letturaGitHub(testo) {
  const text = String(testo || '');
  if (!/\bgithub\b/i.test(text) ||
      !/\b(legg\w*|colleg\w*|apri\w*|guard\w*|consult\w*|mostra\w*|elenc\w*|studia\w*|anali[sz]\w*|acced\w*)\b/i.test(text) ||
      /\b(?:non|evita di)\s+(?:legg\w*|colleg\w*|apri\w*|aprire|acced\w*|consult\w*)\b/i.test(text) ||
      /\b(scrivi\w*|inventa\w*|raccont\w*|pubblica\w*|elimin\w*|cancell\w*|modific\w*|push|commit|carica\w*)\b/i.test(text)) return null;
  const url = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(blob|tree)\/([\w.-]+)\/([^\s?#<>]*))?/i);
  const repo = url ? `${url[1]}/${url[2]}` : text.match(/\b([\w.-]+\/[\w.-]+)\b/)?.[1];
  return { repo: repo?.replace(/(?:\.git|[.]+)$/i, ''), ref: url?.[4], percorso: url?.[5], memorie: /\b(memor\w*|ricord\w*)\b/i.test(text) };
}

export async function risolviLetturaGitHub({ repo, ref, percorso, memorie }) {
  if (!repo) {
    const repos = await myRepos();
    if (!repos.length) return 'GitHub è collegato. Indicami il repository da leggere con il link o con il nome completo proprietario/repository.';
    const pertinenti = memorie ? repos.filter((r) => /\b(memor(?:ia|ie|y)|ricord\w*)\b/i.test(`${r.repo} ${r.description || ''}`)) : repos;
    if (memorie && pertinenti.length === 1) return risolviLetturaGitHub({ repo: pertinenti[0].repo, memorie });
    const titoli = pertinenti.slice(0, 8).map((r) => `- ${r.repo}`).join('\n');
    return titoli
      ? `GitHub è collegato. Quale repository devo leggere?\n\n${titoli}${pertinenti.length > 8 ? '\n\nPuoi indicarmi anche un altro repository con il link completo.' : ''}`
      : 'GitHub è collegato. Mandami il link esatto del repository o del file che contiene le tue memorie.';
  }
  if (percorso) {
    const r = await readRemote(repo, decodeURIComponent(percorso), ref);
    return r.type === 'cartella'
      ? `GitHub · ${r.repo}/${r.path}\n\n${r.items.slice(0, 30).join('\n') || 'Cartella vuota.'}`
      : `GitHub · ${r.repo}/${r.path}\n\n${r.content || 'File vuoto.'}${r.truncated ? '\n\nLettura limitata ai primi 12.000 caratteri.' : ''}`;
  }
  const r = await repoInfo(repo);
  if (memorie) {
    const dir = await readRemote(repo);
    if (dir.items?.includes('📁 .agents')) {
      let indice;
      try { indice = await readRemote(repo, '.agents/memory/MEMORY.md', r.defaultBranch); }
      catch (err) { if (!err.message.startsWith('GitHub: non trovato')) throw err; }
      if (indice?.type === 'file') {
        return `Ho trovato e letto l’indice delle memorie in ${r.repo}.\n\n${indice.content}\n\nFonte: https://github.com/${r.repo}/blob/${r.defaultBranch}/.agents/memory/MEMORY.md`;
      }
    }
    const candidati = dir.items?.filter((x) => /memor|ricord/i.test(x)).slice(0, 10) || [];
    return `Ho aperto ${r.repo} su GitHub. ${candidati.length
      ? 'Quale di questi percorsi contiene le tue memorie?\n\n' + candidati.join('\n')
      : 'Indicami il file delle memorie o incolla il suo link GitHub.'}`;
  }
  return `GitHub · ${r.repo}\n\nRamo predefinito: ${r.defaultBranch || 'non indicato'}.\n\n${r.description || 'Descrizione assente.'}`;
}
