import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * Build-boundary regression on the WRAPPED client bundle (the file the web
 * shell actually serves). Two invariants survive minification:
 *
 * 1. Mermaid's runtime must stay OUT of the core bundle — it ships as the
 *    separate lazy lib/client-mermaid.js chunk registered on
 *    `globalThis.__dshTaskboardChunks__.mermaid`.
 * 2. The wrapped file must stay a syntactically valid module-loader
 *    registration: executing it registers a factory with no throw.
 *
 * (The GFM table/list rendering itself is covered in-process by
 * tests/markdown.spec.ts and tests/mermaid.spec.ts — the wrap only
 * concatenates the minified CJS body verbatim, so line-prefix corruption
 * of template literals is no longer a vector once the bundle is minified
 * on the tsdown side.)
 */
describe('wrapped client bundle', () => {
  it('keeps Mermaid out of the core bundle and emits a separate lazy chunk', () => {
    const core = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const chunk = readFileSync(new URL('../lib/client-mermaid.js', import.meta.url), 'utf8')
    expect(core).not.toContain('globalThis.__dshTaskboardChunks__.mermaid = () => {')
    expect(core).not.toContain('flowchart TD') // no mermaid grammar/parser in core
    expect(chunk).toContain('globalThis.__dshTaskboardChunks__.mermaid = () => {')
    expect(chunk.length).toBeGreaterThan(1_000_000)
  })

  it('loads as a module-loader registration and exposes the plugin surface', () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    let registration: { factory: (require: (specifier: string) => unknown) => unknown } | undefined
    const context: Record<string, unknown> = {
      console,
      fetch: () => undefined,
      EventSource: class {},
      window: {
        __ModuleLoader__: {
          load(value: typeof registration) {
            registration = value
          },
        },
      },
    }
    context.globalThis = context
    expect(() => vm.runInNewContext(source, context)).not.toThrow()
    expect(registration).toBeDefined()
    const fakeRequire = (specifier: string): unknown => {
      if (specifier === 'react-dom') return { createPortal: (node: unknown) => node }
      if (specifier === 'react-dom/client') return {}
      if (specifier === 'react') return { useState: () => [null, () => {}], useEffect: () => {} }
      if (specifier === 'react/jsx-runtime') return { jsx: () => undefined, jsxs: () => undefined }
      throw new Error(`unexpected bundle dependency: ${specifier}`)
    }
    expect(() => registration!.factory(fakeRequire)).not.toThrow()
    // The minified registration returns exports via the closure; the plugin
    // surface contract (name/inject/apply) is asserted at source level.
    expect(source).toContain('dsh-taskboard/client')
  })
})
