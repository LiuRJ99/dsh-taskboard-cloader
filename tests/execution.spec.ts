/**
 * P3 tests: the execution service (fresh in-project session with the pinned
 * model, prompt submission, settlement incl. turn errors) and the cron
 * scheduler (due → advance → run; missed windows skip).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionService, type AgentsFace, type EventsFace } from '../src/host/execution.ts'
import { SchedulerService } from '../src/host/scheduler.ts'
import { TaskStore } from '../src/host/store.ts'
import { normalizeExecution, type TaskRecord } from '../src/shared/protocol.ts'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-exec-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/** A task fixture. */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-run',
    title: 'Run me',
    description: '',
    prompt: 'DO THE THING',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
    ...overrides,
  }
}

/** Build a store holding the given tasks. */
async function storeWith(...tasks: TaskRecord[]): Promise<TaskStore> {
  const store = new TaskStore({ file: join(dir, `led-${Math.random().toString(36).slice(2)}.json`) })
  await store.mutate('task-created', ledger => {
    ledger.tasks.push(...tasks)
    return [...tasks]
  })
  return store
}

// Shared mutable flag for the fail-path test.
const fakeAgentsState = { failNext: false }

/** Capturing agents fake: records create options and followup messages. */
function fakeAgents(): AgentsFace & {
  created: Array<{ sessionId: string; cwd?: string; agentOptions?: { provider?: string; model?: string } }>
  followups: unknown[]
  idle: () => void
} {
  const created: Array<{ sessionId: string; cwd?: string; agentOptions?: { provider?: string; model?: string } }> = []
  const followups: unknown[] = []
  let resolveIdle: (() => void) | undefined
  const svc = {
    created,
    followups,
    idle: () => { resolveIdle?.() },
    async create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: { provider?: string; model?: string } }) {
      if (fakeAgentsState.failNext) {
        fakeAgentsState.failNext = false
        throw new Error('provider has no adapter')
      }
      created.push({ sessionId: options.sessionId, cwd: options.meta?.cwd, agentOptions: options.agentOptions })
      return {
        agent: {
          id: options.sessionId,
          followup: (message: unknown) => { followups.push(message) },
          whenIdle: () => new Promise<void>(resolve => { resolveIdle = resolve }),
        },
        dispose: async () => {},
      }
    },
  } as never
  return svc as AgentsFace & { created: typeof created; followups: typeof followups; idle: () => void }
}

/** Event-bus fake with manual dispatch. */
function fakeEvents(): EventsFace & { dispatch(sessionId: string, event: { type: string; data?: unknown }): void } {
  const listeners: Array<(sessionId: string, event: { type: string; data?: unknown }) => void> = []
  return {
    onSessionEvent: (listener) => {
      listeners.push(listener)
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
    },
    dispatch: (sessionId, event) => { for (const l of [...listeners]) l(sessionId, event) },
  }
}

const workspaces = {
  get: (id: string) => (id === 'ws-a' ? { id: 'ws-a', path: '/proj/a' } : undefined),
  attach: async () => {},
}

describe('ExecutionService', () => {
  it('runs a task in a fresh in-project session with the pinned model', async () => {
    const store = await storeWith(task({ model: { provider: 'deepseek', model: 'reasoner' } }))
    const agents = fakeAgents()
    const events = fakeEvents()
    const svc = new ExecutionService({ store, agents, workspaces, events, now: () => 1_000 })

    const result = await svc.run('t-run', 'manual')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Session created inside the project, carrying the pinned model.
    expect(agents.created).toHaveLength(1)
    expect(agents.created[0]!.cwd).toBe('/proj/a')
    expect(agents.created[0]!.agentOptions).toEqual({ provider: 'deepseek', model: 'reasoner' })

    // The ledger shows in_progress + a running execution with the session id.
    let t = store.get('t-run')!
    expect(t.status).toBe('in_progress')
    expect(t.executions[0]!.outcome).toBe('running')
    expect(t.executions[0]!.sessionId).toBe(result.sessionId)
    expect(t.executions[0]!.trigger).toBe('manual')

    // The prompt went in as an ordinary user message.
    expect(agents.followups).toHaveLength(1)
    const message = agents.followups[0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.content[0]!.type).toBe('text')
    expect(message.content[0]!.text).toContain('DO THE THING')
    expect(message.content[0]!.text).toContain('任务看板执行')
    expect(message.content[0]!.text).toContain('任务 ID: t-run')
    expect(message.content[0]!.text).toContain('taskboard_move')
    expect(message.source.kind).toBe('plugin')

    // Quiescence settles the execution as succeeded.
    agents.idle()
    await new Promise(r => setTimeout(r, 10))
    t = store.get('t-run')!
    expect(t.executions[0]!.outcome).toBe('succeeded')
    expect(t.executions[0]!.endedAt).toBe(1_000)
  })

  it('fails the execution and reverts progress when creation fails', async () => {
    fakeAgentsState.failNext = true
    const store = await storeWith(task())
    const svc = new ExecutionService({ store, agents: fakeAgents(), workspaces, events: fakeEvents(), now: () => 1_000 })
    const result = await svc.run('t-run', 'manual')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('adapter')
    const t = store.get('t-run')!
    expect(t.status).toBe('todo')
    expect(t.executions[0]!.outcome).toBe('failed')
  })

  it('folds turn/end errors into a failed execution', async () => {
    const store = await storeWith(task())
    const agents = fakeAgents()
    const events = fakeEvents()
    const svc = new ExecutionService({ store, agents, workspaces, events, now: () => 1_000 })
    const result = await svc.run('t-run', 'scheduled')
    if (!result.ok) throw new Error('run failed')

    events.dispatch(result.sessionId, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: 'boom: quota exceeded' } } },
    })
    await new Promise(r => setTimeout(r, 10))
    const t = store.get('t-run')!
    expect(t.executions[0]!.outcome).toBe('failed')
    expect(t.executions[0]!.error).toContain('quota exceeded')
  })

  it('rejects a run on a running or unknown task', async () => {
    const store = await storeWith(task({ status: 'in_progress' }))
    const svc = new ExecutionService({ store, agents: fakeAgents(), workspaces, events: fakeEvents(), now: () => 1_000 })
    expect((await svc.run('t-run', 'manual')).ok).toBe(false)
    expect((await svc.run('nope', 'manual')).ok).toBe(false)
  })
})

describe('SchedulerService', () => {
  it('advances and runs a due scheduled task, skips missed windows', async () => {    const now = Date.parse('2026-08-14T10:30:00Z') // arbitrary
    const scheduled = task({
      id: 't-cron',
      execution: normalizeExecution({ mode: 'scheduled', cron: '*/10 * * * *' }, now - 60_000), // due a minute ago
    })
    const store = await storeWith(scheduled)
    const runs: string[] = []
    const scheduler = new SchedulerService({
      store,
      execution: { run: async id => { runs.push(id); return { ok: true, executionId: 'e', sessionId: 's' } } },
      now: () => now,
    })
    await scheduler.tick()
    expect(runs).toEqual(['t-cron'])
    const t = store.get('t-cron')!
    expect(t.execution.lastTriggeredAt).toBe(scheduled.execution.nextRunAt)
    expect(t.execution.nextRunAt).toBeGreaterThan(now)

    // A window missed by > 5 minutes advances without running.
    const stale = task({
      id: 't-missed',
      execution: normalizeExecution({ mode: 'scheduled', cron: '0 3 * * *' }, now - 8 * 60_000),
    })
    stale.execution.nextRunAt = now - 8 * 60_000
    const store2 = await storeWith(stale)
    const runs2: string[] = []
    const scheduler2 = new SchedulerService({
      store: store2,
      execution: { run: async id => { runs2.push(id); return { ok: true, executionId: 'e', sessionId: 's' } } },
      now: () => now,
    })
    await scheduler2.tick()
    expect(runs2).toEqual([])
    expect(store2.get('t-missed')!.execution.nextRunAt).toBeGreaterThan(now)
  })

  it('leaves non-scheduled and running tasks alone', async () => {
    const now = 1_000_000
    const claimTask = task({ id: 't-claim' })
    const running = task({
      id: 't-busy',
      status: 'in_progress',
      execution: { mode: 'scheduled', cron: '* * * * *', nextRunAt: now - 1 },
    })
    const store = await storeWith(claimTask, running)
    const runs: string[] = []
    const scheduler = new SchedulerService({
      store,
      execution: { run: async id => { runs.push(id); return { ok: true, executionId: 'e', sessionId: 's' } } },
      now: () => now,
    })
    await scheduler.tick()
    expect(runs).toEqual([])
  })
})
