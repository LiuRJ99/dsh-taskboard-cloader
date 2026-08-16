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
import {
  effectiveIsolation,
  effectivePrompt,
  newCommentId,
  newExecutionId,
  normalizeBody,
  type ExecutionRecord,
  type IsolationMode,
  type TaskRecord,
} from '../shared/protocol.ts'
import { sanitizeBranchName, worktreePathOf, type GitFace, type SettlementFacts } from './git.ts'
import { MessageId } from './sdk.ts'
import type { TaskStore } from './store.ts'

/** Default cap on concurrently running executions (env-overridable). */
export const DEFAULT_MAX_CONCURRENT = 3

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
      inject(message: unknown): void
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
  /** Best-effort session rename (pins the session list title to the task title). */
  renameSession?: (sessionId: string, title: string) => void
  /** Max concurrently running executions across all tasks (default 3). */
  maxConcurrent?: number
  /**
   * Git face for worktree isolation (0.3.0). Absent → every worktree-mode
   * task degrades to the original directory with an isolationNote.
   */
  git?: GitFace
}

/** Outcome of a run request (immediate; the run settles asynchronously). */
export type RunRequestResult =
  | { ok: true; executionId: string; sessionId: string }
  | { ok: false; error: string }

/** Outcome of a cancel request. */
export type CancelRequestResult =
  | { ok: true; executionId: string }
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

/** One live execution tracked for settlement and cancellation. */
interface RunEntry {
  sessionId: string
  settle: () => void
  dispose: () => Promise<void>
}

/**
 * The execution service.
 */
export class ExecutionService {
  /** Live executions by execution id (settles and cancels remove entries). */
  private readonly runs = new Map<string, RunEntry>()

  /** @param deps - store + agents + workspaces + events + clock. */
  constructor(private readonly deps: ExecutionDeps) {
    deps.events.onSessionEvent((sessionId, event) => {
      if (event.type !== 'turn/end') return
      const failure = isErrorTurnEnd(event.data)
      if (failure !== undefined) this.noteFailure(sessionId, failure.message)
    })
  }

  /** Record a turn failure against the running execution of that session and give the task back. */
  private noteFailure(sessionId: string, message: string): void {
    void this.deps.store.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        for (const execution of task.executions) {
          if (execution.sessionId === sessionId && execution.outcome === 'running') {
            execution.outcome = 'failed'
            execution.error = message.slice(0, 500)
            execution.endedAt = this.deps.now()
            // The failed session will not finish the work: hand the task back
            // instead of leaving it stuck in in_progress forever — and leave a
            // system comment so the GUI shows why.
            if (task.status === 'in_progress' && task.claimedBy === sessionId) {
              task.status = 'todo'
              task.updatedAt = this.deps.now()
              delete task.claimedBy
              delete task.claimedAt
              task.comments.push({
                id: newCommentId(),
                body: normalizeBody(`[系统] 执行失败：${message.slice(0, 300)}；任务已退回待办。`),
                version: 1,
                createdAt: this.deps.now(),
              })
            }
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
   *
   * The in-progress gate and the execution-open write happen inside ONE
   * serial-queue mutation, so two overlapping run() calls (double click,
   * overlapping scheduler ticks) can never both pass — exactly one session
   * is opened per task.
   * @param taskId - the task to run.
   * @param trigger - what started it.
   * @returns the immediate result; settlement lands in the ledger.
   */
  async run(taskId: string, trigger: ExecutionRecord['trigger']): Promise<RunRequestResult> {
    const max = this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    if (this.runs.size >= max) {
      return { ok: false, error: `execution concurrency limit reached (${this.runs.size}/${max} running)` }
    }
    const task = this.deps.store.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) {
      return { ok: false, error: `no task ${taskId}` }
    }
    const workspace = this.deps.workspaces.get(task.workspaceId)
    if (workspace === undefined) {
      return { ok: false, error: `unknown workspace ${task.workspaceId}` }
    }

    const executionId = newExecutionId()
    const sessionId = this.deps.mintSessionId?.() ?? `session-taskboard-${crypto.randomUUID()}`

    // 0. Resolve code isolation (plan §3.2): explicit 'none' → zero git calls;
    //    'worktree' (also the omitted default) → prepare below, degrading to
    //    the original directory fail-soft on any git problem.
    const isolation: IsolationMode = effectiveIsolation(task)
    const branch = task.branch ?? sanitizeBranchName(task.title, task.id)
    const worktreePath = worktreePathOf(workspace.path, task.id)

    // 1. Open the execution record, flip the card to in_progress, and record
    //    the executing session as the claim holder — atomically.
    let gate: string | undefined
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target === undefined || target.trashedAt !== undefined) {
        gate = `no task ${taskId}`
        return undefined
      }
      if (target.status === 'in_progress') {
        gate = 'task is already in progress'
        return undefined
      }
      target.executions.push({
        id: executionId,
        trigger,
        startedAt: this.deps.now(),
        outcome: 'running',
        ...(isolation === 'none' ? { isolation: 'none' as const } : { isolation: 'worktree' as const, branch }),
      })
      target.status = 'in_progress'
      target.updatedAt = this.deps.now()
      target.updatedBy = { kind: 'user' }
      target.claimedBy = sessionId
      target.claimedAt = this.deps.now()
      return [target]
    })
    if (gate !== undefined) return { ok: false, error: gate }

    // 1b. Worktree preparation (fail-soft): any failure degrades this run to
    //     the original directory with an isolationNote — the ledger and the
    //     execution pipeline itself never fail over git.
    let cwd = workspace.path
    let isolationNote: string | undefined
    let prepared: { branch: string; worktreePath: string; baseCommit: string } | undefined
    if (isolation === 'worktree') {
      const outcome = await this.prepareIsolation(task, workspace.path, worktreePath, branch)
      if (outcome.prepared !== undefined) {
        prepared = outcome.prepared
        cwd = outcome.prepared.worktreePath
        // Persist the isolation facts of the run (branch is already on the
        // record from the gate mutation).
        await this.patchExecution(executionId, {
          worktreePath: outcome.prepared.worktreePath,
          baseCommit: outcome.prepared.baseCommit,
        })
      } else {
        isolationNote = outcome.note
        // Degraded run: clear the optimistic worktree markers.
        await this.patchExecution(executionId, { isolation: 'none', isolationNote, branch: undefined, worktreePath: undefined, baseCommit: undefined })
      }
    }

    // 2. Create the fresh agent+session inside the task's project (or its
    //    dedicated worktree), carrying the pinned model — or the deployment
    //    default when unpinned (the persona template renders {{model}}, so
    //    the session always needs one).
    let handle: Awaited<ReturnType<AgentsFace['create']>>
    try {
      const model = task.model ?? this.deps.defaultModel?.()
      handle = await this.deps.agents.create({
        sessionId,
        meta: { cwd },
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

    // 3b. Best-effort rename: pin the session title to the task title so the
    //     session list shows the task name (a user-sourced title also stops
    //     automatic first-prompt retitling).
    try {
      this.deps.renameSession?.(sessionId, task.title)
    } catch { /* cosmetic */ }

    // 4. Record the session id (execution is really started now).
    await this.patchExecution(executionId, { sessionId })

    // 5. Submit the opening pair and settle on quiescence (turn/end errors
    //    were already folded by the listener). Two messages, ONE turn:
    //    - inject() queues the plugin framing line (next-step, no wake); it
    //      renders as a plugin context row in the conversation.
    //    - followup() queues the card body as a normal user message
    //      (next-turn, wakes the driver). At claim time the loop drains ALL
    //      next-step messages plus the one next-turn message into a single
    //    turn — framing first, then the user bubble.
    handle.agent.inject({
      id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: this.pluginFraming(task, prepared) }],
      source: { kind: 'plugin' as const, plugin: 'dsh-taskboard' },
    })
    handle.agent.followup({
      id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: this.userBody(task) }],
      source: { kind: 'user' as const },
    })

    // 6. Settlement watcher: mark succeeded, release the executing session's
    //    hold, collect the worktree evidence (commits / dirty / diff), and —
    //    when the session did NOT follow the handoff protocol — auto-move the
    //    card to in_review with a system comment.
    const settle = (): void => {
      this.runs.delete(executionId)
      void this.settleExecution(executionId, sessionId, prepared)
    }
    this.runs.set(executionId, { sessionId, settle, dispose: () => handle.dispose() })
    void handle.agent.whenIdle().then(settle, () => {
      this.noteFailure(sessionId, 'agent did not reach quiescence')
      settle()
    })

    return { ok: true, executionId, sessionId }
  }

  /**
   * Settle one execution: collect worktree facts first (fail-soft — git
   * problems never block settlement), then commit outcome + release + the
   * protocol-auto-review move in ONE ledger mutation.
   */
  private async settleExecution(
    executionId: string,
    sessionId: string,
    prepared: { branch: string; worktreePath: string; baseCommit: string } | undefined,
  ): Promise<void> {
    let facts: SettlementFacts | undefined
    if (prepared !== undefined && this.deps.git !== undefined) {
      try {
        facts = await this.deps.git.collect(prepared.worktreePath, prepared.baseCommit)
      } catch { /* fail-soft: settle without evidence */ }
    }
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      for (const t of ledger.tasks) {
        const execution = t.executions.find(e => e.id === executionId)
        if (execution !== undefined && execution.outcome === 'running') {
          const now = this.deps.now()
          execution.outcome = 'succeeded'
          execution.endedAt = now
          if (facts !== undefined) {
            if (facts.headCommit !== undefined) execution.headCommit = facts.headCommit
            execution.commits = facts.commits
            execution.dirtyFiles = facts.dirtyFiles
            execution.changedFiles = facts.changedFiles
            if (facts.diffStat !== undefined) execution.diffStat = facts.diffStat
          }
          if (t.status === 'in_progress' && t.claimedBy === sessionId) {
            delete t.claimedBy
            delete t.claimedAt
          }
          if (t.status === 'in_progress') {
            const commented = t.comments.some(c => c.threadId === sessionId)
            t.comments.push({
              id: newCommentId(),
              body: normalizeBody(commented
                ? '[系统] 执行会话已结束并留有评论，但未移至待验收；系统自动移入待验收。'
                : '[系统] 执行会话已结束，但未按协议交接（无评论、未移至待验收）；系统自动移入待验收，请审查后退回或验收。'),
              version: 1,
              createdAt: now,
            })
            t.status = 'in_review'
            t.updatedAt = now
            t.updatedBy = { kind: 'user' }
          }
          return [t]
        }
      }
      return undefined
    })
  }

  /**
   * Prepare the dedicated worktree for a run (fail-soft): detect git, then
   * create/reset the fixed task branch at a fresh baseline. On success the
   * branch name is pinned onto the task once (renames never change it); on
   * any failure the run degrades with a human-readable note.
   */
  private async prepareIsolation(
    task: TaskRecord,
    workspacePath: string,
    worktreePath: string,
    branch: string,
  ): Promise<{ prepared?: { branch: string; worktreePath: string; baseCommit: string }; note?: string }> {
    const git = this.deps.git
    if (git === undefined) return { note: 'git 集成不可用，已在原目录执行' }
    let inside = false
    try {
      inside = await git.detect(workspacePath)
    } catch { /* fail-soft */ }
    if (!inside) return { note: '当前项目不是 git 仓库，已在原目录执行' }
    let info
    try {
      info = await git.prepareWorktree(workspacePath, worktreePath, branch)
    } catch { /* fail-soft */ }
    if (info === undefined) return { note: 'worktree 准备失败（git 报错或目录被占用），已在原目录执行' }
    // Pin the branch name at first SUCCESSFUL creation (§9: 改名不改分支).
    if (task.branch === undefined) {
      await this.deps.store.mutate('task-updated', (ledger) => {
        const target = ledger.tasks.find(t => t.id === task.id)
        if (target !== undefined && target.branch === undefined) {
          target.branch = branch
          return [target]
        }
        return undefined
      })
    }
    return { prepared: { branch: info.branch, worktreePath: info.path, baseCommit: info.baseCommit } }
  }

  /** How many executions are currently running (for the concurrency cap). */
  inFlight(): number {
    return this.runs.size
  }

  /**
   * Cancel the running execution of a task (user action): stop the agent
   * session, mark the execution cancelled, and hand the task back to todo.
   * @param taskId - the task whose execution should be stopped.
   * @returns the immediate result.
   */
  async cancel(taskId: string): Promise<CancelRequestResult> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return { ok: false, error: `no task ${taskId}` }
    const running = [...task.executions].reverse().find(e => e.outcome === 'running')
    if (running === undefined) return { ok: false, error: 'no running execution' }

    const entry = this.runs.get(running.id)
    this.runs.delete(running.id)
    // Stop the agent first (best effort): dispose stops the loop, unregisters
    // the agent, and removes its session. A late whenIdle settlement no-ops —
    // the record is no longer 'running'.
    try {
      await entry?.dispose()
    } catch { /* already gone */ }

    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target === undefined) return undefined
      const execution = target.executions.find(e => e.id === running.id)
      if (execution === undefined || execution.outcome !== 'running') return undefined
      execution.outcome = 'cancelled'
      execution.endedAt = this.deps.now()
      if (target.status === 'in_progress') {
        target.status = 'todo'
        target.updatedAt = this.deps.now()
        delete target.claimedBy
        delete target.claimedAt
      }
      return [target]
    })
    return { ok: true, executionId: running.id }
  }

  /**
   * Startup reconciliation after a host restart: executions left `running`
   * by the previous process can never settle here (their settlement watchers
   * died with it), so mark them failed and hand their tasks back to todo.
   */
  async reconcile(): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const now = this.deps.now()
      const touched: TaskRecord[] = []
      for (const task of ledger.tasks) {
        let dirty = false
        for (const execution of task.executions) {
          if (execution.outcome === 'running') {
            execution.outcome = 'failed'
            execution.error = 'interrupted by host restart'
            execution.endedAt = now
            dirty = true
          }
        }
        if (!dirty) continue
        if (task.status === 'in_progress') {
          task.status = 'todo'
          task.updatedAt = now
          delete task.claimedBy
          delete task.claimedAt
        }
        touched.push(task)
      }
      return touched.length > 0 ? touched : undefined
    })
  }

  /**
   * The plugin framing line (rendered as a plugin context row): task head,
   * already-claimed state, and the handoff protocol — everything the session
   * must know about the board. The task id appears exactly once (here); the
   * protocol steps below refer to it as 本任务. Isolated runs add one line
   * steering the session onto its dedicated branch (commits are the evidence
   * the user reviews at merge time).
   * @param task - the task.
   * @param prepared - worktree facts when this run is isolated.
   */
  private pluginFraming(task: TaskRecord, prepared?: { branch: string; worktreePath: string }): string {
    let text = `【任务看板】${task.title}（ID: ${task.id}）\n`
      + `本会话由任务看板执行服务启动，任务已置为进行中——无需认领；「已完成」仅限用户在界面操作（代码已限制，移了会被拒）。\n`
      + `完成后按序交接：\n`
      + `1. taskboard_get 读取本任务，取得最新 version\n`
      + `2. taskboard_comment_add 留评论：做了什么改动 / 如何验证 / 剩余风险\n`
      + `3. taskboard_move 将本任务移至待验收 in_review（带 ifVersion）\n`
      + `若无法完成：留评论说明原因，将任务移回待办 todo。`
    if (prepared !== undefined) {
      text += `\n本任务启用了 Git Worktree 隔离：当前工作目录是独立分支 ${prepared.branch}；请只在该目录内改动，并把完成的工作提交（git commit）到该分支——验收将基于该分支的提交记录合并。`
    }
    return text
  }

  /**
   * The card body as a normal user bubble: the effective prompt (explicit
   * prompt, else title+description) with template variables resolved from
   * the task's own history at submit time (valuable for recurring patrols):
   * `{{lastExecution}}` → the previous execution's trigger/outcome/error;
   * `{{lastComments}}` → the last three comments (who + body).
   */
  private userBody(task: TaskRecord): string {
    const lastExec = [...task.executions].reverse().find(e => e.outcome !== 'running')
    const lastExecText = lastExec === undefined
      ? '（无）'
      : `${lastExec.trigger} · ${lastExec.outcome}${lastExec.error !== undefined ? ` · ${lastExec.error.slice(0, 200)}` : ''} · ${new Date(lastExec.startedAt ?? 0).toISOString()}`
    const lastCommentsText = task.comments.slice(-3)
      .map(c => `[${c.threadId !== undefined ? 'agent' : 'user'}] ${c.body}`)
      .join('\n') || '（无）'
    return effectivePrompt(task)
      .replace(/\{\{lastExecution\}\}/g, lastExecText)
      .replace(/\{\{lastComments\}\}/g, lastCommentsText)
  }

  /** Move a task back out of in_progress (and release its hold) after a failed start. */
  private async revertProgress(taskId: string): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target !== undefined && target.status === 'in_progress') {
        target.status = 'todo'
        target.updatedAt = this.deps.now()
        delete target.claimedBy
        delete target.claimedAt
        return [target]
      }
      return undefined
    })
  }
}
