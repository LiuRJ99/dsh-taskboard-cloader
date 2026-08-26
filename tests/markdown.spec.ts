// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { escapeHtml, renderMarkdown } from '../src/client/markdown.tsx'

function domFor(html: string): Document {
  const document = globalThis.document.implementation.createHTMLDocument('markdown')
  document.body.innerHTML = html
  return document
}

describe('markdown display renderer', () => {
  it('escapes raw HTML without disabling Markdown parsing', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')

    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('does not double-escape literal characters inside inline or fenced code', () => {
    const literal = `& < > "'`
    const inline = renderMarkdown(`\`${literal}\``)
    const fenced = renderMarkdown(['```', literal, '```'].join('\n'))

    expect(inline).toContain('<code>&amp; &lt; &gt; &quot;&#39;</code>')
    expect(inline).not.toContain('&amp;amp;')
    expect(fenced).toContain('<pre><code>&amp; &lt; &gt; &quot;&#39;')
    expect(fenced).not.toContain('&amp;amp;')
  })

  it('preserves link and image titles and query-string ampersands', () => {
    const html = renderMarkdown('[docs](https://example.com/a?x=1&y=2 "API docs")\n\n![logo](https://example.com/logo.png?size=2 "Brand")')
    const document = domFor(html)
    const link = document.querySelector('a')!
    const image = document.querySelector('img')!

    expect(link.getAttribute('href')).toBe('https://example.com/a?x=1&y=2')
    expect(link.getAttribute('title')).toBe('API docs')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(image.getAttribute('src')).toBe('https://example.com/logo.png?size=2')
    expect(image.getAttribute('title')).toBe('Brand')
  })

  it('drops javascript link hrefs and keeps only the link text', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).toContain('<p>x</p>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href=')
  })

  it('drops unsafe image sources too', () => {
    const html = renderMarkdown('![avatar](data:text/html,alert(1))')
    expect(html).toContain('avatar')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data:text/html')
  })

  it('renders GFM tables and strikethrough', () => {
    const table = renderMarkdown('| Name | Value |\n| --- | --- |\n| A | 1 |')
    expect(table).toContain('<table>')
    expect(table).toContain('<th>Name</th>')
    expect(table).toContain('<td>1</td>')

    expect(renderMarkdown('~~removed~~')).toContain('<del>removed</del>')
  })

  it('keeps all wide-table headers and cells inside a scroll wrapper', () => {
    const html = renderMarkdown([
      '| Dimension | Original | New | Purpose |',
      '| --- | --- | --- | --- |',
      '| Input | ccbFileParser | CcbServiceImpl | consistency check |',
    ].join('\n'))

    expect(html).toContain('<div class="dsh-atb-md-table-wrap"><table>')
    for (const text of ['Dimension', 'Original', 'New', 'Purpose', 'ccbFileParser', 'CcbServiceImpl', 'consistency check']) {
      expect(html).toContain(text)
    }
    expect((html.match(/<th>/g) ?? []).length).toBe(4)
    expect((html.match(/<td>/g) ?? []).length).toBe(4)
  })

  it('keeps blank-separated GFM table rows in one table', () => {
    const html = renderMarkdown([
      '| 维度 | 原解析 | 新解析 |',
      '| --- | --- | --- |',
      '| 输入 | old | new |',
      '',
      '| 日期 | old date | new date |',
      '',
      '| 单号 | old no | new no |',
      '',
      '表格之后的说明。',
    ].join('\n'))
    const document = domFor(html)
    const table = document.querySelector('table')!

    expect(table.querySelectorAll('tbody > tr')).toHaveLength(3)
    expect(table.textContent).toContain('输入')
    expect(table.textContent).toContain('日期')
    expect(table.textContent).toContain('单号')
    expect(table.parentElement?.nextElementSibling?.textContent).toBe('表格之后的说明。')
  })

  it('keeps fenced code and blockquote text in their semantic elements', () => {
    const html = renderMarkdown(['```ts', 'const value = 1', '```', '', '> quote text'].join('\n'))
    expect(html).toContain('<pre><code class="language-ts">const value = 1')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quote text')
  })

  it('supports nested blockquotes after raw HTML handling is isolated', () => {
    const document = domFor(renderMarkdown('> outer\n>> nested'))
    const quotes = document.querySelectorAll('blockquote')

    expect(quotes).toHaveLength(2)
    expect(quotes[0]!.textContent).toContain('outer')
    expect(quotes[1]!.textContent).toContain('nested')
  })

  it('autolinks bare URLs with a safe new-tab relationship', () => {
    const html = renderMarkdown('https://example.com/docs')
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>')
  })

  it('turns a single newline into a line break', () => {
    expect(renderMarkdown('first line\nsecond line')).toContain('<br>')
  })

  it('keeps handoff labels outside the preceding list', () => {
    const document = domFor(renderMarkdown('已完成：\n- A\n- B\n验证：npm test\n剩余风险：无'))
    const list = document.querySelector('ul')!
    const paragraphs = Array.from(document.querySelectorAll('p')).map(p => p.textContent)

    expect(list.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(paragraphs).toEqual(['已完成：', '验证：npm test', '剩余风险：无'])
    expect(list.nextElementSibling?.textContent).toBe('验证：npm test')
  })

  it('keeps ordinary list continuation lines in the same item', () => {
    const document = domFor(renderMarkdown('调研交接：\n1. 第一行\n第二行\n2. 第二项'))
    const items = document.querySelectorAll('ol > li')

    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('第一行')
    expect(items[0]!.textContent).toContain('第二行')
  })

  it('keeps same-document fragment links in the current tab', () => {
    const link = domFor(renderMarkdown('[跳转](#section)')).querySelector('a')!

    expect(link.getAttribute('href')).toBe('#section')
    expect(link.getAttribute('target')).toBeNull()
    expect(link.getAttribute('rel')).toBeNull()
  })

  it('keeps empty input empty and wraps plain text as a paragraph', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('plain text')).toBe('<p>plain text</p>\n')
  })
})
