/**
 * The main board view: toolbar (project filter, urgency chips, secondary tab,
 * composer), five status columns, the detail pane, and the new-task modal.
 *
 * @module dsh-taskboard/client/board/TaskBoard
 */
import { useSyncExternalStore } from 'react'
import type { BoardController, ControllerState } from '../controller.ts'
import type { TaskRecord, TaskStatus, Urgency } from '../../shared/protocol.ts'
import { MAIN_STATUSES } from '../../shared/protocol.ts'
import { DRAG_TYPE, TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { TaskFormModal } from './TaskFormModal.tsx'

/** Column labels. */
const COLUMN_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: '待规划',
  todo: '待办',
  in_progress: '进行中',
  in_review: '待验收',
  done: '已完成',
  canceled: '已取消',
  archived: '已归档',
}

/** The two columns between which cards may be dragged both ways. */
const DRAGGABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['backlog', 'todo'])

/** Urgency chip labels. */
const URGENCY_LABELS: Readonly<Record<Urgency, string>> = {
  urgent: '紧急',
  normal: '一般',
  relaxed: '不急',
}

/** Format an epoch ms as a short local stamp. */
export function fmtTime(ms: number | undefined): string {
  if (ms === undefined) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Apply the active filters to a task list. */
function filterTasks(state: ControllerState, tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter(t =>
    (state.filters.workspaceId === undefined || t.workspaceId === state.filters.workspaceId)
    && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(t.urgency)))
}

/**
 * The board view root.
 * @param controller - the controller.
 */
export function TaskBoard({ controller }: { controller: BoardController }) {
  const state = useSyncExternalStore(
    cb => controller.subscribe(cb),
    () => controller.getSnapshot(),
  )
  const live = filterTasks(state, state.ledger.tasks.filter(t => t.trashedAt === undefined))
  const selected = state.selectedId === undefined ? undefined : state.ledger.tasks.find(t => t.id === state.selectedId)

  return (
    <div className="dsh-atb-board">
      <div className="dsh-atb-toolbar">
        <h2 className="dsh-atb-title">Agent 任务看板</h2>
        <span className="dsh-atb-count">{live.length} 任务 · rev {state.ledger.revision}</span>
        <div className="dsh-atb-spacer" />
        <select
          className="dsh-atb-select"
          value={state.filters.workspaceId ?? ''}
          onChange={e => controller.setWorkspaceFilter(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">全部项目</option>
          {state.workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title || ws.path}</option>)}
        </select>
        {(['urgent', 'normal', 'relaxed'] as const).map(u => (
          <button
            key={u}
            type="button"
            className="dsh-atb-chip"
            data-urgency={u}
            data-on={state.filters.urgencies.includes(u)}
            onClick={() => controller.toggleUrgency(u)}
          >
            <span className="dsh-atb-dot" data-urgency={u} />
            {URGENCY_LABELS[u]}
          </button>
        ))}
        <button type="button" className="dsh-atb-btn" onClick={() => controller.toggleSecondary()}>
          {state.secondaryOpen ? '返回看板' : '其它任务'}
        </button>
        <button type="button" className="dsh-atb-btn" data-primary="true" onClick={() => controller.setComposer(true)}>
          + 新建任务
        </button>
      </div>

      {state.error !== undefined && <div className="dsh-atb-error">{state.error}</div>}

      {state.secondaryOpen
        ? <SecondaryTab controller={controller} tasks={filterTasks(state, state.ledger.tasks)} />
        : (
          <div className="dsh-atb-columns">
            {MAIN_STATUSES.map(status => {
              const columnTasks = live.filter(t => t.status === status)
              const dropTarget = DRAGGABLE_STATUSES.has(status)
              return (
                <div
                  className="dsh-atb-column"
                  key={status}
                  onDragOver={dropTarget
                    ? (e) => {
                        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          e.currentTarget.dataset.dragover = 'true'
                        }
                      }
                    : undefined}
                  onDragLeave={dropTarget
                    ? (e) => { delete e.currentTarget.dataset.dragover }
                    : undefined}
                  onDrop={dropTarget
                    ? (e) => {
                        e.preventDefault()
                        delete e.currentTarget.dataset.dragover
                        const id = e.dataTransfer.getData(DRAG_TYPE)
                        if (id.length === 0) return
                        const task = state.ledger.tasks.find(t => t.id === id)
                        if (task === undefined || task.status === status) return
                        void controller.move(id, task.version, status)
                      }
                    : undefined}
                >
                  <div className="dsh-atb-colhead">
                    {COLUMN_LABELS[status]}
                    <span className="dsh-atb-colcount">{columnTasks.length}</span>
                  </div>
                  <div className="dsh-atb-cards">
                    {columnTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        controller={controller}
                        draggable={dropTarget}
                      />
                    ))}
                    {columnTasks.length === 0 && <div className="dsh-atb-empty">无任务</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {selected !== undefined && (
        <div className="dsh-atb-detailpanel">
          <TaskDetail task={selected} controller={controller} />
        </div>
      )}

      {state.composerOpen && (
        <TaskFormModal
          controller={controller}
          task={state.editingId === undefined ? undefined : state.ledger.tasks.find(t => t.id === state.editingId)}
        />
      )}
    </div>
  )
}

/** Secondary tab: canceled/archived/trashed rows. */
function SecondaryTab({ controller, tasks }: { controller: BoardController; tasks: TaskRecord[] }) {
  const rows = tasks.filter(t => t.status === 'canceled' || t.status === 'archived' || t.trashedAt !== undefined)
  return (
    <div className="dsh-atb-secondary">
      {rows.length === 0 && <div className="dsh-atb-empty">无已取消 / 已归档 / 已删除任务</div>}
      {rows.map(task => (
        <TaskCard key={task.id} task={task} controller={controller} />
      ))}
      {void controller}
    </div>
  )
}
