import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetStore } from '../src/host/assets.ts'
import { StorageCoordinator, STORAGE_CONFIG_FILE } from '../src/host/storage.ts'
import { TaskStore } from '../src/host/store.ts'
import { TemplateStore } from '../src/host/templates.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-storage-'))
  const home = join(root, 'home')
  const storage = new StorageCoordinator({
    defaultDirectory: home,
    configFile: join(home, STORAGE_CONFIG_FILE),
    ledgerName: 'dsh-taskboard.json',
    templatesName: 'dsh-taskboard-templates.json',
    assetsName: 'dsh-taskboard-assets',
  })
  const ledger = new TaskStore({ file: storage.ledgerPath(), queue: storage.queue })
  const templates = new TemplateStore(storage.templatesPath(), storage.queue)
  const assets = new AssetStore(storage.assetsPath(), () => Date.now(), storage.queue)
  storage.attach({ ledger, templates, assets })
  await storage.ready()
  await ledger.load()
  return { root, home, storage, ledger, templates, assets }
}

describe('configurable taskboard storage', () => {
  it('moves ledger, templates, and assets, then boots from the fixed pointer', async () => {
    const f = await fixture()
    await f.ledger.mutate('settings-updated', ledger => {
      ledger.settings = { syncExternalSessions: true }
      return []
    })
    expect((await f.templates.list()).length).toBeGreaterThan(0)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await f.assets.put(png, 'image/png')
    const target = join(f.root, 'moved')

    const moved = await f.storage.migrate(target)
    expect(moved.migrated).toBe(true)
    expect(moved.currentDirectory).toBe(target)
    expect(JSON.parse(await readFile(join(target, 'dsh-taskboard.json'), 'utf8')).settings.syncExternalSessions).toBe(true)
    expect(JSON.parse(await readFile(join(target, 'dsh-taskboard-templates.json'), 'utf8')).templates.length).toBeGreaterThan(0)
    expect(await readFile(join(target, 'dsh-taskboard-assets', image.name))).toEqual(png)
    await expect(readFile(join(f.home, 'dsh-taskboard.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = new StorageCoordinator({
      defaultDirectory: f.home,
      configFile: join(f.home, STORAGE_CONFIG_FILE),
      ledgerName: 'dsh-taskboard.json',
      templatesName: 'dsh-taskboard-templates.json',
      assetsName: 'dsh-taskboard-assets',
    })
    expect(restarted.directory()).toBe(target)
    const ledger = new TaskStore({ file: restarted.ledgerPath(), queue: restarted.queue })
    const templates = new TemplateStore(restarted.templatesPath(), restarted.queue)
    const assets = new AssetStore(restarted.assetsPath(), () => Date.now(), restarted.queue)
    restarted.attach({ ledger, templates, assets })
    await restarted.ready()
    await ledger.load()
    expect(ledger.snapshot().settings?.syncExternalSessions).toBe(true)
    expect((await assets.read(image.name))?.bytes).toEqual(png)

    const restored = await restarted.migrate('')
    expect(restored).toMatchObject({ migrated: true, currentDirectory: f.home, isDefault: true, configured: false })
    await expect(readFile(join(f.home, STORAGE_CONFIG_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(f.home, 'dsh-taskboard.json'), 'utf8')).settings.syncExternalSessions).toBe(true)
  })

  it('rejects a conflicting target and keeps the original store active', async () => {
    const f = await fixture()
    await f.ledger.mutate('settings-updated', ledger => { ledger.settings = { defaultIsolation: 'worktree' }; return [] })
    const target = join(f.root, 'occupied')
    await writeFile(join(f.root, 'placeholder'), '')
    await f.storage.check(target)
    await writeFile(join(target, 'dsh-taskboard.json'), '{}')

    await expect(f.storage.migrate(target)).rejects.toThrow('target already contains dsh-taskboard.json')
    expect(f.storage.directory()).toBe(f.home)
    expect(f.ledger.location()).toBe(join(f.home, 'dsh-taskboard.json'))
    expect(f.ledger.snapshot().settings?.defaultIsolation).toBe('worktree')
  })

  it('queues writes made during migration behind the path switch', async () => {
    const f = await fixture()
    await f.templates.list()
    const target = join(f.root, 'queued')
    const migration = f.storage.migrate(target)
    const mutation = f.ledger.mutate('settings-updated', ledger => {
      ledger.settings = { defaultPermission: 'read-only' }
      return []
    })
    await Promise.all([migration, mutation])
    const persisted = JSON.parse(await readFile(join(target, 'dsh-taskboard.json'), 'utf8'))
    expect(persisted.settings.defaultPermission).toBe('read-only')
  })

  it('deduplicates concurrent requests for the same destination', async () => {
    const f = await fixture()
    await f.templates.list()
    const target = join(f.root, 'same-target')
    const results = await Promise.all([f.storage.migrate(target), f.storage.migrate(target)])
    expect(results.map(result => result.migrated).sort()).toEqual([false, true])
    expect(JSON.parse(await readFile(join(target, 'dsh-taskboard.json'), 'utf8')).schemaVersion).toBe(1)
    expect(f.storage.directory()).toBe(target)
  })
})
