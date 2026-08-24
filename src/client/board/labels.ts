/**
 * Centralized zh-CN display labels for the board UI.
 *
 * Review P2: the same status/urgency/outcome text used to live in three
 * components (TaskBoard / TaskCard / TaskDetail) and drifted — adding a
 * status meant three edits, missing one leaked the raw English key.
 *
 * @module dsh-taskboard/client/board/labels
 */
import type { TaskStatus, Urgency } from '../../shared/protocol.ts'

/** Column headers on the five-column main board (+ secondary tab). */
export const COLUMN_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: '待规划',
  todo: '待办',
  in_progress: '进行中',
  in_review: '待验收',
  done: '已完成',
  canceled: '已取消',
  archived: '已归档',
}

/** Status pill text (detail pane) — historical wording kept verbatim:
 *  terminal states read short here, the column headers carry the full forms. */
export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  backlog: '待规划', todo: '待办', in_progress: '进行中', in_review: '待验收',
  done: '完成', canceled: '取消', archived: '归档',
}

/** Move-button verbs (shorter than the pill text). */
export const MOVE_LABEL: Readonly<Record<TaskStatus, string>> = {
  backlog: '待规划', todo: '待办', in_progress: '进行中', in_review: '待验收',
  done: '完成', canceled: '取消', archived: '归档',
}

/** Urgency chip labels. */
export const URGENCY_LABEL: Readonly<Record<Urgency, string>> = {
  urgent: '紧急', normal: '一般', relaxed: '不急',
}

/** Execution outcome labels. */
export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
}
