import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerService } from '../src/host/scheduler.ts'
import { TaskStore } from '../src/host/store.ts'
import type { TaskRecord } from '../src/shared/protocol.ts'

const T0 = 1_700_000_040_000
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function task(id: string, due = T0 - 1): TaskRecord {
  return { id, title: id, description: '', prompt: '', workspaceId: 'ws-test', urgency: 'normal', status: 'todo', blocked: false,
    execution: { mode: 'scheduled', cron: '* * * * *', nextRunAt: due }, version: 1, createdAt: T0, updatedAt: T0,
    createdBy: { kind: 'user' }, updatedBy: { kind: 'user' }, comments: [], executions: [] }
}
async function seeded(...tasks: TaskRecord[]) {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-queue-')); dirs.push(dir)
  const file = join(dir, 'ledger.json'); const store = new TaskStore({ file })
  await store.mutate('task-created', ledger => { ledger.tasks.push(...tasks); return tasks })
  return { store, file }
}
const accepted = { ok: true as const, executionId: 'exec-test', sessionId: 'session-test' }

describe('durable scheduled dispatch', () => {
  it('keeps a saturated window past the offline skip threshold and across restart, without spawning cards', async () => {
    const { store, file } = await seeded(task('held'))
    const run = vi.fn(async (_id: string) => accepted)
    const first = new SchedulerService({ store, execution: { run, inFlight: () => 3 }, now: () => T0, dispatchIntervalMs: 0 })
    await first.tick(); first.dispose()
    expect(run).not.toHaveBeenCalled()
    expect(store.get('held')!.execution).toMatchObject({ queuedRunAt: T0 - 1, queuedAt: T0 })
    const restarted = new TaskStore({ file })
    const second = new SchedulerService({ store: restarted, execution: { run, inFlight: () => 0 }, now: () => T0 + 600_000, dispatchIntervalMs: 0 })
    await second.tick()
    expect(run).toHaveBeenCalledWith('held', 'scheduled', { scheduledWindow: T0 - 1 })
    expect(restarted.get('held')!.execution.queuedRunAt).toBeUndefined()
    expect(restarted.get('held')!.execution.lastTriggeredAt).toBe(T0 - 1)
    expect(restarted.snapshot().tasks).toHaveLength(1)
  })

  it('dispatches in due-time FIFO order even when ledger order differs', async () => {
    const { store } = await seeded(task('later', T0 - 1), task('earlier', T0 - 30_000))
    const run = vi.fn(async (_id: string) => accepted)
    await new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0, dispatchIntervalMs: 0 }).tick()
    expect(run.mock.calls.map(call => call[0])).toEqual(['earlier', 'later'])
  })

  it('restores a gate rejection and retries the same durable window', async () => {
    const { store } = await seeded(task('retry'))
    const run = vi.fn().mockResolvedValueOnce({ ok: false, error: 'model unavailable' }).mockResolvedValueOnce(accepted)
    const scheduler = new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0, dispatchIntervalMs: 0 })
    await scheduler.tick()
    expect(store.get('retry')!.execution).toMatchObject({ queuedRunAt: T0 - 1, queuedAt: T0 })
    expect(store.get('retry')!.execution.dispatchingRunAt).toBeUndefined()
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(store.get('retry')!.execution.queuedRunAt).toBeUndefined()
  })

  it('restores a reservation left by a host that stopped before opening an execution', async () => {
    const t = task('recover'); t.execution.dispatchingRunAt = T0 - 2; t.execution.queuedAt = T0 - 1
    const { store } = await seeded(t); const run = vi.fn(async (_id: string) => accepted)
    await new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0, dispatchIntervalMs: 0 }).tick()
    expect(run).toHaveBeenCalledWith('recover', 'scheduled', { scheduledWindow: T0 - 2 })
  })

  it('serializes overlapping ticks while an execution gate is pending', async () => {
    const { store } = await seeded(task('one'))
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const run = vi.fn(async (_id: string) => { await held; return accepted })
    const scheduler = new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0, dispatchIntervalMs: 0 })
    const a = scheduler.tick(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const b = scheduler.tick(); release(); await Promise.all([a, b])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels rate waiting, preserves unstarted work and prevents later ticks', async () => {
    const { store } = await seeded(task('first', T0 - 2), task('second', T0 - 1))
    const run = vi.fn(async (_id: string) => accepted); let waiting = false
    const scheduler = new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0,
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: (_fn, ms) => { if (ms === 1_000) waiting = true; return ms }, clearTimeout: () => {} } })
    scheduler.start(); const tick = scheduler.tick()
    await vi.waitFor(() => expect(waiting).toBe(true)); scheduler.dispose(); await tick
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.get('second')!.execution.queuedRunAt).toBe(T0 - 1)
    await scheduler.tick(); expect(run).toHaveBeenCalledTimes(1)
  })

  it('expires queued work only under the explicit shelf-life policy', async () => {
    const { store } = await seeded(task('expire')); let now = T0; let capacity = 3
    const run = vi.fn(async (_id: string) => accepted)
    const scheduler = new SchedulerService({ store, execution: { run, inFlight: () => capacity }, now: () => now, queueMaxAgeMs: 100, dispatchIntervalMs: 0 })
    await scheduler.tick(); now += 101; capacity = 0; await scheduler.tick()
    expect(run).not.toHaveBeenCalled()
    expect(store.get('expire')!.execution.queuedRunAt).toBeUndefined()
    expect(store.get('expire')!.comments.at(-1)?.systemKey).toBe('sys.queuedExpired')
  })

  it('retains recurring review cards and never dispatches terminal or trashed cards', async () => {
    const review = task('review'); review.status = 'in_review'
    const done = task('done'); done.status = 'done'
    const trashed = task('trashed'); trashed.trashedAt = T0
    const { store } = await seeded(review, done, trashed); const run = vi.fn(async (_id: string) => accepted)
    await new SchedulerService({ store, execution: { run, inFlight: () => 0 }, now: () => T0, dispatchIntervalMs: 0 }).tick()
    expect(run.mock.calls.map(call => call[0])).toEqual(['review'])
    expect(store.snapshot().tasks).toHaveLength(3)
  })
})
