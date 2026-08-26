import { marked, Renderer, type Tokens } from 'marked'

/** Escape every character that can introduce or alter an HTML fragment. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return character
    }
  })
}

/** Only these URL forms are allowed to leave the markdown renderer. */
function safeHref(href: string): string | undefined {
  const value = href.trim()
  if (value.startsWith('#')) return value
  if (/^https?:/i.test(value) || /^mailto:/i.test(value)) return value
  return undefined
}

const SECTION_LABEL = /^(?:已完成|验证|剩余风险)[：:]/
const LIST_ITEM = /^(?:[-+*]|\d+[.)])\s+/u

/** A pipe-delimited row used by the GFM table syntax in task reports. */
function isPipeTableRow(line: string): boolean {
  const value = line.trim()
  return value.length > 1 && value.startsWith('|') && value.endsWith('|')
}

/** The delimiter row that makes the preceding pipe row a GFM table header. */
function isTableDelimiter(line: string): boolean {
  if (!isPipeTableRow(line)) return false
  const cells = line.trim().slice(1, -1).split('|')
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell.trim()))
}

/**
 * Keep small, observed producer-format repairs local to Markdown blocks.
 *
 * Markdown uses blank lines to end a list, while model-generated reports
 * commonly write a section label immediately after the final list item. GFM
 * tables likewise require contiguous rows even though producers sometimes
 * insert blank lines between them. Do not normalize arbitrary newlines: that
 * would change legitimate list continuations and fenced code blocks.
 */
function normalizeMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let fence: { marker: string; length: number } | undefined

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!
      if (fence === undefined) {
        fence = { marker: marker[0]!, length: marker.length }
      } else if (marker[0] === fence.marker && marker.length >= fence.length) {
        fence = undefined
      }
      output.push(line)
      index += 1
      continue
    }
    if (fence !== undefined) {
      output.push(line)
      index += 1
      continue
    }

    // These labels are a display convention used by execution handoffs. A
    // blank line makes their intended top-level block explicit without
    // changing ordinary prose or the semantics of other Markdown labels.
    if (line === line.trimStart() && SECTION_LABEL.test(line.trim())) {
      if (output.length > 0 && output.at(-1)!.trim().length > 0) output.push('')
      output.push(line)
      const next = lines[index + 1]
      if (next !== undefined && LIST_ITEM.test(next.trimStart()) && next.trim().length > 0) output.push('')
      index += 1
      continue
    }

    // Once a valid header/delimiter pair is found, remove only blank lines
    // that sit between pipe rows. A blank after the final row is preserved so
    // the following paragraph remains a separate Markdown block.
    if (isPipeTableRow(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1]!)) {
      output.push(line, lines[index + 1]!)
      index += 2
      let previousWasRow = false
      while (index < lines.length) {
        const row = lines[index]!
        if (isPipeTableRow(row)) {
          output.push(row)
          previousWasRow = true
          index += 1
          continue
        }
        if (row.trim().length === 0 && previousWasRow) {
          let next = index + 1
          while (next < lines.length && lines[next]!.trim().length === 0) next += 1
          if (next < lines.length && isPipeTableRow(lines[next]!)) {
            index = next
            continue
          }
        }
        break
      }
      continue
    }

    output.push(line)
    index += 1
  }

  return output.join('\n')
}

/**
 * Renderer overrides are deliberately kept next to the single HTML sink.
 * Raw HTML is escaped by the html renderer; URL checks are an independent
 * safety boundary for link and image tokens.
 */
const defaultRenderer = new Renderer()
const renderer = new Renderer()
renderer.html = function ({ text }: Tokens.HTML | Tokens.Tag) {
  return escapeHtml(text)
}
renderer.code = function ({ text, lang }: Tokens.Code) {
  const language = lang !== undefined && lang.length > 0
    ? ` class="language-${escapeHtml(lang)}"`
    : ''
  return `<pre><code${language}>${escapeHtml(text)}\n</code></pre>\n`
}
renderer.codespan = function ({ text }: Tokens.Codespan) {
  return `<code>${escapeHtml(text)}</code>`
}
renderer.table = function (token: Tokens.Table) {
  // Keep table layout semantics intact and put scrolling on a wrapper. A
  // block-level <table> makes the browser split column sizing across thead /
  // tbody, which is the source of clipped or apparently missing cells.
  return `<div class="dsh-atb-md-table-wrap">${defaultRenderer.table.call(this, token)}</div>`
}
renderer.link = function ({ href, title, tokens }: Tokens.Link) {
  const content = this.parser.parseInline(tokens)
  const safe = safeHref(href)
  if (safe === undefined) return content

  let output = `<a href="${escapeHtml(safe)}"`
  if (title !== undefined && title !== null) output += ` title="${escapeHtml(title)}"`
  if (!safe.startsWith('#')) output += ' target="_blank" rel="noopener noreferrer"'
  output += '>'
  return `${output}${content}</a>`
}
renderer.image = function ({ href, title, text, tokens }: Tokens.Image) {
  const alt = tokens !== undefined
    ? this.parser.parseInline(tokens, this.parser.textRenderer)
    : text
  const safe = safeHref(href)
  // Unsafe images are rendered as their alt text rather than an empty or
  // attacker-controlled src, matching the unsafe-link behavior above.
  if (safe === undefined) return alt

  let output = `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}"`
  if (title !== undefined && title !== null) output += ` title="${escapeHtml(title)}"`
  return `${output}>`
}

/**
 * Convert untrusted task text to display-only markdown HTML.
 * `async: false` is part of the contract: renderMarkdown always returns a
 * string and never exposes a Promise to the component.
 */
export function renderMarkdown(text: string): string {
  return marked.parse(normalizeMarkdown(text), {
    gfm: true,
    breaks: true,
    async: false,
    renderer,
  })
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const classes = ['dsh-atb-md', className].filter(Boolean).join(' ')
  // SECURITY CONTRACT: renderMarkdown is the only producer allowed to reach
  // this dangerouslySetInnerHTML sink. It escapes raw HTML tokens and applies
  // URL scheme checks in the renderer above. Do not bypass this path.
  return <div className={classes} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}
