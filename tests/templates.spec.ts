/**
 * Template store (0.4.0): side-file persistence, built-in seeding, upsert /
 * rename / delete, and the ledger store's import-backup method.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES, TemplateStore } from '../src/host/templates.ts'
import { TaskStore } from '../src/host/store.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-templates-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('TemplateStore', () => {
  it('seeds the built-ins when the side file is missing', async () => {
    const store = new TemplateStore(join(dir, 'a-templates.json'))
    const list = await store.list()
    expect(list.map(t => t.name)).toEqual(BUILTIN_TEMPLATES.map(t => t.name))
    expect(list.every(t => t.builtin === true)).toBe(true)
    expect(list.find(t => t.id === 'tpl-bugfix')?.category).toBe('开发')
    expect(list.find(t => t.id === 'tpl-patrol')?.category).toBe('运营')
    // Seeded on disk: a second store over the same file reads the same list.
    const again = await new TemplateStore(join(dir, 'a-templates.json')).list()
    expect(again.map(t => t.id)).toEqual(list.map(t => t.id))
  })

  it('migrates legacy built-ins with the new execution defaults and preserves custom fields', async () => {
    const file = join(dir, 'legacy-templates.json')
    const legacy = BUILTIN_TEMPLATES.map((template, index) => {
      const task = { ...template.task }
      delete task.speed
      delete task.permissionMode
      const { category: _category, ...withoutCategory } = template
      return { ...withoutCategory, task, builtin: true, createdAt: index, updatedAt: index }
    })
    await writeFile(file, JSON.stringify({ templates: legacy }), 'utf8')

    const list = await new TemplateStore(file).list()
    expect(list.find(t => t.id === 'tpl-bugfix')?.task).toMatchObject({ speed: 'standard', permissionMode: 'workspace-write' })
    expect(list.find(t => t.id === 'tpl-patrol')?.task).toMatchObject({ speed: 'standard', permissionMode: 'read-only' })
    expect(list.find(t => t.id === 'tpl-bugfix')?.category).toBe('开发')
    expect(list.find(t => t.id === 'tpl-patrol')?.category).toBe('运营')

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { templates: Array<{ id: string; category?: string; task: { speed?: string; permissionMode?: string } }> }
    expect(persisted.templates.find(t => t.id === 'tpl-release')?.task).toMatchObject({ speed: 'standard', permissionMode: 'workspace-write' })
    expect(persisted.templates.find(t => t.id === 'tpl-release')?.category).toBe('开发')
  })

  it('upserts: create without id, rename with id, validates the name', async () => {
    const store = new TemplateStore(join(dir, 'b-templates.json'))
    const created = await store.upsert({ name: '我的模板', category: ' 开发 ', task: { urgency: 'urgent', checklist: ['a'] } })
    expect(created.id).toMatch(/^tpl-/)
    expect(created.task.checklist).toEqual(['a'])
    expect(created.category).toBe('开发')

    const renamed = await store.upsert({ id: created.id, name: '改名后', category: '运营', task: created.task })
    expect(renamed.name).toBe('改名后')
    expect(renamed.category).toBe('运营')
    expect((await store.list()).find(t => t.id === created.id)!.name).toBe('改名后')
    expect(renamed.createdAt).toBe(created.createdAt) // replace, not recreate

    await expect(store.upsert({ name: '  ', task: {} })).rejects.toThrow('1..60')
    await expect(store.upsert({ name: 'x'.repeat(61), task: {} })).rejects.toThrow('1..60')
    await expect(store.upsert({ name: '类别太长', category: 'x'.repeat(31), task: {} })).rejects.toThrow('1..30')
  })

  it('deletes by id and reports a miss as false', async () => {
    const store = new TemplateStore(join(dir, 'c-templates.json'))
    const all = await store.list()
    const victim = all[0]!
    expect(await store.remove(victim.id)).toBe(true)
    expect((await store.list()).some(t => t.id === victim.id)).toBe(false)
    expect(await store.remove(victim.id)).toBe(false)
  })

  it('recovers from a corrupt side file by re-seeding', async () => {
    const { writeFile } = await import('node:fs/promises')
    const file = join(dir, 'd-templates.json')
    await writeFile(file, '{corrupt json', 'utf8')
    const list = await new TemplateStore(file).list()
    expect(list.length).toBe(BUILTIN_TEMPLATES.length)
  })
})

describe('TaskStore.backup (import-replace safety)', () => {
  it('writes a timestamped copy next to the ledger', async () => {
    const { mkdtemp: mk } = await import('node:fs/promises')
    const sub = await mk(join(dir, 'bk-'))
    const store = new TaskStore({ file: join(sub, 'ledger.json') })
    await store.mutate('task-created', ledger => {
      ledger.tasks.push({
        id: 't-bk', title: '备份我', description: '', prompt: '', workspaceId: 'ws-a',
        urgency: 'normal', status: 'todo', blocked: false, execution: { mode: 'claim' },
        version: 1, createdAt: 0, updatedAt: 0, createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
        comments: [], executions: [],
      })
      return ledger.tasks
    })
    const backupFile = await store.backup()
    expect(backupFile).toContain('backup-')
    const raw = JSON.parse(await readFile(backupFile, 'utf8')) as { tasks: Array<{ id: string }> }
    expect(raw.tasks.map(t => t.id)).toEqual(['t-bk'])
    await rm(sub, { recursive: true, force: true })
  })
})
