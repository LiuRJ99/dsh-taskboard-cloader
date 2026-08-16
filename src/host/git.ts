/**
 * Host git face (0.3.0): the ONLY place dsh-taskboard shells out to git.
 *
 * Design invariants (plan §3.4/§3.5):
 * - NARROW interface: detect / prepareWorktree / collect / merge /
 *   removeWorktree / deleteBranch — nothing else leaks into the plugin.
 * - FAIL-SOFT: every call has a timeout and resolves to a benign result
 *   (false / undefined / empty facts) on ANY git failure — a missing git,
 *   a locked worktree, or a damaged repo degrades execution to the original
 *   directory and NEVER fails the ledger or the run pipeline. Only the
 *   explicit user actions (merge / remove / deleteBranch) throw, with a
 *   readable message the GUI surfaces as-is.
 * - INJECTABLE runner: the exec layer is a single function so unit tests
 *   script every path without a real git.
 *
 * @module dsh-taskboard/host/git
 */
import type { CommitInfo } from '../shared/protocol.ts'

/** Timeout for quick read-only queries (rev-parse / status / log / diff). */
const QUICK_TIMEOUT_MS = 2_000

/** Timeout for structural operations (worktree add/remove, merge, branch). */
const HEAVY_TIMEOUT_MS = 15_000

/** Directory under a workspace where task worktrees live. */
export const WORKTREE_DIR = '.dsh-worktrees'

/** Result of one underlying exec: `ok` is exit-0, output never null. */
export interface ExecResult { ok: boolean; stdout: string; stderr: string }

/** The injectable exec layer: run `git <args>` under a cwd with a timeout. */
export type ExecFn = (args: string[], options: { cwd?: string; timeout?: number }) => Promise<ExecResult>

/** Facts needed to open an isolated execution. */
export interface WorktreeInfo {
  /** Absolute worktree path (the session's cwd). */
  path: string
  /** The task branch checked out there. */
  branch: string
  /** HEAD of the main worktree when the branch was based (execution baseline). */
  baseCommit: string
}

/** Settlement facts collected from a worktree (partial on best-effort basis). */
export interface SettlementFacts {
  headCommit?: string
  commits: CommitInfo[]
  dirtyFiles: string[]
  diffStat?: string
  changedFiles: number
}

/** The narrow git face the rest of the plugin depends on. */
export interface GitFace {
  /** Whether `root` sits inside a usable git work tree (fail-soft → false). */
  detect(root: string): Promise<boolean>
  /**
   * Ensure a FRESH worktree at `path` on `branch`, rebased onto the main
   * worktree's current HEAD (the 每次全新 default). Resolves undefined on
   * any failure — callers degrade to the original directory.
   */
  prepareWorktree(root: string, path: string, branch: string): Promise<WorktreeInfo | undefined>
  /** Collect settlement facts (never throws; missing pieces stay unset). */
  collect(worktreePath: string, baseCommit: string): Promise<SettlementFacts>
  /** Merge `branch` into the main worktree (`--no-ff`); THROWS with a readable reason. */
  merge(root: string, branch: string): Promise<void>
  /** Remove a worktree; THROWS when it still has uncommitted changes. */
  removeWorktree(root: string, worktreePath: string): Promise<void>
  /** Delete a branch; THROWS (e.g. still checked out in a worktree). */
  deleteBranch(root: string, branch: string): Promise<void>
}

/**
 * Build the task branch name `task/<标题>+<taskId>` (plan §9 拍板).
 *
 * Title sanitizing: whitespace runs collapse to `-`; git-illegal characters
 * (`~ ^ : ? * [ \ / @ { }` and friends) are stripped; `..` collapses; the
 * segment is trimmed of leading/trailing `.-` and truncated to ~20 code
 * points; an empty result falls back to the bare `task/<taskId>`.
 * @param title - the task title (already normalized 1..200 chars).
 * @param taskId - the task id (stable suffix).
 * @returns the branch name.
 */
export function sanitizeBranchName(title: string, taskId: string): string {
  const segment = title.trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\~^:?*[\]@{}"'<>|#%&;$!`'=,;()]+/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
  const head = Array.from(segment).slice(0, 20).join('').replace(/^[-.]+|[-.]+$/g, '')
  return head.length === 0 ? `task/${taskId}` : `task/${head}+${taskId}`
}

/** The canonical worktree path of a task inside its workspace (forward slashes). */
export function worktreePathOf(workspacePath: string, taskId: string): string {
  const root = workspacePath.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  return `${root}/${WORKTREE_DIR}/${taskId}`
}

/** Real exec layer over child_process.execFile (windowsHide, timeout, maxBuffer). */
const realExec: ExecFn = (args, options) => new Promise(resolve => {
  void (async () => {
    const { execFile } = await import('node:child_process')
    execFile('git', args, {
      cwd: options.cwd,
      timeout: options.timeout ?? QUICK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })().catch(() => resolve({ ok: false, stdout: '', stderr: 'exec unavailable' }))
})

/**
 * Build a {@link GitFace} over an injectable exec layer.
 * @param exec - the exec function (real `git` when omitted).
 */
export function createGitFace(exec: ExecFn = realExec): GitFace {
  const quick = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: QUICK_TIMEOUT_MS })
  const heavy = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: HEAVY_TIMEOUT_MS })

  return {
    async detect(root) {
      const r = await quick(['rev-parse', '--is-inside-work-tree'], root)
      return r.ok && r.stdout.trim() === 'true'
    },

    async prepareWorktree(root, path, branch) {
      // Baseline: the main worktree's current HEAD (also validates the repo).
      const head = await quick(['rev-parse', 'HEAD'], root)
      if (!head.ok) return undefined
      const baseCommit = head.stdout.trim()

      const exists = await quick(['show-ref', '--verify', `refs/heads/${branch}`], root)
      if (exists.ok) {
        // Reuse the fixed branch name, but guarantee a FRESH baseline: drop
        // any stale worktree at the path, move the branch to the current
        // HEAD, then check the branch out again (每次全新，复用仅作选项保留).
        await heavy(['worktree', 'remove', '--force', path], root)
        await heavy(['worktree', 'prune'], root)
        const moved = await heavy(['branch', '-f', branch, 'HEAD'], root)
        if (!moved.ok) return undefined
        const added = await heavy(['worktree', 'add', path, branch], root)
        if (!added.ok) return undefined
      } else {
        const added = await heavy(['worktree', 'add', '-b', branch, path], root)
        if (!added.ok) return undefined
      }
      return { path, branch, baseCommit }
    },

    async collect(worktreePath, baseCommit) {
      const facts: SettlementFacts = { commits: [], dirtyFiles: [], changedFiles: 0 }
      const range = `${baseCommit}..HEAD`

      const head = await quick(['rev-parse', 'HEAD'], worktreePath)
      if (head.ok) facts.headCommit = head.stdout.trim()

      const log = await quick(['log', '--pretty=format:%h %s', range], worktreePath)
      if (log.ok) {
        facts.commits = log.stdout.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .map(line => {
            const space = line.indexOf(' ')
            return space === -1
              ? { hash: line, subject: '' }
              : { hash: line.slice(0, space), subject: line.slice(space + 1) }
          })
      }

      const status = await quick(['status', '--porcelain'], worktreePath)
      if (status.ok) {
        facts.dirtyFiles = status.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      }

      const shortstat = await quick(['diff', '--shortstat', range], worktreePath)
      if (shortstat.ok && shortstat.stdout.trim().length > 0) facts.diffStat = shortstat.stdout.trim()

      const names = await quick(['diff', '--name-only', range], worktreePath)
      if (names.ok) facts.changedFiles = names.stdout.split('\n').filter(l => l.trim().length > 0).length

      return facts
    },

    async merge(root, branch) {
      // Main-clean check. The plugin's own worktree directory
      // (<root>/.dsh-worktrees) shows up as untracked noise and is EXEMPT —
      // otherwise merging would be impossible without gitignoring it first.
      const status = await quick(['status', '--porcelain'], root)
      if (status.ok) {
        const dirtyLines = status.stdout.split('\n')
          .map(l => l.trim())
          .filter(l => {
            if (l.length === 0) return false
            const path = l.slice(3)
            return path !== WORKTREE_DIR && !path.startsWith(`${WORKTREE_DIR}/`)
          })
        if (dirtyLines.length > 0) {
          throw new Error(`主工作区有 ${dirtyLines.length} 处未提交修改，请先提交或暂存后再合并`)
        }
      }
      const merged = await heavy(['merge', '--no-ff', '--no-edit', branch], root)
      if (!merged.ok) {
        // Roll the half-finished merge back so the main worktree stays usable;
        // report the ORIGINAL failure verbatim (不自动解决冲突).
        await heavy(['merge', '--abort'], root)
        throw new Error(`合并失败：${merged.stderr.trim().slice(0, 300)}`)
      }
    },

    async removeWorktree(root, worktreePath) {
      const status = await quick(['status', '--porcelain'], worktreePath)
      if (status.ok && status.stdout.trim().length > 0) {
        const lines = status.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        throw new Error(`worktree 有 ${lines.length} 处未提交修改，拒绝删除：\n${lines.slice(0, 10).join('\n')}`)
      }
      const removed = await heavy(['worktree', 'remove', worktreePath], root)
      if (!removed.ok) throw new Error(`删除 worktree 失败：${(removed.stderr.trim() || removed.stdout.trim()).slice(0, 300)}`)
    },

    async deleteBranch(root, branch) {
      const deleted = await heavy(['branch', '-D', branch], root)
      if (!deleted.ok) throw new Error(`删除分支失败：${deleted.stderr.trim().slice(0, 300)}`)
    },
  }
}
