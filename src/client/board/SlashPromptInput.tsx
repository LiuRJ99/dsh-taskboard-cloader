/**
 * SlashPromptInput: Rich text input component for task description & execution prompt.
 * Features:
 * - Slash autocomplete popup for commands and skills with keyboard navigation.
 * - Clean text editing without image base64 pollution.
 *
 * @module dsh-taskboard/client/board/SlashPromptInput
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BoardController } from '../controller.ts'
import type { PromptCompletionItem } from '../../shared/api.ts'
import { useT, type Translate } from '../i18n/runtime.ts'

/** Default built-in slash commands (descriptions resolve through t at render,
 * so they follow the GUI language live; host-provided items override by name). */
export const defaultCommands = (t: Translate): PromptCompletionItem[] => [
  { name: 'goal', kind: 'command', description: t('slash.cmd.goal.desc'), hint: t('slash.cmd.goal.hint') },
  { name: 'schedule', kind: 'command', description: t('slash.cmd.schedule.desc'), hint: t('slash.cmd.schedule.hint') },
  { name: 'plan', kind: 'command', description: t('slash.cmd.plan.desc') },
  { name: 'browser', kind: 'command', description: t('slash.cmd.browser.desc') },
  { name: 'grill-me', kind: 'command', description: t('slash.cmd.grill-me.desc') },
  { name: 'teamwork-preview', kind: 'command', description: t('slash.cmd.teamwork-preview.desc') },
  { name: 'learn', kind: 'command', description: t('slash.cmd.learn.desc') },
  { name: 'review', kind: 'command', description: t('slash.cmd.review.desc') },
  { name: 'security', kind: 'command', description: t('slash.cmd.security.desc') },
  { name: 'permission', kind: 'command', description: t('slash.cmd.permission.desc'), hint: t('slash.cmd.permission.hint') },
]

/** Default built-in skills (descriptions resolve through t at render). */
export const defaultSkills = (t: Translate): PromptCompletionItem[] => [
  { name: 'frontend-ui-engineering', kind: 'skill', description: t('slash.skill.frontend-ui-engineering') },
  { name: 'api-and-interface-design', kind: 'skill', description: t('slash.skill.api-and-interface-design') },
  { name: 'test-driven-development', kind: 'skill', description: t('slash.skill.test-driven-development') },
  { name: 'debugging-and-error-recovery', kind: 'skill', description: t('slash.skill.debugging-and-error-recovery') },
  { name: 'performance-optimization', kind: 'skill', description: t('slash.skill.performance-optimization') },
  { name: 'ci-cd-and-automation', kind: 'skill', description: t('slash.skill.ci-cd-and-automation') },
  { name: 'code-review-and-quality', kind: 'skill', description: t('slash.skill.code-review-and-quality') },
  { name: 'code-simplification', kind: 'skill', description: t('slash.skill.code-simplification') },
  { name: 'context-engineering', kind: 'skill', description: t('slash.skill.context-engineering') },
  { name: 'doubt-driven-development', kind: 'skill', description: t('slash.skill.doubt-driven-development') },
  { name: 'git-workflow-and-versioning', kind: 'skill', description: t('slash.skill.git-workflow-and-versioning') },
  { name: 'idea-refine', kind: 'skill', description: t('slash.skill.idea-refine') },
  { name: 'incremental-implementation', kind: 'skill', description: t('slash.skill.incremental-implementation') },
  { name: 'interview-me', kind: 'skill', description: t('slash.skill.interview-me') },
  { name: 'memory-leak-debugging', kind: 'skill', description: t('slash.skill.memory-leak-debugging') },
  { name: 'observability-and-instrumentation', kind: 'skill', description: t('slash.skill.observability-and-instrumentation') },
  { name: 'planning-and-task-breakdown', kind: 'skill', description: t('slash.skill.planning-and-task-breakdown') },
  { name: 'security-and-hardening', kind: 'skill', description: t('slash.skill.security-and-hardening') },
  { name: 'shipping-and-launch', kind: 'skill', description: t('slash.skill.shipping-and-launch') },
  { name: 'source-driven-development', kind: 'skill', description: t('slash.skill.source-driven-development') },
  { name: 'spec-driven-development', kind: 'skill', description: t('slash.skill.spec-driven-development') },
  { name: 'using-agent-skills', kind: 'skill', description: t('slash.skill.using-agent-skills') },
]

/** Box model the popup height is expressed in (must match the CSS). */
export const POPUP_BOX_SIZING: CSSProperties['boxSizing'] = 'border-box'

/** Gap between the textarea and the popup, and the viewport margin. */
const POPUP_GAP = 6
const POPUP_MARGIN = 8
/** Smallest popup height that still shows a couple of rows. */
const POPUP_MIN_HEIGHT = 120
/** Height assumed before the popup has ever rendered. */
const POPUP_FALLBACK_HEIGHT = 240

/**
 * The popup's UNCLAMPED height: the head plus the list's own capped height
 * plus the border. Our own `maxHeight` is cleared for the measurement so the
 * box reports what the CONTENT wants rather than what the previous pass
 * allowed — reading the clamped `offsetHeight` back as the next `maxHeight`
 * fed the border in on every render and grew the popup 2px per pass until
 * React threw #185 ("Maximum update depth exceeded"); a short list (few
 * matches) hit it as soon as the query changed to a longer one.
 * @param node - the portaled popup element, or null before its first render.
 * @returns the natural border-box height in px.
 */
export function measurePopupNaturalHeight(node: HTMLElement | null): number {
  if (node === null) return POPUP_FALLBACK_HEIGHT
  const applied = node.style.maxHeight
  node.style.maxHeight = 'none'
  const natural = node.offsetHeight
  node.style.maxHeight = applied
  return natural > 0 ? natural : POPUP_FALLBACK_HEIGHT
}

/** Viewport rect of the anchoring textarea. */
export interface PopupAnchorRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly width: number
}

/** Where the popup goes for one measurement pass. */
export interface PopupPlacement {
  readonly left: number
  readonly top: number
  readonly width: number
  /** Max height to apply; the popup renders at exactly this height. */
  readonly height: number
  readonly openBelow: boolean
}

/**
 * Place the popup above the anchor by preference, flipping below when the top
 * is tight, and clamp the height to the room on the chosen side.
 *
 * The result is a fixed point: applying `height` as `maxHeight` renders the
 * popup at `height`, so the next pass measures the same content and returns
 * the same placement — no render loop.
 * @param input - anchor rect, viewport height and the popup's natural height.
 * @returns the placement in viewport coordinates.
 */
export function placeSlashPopup(input: {
  rect: PopupAnchorRect
  viewportHeight: number
  naturalHeight: number
}): PopupPlacement {
  const { rect, viewportHeight, naturalHeight } = input
  const roomAbove = rect.top - POPUP_GAP - POPUP_MARGIN
  const roomBelow = viewportHeight - POPUP_MARGIN - (rect.bottom + POPUP_GAP)
  const openBelow = roomBelow > roomAbove
  const height = Math.min(naturalHeight, Math.max(openBelow ? roomBelow : roomAbove, POPUP_MIN_HEIGHT))
  const top = openBelow ? rect.bottom + POPUP_GAP : rect.top - POPUP_GAP - height
  return { left: rect.left, top, width: rect.width, height, openBelow }
}

/** Props for SlashPromptInput. */
export interface SlashPromptInputProps {
  value: string
  onChange: (value: string) => void
  controller?: BoardController
  placeholder?: string
  rows?: number
  maxLength?: number
  disabled?: boolean
  autoFocus?: boolean
  className?: string
  ariaLabel?: string
  /**
   * Project the composer targets (0.6.5): the host reads the skill catalog with
   * this workspace's cwd so project skill roots contribute. Changing it
   * refetches the host list.
   */
  workspaceId?: string
}

/**
 * Rich prompt textarea with / autocomplete for slash commands & skills.
 */
export function SlashPromptInput({
  value,
  onChange,
  controller,
  placeholder,
  rows = 4,
  maxLength = 8000,
  disabled = false,
  autoFocus = false,
  className,
  ariaLabel,
  workspaceId,
}: SlashPromptInputProps) {
  const t = useT()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Inline fixed-position style for the portaled popup (set by positionPopup).
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({})
  /** The placement already written to `popupStyle` (loop guard). */
  const appliedPlacementRef = useRef<PopupPlacement | undefined>(undefined)

  // Autocomplete state: only HOST-provided items are stateful; the built-in
  // defaults are re-derived per render so their descriptions follow the
  // active locale live (host items override defaults by name).
  const [hostCompletions, setHostCompletions] = useState<{ commands: PromptCompletionItem[]; skills: PromptCompletionItem[] } | undefined>(undefined)
  const completions = useMemo<{ commands: PromptCompletionItem[]; skills: PromptCompletionItem[] }>(() => {
    const merge = (defaults: PromptCompletionItem[], host: PromptCompletionItem[] | undefined): PromptCompletionItem[] => {
      const map = new Map<string, PromptCompletionItem>()
      for (const d of defaults) map.set(d.name, d)
      for (const h of host ?? []) map.set(h.name, h)
      return Array.from(map.values())
    }
    return { commands: merge(defaultCommands(t), hostCompletions?.commands), skills: merge(defaultSkills(t), hostCompletions?.skills) }
  }, [t, hostCompletions])
  const [popupOpen, setPopupOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashStart, setSlashStart] = useState(-1)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Fetch host completions if controller provided (refetched when the target
  // workspace changes — project skill roots are cwd-sensitive).
  useEffect(() => {
    if (controller === undefined) return
    let alive = true
    void controller.fetchPromptCompletions(workspaceId).then(res => {
      if (!alive || res === undefined) return
      setHostCompletions({
        commands: res.commands.map(c => ({ ...c, kind: 'command' })),
        skills: res.skills.map(s => ({ ...s, kind: 'skill' })),
      })
    })
    return () => { alive = false }
  }, [controller, workspaceId])

  // Filter items based on query
  const filteredItems = useMemo<PromptCompletionItem[]>(() => {
    const q = slashQuery.toLowerCase().trim()
    const all = [...completions.commands, ...completions.skills]
    if (q.length === 0) return all
    return all.filter(item => item.name.toLowerCase().includes(q) || (item.description !== undefined && item.description.toLowerCase().includes(q)))
  }, [completions, slashQuery])

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= filteredItems.length) {
      setSelectedIndex(Math.max(0, filteredItems.length - 1))
    }
  }, [filteredItems.length, selectedIndex])

  // Keep the keyboard-highlighted option visible inside the scrolling list:
  // mouse hovering only ever targets rendered rows, but ArrowUp/ArrowDown can
  // move the highlight past the clipped edge. Adjust the list's scrollTop
  // directly from rect deltas — NOT scrollIntoView, which would also scroll
  // ancestor containers (the modal body behind the portaled popup).
  useLayoutEffect(() => {
    if (!popupOpen) return
    const list = listRef.current
    const active = list?.children[selectedIndex]
    if (list === null || !(active instanceof HTMLElement)) return
    const listRect = list.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom
  }, [popupOpen, selectedIndex, filteredItems])

  // Detect slash typing on cursor movement or text change
  const checkSlashTrigger = (): void => {
    const el = textareaRef.current
    if (el === null) return
    const pos = el.selectionStart
    const currentText = el.value.slice(0, pos)

    // Check if cursor is right after a word starting with /
    const lastSlash = currentText.lastIndexOf('/')
    if (lastSlash >= 0) {
      const charBefore = lastSlash > 0 ? (currentText[lastSlash - 1] ?? '\n') : '\n'
      const isWordStart = /\s/.test(charBefore) || lastSlash === 0
      const queryPart = currentText.slice(lastSlash + 1)
      const noWhitespaceInQuery = !/\s/.test(queryPart)

      if (isWordStart && noWhitespaceInQuery) {
        setSlashStart(lastSlash)
        setSlashQuery(queryPart)
        setPopupOpen(true)
        return
      }
    }
    setPopupOpen(false)
  }

  // Insert picked completion item
  const applyCompletion = (item: PromptCompletionItem): void => {
    const el = textareaRef.current
    if (el === null || slashStart < 0) return
    const pos = el.selectionStart
    const before = value.slice(0, slashStart)
    const after = value.slice(pos)
    const inserted = `/${item.name} `
    const nextText = before + inserted + after
    onChange(nextText)
    setPopupOpen(false)

    // Restore focus & cursor position
    setTimeout(() => {
      if (textareaRef.current !== null) {
        const nextPos = slashStart + inserted.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextPos, nextPos)
      }
    }, 0)
  }

  // Keyboard navigation for slash popup
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popupOpen && filteredItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev + 1) % filteredItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev - 1 + filteredItems.length) % filteredItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const picked = filteredItems[selectedIndex]
        if (picked !== undefined) {
          e.preventDefault()
          applyCompletion(picked)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopupOpen(false)
        return
      }
    }
  }

  // The popup is portaled to document.body and fixed-positioned from the
  // textarea's viewport rect: an absolute popup inside the scrollable modal
  // body was clipped at the container's top edge (0.6.0 field report).
  // Opens above by preference, flips below when the top is tight, and clamps
  // to the viewport (maxHeight shrinks; the list scrolls internally).
  const positionPopup = useCallback((): void => {
    const anchor = textareaRef.current
    if (anchor === null) return
    const rect = anchor.getBoundingClientRect()
    const placement = placeSlashPopup({
      rect,
      viewportHeight: window.innerHeight,
      naturalHeight: measurePopupNaturalHeight(popupRef.current),
    })
    // Compare against the placement ALREADY applied, not against React state:
    // this runs from a layout effect on every render, and a state update per
    // run re-enters the commit phase with the previous base state (React's
    // eager-state pass), which is how an "unchanged" placement still managed
    // to drive an unbounded update loop (#185). The ref is updated
    // synchronously, so a repeat placement never schedules an update at all.
    const applied = appliedPlacementRef.current
    if (applied !== undefined && applied.left === placement.left && applied.top === placement.top
      && applied.width === placement.width && applied.height === placement.height) return
    appliedPlacementRef.current = placement
    setPopupStyle({
      position: 'fixed',
      left: placement.left,
      top: placement.top,
      width: placement.width,
      maxHeight: placement.height,
      // border-box keeps maxHeight and the measured height in one box model
      // (see measurePopupNaturalHeight).
      boxSizing: POPUP_BOX_SIZING,
      zIndex: 100,
    })
  }, [])

  // Reposition after every render while open: the popup's height follows the
  // filtered item count, so typing changes the geometry too. positionPopup
  // no-ops unless the placement actually changed (see appliedPlacementRef).
  useLayoutEffect(() => {
    if (!popupOpen) return
    positionPopup()
  })

  // Follow scrolling and viewport resizes while open (capture phase: the
  // modal body scrolls, the window itself does not).
  useEffect(() => {
    if (!popupOpen) return
    window.addEventListener('scroll', positionPopup, true)
    window.addEventListener('resize', positionPopup)
    return () => {
      window.removeEventListener('scroll', positionPopup, true)
      window.removeEventListener('resize', positionPopup)
    }
  }, [popupOpen, positionPopup])

  return (
    <div className={`dsh-atb-prompt-wrap ${className ?? ''}`}>
      <div className="dsh-atb-prompt-inner">
        <textarea
          ref={textareaRef}
          className="dsh-atb-prompt-input"
          value={value}
          rows={rows}
          maxLength={maxLength}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            onChange(e.target.value)
            checkSlashTrigger()
          }}
          onKeyUp={checkSlashTrigger}
          onClick={checkSlashTrigger}
          onKeyDown={handleKeyDown}
        />

        {/* Slash Autocomplete Popup — portaled to document.body so the
            scrollable modal body can never clip it (see positionPopup). */}
        {popupOpen && filteredItems.length > 0 && createPortal(
          <div ref={popupRef} className="dsh-atb-slash-popup" style={popupStyle} role="listbox" aria-label={t('slash.aria')}>
            <div className="dsh-atb-slash-head">
              <span className="dsh-atb-slash-title">{t('slash.title')}</span>
              <span className="dsh-atb-slash-hint">{t('slash.hint')}</span>
            </div>
            <div ref={listRef} className="dsh-atb-slash-list">
              {filteredItems.map((item, idx) => (
                <div
                  key={`${item.kind}-${item.name}`}
                  role="option"
                  aria-selected={idx === selectedIndex}
                  className="dsh-atb-slash-item"
                  data-active={idx === selectedIndex ? 'true' : undefined}
                  data-kind={item.kind}
                  onClick={() => applyCompletion(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="dsh-atb-slash-badge" data-kind={item.kind}>
                    {item.kind === 'command' ? t('slash.badge.command') : t('slash.badge.skill')}
                  </span>
                  <span className="dsh-atb-slash-name">/{item.name}</span>
                  {item.hint && <span className="dsh-atb-slash-param">{item.hint}</span>}
                  {item.description && <span className="dsh-atb-slash-desc">{item.description}</span>}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
      </div>

      {/* Bottom helper toolbar */}
      <div className="dsh-atb-prompt-foot">
        <span className="dsh-atb-prompt-tip">
          {t('slash.tipA')} <code>/</code> {t('slash.tipB')}
        </span>
      </div>
    </div>
  )
}
