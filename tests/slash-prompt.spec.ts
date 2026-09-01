// @vitest-environment jsdom
/**
 * Tests for SlashPromptInput and slash command/skill autocomplete (0.5.5).
 */
import { beforeEach, describe, expect, it } from 'vitest'
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

    const popup = host.querySelector('.dsh-atb-slash-popup')
    expect(popup).not.toBeNull()

    const items = host.querySelectorAll('.dsh-atb-slash-item')
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
})
