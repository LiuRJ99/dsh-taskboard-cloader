// @vitest-environment jsdom
/**
 * Client-half smoke: apply() against a fake client context with stubbed
 * fetch (route responses) — proves the whole client half (styles, sidebar
 * entry, board mount, controller, SSE wiring) starts and renders into a
 * jsdom document without throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Stub a route payload. */
function routeResponse(path: string): unknown {
  if (path === '/dsh-taskboard/state') {
    return { ok: true, value: { schemaVersion: 1, revision: 3, tasks: [] } }
  }
  if (path === '/dsh-taskboard/workspaces') {
    return { ok: true, value: [{ id: 'ws-a', path: '/proj/a', title: 'A', sessionCount: 0 }] }
  }
  throw new Error(`unexpected fetch ${path}`)
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const path = String(input)
  return new Response(JSON.stringify(routeResponse(path)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
})

class EventSourceMock {
  static instances: EventSourceMock[] = []
  onerror: (() => void) | null = null
  constructor(public url: string) { EventSourceMock.instances.push(this) }
  addEventListener(): void { /* frames not exercised here */ }
  close(): void { /* no-op */ }
}

describe('client half', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    for (const d of disposers.splice(0)) d()
    vi.unstubAllGlobals()
  })

  it('apply() mounts styles, waits for panes, and survives without panes', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const { apply } = await import('../src/client/index.ts')

    // REAL cordis effect semantics: callback runs immediately, its return
    // value is the disposer (this fake caught nothing when the plugin passed
    // a single-layer arrow that cordis executed as immediate teardown).
    const disposers: unknown[] = []
    const ctx = { get: () => undefined, effect: (fn: () => unknown) => { disposers.push(fn()) } }
    expect(() => apply(ctx as never)).not.toThrow()

    // Styles injected exactly once.
    expect(document.getElementById('dsh-taskboard-styles')).not.toBeNull()

    // No panes exist: mounts wait via observers without throwing. Give the
    // controller's initial refresh a tick.
    await new Promise(r => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalled()

    // Nothing was torn down by the effect itself (the bug this guards: an
    // immediate teardown would have closed the SSE stream already).
    expect(EventSourceMock.instances.length).toBe(1)
    expect(EventSourceMock.instances[0]!.url).toBe('/dsh-taskboard/events')
    expect(disposers.every(d => typeof d === 'function')).toBe(true)

    // Explicit dispose through the captured disposers.
    for (const fn of disposers) (fn as () => void)()
  })

  it('sidebar entry places itself once a sidebar pane exists', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const { createClient } = await import('../src/client/api.ts')
    const { BoardController } = await import('../src/client/controller.ts')
    const { mountSidebarEntry } = await import('../src/client/sidebar-entry.ts')

    // Build the REAL shell shape (reverse-engineered from the live GUI):
    // sidebarCol pane > wrapper > root > [logoRow(brand aria button)] +
    // direct-child newSession BUTTON (the family plugins' fallback target).
    const column = document.createElement('div')
    column.className = 'pI_x6G_sidebarCol'
    column.dataset.pane = 'sidebar'
    const root = document.createElement('div')
    root.className = 'hHd-Xa_root'
    const row = document.createElement('div')
    row.className = 'hHd-Xa_logoRow'
    const brand = document.createElement('button')
    brand.className = 'hHd-Xa_brand hHd-Xa_wide'
    brand.setAttribute('aria-label', '新建会话')
    brand.innerHTML = '<svg></svg>'
    row.append(brand)
    const newSession = document.createElement('button')
    newSession.textContent = '新会话'
    root.append(row, newSession)
    const wrapper = document.createElement('div')
    wrapper.append(root)
    column.append(wrapper)
    document.body.append(column)

    const controller = new BoardController(createClient())
    const dispose = mountSidebarEntry(controller)
    disposers.push(dispose)

    await new Promise(r => setTimeout(r, 20))
    const entry = document.querySelector('[data-dsh-atb-entry]')
    expect(entry).not.toBeNull()
    // Entry is a direct child of the root, right after the newSession button
    // (the direct-child fallback anchor — same landing spot as the family
    // plugins: after the button block, before the workspace browser).
    expect(entry!.parentElement).toBe(root)
    expect(entry!.previousElementSibling).toBe(newSession)

    controller.toggleBoard()
    expect((entry as HTMLElement).dataset.active).toBe('true')
  })
})
