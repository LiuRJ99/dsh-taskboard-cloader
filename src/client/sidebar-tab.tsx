/**
 * Optional DSH-better-sidebar integration.
 *
 * The taskboard remains usable on shells without better-sidebar: callers use
 * the returned `available` flag to select the legacy DOM mount. Runtime
 * interaction with the other plugin goes through the context service; the
 * package import below is type-only so the client bundle stays independent.
 *
 * @module dsh-taskboard/client/sidebar-tab
 */
import type {
  BetterSidebarService,
  TabComponentProps,
  TabDescriptor,
} from 'dsh-better-sidebar/client/service'
import type { BoardController } from './controller.ts'
import { TaskBoard } from './board/TaskBoard.tsx'

/** The stable tab type owned by this plugin. */
export const TASKBOARD_TAB_ID = 'dsh-taskboard:board'

/** Minimal context face shared with the existing optional client wiring. */
export interface SidebarTabContextFace {
  get?(name: string): unknown
  effect?(fn: () => unknown, label?: string): void
}

/** Result of probing/registering the optional service. */
export interface BetterSidebarRegistration {
  /** Whether the service was present and the tab registration was attempted. */
  available: boolean
  /** The service instance used for this registration, for late-service retries. */
  service?: BetterSidebarService
  /** Only present when the context has no effect manager (test/standalone fallback). */
  disposer?: () => void
}

/** Resolve a short editor title without importing node:path into the client. */
function fileTitle(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return at === -1 ? clean : clean.slice(at + 1)
}

/** Safely read the optional service from a Cordis context. */
export function getBetterSidebarService(ctx: { get?(name: string): unknown }): BetterSidebarService | undefined {
  try {
    const service = ctx.get?.('betterSidebar') as BetterSidebarService | undefined
    if (service === undefined || typeof service.registerTab !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * Register the taskboard as one Better Sidebar tab when the optional plugin is
 * present. The returned disposer is only needed for contexts without Cordis's
 * effect manager; normal DSH activation owns it through `ctx.effect`.
 */
export function registerBetterSidebarTab(
  ctx: SidebarTabContextFace,
  controller: BoardController,
): BetterSidebarRegistration {
  const service = getBetterSidebarService(ctx)
  if (service === undefined) return { available: false }

  const descriptor: TabDescriptor = {
    id: TASKBOARD_TAB_ID,
    title: '任务看板',
    order: 60,
    single: true,
    icon: (size: number) => (
      <span aria-hidden="true" style={{ fontSize: size, lineHeight: 1 }}>▦</span>
    ),
    component: ({ ctx: sidebarCtx, scope, visible }: TabComponentProps) => {
      const liveService = getBetterSidebarService(sidebarCtx)
      const onOpenFile = liveService?.features.includes('openFile') === true
        ? (path: string): void => { liveService.openFile(scope, path, fileTitle(path)) }
        : undefined
      return (
        <div
          className="dsh-atb-sidebar-tab"
          data-dsh-atb-sidebar-tab=""
          data-visible={visible ? 'true' : undefined}
        >
          <TaskBoard
            controller={controller}
            scope={scope}
            visible={visible}
            onOpenFile={onOpenFile}
          />
        </div>
      )
    },
  }

  const register = (): (() => void) => service.registerTab(descriptor)
  if (ctx.effect !== undefined) {
    ctx.effect(register, 'dsh-taskboard: better-sidebar tab')
    return { available: true, service }
  }
  return { available: true, service, disposer: register() }
}
