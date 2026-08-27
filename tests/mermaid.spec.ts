// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { renderMarkdown } from '../src/client/markdown.tsx'
import { MermaidMarkdown } from '../src/client/mermaid.tsx'
import { loadMermaid, setMermaidRuntimeForTests, type MermaidRuntime } from '../src/client/mermaid-chunk-loader.ts'
import { hasMermaidFence } from '../src/client/mermaid-blocks.ts'
import { sanitizeSvg } from '../src/client/mermaid-sanitize.ts'
import { waitFor } from './wait-for.ts'

const roots: Root[] = []

function mount(html: string): HTMLDivElement {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  root.render(React.createElement(MermaidMarkdown, { html, className: 'dsh-atb-md' }))
  return host
}

function fakeRuntime(render: MermaidRuntime['render']): MermaidRuntime {
  return {
    initialize: vi.fn(),
    render,
  }
}

afterEach(async () => {
  // Let the Mermaid enhancement effect settle before the outer test root is
  // unmounted.
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  setMermaidRuntimeForTests(undefined)
  delete (globalThis as { __dshTaskboardChunks__?: unknown }).__dshTaskboardChunks__
  vi.restoreAllMocks()
})

describe('Mermaid fence detection', () => {
  it('recognizes Mermaid fences without matching a nested ordinary code fence', () => {
    expect(hasMermaidFence('~~~MERMAID\nflowchart TD\nA-->B\n~~~')).toBe(true)
    expect(hasMermaidFence('```text\n```mermaid\nA-->B\n```\n```')).toBe(false)
    expect(hasMermaidFence('plain text\n```ts\nconst x = 1\n```')).toBe(false)
  })
})

describe('Mermaid chunk loader', () => {
  it('materializes a registered chunk once without touching the network', async () => {
    const runtime = fakeRuntime(async () => ({ svg: '<svg />' }))
    ;(globalThis as { __dshTaskboardChunks__?: { mermaid?: () => Record<string, unknown> } }).__dshTaskboardChunks__ = {
      mermaid: () => ({ mermaid: runtime }),
    }

    expect(await loadMermaid()).toBe(runtime)
    expect(await loadMermaid()).toBe(runtime)
  })
})

describe('Mermaid SVG sanitization', () => {
  it('keeps valid SVG text while removing active content', () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g onload="x" href="javascript:x"><text>safe</text></g></svg>',
    )
    expect(clean).toContain('<text>safe</text>')
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onload')
    expect(clean).not.toContain('href=')
  })

  it('rejects non-SVG output', () => {
    expect(sanitizeSvg('<div>not svg</div>')).toBe('')
    expect(sanitizeSvg('<svg><broken></svg>')).toBe('')
  })
})

describe('detail Markdown Mermaid enhancement', () => {
  it('replaces a successful Mermaid code block with sanitized SVG', async () => {
    const runtime = fakeRuntime(async (_id, _code) => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
    }))
    setMermaidRuntimeForTests(runtime)
    const host = mount(renderMarkdown('before\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nafter'))

    await waitFor(() => host.querySelector('[data-mermaid-diagram] svg') !== null)
    expect(host.querySelector('[data-mermaid-diagram]')?.textContent).toContain('Rendered')
    expect(host.querySelector('pre')).toBeNull()
    expect(runtime.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
    }))
  })

  it('keeps the original source when Mermaid rendering rejects', async () => {
    const runtime = fakeRuntime(async () => {
      throw new Error('invalid Mermaid syntax')
    })
    setMermaidRuntimeForTests(runtime)
    const source = 'flowchart TD\nA-->'
    const markdown = ['```mermaid', source, '```'].join('\n')
    const host = mount(renderMarkdown(markdown))

    await waitFor(() => host.querySelector('[data-mermaid-state="error"]') !== null)
    expect(host.querySelector('code')?.textContent).toBe(`${source}\n`)
    expect(host.textContent).toContain('Mermaid 渲染失败，已显示源码')
  })

  it('keeps the original source when the rendered SVG is rejected', async () => {
    setMermaidRuntimeForTests(fakeRuntime(async () => ({ svg: '<div>bad</div>' })))
    const source = 'flowchart TD\nA-->B'
    const markdown = ['```mermaid', source, '```'].join('\n')
    const host = mount(renderMarkdown(markdown))

    await waitFor(() => host.querySelector('[data-mermaid-state="error"]') !== null)
    expect(host.querySelector('code')?.textContent).toBe(`${source}\n`)
  })
})
