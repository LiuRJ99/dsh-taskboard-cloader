import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * Client-half build: emit the web shell's lazy-CJS registration directly.
 * Host-provided modules (react, @deepseek-ai/*) resolve through the factory's
 * injected require, and module side effects wait until materialization:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...body...; return module.exports } })
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: 'cjs',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  external: [/^@deepseek-ai\//, /^react(-dom)?(\/.*)?$/, /^schemastery$/],
  target: 'chrome120',
  minify: true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    footer: 'return module.exports; } });',
  },
})
