import { describe, expect, it } from 'vitest'
import { hasReasoningOptions, speedForModel } from '../src/client/board/TaskFormModal.tsx'
import { supportsTaskFastSpeed } from '../src/shared/model-capabilities.ts'

describe('task form model-dependent options', () => {
  it('only preserves fast speed for a catalog row advertising priority', () => {
    const fast = { provider: 'cpa', model: 'gpt-5.6-luna', serviceTiers: [{ id: 'priority' }] }
    const standard = { provider: 'gemini', model: 'gemini-3.1-flash-lite', serviceTiers: [] }
    expect(supportsTaskFastSpeed(undefined)).toBe(false)
    expect(supportsTaskFastSpeed(standard)).toBe(false)
    expect(supportsTaskFastSpeed(fast)).toBe(true)
    expect(speedForModel(undefined, 'fast')).toBe('standard')
    expect(speedForModel(standard, 'fast')).toBe('standard')
    expect(speedForModel(fast, 'fast')).toBe('fast')
  })

  it('only exposes reasoning when the selected model has efforts', () => {
    expect(hasReasoningOptions(undefined)).toBe(false)
    expect(hasReasoningOptions({ efforts: [] })).toBe(false)
    expect(hasReasoningOptions({ efforts: [{ id: 'high', name: 'High' }] })).toBe(true)
  })
})
