// @vitest-environment jsdom
/**
 * Right-column generation probes for the session-header 看板 action.
 *
 * The guard under test is a regression guard: dsh-better-sidebar 0.19 moved
 * the right column into DSH's native Sidebar and left the `data-dsh-panel`
 * marker on its BOTTOM workbench, whose close button (折叠底部面板) sits inside
 * `[data-dsh-panel-host]`. Probing either as "the right panel" made the header
 * click toggle the bottom workbench instead of hiding the right column.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boardShownInRightSidebar,
  boardTabBodyVisible,
  getNativeRightSidebar,
  legacyRightPanelCollapseButton,
} from '../src/client/right-sidebar.ts'

const TAB_ID = 'dsh-taskboard:board'

/** Build the marker set better-sidebar 0.19 leaves on screen: panel host + bottom workbench only. */
function mountModernBottomWorkbench(): { host: HTMLElement; close: HTMLButtonElement } {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-panel-host', '')
  const bottom = document.createElement('div')
  bottom.className = 'nArs4W_bottomPanel nArs4W_bottomPanelHidden'
  bottom.setAttribute('data-dsh-panel', '')
  bottom.setAttribute('data-dsh-bottom-panel', '')
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', '折叠底部面板')
  bottom.append(close)
  host.append(bottom)
  document.body.append(host)
  return { host, close }
}

/** Build the legacy (better-sidebar < 0.19) right panel + its two-button toggle cluster. */
function mountLegacyRightPanel(options: { collapsed?: boolean } = {}): { cluster: HTMLElement; bottomToggle: HTMLButtonElement; rightToggle: HTMLButtonElement } {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-panel-host', '')
  const cluster = document.createElement('div')
  cluster.className = 'x_toggleCluster'
  cluster.setAttribute('data-dsh-toggle-cluster', '')
  const bottomToggle = document.createElement('button')
  bottomToggle.type = 'button'
  bottomToggle.setAttribute('aria-label', '折叠底部面板')
  const rightToggle = document.createElement('button')
  rightToggle.type = 'button'
  rightToggle.setAttribute('aria-label', '折叠')
  cluster.append(bottomToggle, rightToggle)
  const panel = document.createElement('div')
  panel.className = options.collapsed === true ? 'x_panel x_panelHidden' : 'x_panel'
  panel.setAttribute('data-dsh-panel', '')
  host.append(cluster, panel)
  document.body.append(host)
  return { cluster, bottomToggle, rightToggle }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('getNativeRightSidebar', () => {
  it('accepts only a controller exposing the expanded-state toggle', () => {
    const service = { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => ({ kind: TAB_ID }) }
    expect(getNativeRightSidebar({ get: name => name === 'sidebarRight' ? service : undefined })).toBe(service)
    expect(getNativeRightSidebar({ get: () => ({ isExpanded: () => true }) })).toBeUndefined()
    expect(getNativeRightSidebar({ get: () => undefined })).toBeUndefined()
  })

  it('swallows an undeclared-service lookup (Cordis dynamic-package guard) and missing ctx.get', () => {
    expect(getNativeRightSidebar({ get: () => { throw new Error('service "sidebarRight" is not declared') } })).toBeUndefined()
    expect(getNativeRightSidebar({})).toBeUndefined()
  })
})

describe('boardShownInRightSidebar', () => {
  it('is true only while the column is expanded AND its active tab is ours', () => {
    const shown = { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => ({ kind: TAB_ID }) }
    const otherTab = { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => ({ kind: 'editor' }) }
    const collapsed = { isExpanded: () => false, toggleExpanded: vi.fn(), active: () => ({ kind: TAB_ID }) }
    expect(boardShownInRightSidebar(shown, TAB_ID)).toBe(true)
    expect(boardShownInRightSidebar(otherTab, TAB_ID)).toBe(false)
    expect(boardShownInRightSidebar(collapsed, TAB_ID)).toBe(false)
    expect(boardShownInRightSidebar(undefined, TAB_ID)).toBe(false)
  })

  it('matches by tab id too, and treats a throwing controller as "not shown"', () => {
    const byId = { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => ({ id: TAB_ID }) }
    expect(boardShownInRightSidebar(byId, TAB_ID)).toBe(true)
    expect(boardShownInRightSidebar(
      { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => ({ kind: 'editor', id: 'editor:README.md' }) },
      TAB_ID,
    )).toBe(false)
    expect(boardShownInRightSidebar(
      { isExpanded: () => true, toggleExpanded: vi.fn(), active: () => { throw new Error('no seat') } },
      TAB_ID,
    )).toBe(false)
  })
})

describe('legacyRightPanelCollapseButton', () => {
  it('never reads the 0.19 bottom workbench as the right panel (regression)', () => {
    const { close } = mountModernBottomWorkbench()
    expect(legacyRightPanelCollapseButton()).toBeNull()
    // The same DOM nevertheless offers a 折叠-labelled button, which is what
    // the previous aria-label selector clicked.
    expect(document.querySelector('[data-dsh-panel-host] button[aria-label*="折叠"]')).toBe(close)
  })

  it('returns the cluster’s LAST button — the right-panel toggle, not the bottom one', () => {
    const { bottomToggle, rightToggle } = mountLegacyRightPanel()
    const button = legacyRightPanelCollapseButton()
    expect(button).toBe(rightToggle)
    expect(button).not.toBe(bottomToggle)
  })

  it('reports nothing while the legacy right panel is collapsed', () => {
    mountLegacyRightPanel({ collapsed: true })
    expect(legacyRightPanelCollapseButton()).toBeNull()
  })

  it('reports nothing when no companion panel is on screen at all', () => {
    expect(legacyRightPanelCollapseButton()).toBeNull()
  })
})

describe('boardTabBodyVisible', () => {
  it('reads the wrapper’s data-visible flag only', () => {
    expect(boardTabBodyVisible()).toBe(false)
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-dsh-atb-sidebar-tab', '')
    document.body.append(wrapper)
    expect(boardTabBodyVisible()).toBe(false)
    wrapper.setAttribute('data-visible', 'true')
    expect(boardTabBodyVisible()).toBe(true)
    wrapper.setAttribute('data-visible', 'false')
    expect(boardTabBodyVisible()).toBe(false)
  })
})
