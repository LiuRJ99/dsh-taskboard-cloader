/**
 * HTTP-level tests for the /dsh-taskbord routes: a real node:http server
 * wired to the real handler, driven with fetch — envelope shape, optimistic
 * versions, the user-only done move, purge semantics, and the SSE change
 * stream.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerTaskboardRoutes } from '../src/host/routes.ts'
import { TaskStore } from '../src/host/store.ts'
import type { WorkspaceFace } from '../src/host/tools.ts'

let server: Server
let base: string
let disposeRoutes: () => void
let dir: string

const workspaces: WorkspaceFace = {
  resolveByPath: async path => (path === '/proj/a' ? { id: 'ws-a' } : path === '/proj/b' ? { id: 'ws-b' } : undefined),
  get: id => id === 'ws-a' ? { id: 'ws-a', path: '/proj/a', title: 'A' } : id === 'ws-b' ? { id: 'ws-b', path: '/proj/b', title: 'B' } : undefined,
  list: () => [{ id: 'ws-a', path: '/proj/a', title: 'A' }, { id: 'ws-b', path: '/proj/b', title: 'B' }],
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-routes-'))
  server = createServer()
  const store = new TaskStore({ file: join(dir, 'ledger.json') })
  const routes: Array<{ kind: string; path: string; handler: (req: never, res: never) => void }> = []
  const ctxFace = {
    webServer: {
      register: (route: { kind: string; path: string; handler: (req: never, res: never) => void }) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  disposeRoutes = registerTaskboardRoutes(ctxFace as never, { store, workspaces, now: () => 5_000 })
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    // Mirror the real webserver's longest-prefix-wins: exact routes shadow prefixes.
    const hit = routes.find(r => r.kind === 'exact' && url.pathname === r.path)
      ?? routes.find(r => r.kind === 'prefix' && url.pathname.startsWith(r.path))
    if (hit !== undefined) hit.handler(req as never, res as never)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  disposeRoutes()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

/** POST helper. */
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

describe('taskboard routes', () => {
  it('serves an empty state baseline', async () => {
    const res = await fetch(`${base}/dsh-taskbord/state`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.value.tasks).toEqual([])
  })

  it('lists workspaces for the picker', async () => {
    const res = await fetch(`${base}/dsh-taskbord/workspaces`)
    const body = await res.json()
    expect(body.value).toEqual([{ id: 'ws-a', path: '/proj/a', title: 'A' }, { id: 'ws-b', path: '/proj/b', title: 'B' }])
  })

  it('creates a task and rejects bad payloads', async () => {
    const ok = await post('/dsh-taskbord/tasks', { title: 'Route task', workspaceId: 'ws-a', urgency: 'urgent' })
    expect(ok.status).toBe(201)
    expect(ok.json.value.status).toBe('todo')
    expect(ok.json.value.urgency).toBe('urgent')
    const bad = await post('/dsh-taskbord/tasks', { title: '', workspaceId: 'ws-a', urgency: 'urgent' })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('invalid_input')
    const unknownWs = await post('/dsh-taskbord/tasks', { title: 'x', workspaceId: 'nope', urgency: 'normal' })
    expect(unknownWs.status).toBe(404)
  })

  it('moves through the lifecycle; the USER may complete (done)', async () => {
    const created = await post('/dsh-taskbord/tasks', { title: 'Lifecycle', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const claim = await post(`/dsh-taskbord/tasks/${id}/move`, { ifVersion: 1, status: 'in_progress' })
    expect(claim.json.value.status).toBe('in_progress')
    const review = await post(`/dsh-taskbord/tasks/${id}/move`, { ifVersion: 2, status: 'in_review' })
    expect(review.json.value.status).toBe('in_review')
    const done = await post(`/dsh-taskbord/tasks/${id}/move`, { ifVersion: 3, status: 'done' })
    expect(done.json.value.status).toBe('done')
  })

  it('rejects stale versions with 409', async () => {
    const created = await post('/dsh-taskbord/tasks', { title: 'Stale', workspaceId: 'ws-a', urgency: 'relaxed' })
    const id = created.json.value.id as string
    const stale = await post(`/dsh-taskbord/tasks/${id}/move`, { ifVersion: 99, status: 'in_progress' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('version_conflict')
  })

  it('comments then soft-deletes then purges', async () => {
    const created = await post('/dsh-taskbord/tasks', { title: 'CDP', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const comment = await post(`/dsh-taskbord/tasks/${id}/comment`, { body: 'user note' })
    expect(comment.status).toBe(201)
    const soft = await post(`/dsh-taskbord/tasks/${id}/delete`, { ifVersion: 2 })
    expect(soft.json.value.trashed).toBe(true)
    const state = await (await fetch(`${base}/dsh-taskbord/state`)).json()
    const trashed = state.value.tasks.find((t: { id: string }) => t.id === id)
    expect(trashed.trashedAt).toBeGreaterThan(0)
    const purge = await post(`/dsh-taskbord/tasks/${id}/delete`, { purge: true })
    expect(purge.json.value.purged).toBe(true)
    const after = await (await fetch(`${base}/dsh-taskbord/state`)).json()
    expect(after.value.tasks.find((t: { id: string }) => t.id === id)).toBeUndefined()
  })

  it('updates fields including project rebind; unknown workspace 404', async () => {
    const created = await post('/dsh-taskbord/tasks', { title: 'Editable', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const upd = await post(`/dsh-taskbord/tasks/${id}/update`, { ifVersion: 1, title: 'Edited', urgency: 'urgent', workspaceId: 'ws-b' })
    expect(upd.status).toBe(200)
    expect(upd.json.value.version).toBe(2)
    const full = await (await fetch(`${base}/dsh-taskbord/tasks/${id}`)).json()
    expect(full.value.title).toBe('Edited')
    expect(full.value.urgency).toBe('urgent')
    expect(full.value.workspaceId).toBe('ws-b')
    const bad = await post(`/dsh-taskbord/tasks/${id}/update`, { ifVersion: 2, workspaceId: 'nope' })
    expect(bad.status).toBe(404)
  })

  it('streams SSE change events', async () => {
    const controller = new AbortController()
    const res = await fetch(`${base}/dsh-taskbord/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const createP = post('/dsh-taskbord/tasks', { title: 'SSE task', workspaceId: 'ws-a', urgency: 'urgent' })
    // read frames until a change event arrives
    let sawChange = false
    while (!sawChange) {
      const { value } = await reader.read()
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('event: change')) sawChange = true
    }
    expect(sawChange).toBe(true)
    expect(buffer).toContain('SSE task')
    const created = await createP
    expect(created.status).toBe(201)
    controller.abort()
  })
})
