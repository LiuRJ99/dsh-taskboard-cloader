import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/**
 * The core client bundle keeps host-provided modules external and wraps into
 * DSH's __ModuleLoader__ registration format via scripts/wrap-client.mjs.
 */
const coreConfig: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  format: 'cjs',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  external: [/^@deepseek-ai\//, /^react(-dom)?(\/.*)?$/, /^schemastery$/],
  deps: {
    // marked is the normal display-layer runtime dependency and travels in
    // the core bundle rather than requiring another host package.
    alwaysBundle: ['marked'],
    onlyBundle: ['marked'],
  },
  target: 'chrome120',
  minify: false,
  outExtensions: () => ({ js: '.cjs' }),
}

/**
 * Mermaid is deliberately a standalone browser artifact. It is registered in
 * a taskboard-owned global registry and fetched by the detail Markdown view
 * only after a Mermaid fence is found.
 */
const mermaidChunkConfig: UserConfig = {
  entry: { mermaid: 'src/client/chunks/mermaid.ts' },
  format: 'cjs',
  outDir: 'lib',
  platform: 'browser',
  target: 'chrome120',
  clean: false,
  dts: false,
  sourcemap: false,
  external: [],
  noExternal: () => true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    'import.meta.resolve': 'undefined',
  },
  plugins: [mermaidChunkAliases()],
  outputOptions: {
    entryFileNames: 'client-mermaid.js',
    codeSplitting: false,
    banner: 'globalThis.__dshTaskboardChunks__ = globalThis.__dshTaskboardChunks__ || {}; globalThis.__dshTaskboardChunks__.mermaid = () => {',
    footer: 'return module.exports; };',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/**
 * Mermaid's mindmap definition imports the bare uuid specifier. Pin it to the
 * browser implementation so the chunk never pulls node:crypto into the page.
 */
function mermaidChunkAliases(): NonNullable<UserConfig['plugins']> {
  const mermaidRoot = dirname(require.resolve('mermaid/package.json'))
  const uuidRoot = dirname(require.resolve('uuid/package.json', { paths: [mermaidRoot] }))
  const uuidBrowserEntry = join(uuidRoot, 'dist/index.js')
  return {
    name: 'dsh-taskboard-mermaid-uuid-browser-alias',
    resolveId(source: string) {
      return source === 'uuid' ? uuidBrowserEntry : null
    },
  }
}

export default [coreConfig, mermaidChunkConfig] satisfies UserConfig[]
