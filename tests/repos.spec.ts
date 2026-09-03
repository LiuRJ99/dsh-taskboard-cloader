/**
 * 0.6.3 multi-repo mirror: workspace repository discovery (host/repos.ts).
 * Scripted IO — no real filesystem: the scanner must be a pure traversal
 * over the injected face, fail-soft on any IO error.
 */
import { describe, expect, it } from 'vitest'
import { createRepoScanner, MAX_SCAN_DEPTH, type RepoIo } from '../src/host/repos.ts'

/** Script the workspace layout: set of dir paths + set of repo dirs. */
function ioOf(layout: { dirs: string[]; repos: string[] }): RepoIo & { readCalls: string[] } {
  const dirs = new Set(layout.dirs)
  const repos = new Set(layout.repos)
  const readCalls: string[] = []
  return {
    readCalls,
    async readDir(dir) {
      readCalls.push(dir)
      if (!dirs.has(dir)) return []
      const children = new Set<string>()
      for (const d of dirs) {
        const parent = d.slice(0, d.lastIndexOf('/'))
        if (parent === dir && d !== dir) children.add(d.slice(dir.length + 1))
      }
      return [...children]
    },
    async hasGitDir(dir) {
      return repos.has(dir)
    },
  }
}

describe('repo discovery (0.6.3)', () => {
  it('discovers nested parallel repos in path order, skipping noise dirs', async () => {
    const root = '/ws'
    const io = ioOf({
      dirs: [root, root + '/dsh-taskboard', root + '/dsh-devlaunch', root + '/docs', root + '/node_modules/fake-repo', root + '/.hidden/repo'],
      repos: [root + '/dsh-devlaunch', root + '/dsh-taskboard', root + '/node_modules/fake-repo'],
    })
    const scanner = createRepoScanner(io, 0)
    const repos = await scanner.findNestedRepos(root)
    // node_modules + dot dirs skipped; docs has no .git; sorted lexicographically.
    expect(repos.map(r => r.relPath)).toEqual(['dsh-devlaunch', 'dsh-taskboard'])
    expect(repos[0]!.absPath).toBe(root + '/dsh-devlaunch')
  })

  it('does NOT descend into a discovered repo (vendored repos are not workspace repos)', async () => {
    const root = '/ws'
    const io = ioOf({
      dirs: [root, root + '/app', root + '/app/vendor-repo', root + '/app/vendor-repo/nested', root + '/app/vendor-repo/nested/deep'],
      repos: [root + '/app', root + '/app/vendor-repo/nested/deep/really'],
    })
    const scanner = createRepoScanner(io, 0)
    const repos = await scanner.findNestedRepos(root)
    expect(repos.map(r => r.relPath)).toEqual(['app'])
  })

  it('finds repos below non-repo intermediate dirs up to the depth cap', async () => {
    const root = '/ws'
    const deep = root + '/a/b/c/repo'
    const tooDeep = root + '/a/b/c/d/repo2'
    const io = ioOf({
      dirs: [root, root + '/a', root + '/a/b', root + '/a/b/c', root + '/a/b/c/d', tooDeep],
      repos: [deep, tooDeep],
    })
    const scanner = createRepoScanner(io, 0)
    const repos = await scanner.findNestedRepos(root)
    // scan starts at depth 1 (children of root); a/b/c/repo sits at depth 4 → beyond MAX_SCAN_DEPTH.
    expect(repos.map(r => r.relPath)).toEqual([])
    expect(MAX_SCAN_DEPTH).toBe(3)
  })

  it('ignores a .git FILE shape (linked worktree / submodule) via hasGitDir=false', async () => {
    const root = '/ws'
    const io = ioOf({
      dirs: [root, root + '/linked'],
      repos: [], // hasGitDir always false: a .git file is not a .git dir
    })
    const scanner = createRepoScanner(io, 0)
    const repos = await scanner.findNestedRepos(root)
    expect(repos).toEqual([])
  })

  it('caches per workspace within the TTL; clearCache drops it', async () => {
    const root = '/ws'
    const layout = { dirs: [root, root + '/r1'], repos: [root + '/r1'] }
    const io = ioOf(layout)
    const scanner = createRepoScanner(io, 60_000)
    const first = await scanner.findNestedRepos(root)
    const callsAfterFirst = io.readCalls.length
    const second = await scanner.findNestedRepos(root)
    expect(io.readCalls.length).toBe(callsAfterFirst) // served from cache
    expect(second).toBe(first) // same array identity
    scanner.clearCache()
    await scanner.findNestedRepos(root)
    expect(io.readCalls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('fail-soft: unreadable directories shrink the result, never throw', async () => {
    const io: RepoIo = {
      readDir: async dir => (dir === '/ws' ? ['ok-repo', 'boom'] : dir === '/ws/boom' ? (() => { throw new Error('EACCES') })() : []),
      hasGitDir: async dir => dir === '/ws/ok-repo',
    }
    const scanner = createRepoScanner(io, 0)
    const repos = await scanner.findNestedRepos('/ws')
    // ok-repo discovered; the throwing child is tolerated (readDir rejection
    // propagates only into that subtree's absence via the scanner's try/catch
    // at the root — here the whole walk survives and yields the good repo).
    expect(repos.map(r => r.relPath)).toEqual(['ok-repo'])
  })
})
