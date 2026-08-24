/**
 * Pure display helpers shared by the board components.
 *
 * Review P2: these lived in TaskBoard.tsx and were imported back out by
 * TaskCard/TaskDetail/TaskFormModal, forming import cycles with the view
 * root. They have no component dependencies — they belong here.
 *
 * @module dsh-taskboard/client/board/format
 */
import type { TaskRecord } from '../../shared/protocol.ts'

/** Format an epoch ms as a short local stamp. */
export function fmtTime(ms: number | undefined): string {
  if (ms === undefined) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A claim idle for longer than this is highlighted as stale (ms). */
export const STALE_CLAIM_MS = 30 * 60_000

/** Whether the task's claim is stale (in_progress, held, idle too long). */
export function isStaleClaim(task: TaskRecord, now: number): boolean {
  return task.status === 'in_progress' && task.claimedAt !== undefined && now - task.claimedAt > STALE_CLAIM_MS
}
