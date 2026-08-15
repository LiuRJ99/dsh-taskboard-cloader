/**
 * Wire contract for the /agent-taskboard host routes: the JSON envelope,
 * request/response shapes, and SSE event payloads shared by the host routes
 * and the browser client.
 *
 * @module dsh-agent-taskboard/shared/api
 */
import type { TaskLedger, TaskRecord, TaskSummary } from './protocol.ts'

export type { TaskRecord }

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/agent-taskboard'

/** SSE stream path (exact route; longest-prefix wins keep it disjoint). */
export const SSE_PATH = '/agent-taskboard/events'

/** Stable error codes (mirror the tool-level codes plus HTTP mapping). */
export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'version_conflict'
  | 'invalid_transition'
  | 'forbidden'
  | 'internal'

/** Success envelope. */
export type ApiOk<T> = { ok: true; value: T }

/** Failure envelope. */
export type ApiFail = { ok: false; error: { code: ApiErrorCode; message: string } }

/** The envelope either way. */
export type ApiResult<T> = ApiOk<T> | ApiFail

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** Full-state response (the reconnect baseline after an SSE gap). */
export type StateResponse = TaskLedger

/** Workspace listing for the UI pickers. */
export type WorkspaceView = { id: string; path: string; title: string; sessionCount: number }

/** Create-task request body (actor is always the GUI user). */
export type CreateTaskBody = {
  title: string
  workspaceId: string
  urgency: string
  description?: string
  prompt?: string
  execution?: { mode?: string; cron?: string }
  model?: { provider: string; model: string }
}

/** Update-task request body (ifVersion mandatory). */
export type UpdateTaskBody = {
  ifVersion: number
  title?: string
  description?: string
  prompt?: string
  urgency?: string
  blocked?: boolean
  /** Rebind the task to another project (GUI owner surface only). */
  workspaceId?: string
  execution?: { mode?: string; cron?: string }
  model?: { provider: string; model: string } | null
}

/** Move-task request body (ifVersion mandatory; the user MAY move to done). */
export type MoveTaskBody = { ifVersion: number; status: string }

/** Comment request body. */
export type CommentBody = { body: string }

/** Delete request body (purge=true physically removes a trashed task). */
export type DeleteTaskBody = { ifVersion?: number; purge?: boolean }

/** Run request body (P3). */
export type RunTaskBody = Record<string, never>

/** One task (full record) response. */
export type TaskResponse = TaskRecord

/** Summary response used by list-ish endpoints. */
export type SummaryResponse = { tasks: TaskSummary[] }

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** Change frame pushed on every committed ledger mutation. */
export type ChangeEvent = {
  revision: number
  kind: 'task-created' | 'task-updated' | 'task-moved' | 'task-deleted' | 'comment-added' | 'execution-recorded'
  tasks: TaskSummary[]
}
