// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { builtinTemplateContent } from '../src/shared/builtin-templates.ts'

describe('shipped client wrapper', () => {
  it('registers lazily and resolves dependencies through the injected require', () => {
    const load = vi.fn()
    const wrapped = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // Registration must work without global require, module, React, or document.
    runInNewContext(wrapped, { window: { __ModuleLoader__: { load } } })
    expect(load).toHaveBeenCalledTimes(1)
    const registration = load.mock.calls[0]![0]
    expect(registration.id).toBe('dsh-taskboard')
    expect(registration.factory).toBeTypeOf('function')

    const sentinel = new Error('host require reached')
    const require = vi.fn(() => { throw sentinel })
    expect(() => registration.factory(require)).toThrow(sentinel)
    expect(require).toHaveBeenCalled()
  })

  it('retains the actual bundled template prompt without injected indentation', () => {
    const wrapped = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // Evaluate the literal array + join expression emitted for this template,
    // rather than the source template which was never affected by wrapping.
    const prompt = wrapped.match(/prompt:(\[`实现以上新功能并按序交接：`[\s\S]*?\]\.join\(`[\s\S]*?`\))/)?.[1]
    expect(prompt).toBeDefined()
    expect(Function(`return ${prompt}`)()).toBe(builtinTemplateContent('tpl-feature', 'zh')!.task.prompt)
  })
})
