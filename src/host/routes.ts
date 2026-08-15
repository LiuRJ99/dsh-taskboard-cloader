/**
 * /agent-taskboard routes on the shared DSH webserver: a JSON API for the
 * GUI's human operations (create/update/move/comment/delete — actor `user`,
 * the done move IS allowed here) plus an SSE stream mirroring every
 * committed ledger mutation.
 *
 * All domain validation goes through the shared protocol pure functions; the
 * route layer only maps transport to envelope.
 *
 * @module dsh-taskboard/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  asStatus,
  asUrgency,
  canTransition,
  newCommentId,
  newTaskId,
  normalizeBody,
  normalizeExecution,
  normalizePrompt,
  normalizeTitle,
  summarize,
  type TaskRecord,
} from '../shared/protocol.ts'
import { ROUTE_PREFIX, SSE_PATH, type ApiFail, type ApiResult } from '../shared/api.ts'
import type { TaskStore } from './store.ts'
import type { WorkspaceFace } from './tools.ts'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** The workspaces face routes need (same narrow shape as tools). */
export type RoutesWorkspaceFace = WorkspaceFace

/** Options. */
export interface TaskboardRoutesOptions {
  store: TaskStore
  workspaces: RoutesWorkspaceFace
  now: () => number
  /** Manual-run hook (the execution service); absent → 501. */
  run?: (taskId: string) => Promise<{ ok: true; executionId: string; sessionId: string } | { ok: false; error: string }>
}

/** JSON-envelope writer. */
function json(res: ServerResponse, payload: ApiResult<unknown>, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Domain failure → envelope + HTTP status. */
function fail(code: ApiFail['error']['code'], message: string): { res: ApiFail; status: number } {
  const status = code === 'invalid_input' ? 400
    : code === 'not_found' ? 404
      : code === 'version_conflict' ? 409
        : code === 'forbidden' ? 403
          : 500
  return { res: { ok: false, error: { code, message } }, status }
}

/** Read one JSON body (null on parse failure). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** String field accessor (null when absent/not a string). */
function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  return typeof v === 'string' ? v : null
}

/** Number field accessor (undefined when absent; null when present but not a number). */
function num(body: Record<string, unknown>, key: string): number | undefined | null {
  const v = body[key]
  if (v === undefined) return undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Map a thrown domain error to the envelope. */
function toFail(error: unknown): { res: ApiFail; status: number } {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.startsWith('Error: ') ? message.slice(7).split(':')[0] : undefined
  const known: ApiFail['error']['code'][] = ['invalid_input', 'not_found', 'version_conflict', 'invalid_transition', 'forbidden', 'internal']
  if (code !== undefined && (known as string[]).includes(code)) {
    return fail(code as ApiFail['error']['code'], message.slice(7 + code.length + 2))
  }
  if (code === 'workspace_mismatch') return fail('forbidden', message.slice(7 + code.length + 2))
  return fail('invalid_input', message)
}

/**
 * Register the taskboard routes.
 * @param ctx - context carrying the webServer service.
 * @param options - store + workspaces + clock.
 * @returns the disposer.
 */
export function registerTaskboardRoutes(ctx: Context, options: TaskboardRoutesOptions): () => void {
  const { store, workspaces } = options
  const subscribers = new Set<ServerResponse>()
  let heartbeat: NodeJS.Timeout | undefined

  const broadcast = (change: { revision: number; kind: string; tasks: readonly TaskRecord[] }): void => {
    const frame = `event: change\ndata: ${JSON.stringify({ revision: change.revision, kind: change.kind, tasks: change.tasks.map(summarize) })}\n\n`
    for (const res of subscribers) res.write(frame)
  }
  store.subscribe(broadcast)

  const taskPath = (id: string, action?: string): RegExp | null => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = action === undefined
      ? `^${ROUTE_PREFIX}/tasks/${escaped}$`
      : `^${ROUTE_PREFIX}/tasks/${escaped}/${action}$`
    return new RegExp(pattern)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const pathname = url.pathname

      // ---------------------------------------------------------------- GET
      if (req.method === 'GET') {
        if (pathname === `${ROUTE_PREFIX}/state`) {
          await store.load()
          json(res, { ok: true, value: store.snapshot() })
          return
        }
        if (pathname === `${ROUTE_PREFIX}/workspaces`) {
          json(res, { ok: true, value: workspaces.list() })
          return
        }
        const taskMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)$`))
        if (taskMatch !== null) {
          const task = store.get(taskMatch[1]!)
          if (task === undefined) { const f = fail('not_found', 'no such task'); json(res, f.res, f.status); return }
          json(res, { ok: true, value: task })
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      // CSRF fence: cross-site simple requests cannot set application/json.
      const contentType = req.headers['content-type'] ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        const f = fail('invalid_input', 'content-type must be application/json')
        json(res, f.res, 415)
        return
      }
      const body = await readBody(req)
      if (body === null) {
        const f = fail('invalid_input', 'body is not a JSON object')
        json(res, f.res, 400)
        return
      }

      // ------------------------------------------------- POST /tasks (create)
      if (pathname === `${ROUTE_PREFIX}/tasks`) {
        try {
          const title = normalizeTitle(str(body, 'title') ?? '')
          const workspaceId = str(body, 'workspaceId') ?? ''
          if (workspaces.get(workspaceId) === undefined) throw new Error('Error: not_found: unknown workspace')
          const urgency = asUrgency(str(body, 'urgency') ?? '')
          const status = str(body, 'status') === null ? 'todo' as const : asStatus(str(body, 'status')!)
          const execution = normalizeExecution((body.execution as { mode?: string; cron?: string } | undefined) ?? {}, options.now())
          const model = body.model as { provider: string; model: string } | undefined
          const now = options.now()
          const task: TaskRecord = {
            id: newTaskId(),
            title,
            description: (str(body, 'description') ?? '').trim(),
            prompt: normalizePrompt(str(body, 'prompt') ?? undefined),
            workspaceId,
            urgency,
            status,
            blocked: false,
            execution,
            model,
            version: 1,
            createdAt: now,
            updatedAt: now,
            createdBy: { kind: 'user' },
            updatedBy: { kind: 'user' },
            comments: [],
            executions: [],
          }
          await store.mutate('task-created', ledger => {
            ledger.tasks.push(task)
            return [task]
          })
          json(res, { ok: true, value: summarize(task) }, 201)
        } catch (error) {
          const f = toFail(error)
          json(res, f.res, f.status)
        }
        return
      }

      // ------------------------------------------- POST /tasks/:id/{action}
      const actionMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)/(\\w+)$`))
      if (actionMatch !== null) {
        const id = actionMatch[1]!
        const action = actionMatch[2]!
        try {
          const task = store.get(id)
          if (task === undefined) throw new Error('Error: not_found: no such task')
          if (action === 'update') {
            const ifVersion = num(body, 'ifVersion')
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const next = structuredClone(task)
            const title = str(body, 'title')
            if (title !== null) next.title = normalizeTitle(title)
            const description = str(body, 'description')
            if (description !== null) next.description = description.trim()
            const prompt = str(body, 'prompt')
            if (prompt !== null) next.prompt = normalizePrompt(prompt)
            const urgency = str(body, 'urgency')
            if (urgency !== null) next.urgency = asUrgency(urgency)
            // GUI-only rebind to another project; validated against the workspace registry.
            const workspaceId = str(body, 'workspaceId')
            if (workspaceId !== null) {
              if (workspaces.get(workspaceId) === undefined) throw new Error('Error: not_found: unknown workspace')
              next.workspaceId = workspaceId
            }
            if (typeof body.blocked === 'boolean') next.blocked = body.blocked
            // The GUI (task owner surface) may edit model/execution; null clears the model.
            if (body.execution !== undefined) next.execution = normalizeExecution(body.execution as { mode?: string; cron?: string }, options.now())
            if (body.model === null) next.model = undefined
            else if (body.model !== undefined) next.model = body.model as { provider: string; model: string }
            next.version = task.version + 1
            next.updatedAt = options.now()
            next.updatedBy = { kind: 'user' }
            await store.mutate('task-updated', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: summarize(next) })
            return
          }
          if (action === 'move') {
            const ifVersion = num(body, 'ifVersion')
            const status = str(body, 'status') ?? ''
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const to = asStatus(status)
            if (!canTransition(task.status, to)) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → ${to}`)
            const next = structuredClone(task)
            next.status = to
            next.version = task.version + 1
            next.updatedAt = options.now()
            next.updatedBy = { kind: 'user' }
            if (task.status === 'todo' && to === 'in_progress') next.blocked = false
            await store.mutate('task-moved', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: summarize(next) })
            return
          }
          if (action === 'comment') {
            const bodyText = str(body, 'body') ?? ''
            const comment = { id: newCommentId(), body: normalizeBody(bodyText), version: 1, createdAt: options.now() }
            const next = structuredClone(task)
            next.comments.push(comment)
            next.version = task.version + 1
            next.updatedAt = options.now()
            await store.mutate('comment-added', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: comment }, 201)
            return
          }
          if (action === 'delete') {
            const purge = body.purge === true
            if (purge) {
              if (task.trashedAt === undefined) throw new Error('Error: invalid_input: purge requires a trashed task (soft-delete first)')
              await store.mutate('task-deleted', ledger => {
                ledger.tasks = ledger.tasks.filter(t => t.id !== id)
                return []
              })
              json(res, { ok: true, value: { purged: true } })
              return
            }
            const ifVersion = num(body, 'ifVersion')
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const next = structuredClone(task)
            next.trashedAt = options.now()
            next.version = task.version + 1
            await store.mutate('task-deleted', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: { trashed: true } })
            return
          }
          if (action === 'run') {
            if (options.run === undefined) {
              const f = fail('invalid_input', 'execution service unavailable')
              json(res, f.res, 501)
              return
            }
            const result = await options.run(id)
            if (result.ok) json(res, { ok: true, value: result }, 202)
            else {
              const f = fail('invalid_input', result.error)
              json(res, f.res, f.status)
            }
            return
          }
          const f = fail('not_found', `unknown action ${action}`)
          json(res, f.res, f.status)
        } catch (error) {
          const f = toFail(error)
          json(res, f.res, f.status)
        }
        return
      }

      void taskPath
      res.writeHead(404)
      res.end()
    } catch (error) {
      const f = fail('internal', error instanceof Error ? error.message : String(error))
      json(res, f.res, f.status)
    }
  }

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // Baseline frame: the client reconciles by revision and refetches state on gaps.
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`)
    subscribers.add(res)
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const current of subscribers) current.write(': ping\n\n')
      }, HEARTBEAT_MS)
    }
    req.on('close', () => {
      subscribers.delete(res)
      if (subscribers.size === 0 && heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) res.end()
    subscribers.clear()
  }
}
