/**
 * Session-header action for taskboard-backed conversations.
 *
 * The DSH conversation shell supplies `sessionId` to every
 * `conversation.session.header.actions` entry. This component only renders
 * when the taskboard controller's live ledger can associate that session with
 * a task, keeping ordinary conversations completely unchanged.
 *
 * @module dsh-taskboard/client/session-header-action
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { BoardController } from './controller.ts'
import type { TaskRecord } from '../shared/protocol.ts'
import { findTaskForSession } from './session-task.ts'

/** The framework-provided part of a session-scoped header action. */
export interface SessionHeaderActionStandardProps {
  sessionId: string
}

/** Additional faces closed over by the taskboard registration. */
export interface TaskboardHeaderActionProps extends SessionHeaderActionStandardProps {
  controller: BoardController
  onOpenTask: (task: TaskRecord, sessionId: string) => void
}

/**
 * Render the compact taskboard link for a task-associated session.
 * @param props - controller, current session id, and navigation callback.
 */
export function TaskboardSessionHeaderAction({
  sessionId,
  controller,
  onOpenTask,
}: TaskboardHeaderActionProps): ReactNode {
  const state = useSyncExternalStore(
    callback => controller.subscribe(callback),
    () => controller.getSnapshot(),
  )
  const task = findTaskForSession(state.ledger.tasks, sessionId)
  if (task === undefined) return null

  return (
    <button
      type="button"
      className="dsh-atb-session-link"
      data-dsh-atb-session-link=""
      data-task-id={task.id}
      aria-label={`打开任务看板：${task.title}`}
      title={`打开任务看板：${task.title}`}
      onClick={() => onOpenTask(task, sessionId)}
    >
      <span className="dsh-atb-session-link-icon" aria-hidden="true">▦</span>
      <span>看板</span>
    </button>
  )
}

/**
 * Adapt the taskboard action to DSH's slot component shape.
 * @param controller - shared taskboard controller.
 * @param onOpenTask - native/legacy navigation chosen by the client entry.
 * @returns a session-scoped slot component.
 */
export function createTaskboardSessionHeaderAction(
  controller: BoardController,
  onOpenTask: (task: TaskRecord, sessionId: string) => void,
): (props: SessionHeaderActionStandardProps) => ReactNode {
  return function TaskboardSessionHeaderSlot(props: SessionHeaderActionStandardProps): ReactNode {
    return (
      <TaskboardSessionHeaderAction
        sessionId={props.sessionId}
        controller={controller}
        onOpenTask={onOpenTask}
      />
    )
  }
}
