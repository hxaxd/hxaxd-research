import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const pdf = path.dirname(require.resolve('pdfjs-dist/package.json'));
const destination = path.resolve('public/pdf-assets');
mkdirSync(destination, { recursive: true });
cpSync(path.join(pdf, 'build/pdf.worker.min.mjs'), path.join(destination, 'pdf.worker.min.mjs'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) cpSync(path.join(pdf, directory), path.join(destination, directory), { recursive: true });
