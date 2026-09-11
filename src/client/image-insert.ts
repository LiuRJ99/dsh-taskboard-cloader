import type { AttachmentUpload } from '../shared/api.ts'

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const TYPES = new Set(IMAGE_ACCEPT.split(','))

/** Keep Markdown alt text single-line and unable to close its own bracket. */
export function imageAlt(fileName: string, fallback: string): string {
  const withoutExtension = fileName.replace(/\.(?:png|jpe?g|gif|webp)$/i, '')
  const clean = withoutExtension.replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > 0 ? clean.slice(0, 120) : fallback
}

export function imageMarkdown(asset: AttachmentUpload, alt: string): string {
  return `![${alt}](${asset.url})`
}

/** Insert a block at the current selection, preserving readable line boundaries. */
export function insertImageMarkdown(value: string, start: number, end: number, markdown: string): { value: string; cursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
  const suffix = after.length > 0 && !after.startsWith('\n') ? '\n' : ''
  const inserted = `${prefix}${markdown}${suffix}`
  return { value: before + inserted + after, cursor: before.length + inserted.length }
}

export function acceptedImageFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter(file => TYPES.has(file.type)).slice(0, 10)
}
