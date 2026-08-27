// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { getInitial, InitialAvatar } from '../src/client/board/Avatar.tsx'

describe('InitialAvatar', () => {
  it('extracts correct initial for user and models', () => {
    expect(getInitial(undefined, true)).toBe('U')
    expect(getInitial('deepseek-chat', false)).toBe('D')
    expect(getInitial('gpt-4o', false)).toBe('G')
    expect(getInitial('claude-3-7-sonnet', false)).toBe('C')
    expect(getInitial('qwen-max', false)).toBe('Q')
    expect(getInitial('o3-mini', false)).toBe('O')
    expect(getInitial(undefined, false)).toBe('A')
    expect(getInitial('', false)).toBe('A')
  })

  it('renders SVG avatar with initials and accessible title', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    root.render(
      React.createElement('div', null,
        React.createElement(InitialAvatar, { name: 'deepseek-chat', isUser: false }),
        React.createElement(InitialAvatar, { isUser: true }),
      )
    )

    await new Promise(r => setTimeout(r, 20))

    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)

    // DeepSeek avatar
    expect(svgs[0]!.getAttribute('aria-label')).toBe('模型：deepseek-chat')
    expect(svgs[0]!.querySelector('text')?.textContent).toBe('D')

    // User avatar
    expect(svgs[1]!.getAttribute('aria-label')).toBe('用户')
    expect(svgs[1]!.querySelector('text')?.textContent).toBe('U')

    root.unmount()
    container.remove()
  })
})
