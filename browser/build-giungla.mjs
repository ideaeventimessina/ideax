import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./giungla3d.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../public/giungla3d.bundle.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'inline',
  loader: { '.webp': 'dataurl' },
});
