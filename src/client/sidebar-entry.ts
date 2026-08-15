/**
 * Sidebar entry injection — structure ported from the working dsh-web-ui
 * family implementations (dsh-ssh / dsh-client-ui-task-board, verified live
 * in this shell): scope to the sidebar root (the logoRow's parent), find the
 * New Session button inside it (newSession class → first direct-child BUTTON
 * → aria-label/text fallbacks), and insert the entry as a direct child of
 * that root next to the logo row. A body-level MutationObserver waits for
 * the shell and self-heals React re-renders; a slow timer covers shells that
 * mount late without further mutations.
 *
 * The row is plain DOM (no React tree) so it can never disturb the shell's
 * reconciliation; the board view it toggles is a separate React root mounted
 * in the center column (see board-mount.tsx).
 *
 * @module dsh-taskboard/client/sidebar-entry
 */
import type { BoardController } from './controller.ts'

/** Stable data attribute identifying this entry row. */
export const ENTRY_SELECTOR = '[data-dsh-atb-entry]'

/** Inline icon (16px nav-icon look). */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'

/**
 * Find the sidebar shell root element, or undefined while not yet mounted.
 * (Same as the working family plugins: sidebarCol pane → logoRow owner.)
 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/**
 * The New Session button: nested in the logo row on current shells, a direct
 * child BUTTON on the real shell (the family plugins' fallback), with
 * aria-label/text fallbacks for other shells.
 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement) return child
  }
  const byAria = root.querySelector<HTMLButtonElement>(
    'button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]',
  )
  if (byAria !== null) return byAria
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find(button => /新会话|新建会话|new session/i.test(button.textContent ?? ''))
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(controller: BoardController): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshAtbEntry = ''
  entry.className = 'dsh-atb-entry'
  entry.setAttribute('aria-label', 'Agent 任务看板')
  entry.innerHTML = `<span class="dsh-atb-entry-icon">${ICON}</span><span class="dsh-atb-entry-label">任务看板</span>`
  entry.addEventListener('click', () => { controller.toggleBoard() })
  return entry
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    // Position relative to the family block (entries injected by sibling
    // plugins), never relative to transient logoRow geometry: every family
    // plugin that self-heals during a re-render then lands in the same
    // relative order. No append-to-end fallback: appending at the end would
    // randomly reorder the block after a shell re-render.
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches('[data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'),
    )
    // agent-taskboard sits before the whole family block.
    const anchor = family.length > 0 ? (family[0] ?? null) : (base.nextElementSibling ?? null)
    root.insertBefore(entry, anchor)
  }
  return true
}

/** Debug counters (window.__atbDebug) — evidence if the entry fails to appear. */
interface AtbDebug { attempts: number; found: boolean; placed: boolean }

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param controller - the board controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(controller: BoardController): () => void {
  const entry = createEntry(controller)
  const debug: AtbDebug = { attempts: 0, found: false, placed: false }
  ;(window as unknown as { __atbDebug?: AtbDebug }).__atbDebug = debug
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    debug.attempts++
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    debug.found = newSessionButton(root) !== undefined
    placed = placeEntry(root, entry)
    debug.placed = placed
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher as the whole-rebuild fallback.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: re-insert in the same frame when a re-render displaces the row.
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry)
    }
  })

  // Belt-and-braces: a late shell mount that triggers no further mutations
  // still gets periodic retries (the family plugins rely on mutation traffic
  // alone; the timer costs one cheap contains-check per tick once placed).
  const retry = setInterval(() => { tryPlace() }, 2_000)

  const syncActive = () => {
    if (controller.getSnapshot().boardOpen) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()

  tryPlace()

  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}
