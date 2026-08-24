/**
 * Security negative-path tests for the /dsh-taskboard routes — previously
 * zero coverage:
 *
 *  - the method gate (405 for anything but GET/POST),
 *  - the CSRF fence (415 + invalid_input unless content-type is
 *    application/json — cross-site simple requests cannot set that header),
 *  - and a control case proving the fence blocks the content-type, not the
 *    endpoint: a proper application/json POST /tasks still creates (201).
 *
 * Minimal self-built harness (independent of tests/routes.spec.ts): the
 * routes register into a captured webServer face, the captured prefix/exact
 * handlers are mounted on a real node:http server with the webserver's
 * longest-prefix-wins dispatch (the exact SSE route included, so it cannot
 * be shadowed), and the store is a real TaskStore over a fresh mkdtemp
 * ledger per test.
 *
 * @module dsh-taskboard/tests/routes-security
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerTaskboardRoutes } from '../src/host/routes.ts'
import { TaskStore, type LedgerChange } from '../src/host/store.ts'
import type { WorkspaceFace } from '../src/host/tools.ts'
import type { TaskLedger, TaskRecord } from '../src/shared/protocol.ts'

let server: Server
let base: string
let disposeRoutes: () => void
let dir: string

// ---------------------------------------------------------------------------
// Store forwarding face: routes register ONCE against it; each test swaps in
// a fresh TaskStore (unique ledger file) so tests stay order-independent.
// ---------------------------------------------------------------------------
let store: InstanceType<typeof TaskStore>
let storeSeq = 0
const liveSubscribers = new Map<(change: LedgerChange) => void, () => void>()

function installLiveStore(next: InstanceType<typeof TaskStore>): void {
  for (const unsub of liveSubscribers.values()) unsub()
  store = next
  for (const fn of liveSubscribers.keys()) liveSubscribers.set(fn, store.subscribe(fn))
}

const storeFace = {
  load: () => store.load(),
  snapshot: () => store.snapshot(),
  get: (id: string) => store.get(id),
  subscribe: (fn: (change: LedgerChange) => void) => {
    const unsub = store.subscribe(fn)
    liveSubscribers.set(fn, unsub)
    return () => {
      liveSubscribers.delete(fn)
      unsub()
    }
  },
  backup: () => store.backup(),
  mutate: (kind: LedgerChange['kind'], mutator: (ledger: TaskLedger) => TaskRecord[] | undefined) => store.mutate(kind, mutator),
  read: <T,>(fn: (ledger: TaskLedger) => T) => store.read<T>(fn),
}

// One stub project the security tests operate in.
const WS = { id: 'ws-sec', path: 'D:/tmp/sec-fixture', title: 'Security fixture' }
const workspaces: WorkspaceFace = {
  resolveByPath: async () => undefined,
  get: id => (id === WS.id ? WS : undefined),
  list: () => [WS],
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-routes-sec-'))
  installLiveStore(new TaskStore({ file: join(dir, 'ledger-0.json') }))

  // Capture what registerTaskboardRoutes hands to the webserver.
  const routes: Array<{ kind: string; path: string; handler: (req: never, res: never) => void }> = []
  const ctxFace = {
    webServer: {
      register: (route: { kind: string; path: string; handler: (req: never, res: never) => void }) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  disposeRoutes = registerTaskboardRoutes(ctxFace as never, {
    store: storeFace as unknown as InstanceType<typeof TaskStore>,
    workspaces,
    now: () => 5_000,
  })

  // Mount the captured handlers on a REAL http server, mirroring the shared
  // webserver's longest-prefix-wins: exact routes shadow the prefix.
  server = createServer()
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const hit = routes.find(r => r.kind === 'exact' && url.pathname === r.path)
      ?? routes.find(r => r.kind === 'prefix' && url.pathname.startsWith(r.path))
    if (hit !== undefined) hit.handler(req as never, res as never)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

beforeEach(() => {
  storeSeq += 1
  installLiveStore(new TaskStore({ file: join(dir, `ledger-${storeSeq}.json`) }))
})

afterAll(async () => {
  disposeRoutes()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

describe('taskboard routes security negatives', () => {
  it('rejects PUT on a task path with 405 (and writes nothing)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks/t-zzz`, { method: 'PUT' })
    expect(res.status).toBe(405)
    expect(await res.text()).toBe('')
    expect(store.snapshot().tasks).toHaveLength(0)
  })

  it('rejects DELETE on a task path with 405', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks/t-zzz`, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(await res.text()).toBe('')
  })

  it('rejects PUT with a JSON body too — the method gate precedes everything', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks/t-zzz`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'must never be applied' }),
    })
    expect(res.status).toBe(405)
    expect(store.snapshot().tasks).toHaveLength(0)
  })

  it('fences POST text/plain with 415 invalid_input (CSRF gate)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'title=smuggled',
    })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.message).toMatch(/application\/json/)
    expect(store.snapshot().tasks).toHaveLength(0)
  })

  it('fences POST form-urlencoded too (the actual cross-site form encoding)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=smuggled&workspaceId=ws-sec',
    })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('invalid_input')
  })

  it('fences a POST with no content-type at all (bodiless)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks`, { method: 'POST' })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_input')
  })

  it('control: POST application/json creates the task (201) — the fence only blocks the content-type', async () => {
    const res = await fetch(`${base}/dsh-taskboard/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fence control', workspaceId: 'ws-sec', urgency: 'normal' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.value.id).toBe('string')
    expect(body.value.status).toBe('todo')
    // Persisted through the real store, not just answered.
    expect(store.get(body.value.id)?.title).toBe('fence control')
    expect(store.snapshot().tasks).toHaveLength(1)
  })

  it('keeps the exact SSE route mounted (not shadowed by the prefix handler)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body?.cancel() // SSE holds the socket open — release it
  })
})
