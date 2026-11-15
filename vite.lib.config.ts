import { defineConfig } from 'vite';

// `vite build -c vite.lib.config.ts` -> dist/bottom-sheet.js + dist/physics.js (readable ESM)
// `... --mode min`                   -> dist/bottom-sheet.min.js (one self-contained minified file)
export default defineConfig(({ mode }) => {
  const min = mode === 'min';
  return {
    publicDir: false,
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: !min,
      minify: min,
      sourcemap: !min,
      // Vite keeps whitespace in ES lib output; ask Rolldown for a fully minified file.
      rolldownOptions: min ? { output: { minify: true } } : {},
      lib: {
        entry: (min ? { 'bottom-sheet.min': 'src/bottom-sheet.ts' } : { 'bottom-sheet': 'src/bottom-sheet.ts', physics: 'src/physics.ts' }) as Record<string, string>,
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  };
});
