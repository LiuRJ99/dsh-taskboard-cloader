import { mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore, MAX_ASSET_BYTES, ORPHAN_GRACE_MS, detectImage } from '../src/host/assets.ts'
import { imageAlt, imageMarkdown, insertImageMarkdown } from '../src/client/image-insert.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function store(now = Date.now()): Promise<{ root: string; store: AssetStore }> {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-assets-'))
  dirs.push(root)
  return { root, store: new AssetStore(root, () => now) }
}

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('image attachments', () => {
  it('detects supported magic bytes and rejects arbitrary content', () => {
    expect(detectImage(png())?.mime).toBe('image/png')
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff]))?.extension).toBe('jpg')
    expect(detectImage(Buffer.from('GIF89a'))?.extension).toBe('gif')
    expect(detectImage(Buffer.from('RIFFxxxxWEBP'))?.extension).toBe('webp')
    expect(detectImage(Buffer.from('<svg/>'))).toBeUndefined()
  })

  it('deduplicates by content and never accepts path-shaped reads', async () => {
    const h = await store()
    const first = await h.store.put(png(), 'image/png')
    const second = await h.store.put(png(), 'image/png')
    expect(second).toEqual(first)
    expect((await stat(join(h.root, first.name))).size).toBe(png().length)
    expect(await h.store.read('../package.json')).toBeUndefined()
    await expect(h.store.put(Buffer.alloc(MAX_ASSET_BYTES + 1), 'image/png')).rejects.toThrow('1..')
    await expect(h.store.put(png(), 'image/jpeg')).rejects.toThrow('does not match')
  })

  it('cleans only old unreferenced uploads', async () => {
    const now = Date.now() + ORPHAN_GRACE_MS + 1_000
    const h = await store(now)
    const kept = await h.store.put(png(), 'image/png')
    const otherBytes = Buffer.concat([png(), Buffer.from([9])])
    const orphan = await h.store.put(otherBytes, 'image/png')
    const old = new Date(now - ORPHAN_GRACE_MS - 1)
    await utimes(join(h.root, kept.name), old, old)
    await utimes(join(h.root, orphan.name), old, old)
    expect(await h.store.cleanup(`![kept](${kept.url})`)).toBe(1)
    expect(await h.store.read(kept.name)).toBeDefined()
    expect(await h.store.read(orphan.name)).toBeUndefined()
  })

  it('builds safe Markdown and inserts it at the selection', () => {
    const asset = { id: 'a', name: 'a.png', size: 1, url: '/dsh-taskboard/assets/a.png', extension: 'png', mime: 'image/png' } as const
    expect(imageAlt('bad[]\nname.png', 'Image')).toBe('bad name')
    const markdown = imageMarkdown(asset, 'screen')
    expect(insertImageMarkdown('before after', 7, 7, markdown)).toEqual({
      value: `before \n${markdown}\nafter`, cursor: 7 + 1 + markdown.length + 1,
    })
  })
})
