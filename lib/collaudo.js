import { isDeepStrictEqual } from 'node:util';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';

let engine;

export function preparaCollaudo(spec) {
  if (spec == null) return null;
  if (typeof spec.funzione !== 'string' || !/^[a-zA-Z_$][\w$]{0,63}$/.test(spec.funzione) ||
      !Array.isArray(spec.casi) || spec.casi.length < 1 || spec.casi.length > 20 ||
      !spec.casi.every((c) => c && Array.isArray(c.argomenti) && Object.hasOwn(c, 'atteso')) ||
      Buffer.byteLength(JSON.stringify(spec)) > 16_384) {
    throw new Error('Indica una funzione JavaScript e da 1 a 20 casi JSON con argomenti e atteso.');
  }
  return spec;
}

export async function collauda(codice, { funzione, casi }) {
  engine ??= newQuickJSWASMModuleFromVariant(variant);
  const vm = await engine;
  const runtime = vm.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 300;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const ctx = runtime.newContext();
  let esegui;
  try {
    const evaluate = (source) => ctx.unwrapResult(ctx.evalCode(source, 'collaudo.js', { type: 'global' }));
    esegui = evaluate(`((parse, stringify) => (fn, argomenti) => {
      const risultato = fn(...parse(argomenti));
      if (risultato && typeof risultato.then === 'function') throw new Error('Il risultato deve essere sincrono.');
      return stringify(risultato);
    })(JSON.parse, JSON.stringify)`);
    evaluate(codice + '\n;0').dispose();
    const fn = ctx.getProp(ctx.global, funzione);
    try {
      if (ctx.typeof(fn) !== 'function') return { ok: false, errore: `Manca la funzione globale ${funzione}.` };
      for (const [i, caso] of casi.entries()) {
        const args = ctx.newString(JSON.stringify(caso.argomenti));
        let risultato;
        try {
          const value = ctx.unwrapResult(ctx.callFunction(esegui, ctx.undefined, fn, args));
          try { risultato = ctx.dump(value); } finally { value.dispose(); }
        } finally { args.dispose(); }
        if (typeof risultato !== 'string' || !isDeepStrictEqual(JSON.parse(risultato), caso.atteso)) {
          return { ok: false, errore: `Caso ${i + 1}, input ${JSON.stringify(caso.argomenti).slice(0, 180)}: atteso ${JSON.stringify(caso.atteso).slice(0, 180)}, ottenuto ${String(risultato).slice(0, 180)}.` };
        }
      }
    } finally { fn.dispose(); }
    return { ok: true, casi: casi.length };
  } catch (err) {
    return { ok: false, errore: String(err.message || err).slice(0, 260) };
  } finally {
    esegui?.dispose();
    ctx.dispose();
    runtime.dispose();
  }
}
