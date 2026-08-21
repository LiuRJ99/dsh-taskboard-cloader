import { describe, expect, it } from 'vitest'
import { hasReasoningOptions, speedForModel } from '../src/client/board/TaskFormModal.tsx'

describe('task form model-dependent options', () => {
  it('requires an explicit model before preserving fast speed', () => {
    expect(speedForModel(false, 'fast')).toBe('standard')
    expect(speedForModel(false, 'standard')).toBe('standard')
    expect(speedForModel(true, 'fast')).toBe('fast')
  })

  it('only exposes reasoning when the selected model has efforts', () => {
    expect(hasReasoningOptions(undefined)).toBe(false)
    expect(hasReasoningOptions({ efforts: [] })).toBe(false)
    expect(hasReasoningOptions({ efforts: [{ id: 'high', name: 'High' }] })).toBe(true)
  })
})
