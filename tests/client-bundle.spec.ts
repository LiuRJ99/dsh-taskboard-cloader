import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * The web client is wrapped after tsdown. Keep one regression at the actual
 * browser bundle boundary: line-prefixing the CJS body changes template
 * literal newlines inside marked and silently changes list/table parsing.
 */
function loadBundledRenderer(): (text: string) => string {
  const bundlePath = new URL('../lib/client.js', import.meta.url)
  const source = readFileSync(bundlePath, 'utf8')
  const probeSource = source.replace(
    'exports.apply = apply;',
    'globalThis.__probeRenderMarkdown = renderMarkdown; exports.apply = apply;',
  )
  expect(probeSource).not.toBe(source)

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
  vm.runInNewContext(probeSource, context)

  expect(registration).toBeDefined()
  const fakeRequire = (specifier: string): unknown => {
    if (specifier === 'react-dom') return { createPortal: (node: unknown) => node }
    if (specifier === 'react-dom/client') return {}
    if (specifier === 'react') return { useState: () => [null, () => {}], useEffect: () => {} }
    if (specifier === 'react/jsx-runtime') return { jsx: () => undefined, jsxs: () => undefined }
    throw new Error(`unexpected bundle dependency: ${specifier}`)
  }
  registration!.factory(fakeRequire)
  return context.__probeRenderMarkdown as (text: string) => string
}

describe('wrapped client bundle', () => {
  it('keeps Mermaid out of the core bundle and emits a separate lazy chunk', () => {
    const core = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const chunk = readFileSync(new URL('../lib/client-mermaid.js', import.meta.url), 'utf8')
    expect(core).not.toContain('globalThis.__dshTaskboardChunks__.mermaid = () => {')
    expect(chunk).toContain('globalThis.__dshTaskboardChunks__.mermaid = () => {')
    expect(chunk.length).toBeGreaterThan(1_000_000)
  })

  it('preserves multiline list labels and every GFM table row', () => {
    const renderMarkdown = loadBundledRenderer()
    const html = renderMarkdown([
      '已完成：',
      '1. 第一项',
      '2. 第二项',
      '',
      '#### 对比',
      '| 维度 | 原解析 | 新解析 |',
      '| --- | --- | --- |',
      '| 输入 | old | new |',
      '| 日期 | old date | new date |',
      '| 单号 | old no | new no |',
      '验证：通过',
    ].join('\n'))

    expect((html.match(/<tr>/g) ?? []).length).toBe(4)
    expect((html.match(/<tbody>/g) ?? []).length).toBe(1)
    expect(html).toContain('验证：通过')
  })
})
