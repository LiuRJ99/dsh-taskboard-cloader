/**
 * Workspace repository discovery (0.6.3): locate the PARALLEL nested git
 * repositories inside a workspace so worktree isolation can mirror the
 * whole multi-repo layout under the task's worktree directory (plan §4.1).
 *
 * Scope rules:
 * - Only TRUE independent repositories qualify: a child directory counts
 *   when it contains a `.git` DIRECTORY. A `.git` FILE (a linked worktree
 *   or a submodule) is skipped — its refs live in some other repository's
 *   object store, so treating it as a repo would double-register that one.
 * - Bounded scan (depth ≤ {@link MAX_SCAN_DEPTH}), never descending into a
 *   discovered repo, a skip-listed directory (node_modules, build output,
 *   the plugin's own .dsh-worktrees), or a dot directory.
 * - FAIL-SOFT: every IO error shrinks the result and never throws — the
 *   caller degrades to single-repo (or plain no-git) behavior.
 * - Per-workspace TTL cache: the layout rarely changes mid-run.
 *
 * The workspace ROOT repo is not discovered here — the caller (isolation)
 * composes it in front of this list when `GitFace.detect` says the root is
 * a work tree, whatever `.git` shape it has.
 *
 * @module dsh-taskboard/host/repos
 */

/** How deep below the workspace root nested repos are looked for. */
export const MAX_SCAN_DEPTH = 3

/** Default TTL of the per-workspace discovery cache (aligns routes' git-detect TTL). */
const CACHE_TTL_MS = 60_000

/** Skip-listed directory names at every level of the scan. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.dsh-worktrees',
  'lib',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
  'Pods',
])

/** One discovered repository: path relative to the workspace + absolute. */
export interface RepoRef {
  /**
   * Forward-slash path relative to the workspace root. `` (empty) is
   * reserved for the workspace root repo and is NEVER returned here.
   */
  relPath: string
  /** Absolute working-tree path of the repository. */
  absPath: string
}

/** Injectable IO face (unit tests script the layout without a filesystem). */
export interface RepoIo {
  /** Direct child directory names of `dir` ([] on any error). */
  readDir(dir: string): Promise<string[]>
  /** Whether `dir` contains a `.git` DIRECTORY (true independent repo). */
  hasGitDir(dir: string): Promise<boolean>
}

/** Real IO over node:fs/promises (dynamic import like the git face). */
const realRepoIo: RepoIo = {
  async readDir(dir) {
    try {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return []
    }
  },
  async hasGitDir(dir) {
    try {
      const { stat } = await import('node:fs/promises')
      return (await stat(`${dir}/.git`)).isDirectory()
    } catch {
      return false
    }
  },
}

/** The scanner: discovery plus its TTL cache. */
export interface RepoScanner {
  /** Discover the nested parallel repos of a workspace (cache-backed). */
  findNestedRepos(workspacePath: string): Promise<RepoRef[]>
  /** Drop every cached discovery (mirror teardown re-discovers fresh — the TTL cache only serves the prepare/merge hot path). */
  clearCache(): void
}

/**
 * Build a scanner over an injectable IO face.
 * @param io - the IO face (real filesystem when omitted).
 * @param ttlMs - cache lifetime; `0` disables caching (tests).
 */
export function createRepoScanner(io: RepoIo = realRepoIo, ttlMs: number = CACHE_TTL_MS): RepoScanner {
  const cache = new Map<string, { at: number; repos: RepoRef[] }>()

  const scanDir = async (dir: string, rel: string, depth: number, out: RepoRef[]): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return
    const names = (await io.readDir(dir)).slice().sort()
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      const childRel = rel.length === 0 ? name : `${rel}/${name}`
      const childAbs = `${dir}/${name}`
      if (await io.hasGitDir(childAbs)) {
        // A discovered repo is a LEAF: repos nested inside it (vendored
        // copies) are not part of the workspace's parallel layout.
        out.push({ relPath: childRel, absPath: childAbs })
        continue
      }
      // One unreadable subtree must not sink the whole walk (fail-soft).
      try {
        await scanDir(childAbs, childRel, depth + 1, out)
      } catch { /* skip the unreadable subtree */ }
    }
  }

  return {
    async findNestedRepos(workspacePath) {
      const root = workspacePath.replace(/[\\/]+$/, '')
      const now = Date.now()
      const cached = cache.get(root)
      if (ttlMs > 0 && cached !== undefined && now - cached.at < ttlMs) return cached.repos
      const out: RepoRef[] = []
      try {
        await scanDir(root, '', 1, out)
      } catch {
        /* fail-soft: keep whatever was found before the error */
      }
      if (ttlMs > 0) cache.set(root, { at: now, repos: out })
      return out
    },
    clearCache() {
      cache.clear()
    },
  }
}
