// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../src/client/api.ts'
import { BoardController } from '../src/client/controller.ts'

const state = (revision: number) => ({
  schemaVersion: 1,
  revision,
  tasks: [{ id: 'task-a', title: 'Visible task', workspaceId: 'ws-a', status: 'todo' }],
})
const workspaces = [{ id: 'ws-a', path: '/project/a', title: 'A', sessionCount: 0 }]

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('issue #42: response errors and partial refresh', () => {
  it('distinguishes empty, non-JSON, and invalid API bodies from an HTTP error', async () => {
    const client = createClient()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(client.state()).rejects.toThrow('empty response body (HTTP 200)')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>fallback</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    await expect(client.state()).rejects.toThrow('non-JSON response (HTTP 200)')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [] })))
    await expect(client.state()).rejects.toThrow('invalid API response (HTTP 200)')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    await expect(client.state()).rejects.toThrow('invalid JSON response (HTTP 200)')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: false,
      error: { code: 'not_found', message: 'missing' },
    }, { status: 404 })))
    await expect(client.state()).rejects.toThrow('taskboard: not_found: missing')
  })

  it('reports a timeout while reading an already successful response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException('late body', 'TimeoutError')) },
    }), { status: 200 })))
    let error: Error | undefined
    try { await createClient().state() } catch (caught) { error = caught as Error }
    expect(error?.message).toContain('response body timed out (HTTP 200)')
    expect((error?.cause as Error).name).toBe('TimeoutError')
  })

  it('distinguishes a request timeout before headers from a body read failure', async () => {
    const client = createClient()
    const timeout = new DOMException('before headers', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout }))
    await expect(client.state()).rejects.toMatchObject({
      message: expect.stringContaining('request timed out'),
      cause: timeout,
    })

    const interrupted = new TypeError('stream closed')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(interrupted) },
    }), { status: 200 })))
    await expect(client.state()).rejects.toMatchObject({
      message: expect.stringContaining('response body read failed (HTTP 200)'),
      cause: interrupted,
    })
  })

  it('keeps successful workspaces on a failed cold state load, then retains both snapshots on partial refresh', async () => {
    let stateFails = true
    let workspacesFail = false
    let revision = 1
    const controller = new BoardController({
      state: async () => {
        if (stateFails) throw new Error('broken state')
        return state(revision)
      },
      workspaces: async () => {
        if (workspacesFail) throw new Error('broken workspaces')
        return workspaces
      },
    } as never)

    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      workspaces,
      error: 'state: broken state',
    })
    expect(controller.getSnapshot().ledger.tasks).toHaveLength(0)

    stateFails = false
    workspacesFail = true
    await controller.refresh()
    expect(controller.getSnapshot().ledger.tasks).toHaveLength(1)
    expect(controller.getSnapshot().workspaces).toEqual(workspaces)
    expect(controller.getSnapshot().error).toBe('workspaces: broken workspaces')

    workspacesFail = false
    revision = 2
    await controller.refresh()
    expect(controller.getSnapshot().ledger.revision).toBe(2)
    expect(controller.getSnapshot().error).toBeUndefined()
    controller.dispose()
  })

  it('clears a persisted project filter only after a successful workspace list excludes it', async () => {
    localStorage.setItem('dsh-taskboard-view-v1', JSON.stringify({ workspaceId: 'removed', sortBy: 'updated' }))
    let workspacesFail = true
    const controller = new BoardController({
      state: async () => state(1),
      workspaces: async () => {
        if (workspacesFail) throw new Error('offline')
        return workspaces
      },
    } as never)

    await controller.refresh()
    expect(controller.getSnapshot().filters.workspaceId).toBe('removed')
    workspacesFail = false
    await controller.refresh()
    expect(controller.getSnapshot().filters.workspaceId).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('dsh-taskboard-view-v1')!)).not.toHaveProperty('workspaceId')
    expect(controller.getSnapshot().sortBy).toBe('updated')
    controller.dispose()

    localStorage.setItem('dsh-taskboard-view-v1', JSON.stringify({ workspaceId: 'ws-a', sortBy: 'title' }))
    const valid = new BoardController({
      state: async () => state(2),
      workspaces: async () => workspaces,
    } as never)
    await valid.refresh()
    expect(valid.getSnapshot().filters.workspaceId).toBe('ws-a')
    valid.dispose()
  })
})
