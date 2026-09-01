// @vitest-environment jsdom
/**
 * Tests for SlashPromptInput and slash command/skill autocomplete (0.5.5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCommands, defaultSkills } from '../src/client/board/SlashPromptInput.tsx'
import { disposeI18n } from '../src/client/i18n/runtime.ts'

describe('SlashPromptInput & autocomplete (0.5.5)', () => {
  beforeEach(() => {
    // i18n: the component resolves copy through the runtime (no DSH locale
    // service in jsdom) — pin zh and force re-detection so the zh assertions
    // below hold.
    document.documentElement.lang = 'zh-CN'
    disposeI18n()
  })

  it('defines standard slash commands and skills with descriptions', () => {
    const commands = defaultCommands(k => k)
    const skills = defaultSkills(k => k)
    expect(commands.length).toBeGreaterThanOrEqual(8)
    expect(skills.length).toBeGreaterThanOrEqual(15)

    const goalCmd = commands.find(c => c.name === 'goal')
    expect(goalCmd).toBeDefined()
    expect(goalCmd?.kind).toBe('command')

    const uiSkill = skills.find(s => s.name === 'frontend-ui-engineering')
    expect(uiSkill).toBeDefined()
    expect(uiSkill?.kind).toBe('skill')
  })

  it('renders SlashPromptInput and handles value editing', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { SlashPromptInput } = await import('../src/client/board/SlashPromptInput.tsx')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    let currentVal = '初始提示词'
    const handleChange = (v: string) => { currentVal = v }

    root.render(React.createElement(SlashPromptInput, {
      value: currentVal,
      onChange: handleChange,
      placeholder: '请输入提示词...',
    }))
    await new Promise(r => setTimeout(r, 30))

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe('初始提示词')
    expect(textarea.placeholder).toBe('请输入提示词...')

    // Tip line is present
    const tip = host.querySelector('.dsh-atb-prompt-tip')!
    expect(tip.textContent).toContain('Slash 命令与 Agent 技能')

    root.unmount()
    host.remove()
  })

  it('filters and selects slash completions on typing /', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { SlashPromptInput } = await import('../src/client/board/SlashPromptInput.tsx')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    let currentVal = '/go'
    const handleChange = (v: string) => { currentVal = v }

    root.render(React.createElement(SlashPromptInput, {
      value: currentVal,
      onChange: handleChange,
    }))
    await new Promise(r => setTimeout(r, 30))

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.focus()
    textarea.setSelectionRange(3, 3)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 30))

    // The popup is portaled to document.body (fixed-positioned), so it is no
    // longer a DOM descendant of the host container — query the document.
    const popup = document.querySelector('.dsh-atb-slash-popup')
    expect(popup).not.toBeNull()
    expect(popup?.parentElement).toBe(document.body)

    const items = document.querySelectorAll('.dsh-atb-slash-item')
    expect(items.length).toBeGreaterThanOrEqual(1)
    const goalItem = Array.from(items).find(el => el.textContent?.includes('/goal'))!
    expect(goalItem).toBeDefined()

    // Click to select
    ;(goalItem as HTMLElement).click()
    await new Promise(r => setTimeout(r, 20))

    expect(currentVal).toBe('/goal ')

    root.unmount()
    host.remove()
  })

  it('scrolls the keyboard-highlighted item into view (arrow-key navigation)', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { SlashPromptInput } = await import('../src/client/board/SlashPromptInput.tsx')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    let currentVal = '/'
    root.render(React.createElement(SlashPromptInput, { value: currentVal, onChange: (v: string) => { currentVal = v } }))
    await new Promise(r => setTimeout(r, 30))

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.focus()
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 30))

    // Stub geometry: the list shows a 200px window at y=100; items are 30px
    // tall, stacked from y=104. Item rects follow the list's scrollTop so the
    // stub behaves like real scrolling DOM. Everything else keeps real (zero)
    // jsdom rects — including the popup/textarea reads in positionPopup.
    const realRect = HTMLElement.prototype.getBoundingClientRect
    const itemBase = (i: number): number => 104 + i * 30
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('dsh-atb-slash-list')) {
        const top = 100
        return { top, bottom: 300, left: 0, right: 466, width: 466, height: 200, x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
      if (this.classList.contains('dsh-atb-slash-item')) {
        const list = document.querySelector('.dsh-atb-slash-list')!
        const items = Array.from(list.querySelectorAll('.dsh-atb-slash-item'))
        const i = items.indexOf(this)
        const top = itemBase(i) - list.scrollTop
        return { top, bottom: top + 30, left: 0, right: 466, width: 466, height: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
      return realRect.call(this)
    })
    try {
      const list = document.querySelector<HTMLDivElement>('.dsh-atb-slash-list')!
      expect(list.scrollTop).toBe(0)

      const pressKey = async (key: string): Promise<void> => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        await new Promise(r => setTimeout(r, 15))
      }

      // Walk the highlight 8 rows down (visible window ≈ 6 rows): the list
      // must scroll so the highlighted bottom edge re-enters the window.
      for (let i = 0; i < 8; i++) await pressKey('ArrowDown')
      // item 6 sticks out by 14 (partial row), then items 7 and 8 by 30 each:
      // scrollTop 14 → 44 → 74, ending with item 8's bottom exactly at the
      // window's bottom edge (300).
      expect(list.scrollTop).toBe(74)

      // Walk back to the top: the highlight must scroll back into view.
      for (let i = 0; i < 8; i++) await pressKey('ArrowUp')
      expect(list.scrollTop).toBe(4) // item 0 top (104) vs window top (100)
    } finally {
      spy.mockRestore()
    }

    root.unmount()
    host.remove()
  })
})
