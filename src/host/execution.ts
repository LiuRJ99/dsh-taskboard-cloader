/**
 * Host execution service: runs a task through dsh's REAL session machinery —
 * a fresh agent+session inside the task's project workspace (creation carries
 * the pinned model when the task has one), the session is attached to the
 * workspace so it appears in the GUI's project session list, the effective
 * prompt is submitted as an ordinary user message, and the turn settlement
 * (turn/end reason) is folded back into the task's execution record.
 *
 * Every execution is a NEW session: clean context, no reuse of previous runs.
 *
 * @module dsh-taskboard/host/execution
 */
import { effectivePrompt, newExecutionId, type ExecutionRecord, type TaskRecord } from '../shared/protocol.ts'
import { MessageId } from './sdk.ts'
import type { TaskStore } from './store.ts'

/** Narrow agents face (the registry's create, structurally). */
export interface AgentsFace {
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: { provider?: string; model?: string }
  }): Promise<{
    agent: {
      id: string
      followup(message: unknown): void
      whenIdle(): Promise<void>
    }
    dispose(): Promise<void>
  }>
}

/** Narrow workspaces face for execution. */
export interface ExecutionWorkspaceFace {
  get(id: string): { id: string; path: string } | undefined
  attach(workspaceId: string, sessionId: string): Promise<void>
}

/** Narrow event-bus face for settlement listening. */
export interface EventsFace {
  onSessionEvent(listener: (sessionId: string, event: { type: string; data?: unknown }) => void): () => void
}

/** Everything the execution service needs. */
export interface ExecutionDeps {
  store: TaskStore
  agents: AgentsFace
  workspaces: ExecutionWorkspaceFace
  events: EventsFace
  now: () => number
  /** The deployment default model (fills sessions of unpinned tasks). */
  defaultModel?: () => { provider: string; model: string } | undefined
  /** Mint session ids (injectable for tests). */
  mintSessionId?: () => string
  /** Mint message ids (injectable for tests). */
  mintMessageId?: () => string
}

/** Outcome of a run request (immediate; the run settles asynchronously). */
export type RunRequestResult =
  | { ok: true; executionId: string; sessionId: string }
  | { ok: false; error: string }

/** Whether a turn/end payload closed with an error reason. */
function isErrorTurnEnd(data: unknown): { message: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (kind !== 'error') return undefined
  const error = (reason as { error?: { message?: unknown } }).error
  const detail = JSON.stringify(error) ?? ''
  const message = typeof error?.message === 'string' ? error.message : 'turn failed'
  console.error('[dsh-taskboard] turn error detail:', detail.slice(0, 2000))
  void detail
  return { message }
}

/**
 * The execution service.
 */
export class ExecutionService {
  /** Execution ids currently settling. */
  private readonly settling = new Map<string, () => void>()

  /** @param deps - store + agents + workspaces + events + clock. */
  constructor(private readonly deps: ExecutionDeps) {
    deps.events.onSessionEvent((sessionId, event) => {
      if (event.type !== 'turn/end') return
      const failure = isErrorTurnEnd(event.data)
      if (failure !== undefined) this.noteFailure(sessionId, failure.message)
    })
  }

  /** Record a turn failure against the running execution of that session. */
  private noteFailure(sessionId: string, message: string): void {
    void this.deps.store.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        for (const execution of task.executions) {
          if (execution.sessionId === sessionId && execution.outcome === 'running') {
            execution.outcome = 'failed'
            execution.error = message.slice(0, 500)
            execution.endedAt = this.deps.now()
            return [task]
          }
        }
      }
      return undefined
    })
  }

  /** Patch one task's execution record in the ledger. */
  private async patchExecution(executionId: string, patch: Partial<ExecutionRecord>): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        const execution = task.executions.find(e => e.id === executionId)
        if (execution !== undefined) {
          Object.assign(execution, patch)
          return [task]
        }
      }
      return undefined
    })
  }

  /**
   * Run one task now (manual button or scheduler tick).
   * @param taskId - the task to run.
   * @param trigger - what started it.
   * @returns the immediate result; settlement lands in the ledger.
   */
  async run(taskId: string, trigger: ExecutionRecord['trigger']): Promise<RunRequestResult> {
    const task = this.deps.store.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) {
      return { ok: false, error: `no task ${taskId}` }
    }
    if (task.status === 'in_progress') {
      return { ok: false, error: 'task is already in progress' }
    }
    const workspace = this.deps.workspaces.get(task.workspaceId)
    if (workspace === undefined) {
      return { ok: false, error: `unknown workspace ${task.workspaceId}` }
    }

    const executionId = newExecutionId()
    const sessionId = this.deps.mintSessionId?.() ?? `session-taskboard-${crypto.randomUUID()}`

    // 1. Open the execution record and move the card to in_progress in one write.
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target === undefined) return undefined
      target.executions.push({
        id: executionId,
        trigger,
        startedAt: this.deps.now(),
        outcome: 'running',
      })
      target.status = 'in_progress'
      target.updatedAt = this.deps.now()
      target.updatedBy = { kind: 'user' }
      return [target]
    })

    // 2. Create the fresh agent+session inside the task's project, carrying
    //    the pinned model — or the deployment default when unpinned (the
    //    persona template renders {{model}}, so the session always needs one).
    let handle: Awaited<ReturnType<AgentsFace['create']>>
    try {
      const model = task.model ?? this.deps.defaultModel?.()
      handle = await this.deps.agents.create({
        sessionId,
        meta: { cwd: workspace.path },
        ...(model !== undefined ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.patchExecution(executionId, { outcome: 'failed', error: message.slice(0, 500), endedAt: this.deps.now() })
      await this.revertProgress(taskId)
      return { ok: false, error: message }
    }

    // 3. Attach the session to the workspace (GUI project session list).
    await this.deps.workspaces.attach(task.workspaceId, sessionId).catch(() => { /* cosmetic */ })

    // 4. Record the session id (execution is really started now).
    await this.patchExecution(executionId, { sessionId })

    // 5. Submit the effective prompt as an ordinary user message and settle
    //    on quiescence (turn/end errors were already folded by the listener).
    const message = {
      id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: this.executionPrompt(task) }],
      source: { kind: 'plugin' as const, plugin: 'agent-taskboard' },
    }
    handle.agent.followup(message)

    // 6. Settlement watcher.
    const settle = (): void => {
      this.settling.delete(executionId)
      void this.deps.store.mutate('execution-recorded', (ledger) => {
        for (const t of ledger.tasks) {
          const execution = t.executions.find(e => e.id === executionId)
          if (execution !== undefined && execution.outcome === 'running') {
            execution.outcome = 'succeeded'
            execution.endedAt = this.deps.now()
            return [t]
          }
        }
        return undefined
      })
    }
    this.settling.set(executionId, settle)
    void handle.agent.whenIdle().then(settle, () => {
      this.noteFailure(sessionId, 'agent did not reach quiescence')
      settle()
    })

    return { ok: true, executionId, sessionId }
  }

  /** The prompt text one execution submits (task context + instructions). */
  private executionPrompt(task: TaskRecord): string {
    const head = `【任务看板执行】${task.title}（任务 ID: ${task.id}）`
    const state = '本任务由执行服务启动本会话并已置为 in_progress（你无需再认领，也无需移到 done）。'
    const tail = `完成后请：1) 用 taskboard_get 读取任务 ${task.id} 拿最新 version；`
      + `2) 用 taskboard_comment_add 留评论（做了什么改动、如何验证、剩余风险）；`
      + `3) 用 taskboard_move 把任务 ${task.id} 移到 in_review（带 ifVersion）。`
    return `${head}\n\n${state}\n\n${effectivePrompt(task)}\n\n${tail}`
  }

  /** Move a task back out of in_progress after a failed start. */
  private async revertProgress(taskId: string): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target !== undefined && target.status === 'in_progress') {
        target.status = 'todo'
        target.updatedAt = this.deps.now()
        return [target]
      }
      return undefined
    })
  }
}
