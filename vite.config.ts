import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
const root = resolve(__dirname, 'public');
const input = Object.fromEntries(
  readdirSync(root).filter(file => file.endsWith('.html')).map(file => [file.replace(/\.html$/, ''), resolve(root, file)])
);
export default defineConfig({ root: 'public', build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { input } } });
