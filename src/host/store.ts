/**
 * Host-side task ledger: one JSON file under the DSH home, mutated through a
 * serial write queue, published as immutable snapshots with a global
 * monotonic revision. Change subscribers (P2: SSE route) observe every
 * committed mutation.
 *
 * @module dsh-taskboard/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  LEDGER_SCHEMA_VERSION,
  emptyLedger,
  type TaskLedger,
  type TaskRecord,
} from '../shared/protocol.ts'

/** One committed ledger mutation, handed to change subscribers. */
export interface LedgerChange {
  /** Revision after the mutation. */
  revision: number
  /** The mutated tasks, if any (a comment purge may touch none). */
  tasks: readonly TaskRecord[]
  /** What kind of mutation this was (for SSE event naming later). */
  kind: 'task-created' | 'task-updated' | 'task-moved' | 'task-deleted' | 'comment-added' | 'execution-recorded'
}

/** Options for {@link TaskStore}. */
export interface TaskStoreOptions {
  /** Absolute ledger file path. */
  file: string
}

/**
 * The durable ledger. All mutations run through {@link mutate}, which:
 * validates the resulting document, bumps the global revision, persists
 * atomically (temp file + rename), and only then notifies subscribers.
 */
export class TaskStore {
  private readonly file: string
  private ledger: TaskLedger = emptyLedger()
  private readonly subscribers = new Set<(change: LedgerChange) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false

  /** @param options - file location. */
  constructor(options: TaskStoreOptions) {
    this.file = options.file
  }

  /** Load (once) from disk; a missing file starts empty; a corrupt file is quarantined, not thrown. */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as TaskLedger
      if (typeof parsed.revision === 'number' && Array.isArray(parsed.tasks)) {
        this.ledger = { schemaVersion: LEDGER_SCHEMA_VERSION, revision: parsed.revision, tasks: parsed.tasks }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Quarantine a corrupt ledger: rename it aside, start fresh. Never
        // take the host down over ledger damage.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch { /* best effort */ }
      }
    }
    this.loaded = true
  }

  /** The current immutable snapshot. */
  snapshot(): TaskLedger {
    return this.ledger
  }

  /** Find a task by id. */
  get(id: string): TaskRecord | undefined {
    return this.ledger.tasks.find(t => t.id === id)
  }

  /** Subscribe to committed changes; returns the unsubscribe. */
  subscribe(fn: (change: LedgerChange) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * Run one mutation inside the serial queue. The mutator works on a
   * structured clone; returning `undefined` aborts with no write.
   * @param kind - change kind for subscribers.
   * @param mutator - receives the cloned ledger; mutate tasks in place; return the touched tasks.
   */
  async mutate(
    kind: LedgerChange['kind'],
    mutator: (ledger: TaskLedger) => TaskRecord[] | undefined,
  ): Promise<{ ledger: TaskLedger; changed: readonly TaskRecord[] }> {
    const run = async (): Promise<{ ledger: TaskLedger; changed: readonly TaskRecord[] }> => {
      await this.load()
      const draft: TaskLedger = structuredClone(this.ledger)
      const changed = mutator(draft)
      if (changed === undefined) {
        return { ledger: this.ledger, changed: [] }
      }
      draft.revision += 1
      const json = JSON.stringify(draft)
      await persistAtomic(this.file, json)
      this.ledger = draft
      const change: LedgerChange = { revision: draft.revision, tasks: changed, kind }
      for (const fn of this.subscribers) {
        try {
          fn(change)
        } catch { /* subscriber errors never abort the write */ }
      }
      return { ledger: draft, changed }
    }
    const result = (this.queue = this.queue.then(run, run)) as ReturnType<typeof run>
    return result
  }

  /** Persist the current ledger now (used after external reconciliation). */
  async flush(kind: LedgerChange['kind'], changed: readonly TaskRecord[]): Promise<void> {
    await this.mutate(kind, (ledger) => {
      // replace tasks wholesale from the live snapshot objects
      const byId = new Map(this.ledger.tasks.map(t => [t.id, t]))
      ledger.tasks = ledger.tasks.map(t => byId.get(t.id) ?? t)
      return [...changed]
    })
  }
}

/** Atomic file persist: write temp, then rename over the target. */
async function persistAtomic(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(temp, contents, 'utf8')
  await rename(temp, file)
}
