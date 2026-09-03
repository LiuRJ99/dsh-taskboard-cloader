/**
 * Resolve task-reported paths for Better Sidebar actions.
 *
 * Reports are untrusted display data: relative paths need an execution/workspace
 * base, absolute paths still need to stay inside the active session scope, and
 * the host remains the final realpath/symlink authority. This module only does
 * a cheap client-side normalization and containment preflight so the UI does
 * not offer a sidebar action for an obviously unrelated path.
 *
 * @module dsh-taskboard/client/file-paths
 */
import type { SessionScope } from 'dsh-better-sidebar/client/service'
import type { WorkspaceView } from '../shared/api.ts'
import type { ExecutionRecord, TaskRecord } from '../shared/protocol.ts'

/** One normalized path target suitable for display/copy and optional opening. */
export interface TaskFileTarget {
  /** Absolute normalized path when a base was available; otherwise the cleaned input. */
  path: string
  /** True only when the target is known to be under the active session cwd. */
  available: boolean
  /** Why the action is unavailable, when it is unavailable. */
  reason?: 'missing-base' | 'missing-session-cwd' | 'outside-session-workspace'
}

/** Mirror the host/client absolute-path forms without importing node:path. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/** Remove the common quoting used by porcelain-style path output. */
export function cleanReportedPath(raw: string): string {
  let value = raw.trim()
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  return value
}

/** Normalize separators and dot segments while preserving POSIX/drive/UNC roots. */
export function normalizePath(path: string): string {
  const input = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:\//.test(input)
  const unc = input.startsWith('//')
  const absolute = input.startsWith('/') || drive || unc
  const prefix = drive ? input.slice(0, 3) : unc ? '//' : input.startsWith('/') ? '/' : ''
  const body = drive ? input.slice(3) : unc ? input.slice(2) : input.replace(/^\/+/, '')
  const segments: string[] = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const previous = segments[segments.length - 1]
      if (previous !== undefined && previous !== '..') segments.pop()
      else if (!absolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (prefix === '/') return joined === '' ? '/' : `/${joined}`
  if (prefix === '//') return joined === '' ? '//' : `//${joined}`
  if (prefix !== '') return joined === '' ? prefix : `${prefix}${joined}`
  return joined
}

/** Join a base directory and a possibly separator-prefixed relative path. */
function joinPath(base: string, relative: string): string {
  return normalizePath(`${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`)
}

/** Case-fold only Windows-looking paths; POSIX host checks remain case-sensitive. */
function comparable(path: string): string {
  const windows = /^[A-Za-z]:\//.test(path) || path.startsWith('//')
  return windows ? path.toLowerCase() : path
}

/** Keep filesystem roots intact while trimming ordinary directory tails. */
function trimTrailingSeparators(path: string): string {
  if (path === '/' || path === '//' || /^[A-Za-z]:\/$/.test(path)) return path
  return path.replace(/[\\/]+$/, '')
}

/** Cheap client-side mirror of the host's workspace containment check. */
export function isWithinWorkspace(base: string, target: string): boolean {
  const b = comparable(trimTrailingSeparators(normalizePath(base)))
  const t = comparable(normalizePath(target))
  if (b === '/') return t.startsWith('/')
  if (b === '//') return t.startsWith('//')
  if (/^[a-z]:\/$/i.test(b)) return t === b || t.startsWith(b)
  return t === b || t.startsWith(`${b}/`)
}

/** Pick the directory that gives meaning to a task's relative report path. */
export function taskFileBase(
  task: TaskRecord,
  workspaces: readonly WorkspaceView[],
  execution?: ExecutionRecord,
  scope?: SessionScope,
): string | undefined {
  if (execution?.worktreePath !== undefined && execution.worktreePath !== '') return execution.worktreePath
  const workspace = workspaces.find(candidate => candidate.id === task.workspaceId)
  if (workspace?.path !== undefined && workspace.path !== '') return workspace.path
  return scope?.repoRoot ?? scope?.cwd
}

/** Resolve one report/git path and preflight it against the active session cwd. */
export function resolveTaskFilePath(
  raw: string,
  task: TaskRecord,
  workspaces: readonly WorkspaceView[],
  execution?: ExecutionRecord,
  scope?: SessionScope,
): TaskFileTarget | undefined {
  const cleaned = cleanReportedPath(raw)
  if (cleaned === '' || cleaned.includes('\u0000')) return undefined

  const base = taskFileBase(task, workspaces, execution, scope)
  const resolved = isAbsolutePath(cleaned)
    ? normalizePath(cleaned)
    : base === undefined
      ? cleaned
      : joinPath(base, cleaned)

  if (!isAbsolutePath(resolved)) {
    return { path: resolved, available: false, reason: 'missing-base' }
  }
  if (scope?.cwd === undefined || scope.cwd === '') {
    return { path: resolved, available: false, reason: 'missing-session-cwd' }
  }
  if (!isWithinWorkspace(scope.cwd, resolved)) {
    return { path: resolved, available: false, reason: 'outside-session-workspace' }
  }
  return { path: resolved, available: true }
}
