/**
 * Resolve the task associated with one conversation session.
 *
 * Execution sessions are the durable association: every taskboard execution
 * records the session id after the fresh session has really started. The live
 * claim fallback covers an interactive agent that claimed a task directly;
 * that claim is intentionally only considered while the task is in progress.
 *
 * @module dsh-taskboard/client/session-task
 */
import type { TaskRecord } from '../shared/protocol.ts'

interface Match<T extends TaskRecord> {
  task: T
  score: number
}

/** Return the newest execution timestamp for this session on one task. */
function executionScore(task: TaskRecord, sessionId: string): number | undefined {
  let score: number | undefined
  for (const execution of task.executions) {
    if (execution.sessionId !== sessionId) continue
    const timestamp = execution.startedAt ?? execution.endedAt ?? 0
    if (score === undefined || timestamp > score) score = timestamp
  }
  return score
}

/**
 * Find the best task association for a conversation session.
 *
 * Execution matches win over live claims because a session created by the
 * board is the stronger, one-session/one-execution identity. Ties are broken
 * by the task's updated timestamp so malformed/imported ledgers remain
 * deterministic instead of making the header flicker between tasks.
 */
export function findTaskForSession(tasks: readonly TaskRecord[], sessionId: string): TaskRecord | undefined {
  if (sessionId.length === 0) return undefined

  let executionMatch: Match<TaskRecord> | undefined
  let claimMatch: Match<TaskRecord> | undefined
  for (const task of tasks) {
    // A purged task cannot be opened from the board, even if an old execution
    // record still carries the session id.
    if (task.trashedAt !== undefined) continue

    const execution = executionScore(task, sessionId)
    if (execution !== undefined && (
      executionMatch === undefined
      || execution > executionMatch.score
      || (execution === executionMatch.score && task.updatedAt > executionMatch.task.updatedAt)
    )) {
      executionMatch = { task, score: execution }
    }

    // claimedBy is ephemeral: syncClaim clears it as soon as the task leaves
    // in_progress. It is still useful for the active interactive-claim case.
    if (
      task.status === 'in_progress'
      && task.claimedBy === sessionId
      && (
        claimMatch === undefined
        || task.updatedAt > claimMatch.task.updatedAt
      )
    ) {
      claimMatch = { task, score: task.updatedAt }
    }
  }

  return executionMatch?.task ?? claimMatch?.task
}
