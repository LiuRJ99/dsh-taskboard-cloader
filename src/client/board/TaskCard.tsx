/**
 * One board card: urgency edge, title, project/urgency/model/schedule/
 * blocked/trashed badges, comment count, and the last execution outcome.
 * Click opens the detail pane; cards in the backlog/todo columns are
 * draggable between those two columns (HTML5 drag & drop).
 *
 * @module dsh-taskboard/client/board/TaskCard
 */
import type { BoardController } from '../controller.ts'
import type { TaskRecord } from '../../shared/protocol.ts'
import { fmtTime } from './TaskBoard.tsx'

const URGENCY_LABEL: Record<TaskRecord['urgency'], string> = { urgent: '紧急', normal: '一般', relaxed: '不急' }
const OUTCOME_LABEL: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }

/** dataTransfer type carrying the dragged task id. */
export const DRAG_TYPE = 'application/x-dsh-atb-task'

/**
 * The card view.
 * @param task - the task record.
 * @param controller - the controller.
 * @param draggable - enable dragging.
 * @param onAlert - show an alert message (replaces native alert).
 */
export function TaskCard({ task, controller, draggable = false, onAlert }: { task: TaskRecord; controller: BoardController; draggable?: boolean; onAlert?: (msg: string) => void }) {
  const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : undefined
  return (
    <button
      type="button"
      className="dsh-atb-card"
      data-urgency={task.urgency}
      draggable={draggable}
      onDragStart={(e) => {
        // Block drag if a session is still executing this task
        const running = task.executions.find(ex => ex.outcome === 'running')
        if (running !== undefined) {
          e.preventDefault()
          const msg = `该任务正在由【${task.title}】会话执行，不能拖动`
          if (onAlert !== undefined) onAlert(msg)
          else alert(msg)
          return
        }
        e.dataTransfer.setData(DRAG_TYPE, task.id)
        e.dataTransfer.effectAllowed = 'move'
        e.currentTarget.dataset.dragging = 'true'
      }}
      onDragEnd={(e) => { delete e.currentTarget.dataset.dragging }}
      onClick={() => controller.select(task.id)}
    >
      <div className="dsh-atb-card-title">{task.title}</div>
      <div className="dsh-atb-card-meta">
        <span className="dsh-atb-badge">{URGENCY_LABEL[task.urgency]}</span>
        {task.blocked && <span className="dsh-atb-badge" data-kind="blocked">受阻</span>}
        {task.execution.mode === 'scheduled' && (
          <span className="dsh-atb-badge" data-kind="scheduled">⏰ {fmtTime(task.execution.nextRunAt)}</span>
        )}
        {task.model !== undefined && <span className="dsh-atb-badge">{task.model.model}</span>}
        {task.status === 'done' && <span className="dsh-atb-badge" data-kind="done">完成</span>}
        {last !== undefined && (
          <span className="dsh-atb-badge" data-kind={last.outcome === 'running' ? 'running' : last.outcome}>
            {OUTCOME_LABEL[last.outcome] ?? last.outcome}
          </span>
        )}
        {task.comments.length > 0 && <span>💬 {task.comments.length}</span>}
        {task.trashedAt !== undefined && <span className="dsh-atb-badge" data-kind="trashed">待清除</span>}
        <span style={{ marginLeft: 'auto' }}>{fmtTime(task.updatedAt)}</span>
      </div>
    </button>
  )
}
