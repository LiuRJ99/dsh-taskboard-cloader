/**
 * The task detail pane — visually polished: urgency accent header with
 * status pill and meta chips, card-wrapped description/prompt, chat-style
 * comment bubbles distinguishing user vs agent authors, a timeline of
 * executions with outcome pills, grouped actions (run / transitions /
 * danger zone), and the user comment composer.
 *
 * @module dsh-agent-taskboard/client/board/TaskDetail
 */
import { useState, type ReactNode } from 'react'
import type { BoardController } from '../controller.ts'
import type { TaskRecord } from '../../shared/protocol.ts'
import { canTransition } from '../../shared/protocol.ts'
import { fmtTime } from './TaskBoard.tsx'

/** Statuses a user may move this task to, per the state machine. */
function moveTargets(task: TaskRecord): TaskRecord['status'][] {
  const all: TaskRecord['status'][] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived']
  return all.filter(to => canTransition(task.status, to))
}

const MOVE_LABEL: Record<string, string> = {
  backlog: '待规划', todo: '待办', in_progress: '进行中', in_review: '待验收',
  done: '完成', canceled: '取消', archived: '归档',
}
const STATUS_LABEL: Record<string, string> = { ...MOVE_LABEL }
const URGENCY_LABEL: Record<string, string> = { urgent: '紧急', normal: '一般', relaxed: '不急' }
const OUTCOME_LABEL: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }

/** Compact session-id display. */
function shortId(id: string | undefined): string {
  if (id === undefined) return ''
  return id.replace(/^session-/, '').slice(0, 8)
}

/** Execution duration between start and end. */
function duration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (startedAt === undefined || endedAt === undefined) return ''
  const s = Math.max(0, Math.round((endedAt - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

/** Small labelled meta chip. */
function Chip({ icon, children, tone }: { icon?: string; children: ReactNode; tone?: string }) {
  return <span className="dsh-atb-chip2" data-tone={tone}>{icon !== undefined && <span className="dsh-atb-chip2-icon">{icon}</span>}{children}</span>
}

/**
 * The detail view.
 * @param task - the task record.
 * @param controller - the controller.
 */
export function TaskDetail({ task, controller }: { task: TaskRecord; controller: BoardController }) {
  const [comment, setComment] = useState('')
  const [confirmDone, setConfirmDone] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const ws = controller.getSnapshot().workspaces.find(w => w.id === task.workspaceId)
  const canRun = task.status !== 'in_progress' && task.status !== 'done' && task.status !== 'archived'

  return (
    <div className="dsh-atb-detail" data-urgency={task.urgency}>
      <div className="dsh-atb-detail-head">
        <div className="dsh-atb-detail-titlewrap">
          <div className="dsh-atb-detail-titlebar">
            <h3>{task.title}</h3>
            <span className="dsh-atb-statuspill" data-status={task.status}>{STATUS_LABEL[task.status] ?? task.status}</span>
          </div>
          <div className="dsh-atb-detail-chips">
            <Chip tone={task.urgency}>● {URGENCY_LABEL[task.urgency] ?? task.urgency}</Chip>
            <Chip icon="📁">{ws?.title ?? shortId(task.workspaceId)}</Chip>
            {task.model !== undefined && <Chip icon="✦">{task.model.model}</Chip>}
            {task.execution.mode === 'scheduled' && (
              <Chip icon="⏰">{task.execution.cron} · 下次 {fmtTime(task.execution.nextRunAt)}</Chip>
            )}
            {task.blocked && <Chip icon="⛔" tone="urgent">受阻</Chip>}
            {task.trashedAt !== undefined && <Chip icon="🗑" tone="urgent">已删除待清除</Chip>}
            <Chip>v{task.version}</Chip>
          </div>
          <div className="dsh-atb-detail-sub">
            更新 {fmtTime(task.updatedAt)} · 最近操作 {task.updatedBy.kind === 'agent' ? `🤖 ${shortId(task.updatedBy.sessionId)}` : '👤 用户'}
          </div>
        </div>
        <div className="dsh-atb-detail-topbtns">
          <button type="button" className="dsh-atb-detail-edit" onClick={() => controller.openEditor(task.id)}>✎ 编辑</button>
          <button type="button" className="dsh-atb-detail-close" aria-label="关闭" onClick={() => controller.select(undefined)}>✕</button>
        </div>
      </div>

      {task.description.length > 0 && (
        <div className="dsh-atb-fieldcard">
          <div className="dsh-atb-fieldcard-label">描述</div>
          <div className="dsh-atb-desc">{task.description}</div>
        </div>
      )}

      {task.prompt.length > 0 && (
        <div className="dsh-atb-fieldcard" data-kind="prompt">
          <div className="dsh-atb-fieldcard-label">执行 Prompt</div>
          <div className="dsh-atb-promptbox">{task.prompt}</div>
        </div>
      )}

      <div className="dsh-atb-detail-actions">
        {canRun && (
          <button type="button" className="dsh-atb-runbtn" onClick={() => void controller.run(task.id)}>
            ▶ 执行 · 新会话{task.model !== undefined ? `（${task.model.model}）` : '（默认模型）'}
          </button>
        )}
        <div className="dsh-atb-movebtns">
          {moveTargets(task).map(to => to === 'done'
            ? (confirmDone
                ? (
                    <span key={to} className="dsh-atb-confirm">
                      <span className="dsh-atb-confirm-label">确认完成？</span>
                      <button type="button" className="dsh-atb-btn" data-primary="true" onClick={() => { void controller.move(task.id, task.version, 'done'); setConfirmDone(false) }}>确认</button>
                      <button type="button" className="dsh-atb-btn" onClick={() => setConfirmDone(false)}>取消</button>
                    </span>
                  )
                : <button key={to} type="button" className="dsh-atb-movebtn" data-to={to} onClick={() => setConfirmDone(true)}>✓ {MOVE_LABEL[to]}</button>)
            : (
                <button key={to} type="button" className="dsh-atb-movebtn" data-to={to} onClick={() => void controller.move(task.id, task.version, to)}>
                  {MOVE_LABEL[to]}
                </button>
              ))}
          <button type="button" className="dsh-atb-movebtn" data-to="blocked" onClick={() => void controller.toggleBlocked(task)}>
            {task.blocked ? '✓ 解除受阻' : '⛔ 标记受阻'}
          </button>
        </div>
      </div>

      <div className="dsh-atb-section">
        <h4>评论{task.comments.length > 0 && <span className="dsh-atb-count2">{task.comments.length}</span>}</h4>
        {task.comments.length === 0
          ? <div className="dsh-atb-empty2">暂无评论 — agent 交接时会在这里汇报改动与验证结果</div>
          : (
              <div className="dsh-atb-commentlist">
                {task.comments.map(c => (
                  <div key={c.id} className="dsh-atb-bubble" data-from={c.threadId !== undefined ? 'agent' : 'user'}>
                    <div className="dsh-atb-bubble-avatar">{c.threadId !== undefined ? '🤖' : '👤'}</div>
                    <div className="dsh-atb-bubble-main">
                      <div className="dsh-atb-bubble-meta">
                        <b>{c.threadId !== undefined ? `agent ${shortId(c.threadId)}` : '用户'}</b>
                        <span>{fmtTime(c.createdAt)}</span>
                      </div>
                      <div className="dsh-atb-bubble-body">{c.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
        <div className="dsh-atb-composer">
          <textarea
            className="dsh-atb-composer-input"
            value={comment}
            placeholder="以用户身份留言（agent 开工前会读）…"
            onChange={e => setComment(e.target.value)}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && comment.trim().length > 0) {
                void controller.comment(task.id, comment)
                setComment('')
              }
            }}
          />
          <button
            type="button"
            className="dsh-atb-composer-send"
            disabled={comment.trim().length === 0}
            onClick={() => { void controller.comment(task.id, comment); setComment('') }}
          >
            发表
          </button>
        </div>
      </div>

      {task.executions.length > 0 && (
        <div className="dsh-atb-section">
          <h4>执行记录<span className="dsh-atb-count2">{task.executions.length}</span></h4>
          <div className="dsh-atb-execlist">
            {task.executions.map(e => (
              <div key={e.id} className="dsh-atb-exec-row">
                <span className="dsh-atb-exec-dot" data-outcome={e.outcome} />
                <span className="dsh-atb-exec-trigger">{e.trigger === 'manual' ? '手动' : '定时'}</span>
                <span className="dsh-atb-exec-outcome" data-outcome={e.outcome}>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</span>
                <span className="dsh-atb-exec-time">{fmtTime(e.startedAt)}{e.endedAt !== undefined && ` · ${duration(e.startedAt, e.endedAt)}`}</span>
                {e.sessionId !== undefined && <span className="dsh-atb-exec-session" title={e.sessionId}>🤖 {shortId(e.sessionId)}</span>}
                {e.error !== undefined && <span className="dsh-atb-exec-error" title={e.error}>{e.error.slice(0, 80)}{e.error.length > 80 ? '…' : ''}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="dsh-atb-dangerzone">
        {task.trashedAt === undefined
          ? <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => void controller.remove(task.id, task.version, false)}>🗑 删除（标记待清除）</button>
          : (confirmPurge
              ? (
                  <span className="dsh-atb-confirm">
                    <span className="dsh-atb-confirm-label">物理清除不可恢复</span>
                    <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.remove(task.id, task.version, true); setConfirmPurge(false) }}>确认清除</button>
                    <button type="button" className="dsh-atb-btn" onClick={() => setConfirmPurge(false)}>取消</button>
                  </span>
                )
              : <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => setConfirmPurge(true)}>🔥 物理清除（需确认）</button>)}
      </div>
    </div>
  )
}
