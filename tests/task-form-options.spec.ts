import { describe, expect, it } from 'vitest'
import { hasReasoningOptions, speedForModel, supportsTaskFastSpeed } from '../src/client/board/TaskFormModal.tsx'

describe('task form model-dependent options', () => {
  it('only preserves fast speed for the current gpt-5.6 capability set', () => {
    expect(supportsTaskFastSpeed(undefined)).toBe(false)
    expect(supportsTaskFastSpeed('gemini-3.1-flash-lite')).toBe(false)
    expect(supportsTaskFastSpeed('gpt-5.6-luna')).toBe(true)
    expect(speedForModel(undefined, 'fast')).toBe('standard')
    expect(speedForModel('gemini-3.1-flash-lite', 'fast')).toBe('standard')
    expect(speedForModel('gpt-5.6-luna', 'fast')).toBe('fast')
  })

  it('only exposes reasoning when the selected model has efforts', () => {
    expect(hasReasoningOptions(undefined)).toBe(false)
    expect(hasReasoningOptions({ efforts: [] })).toBe(false)
    expect(hasReasoningOptions({ efforts: [{ id: 'high', name: 'High' }] })).toBe(true)
  })
})
