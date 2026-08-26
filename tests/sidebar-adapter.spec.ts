import { describe, expect, it, vi } from 'vitest'
import { registerBetterSidebarTab } from '../src/client/sidebar-tab.tsx'
import { isWithinWorkspace, normalizePath, resolveTaskFilePath } from '../src/client/file-paths.ts'

const workspace = { id: 'ws-a', path: '/repo/app', title: 'App', sessionCount: 0 }
const task = { workspaceId: 'ws-a' } as never

function serviceStub() {
  const registered: Array<{ id: string; component: (props: never) => unknown }> = []
  const openFile = vi.fn()
  const service = {
    registerTab: vi.fn((descriptor: { id: string; component: (props: never) => unknown }) => {
      registered.push(descriptor)
      return vi.fn()
    }),
    features: ['openFile'],
    openFile,
  }
  return { service, registered, openFile }
}

describe('Better Sidebar adapter', () => {
  it('registers one optional tab through the effect disposer and wires scoped file opening', () => {
    const { service, registered, openFile } = serviceStub()
    let registeredDisposer: (() => void) | undefined
    const ctx = {
      get: (name: string) => name === 'betterSidebar' ? service : undefined,
      effect: (fn: () => unknown) => { registeredDisposer = fn() as (() => void) },
    }
    const result = registerBetterSidebarTab(ctx, {} as never)

    expect(result.available).toBe(true)
    expect(result.disposer).toBeUndefined()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe('dsh-taskboard:board')
    expect(registeredDisposer).toEqual(expect.any(Function))

    const scope = { sessionId: 'session-a', cwd: '/repo/app' }
    const referenced = vi.fn()
    const wrapper = registered[0]!.component({
      ctx: { get: () => service },
      scope,
      visible: true,
      onReferenceFile: referenced,
    } as never) as { props: { children: { props: { onOpenFile?: (path: string) => void; onReferenceFile?: (path: string) => void } } } }
    const board = wrapper.props.children
    board.props.onOpenFile!('/repo/app/src/index.ts')
    board.props.onReferenceFile!('/repo/app/src/index.ts')

    expect(openFile).toHaveBeenCalledWith(scope, '/repo/app/src/index.ts', 'index.ts')
    expect(referenced).toHaveBeenCalledWith('/repo/app/src/index.ts')
  })

  it('reports unavailable when the optional companion service is absent', () => {
    const result = registerBetterSidebarTab({ get: () => undefined }, {} as never)
    expect(result).toEqual({ available: false })
  })
})

describe('task file path resolution', () => {
  it('resolves relative worktree paths and keeps them within the session workspace', () => {
    const target = resolveTaskFilePath(
      'src/../src/index.ts',
      task,
      [workspace],
      { isolation: 'worktree', worktreePath: '/repo/app/.dsh-worktrees/t-1' } as never,
      { sessionId: 'session-a', cwd: '/repo/app' },
    )
    expect(target).toEqual({ path: '/repo/app/.dsh-worktrees/t-1/src/index.ts', available: true })
  })

  it('does not offer actions for an absolute path outside the active session workspace', () => {
    const target = resolveTaskFilePath(
      '/Users/liurenjie/.dsh/profiles/web/package.json',
      task,
      [workspace],
      undefined,
      { sessionId: 'session-a', cwd: '/repo/app' },
    )
    expect(target?.available).toBe(false)
    expect(target?.reason).toBe('outside-session-workspace')
  })

  it('normalizes roots, dot segments, and Windows separators without node:path', () => {
    expect(normalizePath('/repo/app/./src/../README.md')).toBe('/repo/app/README.md')
    expect(normalizePath('C:\\repo\\app\\src\\..\\main.ts')).toBe('C:/repo/app/main.ts')
    expect(isWithinWorkspace('C:\\repo\\app', 'C:\\REPO\\APP\\src\\main.ts')).toBe(true)
    expect(isWithinWorkspace('/', '/tmp/file.ts')).toBe(true)
    expect(isWithinWorkspace('C:\\', 'C:\\Windows\\system32.dll')).toBe(true)
    expect(isWithinWorkspace('/repo/app', '/repo/application/file.ts')).toBe(false)
  })
})
