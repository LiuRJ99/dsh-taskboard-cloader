/**
 * Browser client for the /taskboard host routes: typed fetch wrappers
 * (same origin as the GUI) and the SSE subscription with revision-gap
 * reconciliation (a gap or a reconnect triggers one full state refetch).
 *
 * @module dsh-taskboard/client/api
 */
import type {
  ApiResult,
  ChangeEvent,
  CreateTaskBody,
  DeleteTaskBody,
  MoveTaskBody,
  StateResponse,
  TaskRecord,
  UpdateTaskBody,
  WorkspaceView,
} from '../shared/api.ts'
import type { CommentRecord, TaskSummary } from '../shared/protocol.ts'

/** Unwrap the envelope or throw a readable error. */
async function unwrap<T>(pending: Response | Promise<Response>): Promise<T> {
  const res = await pending
  const body = (await res.json().catch(() => null)) as ApiResult<T> | null
  if (body === null) throw new Error(`taskboard: HTTP ${res.status}`)
  if (!body.ok) throw new Error(`taskboard: ${body.error.code}: ${body.error.message}`)
  return body.value
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap<T>(res)
}

/** Route client face (the controller consumes this narrow surface). */
export interface TaskboardClient {
  state(): Promise<StateResponse>
  workspaces(): Promise<WorkspaceView[]>
  create(body: CreateTaskBody): Promise<TaskSummary>
  get(id: string): Promise<TaskRecord>
  update(id: string, body: UpdateTaskBody): Promise<TaskSummary>
  move(id: string, body: MoveTaskBody): Promise<TaskSummary>
  comment(id: string, bodyText: string): Promise<CommentRecord>
  remove(id: string, body: DeleteTaskBody): Promise<{ trashed?: boolean; purged?: boolean }>
  /** Trigger a manual run (fresh in-project session). */
  run(id: string): Promise<{ executionId: string; sessionId: string }>
  /** Subscribe to change frames; the disposer stops the stream. */
  stream(onChange: (event: ChangeEvent) => void, onGap: () => void): () => void
}

/** Build the client over fetch + EventSource. */
export function createClient(): TaskboardClient {
  return {
    state: () => unwrap<StateResponse>(fetch('/dsh-taskbord/state')),
    workspaces: () => unwrap<WorkspaceView[]>(fetch('/dsh-taskbord/workspaces')),
    create: body => post('/dsh-taskbord/tasks', body),
    get: id => unwrap<TaskRecord>(fetch(`/dsh-taskbord/tasks/${encodeURIComponent(id)}`)),
    update: (id, body) => post(`/dsh-taskbord/tasks/${encodeURIComponent(id)}/update`, body),
    move: (id, body) => post(`/dsh-taskbord/tasks/${encodeURIComponent(id)}/move`, body),
    comment: (id, bodyText) => post(`/dsh-taskbord/tasks/${encodeURIComponent(id)}/comment`, { body: bodyText }),
    remove: (id, body) => post(`/dsh-taskbord/tasks/${encodeURIComponent(id)}/delete`, body),
    run: id => post(`/dsh-taskbord/tasks/${encodeURIComponent(id)}/run`, {}),
    stream(onChange, onGap) {
      const es = new EventSource('/dsh-taskbord/events')
      let revision: number | undefined
      const hello = (event: MessageEvent): void => {
        const payload = JSON.parse(event.data) as { revision: number }
        if (revision !== undefined && payload.revision !== revision) onGap()
        revision = payload.revision
      }
      const change = (event: MessageEvent): void => {
        const payload = JSON.parse(event.data) as ChangeEvent
        // A gap means we missed frames while disconnected: reconcile fully.
        if (revision !== undefined && payload.revision !== revision + 1) onGap()
        revision = payload.revision
        onChange(payload)
      }
      es.addEventListener('hello', hello as EventListener)
      es.addEventListener('change', change as EventListener)
      es.onerror = () => { /* EventSource auto-reconnects; hello re-checks the gap */ }
      return () => {
        es.close()
      }
    },
  }
}
