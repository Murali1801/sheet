// Prints the real gzip/brotli size of the minified bundle and fails above the 6 kB budget.
import { readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const file = new URL('../dist/bottom-sheet.min.js', import.meta.url);
const src = readFileSync(file);
const gz = gzipSync(src, { level: 9 }).length;
const br = brotliCompressSync(src).length;
const kb = (n) => (n / 1024).toFixed(2) + ' kB';
console.log(`bottom-sheet.min.js  ${kb(src.length)} min  ${kb(gz)} gzip  ${kb(br)} brotli`);
if (gz > 6 * 1024) {
  console.error('Over the 6 kB gzip budget.');
  process.exit(1);
}
