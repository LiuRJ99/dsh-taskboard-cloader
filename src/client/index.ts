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
import { BoardController, type GateCapabilityOption } from './controller.ts'
import { injectStyles } from './styles.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountBoard } from './board-mount.tsx'
import { getBetterSidebarService, registerBetterSidebarTab, TASKBOARD_TAB_ID } from './sidebar-tab.tsx'
import { createTaskboardSessionHeaderAction } from './session-header-action.tsx'
import { createSessionJumper, type SessionsServiceFace, type WorkspacesServiceFace } from './session-jump.ts'
import { isTaskModelSupported } from './model-catalog.ts'
import { MODEL_CAPABILITY_SERVICE, type ModelCapability, type ModelCapabilityProvider } from '../shared/model-capabilities.ts'
import { TASKBOARD_CAPABILITY } from '../shared/protocol.ts'

/** Client plugin name. */
export const name = 'dsh-taskboard/client'

/** Required client services (fiber inject waiting). */
export const inject = ['connection']

/** Narrow connection face for the model catalog + preset roster. */
interface ConnectionFace {
  rpc?: {
    call(path: string, endpoint: string, payload: unknown): Promise<{ ok: true; value?: unknown } | { ok: false; error?: unknown }>
  }
  api: {
    llm: {
      models(payload: Record<string, never>): Promise<{
        result: {
          ok: true
          value: {
            groups: Array<{
              id: string
              name: string
              models: Array<{
                id: string
                name?: string
                description?: string
                reasoning?: {
                  efforts: Array<{ id: string; name: string; description?: string }>
                  defaultEffort?: string
                }
                serviceTiers?: readonly { id: string; name?: string; description?: string }[]
              }>
            }>
          }
        } | { ok: false }
      }>
    }
    agentPresets?: {
      list(payload: Record<string, never>): Promise<{ result: { ok: true; value: { presets: Array<{ id: string; name?: string; isDefault: boolean }> } } | { ok: false } }>
    }
  }
}

/** Minimal slot service face; the DSH slot package stays an optional runtime peer. */
interface ClientSlotsFace {
  inject(name: string, factory: () => unknown): unknown
  register(descriptor: { name: string; id: string; order?: number }, component: unknown): unknown
}

/** Effect-hook face the runner provides on the client context. */
interface ClientContextFace {
  get?(name: string): unknown
  /** Direct service property on modern DSH contexts; `get('slots')` is the fallback. */
  slots?: ClientSlotsFace
  effect?(fn: () => unknown, label?: string): void
  /** Cordis lifecycle notifications let optional peers register after us. */
  on?(event: string, listener: (...args: unknown[]) => unknown, options?: { global?: boolean }): () => unknown
}

interface CurrentSessionListFace {
  list?: {
    getSnapshot?(): { current?: unknown }
  }
}

function sessionIdFromCurrent(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { id?: unknown; sessionId?: unknown }
  if (typeof record.id === 'string' && record.id.length > 0) return record.id
  return typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : undefined
}

function currentInteractiveSessionId(ctx: ClientContextFace): string | undefined {
  const sessions = ctx.get?.('sessions') as CurrentSessionListFace | undefined
  return sessionIdFromCurrent(sessions?.list?.getSnapshot?.().current)
}

/** Resolve the optional slot registry without making it a hard dependency. */
function slotsFromContext(ctx: ClientContextFace): ClientSlotsFace | undefined {
  // The dynamic-package guard throws when an undeclared service is read through
  // `ctx.slots`; keep that probe isolated so the optional `ctx.get('slots')`
  // lookup still gets a chance. This is also what preserves legacy shells that
  // do not provide the slot service at all.
  try {
    const direct = ctx.slots
    if (direct !== undefined && typeof direct.inject === 'function' && typeof direct.register === 'function') return direct
  } catch {
    // Direct service access is unavailable until `slots` is declared/injected.
  }
  try {
    const fromService = ctx.get?.('slots') as ClientSlotsFace | undefined
    if (fromService !== undefined && typeof fromService.inject === 'function' && typeof fromService.register === 'function') return fromService
  } catch {
    // A partially mounted optional client service must not break the board.
  }
  return undefined
}

/**
 * Client entry: installs styles, starts the controller, mounts DOM seats.
 * @param ctx - the cordis client context.
 */
export function apply(ctx: ClientContextFace): void {
  try {
    injectStyles()
    const client = createClient()
    const controller = new BoardController(client)

    // Model catalog for the composer: llm.models over the connection RPC —
    // installed through the controller's formal installer (T13: no more
    // monkeypatched instance properties).
    const connection = ctx.get?.('connection') as ConnectionFace | undefined
    if (connection !== undefined) {
      type CatalogRow = {
        provider: string
        model: string
        name?: string
        description?: string
        reasoning?: {
          efforts: Array<{ id: string; name: string; description?: string }>
          defaultEffort?: string
        }
        serviceTiers?: readonly { id: string; name?: string; description?: string }[]
      }
      controller.installModelCatalog(async (): Promise<CatalogRow[]> => {
        const capabilityProvider = ctx.get?.(MODEL_CAPABILITY_SERVICE) as ModelCapabilityProvider | undefined
        const [response, capabilities] = await Promise.all([
          connection.api.llm.models({}),
          capabilityProvider?.listModelCapabilities().catch(() => []) ?? Promise.resolve<readonly ModelCapability[]>([]),
        ])
        if (!response.result.ok) return []
        const capabilityMap = new Map(capabilities.map(capability => [`${capability.provider}\u0000${capability.model}`, capability]))
        const out: CatalogRow[] = []
        for (const group of response.result.value.groups) {
          for (const model of group.models) {
            const capability = capabilityMap.get(`${group.id}\u0000${model.id}`)
            const row = {
              provider: group.id,
              model: model.id,
              ...(model.name !== undefined ? { name: model.name } : {}),
              ...(model.description !== undefined ? { description: model.description } : {}),
              ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
              ...(model.serviceTiers !== undefined ? { serviceTiers: model.serviceTiers } : capability !== undefined ? { serviceTiers: capability.serviceTiers } : {}),
            }
            if (isTaskModelSupported(row)) out.push(row)
          }
        }
        return out
      })

      // Preset roster for the composer (0.3.3): agentPreset.list over the
      // connection RPC — [{id, name}] plus which one is the deployment
      // default (the form pre-selects it on create).
      type PresetRow = { id: string; name?: string }
      controller.installPresetRoster(async (): Promise<{ presets: PresetRow[]; defaultId?: string }> => {
        const list = connection.api.agentPresets
        if (list === undefined) return { presets: [] }
        const response = await list.list({})
        if (!response.result.ok) return { presets: [] }
        const presets = response.result.value.presets.map((p: { id: string; name?: string }) => ({ id: p.id, name: p.name }))
        const def = response.result.value.presets.find((p: { id: string; isDefault: boolean }) => p.isDefault)
        return { presets, ...(def !== undefined ? { defaultId: def.id } : {}) }
      })

      // Lazy-gate discovery is optional and is the sole signal that the GUI
      // should expose extra execution capabilities. A missing/disabled gate is
      // represented as undefined internally and never falls back to noisy,
      // non-functional Browser/Computer checkboxes.
      let lazyGateDiscovery: Promise<GateCapabilityOption[] | undefined> | undefined
      const discoverLazyGate = (refresh = false): Promise<GateCapabilityOption[] | undefined> => {
        if (!refresh && lazyGateDiscovery !== undefined) return lazyGateDiscovery
        const rpc = connection.rpc
        lazyGateDiscovery = rpc?.call === undefined
          ? Promise.resolve(undefined)
          : rpc.call('/tool-lazy-gate', 'discover', {}).then(response => {
              if (!response.ok || typeof response.value !== 'object' || response.value === null) return undefined
              // The host keeps `skills` complete for the lazy-gate settings page;
              // Taskboard intentionally consumes only its active-only projection.
              const val = response.value as { enabledSkills?: unknown; skills?: unknown }
              const skills = Array.isArray(val.enabledSkills)
                ? val.enabledSkills
                : Array.isArray(val.skills)
                  ? val.skills
                  : undefined
              if (!Array.isArray(skills)) return undefined
              return skills
                .filter((skill): skill is { name: string } => typeof skill === 'object' && skill !== null && typeof (skill as { name?: unknown }).name === 'string')
                .map(skill => ({ name: skill.name }))
            }).catch(() => undefined)
        return lazyGateDiscovery
      }
      // A fresh form opens a fresh discovery cycle so newly enabled/registered
      // capabilities appear without retaining stale catalog data. The submit
      // path shares that in-flight result and does not issue a second probe.
      controller.installCapabilityCatalog(async () => (await discoverLazyGate(true)) ?? [])
      controller.installCurrentSessionAuthorizer(async explicitSessionId => {
        const skills = await discoverLazyGate()
        // No gate, or no enabled Taskboard capability: do not make a pointless
        // panel authorization RPC. Task creation itself remains available.
        if (skills === undefined || !skills.some(skill => skill.name === TASKBOARD_CAPABILITY)) return
        const sessionId = explicitSessionId ?? currentInteractiveSessionId(ctx)
        if (sessionId === undefined) throw new Error('当前会话不可用，无法授权任务看板')
        const response = await connection.rpc?.call('/tool-lazy-gate', 'grant-taskboard', { sessionId })
        if (response === undefined || !response.ok) throw new Error('当前运行时不支持任务看板会话授权')
      })
    }

    // Session navigation for execution rows: resolved LAZILY on every jump —
    // apply may run before the runtime provides the services, and a captured
    // undefined would permanently disable the jump. On a platform without
    // them the jump degrades to an 'unavailable' notice instead of failing.
    controller.installSessionJumper(createSessionJumper({
      getSessions: () => ctx.get?.('sessions') as SessionsServiceFace | undefined,
      getWorkspaces: () => ctx.get?.('workspaces') as WorkspacesServiceFace | undefined,
    }))

    controller.start()
    const disposers: Array<() => void> = []
    let sidebarTabActive = false
    let registeredSidebarService: unknown
    let registeredSidebarDisposer: (() => void) | undefined
    let registeredHeaderSlots: ClientSlotsFace | undefined
    let legacyDisposers: Array<() => void> = []

    const disposeLegacyMounts = (): void => {
      for (const disposer of legacyDisposers.splice(0)) disposer()
    }
    const mountLegacy = (): void => {
      if (legacyDisposers.length > 0) return
      try {
        legacyDisposers = [mountSidebarEntry(controller), mountBoard(controller)]
      } catch (error) {
        // DOM failures degrade the board, never the GUI.
        console.error('[dsh-taskboard] mount failed:', error)
      }
    }

    /** Toggle or open a selected task in the best board surface currently available. */
    const openTaskFromHeader = (taskId: string, sessionId: string): void => {
      const currentService = getBetterSidebarService(ctx)
      const nativeReady = sidebarTabActive
        && currentService !== undefined
        && registeredSidebarService === currentService
        && typeof currentService.openTab === 'function'
      if (nativeReady) {
        // Better Sidebar refuses disabled tab types. The user asked for the
        // native path only while the taskboard tab is enabled; avoid claiming a
        // successful navigation when the side-card setting explicitly disables it.
        if (currentService.isTabEnabled?.(TASKBOARD_TAB_ID) === false) return

        // Check if the right sidebar is currently open AND displaying the taskboard tab
        const tabEl = typeof document !== 'undefined'
          ? document.querySelector<HTMLElement>('[data-dsh-atb-sidebar-tab]')
          : null
        const isTabActiveAndVisible = tabEl?.getAttribute('data-visible') === 'true'
        const rightPanel = typeof document !== 'undefined'
          ? document.querySelector('[data-dsh-panel]')
          : null
        const isPanelCollapsed = typeof document !== 'undefined'
          && (document.body.hasAttribute('data-dsh-sidebar-collapsed')
            || rightPanel?.className.includes('panelHidden') === true)
        const isRightPanelOpen = rightPanel !== null && !isPanelCollapsed

        if (isTabActiveAndVisible && isRightPanelOpen) {
          // If the right sidebar is already open and showing taskboard, clicking again collapses the right sidebar.
          // IMPORTANT: Must scope strictly inside [data-dsh-panel-host] so we never accidentally match/collapse the left sidebar!
          const rightSidebarCollapseBtn = typeof document !== 'undefined'
            ? document.querySelector<HTMLButtonElement>(
              '[data-dsh-panel-host] [class*="toggleCluster"] button:last-child, [data-dsh-panel-host] button[aria-label*="侧边栏"], [data-dsh-panel-host] button[aria-label*="側邊欄"], [data-dsh-panel-host] button[aria-label*="sidebar" i], [data-dsh-panel-host] button[aria-label*="折叠"]',
            )
            : null
          if (rightSidebarCollapseBtn !== null) {
            rightSidebarCollapseBtn.click()
            return
          }
          if (typeof currentService.closeTab === 'function') {
            currentService.closeTab(TASKBOARD_TAB_ID, { sessionId })
            return
          }
        }

        // Select before opening: both the native tab and the legacy mount read
        // the same controller snapshot, so a newly mounted board renders the
        // detail pane immediately instead of briefly showing the column overview.
        controller.select(taskId)
        try {
          currentService.openTab?.({ type: TASKBOARD_TAB_ID, path: 'board' }, { sessionId })
        } catch (error) {
          console.error('[dsh-taskboard] native taskboard navigation failed:', error)
        }
        return
      }

      // No companion, a late/failed registration, or an older service without
      // targeted open: the existing center-column mount is the safe fallback (toggles open/close).
      if (controller.getSnapshot().boardOpen) {
        controller.closeBoard()
      } else {
        controller.select(taskId)
        controller.openBoard()
      }
    }

    /** Register the optional DSH session-header action when the slot service exists. */
    const registerHeaderAction = (): void => {
      const slots = slotsFromContext(ctx)
      if (slots === undefined || registeredHeaderSlots === slots) return
      try {
        const component = createTaskboardSessionHeaderAction(controller, (task, sessionId) => {
          openTaskFromHeader(task.id, sessionId)
        })
        slots.inject('conversation.session.header.actions', () => slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-taskboard:session-link',
          order: 10,
        }, component))
        registeredHeaderSlots = slots
      } catch (error) {
        // The header is additive polish; a missing/partial slot service must
        // never disable the board itself.
        console.warn('[dsh-taskboard] session-header slot unavailable:', error)
      }
    }

    const syncSidebarRegistration = (): void => {
      try {
        // Better Sidebar is an optional peer. When its client service is
        // present, the board lives inside the registered tab (and can therefore
        // use the panel/free-window lifecycle); otherwise keep the legacy DOM
        // mount for shells that do not install the companion plugin.
        const currentService = getBetterSidebarService(ctx)
        if (currentService !== undefined) {
          // The service is recreated on Better Sidebar HMR/reload. Identity
          // tracking prevents duplicate registration on ordinary status events
          // while allowing the new service instance to register cleanly.
          if (registeredSidebarService === currentService) return

          if (registeredSidebarDisposer !== undefined) {
            registeredSidebarDisposer()
            registeredSidebarDisposer = undefined
          }

          const registration = registerBetterSidebarTab(ctx, controller)
          if (registration.available) {
            disposeLegacyMounts()
            sidebarTabActive = true
            registeredSidebarService = registration.service
            registeredSidebarDisposer = registration.disposer
            return
          }
        }

        if (registeredSidebarService !== undefined) {
          if (registeredSidebarDisposer !== undefined) {
            registeredSidebarDisposer()
            registeredSidebarDisposer = undefined
          }
          registeredSidebarService = undefined
          sidebarTabActive = false
        }
        if (!sidebarTabActive) mountLegacy()
      } catch (error) {
        // A registration failure must not remove the legacy board fallback.
        console.error('[dsh-taskboard] Better Sidebar registration failed:', error)
        sidebarTabActive = false
        mountLegacy()
      }
    }
    registerHeaderAction()
    syncSidebarRegistration()

    // Cordis may activate sibling client plugins in a different order even
    // when the profile bundle order is correct. Observe lifecycle transitions
    // so a service that appears after this plugin still upgrades the legacy
    // mount to a native tab instead of requiring another restart.
    try {
      const unsubscribe = ctx.on?.(
        'internal/status',
        () => {
          registerHeaderAction()
          syncSidebarRegistration()
        },
        { global: true },
      )
      if (typeof unsubscribe === 'function') disposers.push(unsubscribe as () => void)
    } catch (error) {
      console.warn('[dsh-taskboard] Better Sidebar readiness watcher unavailable:', error)
    }
    // cordis effect semantics: the callback runs immediately and its RETURN
    // VALUE is the disposer (family-plugin precedent: () => () => {...}).
    // A single-layer arrow here executes the teardown immediately.
    // The stylesheet itself is NOT removed here: the HMR driver owns removal
    // of tagged styles on this plugin's rebuild (and a self-removal could
    // race a same-lifetime re-apply); its rules are dsh-atb-* scoped, so a
    // leftover tag after a full disable is inert.
    ctx.effect?.(() => () => {
      disposeLegacyMounts()
      if (registeredSidebarDisposer !== undefined) {
        registeredSidebarDisposer()
        registeredSidebarDisposer = undefined
      }
      registeredSidebarService = undefined
      for (const d of disposers.splice(0)) d()
      registeredHeaderSlots = undefined
      controller.dispose()
    }, 'dsh-taskboard: client mount')
  } catch (error) {
    console.error('[dsh-taskboard] client half failed to start:', error)
  }
}
