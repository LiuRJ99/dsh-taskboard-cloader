// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { BoardController, ControllerState } from '../src/client/controller.ts'
import { TaskboardSessionHeaderAction } from '../src/client/session-header-action.tsx'
import { findTaskForSession } from '../src/client/session-task.ts'
import type { TaskRecord } from '../src/shared/protocol.ts'

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    title: '任务 A',
    description: '',
    prompt: '',
    workspaceId: 'workspace-a',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
    ...overrides,
  }
}

function controllerWithTasks(tasks: readonly TaskRecord[]) {
  let state = { ledger: { schemaVersion: 1, revision: 1, tasks: [...tasks] } } as ControllerState
  const listeners = new Set<() => void>()
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as BoardController
  return {
    controller,
    replace(next: readonly TaskRecord[]) {
      state = { ...state, ledger: { ...state.ledger, tasks: [...next] } }
      for (const listener of listeners) listener()
    },
  }
}

const sessionId = 'session-taskboard-a-1234'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('findTaskForSession', () => {
  it('matches a durable execution session and ignores ordinary sessions', () => {
    const task = makeTask({
      executions: [{ id: 'execution-a', trigger: 'manual', outcome: 'succeeded', sessionId }],
    })

    expect(findTaskForSession([task], sessionId)).toBe(task)
    expect(findTaskForSession([task], 'session-ordinary')).toBeUndefined()
  })

  it('falls back to the active interactive claim', () => {
    const task = makeTask({
      status: 'in_progress',
      claimedBy: sessionId,
    })

    expect(findTaskForSession([task], sessionId)).toBe(task)
  })

  it('prefers execution identity and excludes trashed tasks', () => {
    const claimed = makeTask({ id: 'claimed', updatedAt: 100, status: 'in_progress', claimedBy: sessionId })
    const executed = makeTask({
      id: 'executed',
      updatedAt: 10,
      executions: [{ id: 'execution-a', trigger: 'manual', outcome: 'succeeded', sessionId, startedAt: 20 }],
    })
    const trashed = makeTask({
      id: 'trashed',
      trashedAt: 200,
      executions: [{ id: 'execution-b', trigger: 'manual', outcome: 'succeeded', sessionId, startedAt: 30 }],
    })

    expect(findTaskForSession([claimed, executed, trashed], sessionId)?.id).toBe('executed')
    expect(findTaskForSession([trashed], sessionId)).toBeUndefined()
  })
})

describe('TaskboardSessionHeaderAction', () => {
  it('renders only for a matching session and opens the matched task', async () => {
    const task = makeTask({
      executions: [{ id: 'execution-a', trigger: 'manual', outcome: 'running', sessionId }],
    })
    const { controller } = controllerWithTasks([task])
    const onOpenTask = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    root.render(
      <TaskboardSessionHeaderAction
        sessionId={sessionId}
        controller={controller}
        onOpenTask={onOpenTask}
      />,
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    const link = host.querySelector<HTMLButtonElement>('[data-dsh-atb-session-link]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('看板')
    expect(link?.dataset.taskId).toBe('task-a')

    link?.click()
    expect(onOpenTask).toHaveBeenCalledWith(task, sessionId)

    root.unmount()
  })

  it('removes the link when the live ledger no longer has the association', async () => {
    const task = makeTask({
      executions: [{ id: 'execution-a', trigger: 'manual', outcome: 'running', sessionId }],
    })
    const { controller, replace } = controllerWithTasks([task])
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    root.render(
      <TaskboardSessionHeaderAction
        sessionId={sessionId}
        controller={controller}
        onOpenTask={() => {}}
      />,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.querySelector('[data-dsh-atb-session-link]')).not.toBeNull()

    replace([])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.querySelector('[data-dsh-atb-session-link]')).toBeNull()

    root.unmount()
  })
})
