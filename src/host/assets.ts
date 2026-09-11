/** Durable, content-addressed image attachments for task descriptions/comments. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageQueue } from './storage-queue.ts'

export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export const MAX_ASSET_STORE_BYTES = 200 * 1024 * 1024
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

export type ImageKind = { extension: 'png' | 'jpg' | 'gif' | 'webp'; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
export type StoredAsset = ImageKind & { id: string; name: string; size: number; url: string }

const ASSET_NAME_RE = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/

/** Detect supported images from magic bytes; request MIME and filenames are not trusted. */
export function detectImage(bytes: Uint8Array): ImageKind | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { extension: 'png', mime: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg' }
  }
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString('ascii')
    if (head === 'GIF87a' || head === 'GIF89a') return { extension: 'gif', mime: 'image/gif' }
  }
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mime: 'image/webp' }
  }
  return undefined
}

/** Files live outside the ledger so state/SSE/tool payloads only carry short Markdown URLs. */
export class AssetStore {
  private queue: Promise<unknown> = Promise.resolve()
  private root: string

  constructor(root: string, private readonly now: () => number = () => Date.now(), private readonly storageQueue?: StorageQueue) { this.root = root }

  /** Current absolute attachment-directory path. */
  location(): string { return this.root }

  /** Switch reads and future writes after the coordinator copied the directory. */
  setLocation(root: string): void { this.root = root }

  async put(bytes: Uint8Array, declaredMime?: string): Promise<StoredAsset> {
    const run = () => this.putSerial(bytes, declaredMime)
    if (this.storageQueue !== undefined) return this.storageQueue.run(run)
    return (this.queue = this.queue.then(run, run)) as Promise<StoredAsset>
  }

  private async putSerial(bytes: Uint8Array, declaredMime?: string): Promise<StoredAsset> {
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
      throw new Error(`image must be 1..${MAX_ASSET_BYTES} bytes`)
    }
    const kind = detectImage(bytes)
    if (kind === undefined) throw new Error('unsupported image; use PNG, JPEG, GIF, or WebP')
    if (declaredMime !== undefined && declaredMime.toLowerCase() !== kind.mime) {
      throw new Error(`image content does not match ${declaredMime}`)
    }
    const id = createHash('sha256').update(bytes).digest('hex')
    const name = `${id}.${kind.extension}`
    await mkdir(this.root, { recursive: true })
    try {
      const current = await stat(join(this.root, name))
      if (current.isFile()) return { id, name, size: current.size, url: `/dsh-taskboard/assets/${name}`, ...kind }
    } catch { /* new content */ }

    let total = 0
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !ASSET_NAME_RE.test(entry.name)) continue
      try { total += (await stat(join(this.root, entry.name))).size } catch { /* concurrent cleanup */ }
    }
    if (total + bytes.length > MAX_ASSET_STORE_BYTES) throw new Error('image store quota exceeded')
    try {
      await writeFile(join(this.root, name), bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return { id, name, size: bytes.length, url: `/dsh-taskboard/assets/${name}`, ...kind }
  }

  async read(name: string): Promise<{ bytes: Buffer; mime: ImageKind['mime'] } | undefined> {
    const run = async (): Promise<{ bytes: Buffer; mime: ImageKind['mime'] } | undefined> => {
    const match = ASSET_NAME_RE.exec(name)
    if (match === null) return undefined
    const mime = match[2] === 'png' ? 'image/png'
      : match[2] === 'jpg' ? 'image/jpeg'
        : match[2] === 'gif' ? 'image/gif' : 'image/webp'
    try {
      return { bytes: await readFile(join(this.root, name)), mime }
    } catch { return undefined }
    }
    return this.storageQueue === undefined ? run() : this.storageQueue.run(run)
  }

  /** Remove abandoned draft uploads after a grace period; referenced files always survive. */
  async cleanup(referencedContent: string): Promise<number> {
    const run = async (): Promise<number> => {
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) } catch { return 0 }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !ASSET_NAME_RE.test(entry.name) || referencedContent.includes(entry.name)) continue
      const path = join(this.root, entry.name)
      try {
        const info = await stat(path)
        if (this.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue
        await rm(path, { force: true })
        removed += 1
      } catch { /* best effort */ }
    }
    return removed
    }
    return this.storageQueue === undefined ? run() : this.storageQueue.run(run)
  }
}
