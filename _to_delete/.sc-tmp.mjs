import { compile } from './node_modules/svelte/src/compiler/index.js';
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  try { const r = compile(readFileSync(f,'utf8'), { filename: f, generate: 'client' }); console.log('OK', f, r.warnings.map(w=>w.code).join(',')); }
  catch (e) { console.log('ERR', f, e.message); }
}
