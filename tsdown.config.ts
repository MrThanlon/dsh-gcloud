/**
 * Build configuration, mirroring the official packages: a Host half compiled to
 * ESM with declarations, and a browser half compiled to CommonJS that
 * `scripts/wrap-client.mjs` turns into a `window.__ModuleLoader__` bundle.
 *
 * The Host bundle inlines the schema validator it needs (a linked bundle cannot
 * resolve the harness installation's packages) and keeps Node builtins
 * external; the browser bundle keeps React external, because the shell's module
 * table supplies it.
 */
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: true,
    clean: true,
    sourcemap: false,
    deps: { neverBundle: [/^node:/] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    outDir: 'lib/.client',
    dts: false,
    clean: true,
    sourcemap: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime'] },
    define: { 'process.env.NODE_ENV': '"production"' },
  },
])
