/**
 * Startup preload regression (review P0): the plugin's apply() kicks off an
 * eager store.load() because the tools and most routes read snapshot()/get()
 * WITHOUT triggering the lazy load — a fresh boot used to serve an empty
 * board until the scheduler tick or GET /state loaded the file.
 *
 * These tests pin both halves of that contract at the store level:
 * 1. a never-loaded store serves an empty board even when the ledger file
 *    has tasks (the hazard), and
 * 2. after the startup-style fire-and-forget load(), the data is readable
 *    with no mutation enqueued first.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TaskStore } from '../src/host/store.ts'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function seededLedgerFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-preload-'))
  dirs.push(dir)
  const task = {
    id: 't-preload-0001',
    title: 'preload probe',
    description: '',
    prompt: '',
    workspaceId: 'ws-preload',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 3,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
  }
  const file = join(dir, 'dsh-taskboard.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 7, tasks: [task] }))
  return file
}

describe('startup ledger preload', () => {
  it('a never-loaded store serves an empty board even when the ledger file has tasks', async () => {
    const lazy = new TaskStore({ file: await seededLedgerFile() })
    expect(lazy.snapshot().tasks).toHaveLength(0)
    expect(lazy.get('t-preload-0001')).toBeUndefined()
  })

  it('the startup-style eager load makes tasks readable without any prior mutation', async () => {
    const store = new TaskStore({ file: await seededLedgerFile() })
    void store.load() // what src/index.ts apply() does at startup
    await vi.waitFor(() => {
      // No mutate/read was ever enqueued — only the eager load can have
      // populated this.
      expect(store.get('t-preload-0001')?.version).toBe(3)
      expect(store.snapshot().revision).toBe(7)
    })
  })
})
