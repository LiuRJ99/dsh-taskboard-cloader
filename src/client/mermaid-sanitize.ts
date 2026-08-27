/**
 * Defense-in-depth sanitization for SVG emitted by Mermaid.
 *
 * Task descriptions, comments, and agent reports are untrusted strings. Mermaid
 * is configured in strict mode as well, but the generated SVG is parsed and
 * scrubbed again before it reaches the only SVG HTML sink below.
 */

/** Elements that must never survive the SVG-to-HTML boundary. */
const STRIP_ELEMENTS = new Set([
  'foreignobject',
  'script',
  'img',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'input',
  'button',
  'form',
  'link',
  'meta',
  'base',
])

/**
 * Keep only a valid SVG root and remove active-content channels.
 * An empty string means that the caller must keep showing the source block.
 */
export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return ''

  let document: Document
  try {
    document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return ''
  }

  if (document.querySelector('parsererror') !== null) return ''
  if (document.documentElement === null || document.documentElement.localName !== 'svg') return ''

  document.querySelectorAll('*').forEach(node => {
    if (STRIP_ELEMENTS.has(node.localName.toLowerCase())) {
      node.remove()
      return
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name.startsWith('@') || name === 'href' || name === 'xlink:href') {
        node.removeAttribute(attribute.name)
      }
    }
  })

  return new XMLSerializer().serializeToString(document.documentElement)
}
