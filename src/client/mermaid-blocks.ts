/**
 * CommonMark-aware detection for Mermaid fenced code blocks.
 *
 * The taskboard keeps the whole Markdown document on one marked pass. This
 * module only answers whether that document needs the asynchronous Mermaid
 * enhancement; it never splits or rewrites the source used by marked.
 */

/** CommonMark opening fence: 0-3 spaces + 3+ backticks or tildes. */
export const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/** CommonMark closing fence: same character, at least as long, no info text. */
export const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** Parse the first info word after an opening fence. */
export function fenceInfo(rest: string, fence: string): string | undefined {
  const info = rest.trimStart().split(/\s+/u)[0] ?? ''
  // Backtick info strings cannot contain another backtick.
  if (fence[0] === '`' && info.includes('`')) return undefined
  return info
}

/** True for `mermaid` and Mermaid's optional directive suffix form. */
function isMermaidInfo(info: string): boolean {
  const normalized = info.toLowerCase()
  return normalized === 'mermaid' || normalized.startsWith('mermaid{')
}

/**
 * Return whether text contains a Mermaid fence outside another fenced block.
 * This deliberately follows the same fence rules as marked closely enough to
 * avoid loading the heavy runtime for ordinary code examples.
 */
export function hasMermaidFence(text: string): boolean {
  if (text.length === 0) return false
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const opening = OPEN_FENCE_RE.exec(line)
    if (opening === null) {
      index += 1
      continue
    }
    const fence = opening[1]!
    const rest = line.slice(opening[0].length)
    const info = fenceInfo(rest, fence)
    if (info === undefined || !isMermaidInfo(info)) {
      // Skip the entire ordinary fenced block so a Mermaid-looking line
      // nested inside a code sample cannot trigger the heavy runtime.
      const char = fence[0]!
      const length = fence.length
      index += 1
      while (index < lines.length) {
        const closing = CLOSE_FENCE_RE.exec(lines[index] ?? '')
        if (closing !== null && closing[1]![0] === char && closing[1]!.length >= length) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    return true
  }
  return false
}
