/**
 * The board controller: framework-free state holder the React views render
 * from. Owns the ledger snapshot, workspace listing, view state (open,
 * filters, selection, modals), and the SSE subscription with gap-triggered
 * full refetch. Every mutation goes through the route client and lands in the
 * snapshot through the SSE change stream or the explicit refetch.
 *
 * @module dsh-agent-taskboard/client/controller
 */
import type { ChangeEvent, UpdateTaskBody, WorkspaceView } from '../shared/api.ts'
import type { TaskLedger, TaskRecord, Urgency } from '../shared/protocol.ts'
import { emptyLedger } from '../shared/protocol.ts'
import type { TaskboardClient } from './api.ts'

/** View filters over the ledger. */
export interface BoardFilters {
  /** Selected project id; undefined = all projects. */
  workspaceId?: string
  /** Selected urgency chips (empty = all). */
  urgencies: Urgency[]
}

/** Controller snapshot the views render. */
export interface ControllerState {
  boardOpen: boolean
  ledger: TaskLedger
  workspaces: WorkspaceView[]
  filters: BoardFilters
  /** Selected task id (detail view); undefined closes the detail. */
  selectedId?: string
  /** Task form modal visible (create when editingId is unset). */
  composerOpen: boolean
  /** Task being edited in the form modal; unset = create mode. */
  editingId?: string
  /** Secondary (canceled/archived/trashed) tab visible. */
  secondaryOpen: boolean
  /** Transient error surface (action failures); cleared on next success. */
  error?: string
}

/** Instantiate the default state. */
function initialState(): ControllerState {
  return {
    boardOpen: false,
    ledger: emptyLedger(),
    workspaces: [],
    filters: { urgencies: [] },
    composerOpen: false,
    secondaryOpen: false,
  }
}

/**
 * The board controller.
 */
export class BoardController {
  private state: ControllerState = initialState()
  private readonly subscribers = new Set<() => void>()
  private disposed = false
  private disposeStream: (() => void) | undefined
  private refreshInFlight: Promise<void> | undefined

  /** @param client - the route client. */
  constructor(private readonly client: TaskboardClient) {}

  /** Current snapshot (render input). */
  getSnapshot(): ControllerState {
    return this.state
  }

  /** Subscribe; returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  private emit(): void {
    if (this.disposed) return
    for (const fn of this.subscribers) fn()
  }

  private setState(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  /** Start subscriptions; call once after construction. */
  start(): void {
    void this.refresh()
    this.disposeStream = this.client.stream(
      (change: ChangeEvent) => {
        this.setState({ ledger: { ...this.state.ledger, revision: change.revision } })
        // Any change invalidates the full snapshot; refetch (cheap, local).
        void this.refresh()
      },
      () => { void this.refresh() },
    )
  }

  /** Full refetch (state + workspaces + open detail). */
  async refresh(): Promise<void> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        const [ledger, workspaces] = await Promise.all([
          this.client.state(),
          this.client.workspaces(),
        ])
        let selected: TaskRecord | undefined
        if (this.state.selectedId !== undefined) {
          selected = ledger.tasks.find(t => t.id === this.state.selectedId)
        }
        this.setState({ ledger, workspaces, error: undefined, selectedId: selected === undefined ? undefined : this.state.selectedId })
      } catch (error) {
        this.setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        this.refreshInFlight = undefined
      }
    })()
    return this.refreshInFlight
  }

  /** Stop everything. */
  dispose(): void {
    this.disposed = true
    this.disposeStream?.()
    this.subscribers.clear()
  }

  // ------------------------------------------------------------------ view
  /** Open the board (sidebar entry). */
  openBoard(): void { this.setState({ boardOpen: true }) }

  /** Close the board. */
  closeBoard(): void { this.setState({ boardOpen: false }) }

  /** Toggle the board. */
  toggleBoard(): void { this.setState({ boardOpen: !this.state.boardOpen }) }

  /** Set the project filter. */
  setWorkspaceFilter(workspaceId?: string): void {
    this.setState({ filters: { ...this.state.filters, workspaceId } })
  }

  /** Toggle one urgency chip. */
  toggleUrgency(urgency: Urgency): void {
    const set = new Set(this.state.filters.urgencies)
    if (set.has(urgency)) set.delete(urgency)
    else set.add(urgency)
    this.setState({ filters: { ...this.state.filters, urgencies: [...set] } })
  }

  /** Select a task (open detail). */
  select(id?: string): void { this.setState({ selectedId: id }) }

  /** Show/hide the task form (create mode when opening). */
  setComposer(open: boolean): void { this.setState({ composerOpen: open, editingId: undefined }) }

  /** Open the form modal editing an existing task. */
  openEditor(id: string): void { this.setState({ composerOpen: true, editingId: id }) }

  /** Close the form modal whatever its mode. */
  closeForm(): void { this.setState({ composerOpen: false, editingId: undefined }) }

  /** Toggle the secondary tab. */
  toggleSecondary(): void { this.setState({ secondaryOpen: !this.state.secondaryOpen }) }

  // ---------------------------------------------------------------- writes
  /** Create a task (composer submit). */
  async create(body: Parameters<TaskboardClient['create']>[0]): Promise<void> {
    try {
      await this.client.create(body)
      this.setState({ composerOpen: false, error: undefined })
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Edit task fields (form modal submit; the GUI is the owner surface). */
  async update(id: string, ifVersion: number, body: Omit<UpdateTaskBody, 'ifVersion'>): Promise<void> {
    try {
      await this.client.update(id, { ifVersion, ...body })
      this.setState({ composerOpen: false, editingId: undefined, error: undefined })
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Move a task (user surface: done allowed). */
  async move(id: string, ifVersion: number, status: string): Promise<void> {
    try {
      await this.client.move(id, { ifVersion, status })
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Toggle the blocked marker. */
  async toggleBlocked(task: TaskRecord): Promise<void> {
    try {
      await this.client.update(task.id, { ifVersion: task.version, blocked: !task.blocked })
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Append a user comment. */
  async comment(id: string, body: string): Promise<void> {
    try {
      await this.client.comment(id, body)
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Trigger a manual run (fresh in-project session, pinned model). */
  async run(id: string): Promise<void> {
    try {
      await this.client.run(id)
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Soft-delete (agent parity) then optional purge. */
  async remove(id: string, ifVersion: number, purge: boolean): Promise<void> {
    try {
      await this.client.remove(id, purge ? { purge: true } : { ifVersion })
      if (purge) this.setState({ selectedId: undefined })
      await this.refresh()
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
