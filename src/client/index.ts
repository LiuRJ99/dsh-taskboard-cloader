/**
 * Browser half entry for dsh-taskboard: wires the route client and the
 * board controller, exposes the model catalog (via the runtime's llm.models
 * RPC when the connection service is present), mounts the sidebar entry and
 * the board view.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws.
 *
 * Export shape: `name` / `inject` / `apply`, no default.
 *
 * @module dsh-taskboard/client
 */
import { createClient } from './api.ts'
import { BoardController } from './controller.ts'
import { injectStyles } from './styles.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountBoard } from './board-mount.tsx'

/** Client plugin name. */
export const name = 'dsh-taskboard/client'

/** Required client services (fiber inject waiting). */
export const inject = ['connection']

/** Narrow connection face for the model catalog. */
interface ConnectionFace {
  api: {
    llm: {
      models(payload: Record<string, never>): Promise<{ result: { ok: true; value: { groups: Array<{ id: string; name: string; models: Array<{ id: string; name?: string }> }> } } | { ok: false } }>
    }
  }
}

/** Effect-hook face the runner provides on the client context. */
interface ClientContextFace {
  get?(name: string): unknown
  effect?(fn: () => unknown, label?: string): void
}

/**
 * Mount the client half.
 * @param ctx - the client context (connection injected).
 */
export function apply(ctx: ClientContextFace): void {
  try {
    injectStyles()
    const client = createClient()
    const controller = new BoardController(client)

    // Model catalog for the composer: llm.models over the connection RPC.
    const connection = ctx.get?.('connection') as ConnectionFace | undefined
    if (connection !== undefined) {
      type CatalogRow = { provider: string; model: string; name?: string }
      ;(controller as unknown as { modelCatalog?: () => Promise<CatalogRow[]> }).modelCatalog = async (): Promise<CatalogRow[]> => {
        const response = await connection.api.llm.models({})
        if (!response.result.ok) return []
        const out: CatalogRow[] = []
        for (const group of response.result.value.groups) {
          for (const model of group.models) {
            out.push({ provider: group.id, model: model.id, name: model.name })
          }
        }
        return out
      }
    }

    controller.start()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(controller))
      disposers.push(mountBoard(controller))
    } catch (error) {
      // DOM failures degrade the board, never the GUI.
      console.error('[dsh-taskboard] mount failed:', error)
    }
    // cordis effect semantics: the callback runs immediately and its RETURN
    // VALUE is the disposer (family-plugin precedent: () => () => {...}).
    // A single-layer arrow here executes the teardown immediately.
    ctx.effect?.(() => () => {
      for (const d of disposers.splice(0)) d()
      controller.dispose()
    }, 'taskboard: client mount')
  } catch (error) {
    console.error('[dsh-taskboard] client half failed to start:', error)
  }
}
