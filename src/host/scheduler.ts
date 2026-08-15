/**
 * Host-side cron scheduler: one tick per minute over the ledger's scheduled
 * tasks. A due task (nextRunAt reached, not running, not trashed) first has
 * its next run advanced to the next cron match — then it executes through
 * the same path as the manual button. Missed windows (host was down, tab
 * closed — irrelevant here, this is the host process) simply advance: a
 * nextRunAt more than one window in the past is skipped, not caught up.
 *
 * @module dsh-taskboard/host/scheduler
 */
import { nextCronTime, parseCron, type TaskLedger } from '../shared/protocol.ts'
import type { ExecutionService } from './execution.ts'
import type { TaskStore } from './store.ts'

/** Tick cadence. */
const TICK_MS = 60_000

/** A due window older than this is skipped (missed while the host was down). */
const SKIP_AFTER_MS = 5 * 60_000

/** Everything the scheduler needs. */
export interface SchedulerDeps {
  store: TaskStore
  execution: Pick<ExecutionService, 'run'>
  now: () => number
  /** Timer face (injectable for tests). */
  timers?: {
    setInterval(fn: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

/**
 * The cron scheduler.
 */
export class SchedulerService {
  private handle: unknown

  /** @param deps - store + execution + clock. */
  constructor(private readonly deps: SchedulerDeps) {}

  /** Start ticking. */
  start(): void {
    const timers = this.deps.timers ?? {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    }
    this.handle = timers.setInterval(() => { void this.tick() }, TICK_MS)
    // Catch up promptly on host restart: run one tick soon after start.
    setTimeout(() => { void this.tick() }, 3_000)
  }

  /** Stop ticking. */
  dispose(): void {
    if (this.handle === undefined) return
    const timers = this.deps.timers ?? { clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) }
    timers.clearInterval(this.handle)
    this.handle = undefined
  }

  /** One scheduler pass (exported for tests). */
  async tick(): Promise<void> {
    const now = this.deps.now()
    const ledger: TaskLedger = this.deps.store.snapshot()
    for (const task of ledger.tasks) {
      if (task.execution.mode !== 'scheduled' || task.execution.cron === undefined) continue
      if (task.execution.nextRunAt === undefined) continue
      if (task.status === 'in_progress' || task.trashedAt !== undefined) continue
      if (task.execution.nextRunAt > now) continue
      const missed = now - task.execution.nextRunAt > SKIP_AFTER_MS

      // Advance the schedule FIRST (idempotent under re-ticks), then run
      // unless the window was missed entirely.
      await this.advance(task.id, now)
      if (missed) continue
      const lastTriggeredAt = task.execution.nextRunAt
      await this.markTriggered(task.id, lastTriggeredAt)
      await this.deps.execution.run(task.id, 'scheduled').catch(error => {
        console.error('[dsh-taskboard] scheduled run failed:', error)
      })
    }
  }

  /** Recompute and persist the next run for one scheduled task. */
  private async advance(taskId: string, now: number): Promise<void> {
    await this.deps.store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find(t => t.id === taskId)
      if (task === undefined || task.execution.cron === undefined) return undefined
      const match = parseCron(task.execution.cron)
      const next = match === null ? undefined : nextCronTime(match, now) ?? undefined
      if (next === undefined) return undefined
      task.execution.nextRunAt = next
      return [task]
    })
  }

  /** Record the trigger instant on the task. */
  private async markTriggered(taskId: string, at: number | undefined): Promise<void> {
    if (at === undefined) return
    await this.deps.store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find(t => t.id === taskId)
      if (task === undefined) return undefined
      task.execution.lastTriggeredAt = at
      return [task]
    })
  }
}
