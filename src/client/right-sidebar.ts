/**
 * Right-column navigation face for the session-header 看板 action.
 *
 * Two generations of the right column exist, and a header click must toggle
 * the RIGHT one:
 *
 * 1. **Native right Sidebar** (DSH 0.1.5+, `ctx.sidebarRight`). Since
 *    dsh-better-sidebar 0.19 the companion registers the board as a native tab
 *    type and routes every open there, so the column's expanded state and its
 *    active tab are read from the native controller.
 * 2. **Legacy companion panel** (dsh-better-sidebar < 0.19, and shells without
 *    the native Sidebar), where the companion still draws the right column
 *    itself: `[data-dsh-panel]` with a `panelHidden` class while collapsed, and
 *    the persistent toggle cluster in `[data-dsh-panel-host]` whose LAST button
 *    collapses the right panel.
 *
 * Generation 2's markers were REUSED by 0.19: the companion's bottom workbench
 * now carries `data-dsh-panel` (+ `data-dsh-bottom-panel`) and its close button
 * (`aria-label="折叠底部面板"`, handler = toggle bottom panel) sits inside
 * `[data-dsh-panel-host]`. Probing those as "the right panel" is what made a
 * header click toggle the BOTTOM workbench — open on the second click, hide on
 * the third — instead of hiding the right column. Hence the explicit exclusion
 * below: only an element WITHOUT `data-dsh-bottom-panel` may be read as the
 * legacy right panel, and only the toggle cluster may be clicked.
 *
 * @module dsh-taskboard/client/right-sidebar
 */

/** Minimal face of DSH's native right Sidebar controller (`ctx.sidebarRight`). */
export interface NativeRightSidebarFace {
  /** `true` while the column shows its panel, `false` while collapsed. */
  isExpanded?(): boolean
  /** Collapse an expanded column, or expand a collapsed one. */
  toggleExpanded?(): void
  /** The active tab of the active pane; `undefined` without a mounted seat. */
  active?(): { id?: string; kind?: string } | undefined
}

/**
 * Resolve the native right Sidebar controller without making it a hard
 * dependency: older shells (and compositions whose right column the companion
 * still draws itself) simply have no such service.
 * @param ctx - the client context (service lookup only).
 * @returns the controller, or undefined when the native column is absent.
 */
export function getNativeRightSidebar(ctx: { get?(name: string): unknown }): NativeRightSidebarFace | undefined {
  try {
    const service = ctx.get?.('sidebarRight') as NativeRightSidebarFace | undefined
    if (service === undefined || service === null) return undefined
    if (typeof service.isExpanded !== 'function' || typeof service.toggleExpanded !== 'function') return undefined
    return service
  } catch {
    // An undeclared service can throw on lookup (Cordis dynamic-package guard).
    return undefined
  }
}

/**
 * Whether the native right Sidebar currently SHOWS the board: the column is
 * expanded and our tab is its active one. That is the only state in which a
 * header click means "hide the column"; every other state means "reveal it".
 * @param sidebar - the native controller, or undefined.
 * @param tabId - the tab type this plugin owns.
 */
export function boardShownInRightSidebar(sidebar: NativeRightSidebarFace | undefined, tabId: string): boolean {
  if (sidebar === undefined) return false
  try {
    if (sidebar.isExpanded?.() !== true) return false
    const active = sidebar.active?.()
    // Native page tabs carry the descriptor id as `kind`; `id` is checked too
    // so a companion that mints a prefixed implementation id still matches.
    return active?.kind === tabId || active?.id === tabId
  } catch {
    return false
  }
}

/**
 * The collapse control of the LEGACY companion right panel, or null when that
 * generation is not on screen. Requires the right panel itself to be present
 * (explicitly excluding the bottom workbench) and expanded; the button is the
 * toggle cluster's last child, since the cluster renders the bottom-panel
 * toggle first.
 * @returns the clickable control, or null.
 */
export function legacyRightPanelCollapseButton(): HTMLButtonElement | null {
  if (typeof document === 'undefined') return null
  const panel = document.querySelector<HTMLElement>('[data-dsh-panel]:not([data-dsh-bottom-panel])')
  if (panel === null || panel.className.includes('panelHidden')) return null
  return document.querySelector<HTMLButtonElement>(
    '[data-dsh-panel-host] [data-dsh-toggle-cluster] button:last-child, [data-dsh-panel-host] [class*="toggleCluster"] button:last-child',
  )
}

/**
 * Whether the board tab body is rendered with `visible` — the legacy
 * generation's "the board is the shown tab" signal (the native generation
 * answers through {@link boardShownInRightSidebar} instead).
 */
export function boardTabBodyVisible(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector<HTMLElement>('[data-dsh-atb-sidebar-tab]')?.getAttribute('data-visible') === 'true'
}
