import { defineConfig } from 'vite';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function copyRuntimeAssets() {
  return {
    name: 'copy-runtime-assets',
    closeBundle() {
      mkdirSync('dist/terrain', { recursive: true });
      cpSync('terrain/src', 'dist/terrain/src', { recursive: true });
      cpSync('terrain/public', 'dist/terrain/public', {
        recursive: true,
        filter: source => !/(?:^|[/\\])(?:tiles|imagery|atlas-candidates)(?:[/\\]|$)/.test(source)
          && !source.endsWith('treepoints.bin'),
      });
      cpSync('sw-tiles.js', 'dist/sw-tiles.js');
      writeFileSync(resolve('dist/.nojekyll'), '');
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    // Vite resolves the package imports used by the r184 module entry point. Keep serve.py on
    // :8123 as the screenshot inbox and proxy only capture POSTs to it.
    proxy: {
      '/shot': {
        target: 'http://localhost:8123',
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: 'index.html',
        experience: 'grand-teton-3d.html',
      },
    },
  },
  plugins: [copyRuntimeAssets()],
});
