import { describe, expect, it } from 'vitest'
import { isTaskModelSupported } from '../src/client/model-catalog.ts'

describe('task model catalog filtering', () => {
  it('hides catalog entries that clearly identify non-text endpoints', () => {
    expect(isTaskModelSupported({ model: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' })).toBe(false)
    expect(isTaskModelSupported({ model: 'text-embedding-3-large' })).toBe(false)
    expect(isTaskModelSupported({ model: 'rerank-v3' })).toBe(false)
  })

  it('keeps ordinary and multimodal text models selectable', () => {
    expect(isTaskModelSupported({ model: 'gemini-3-flash', name: 'Gemini 3 Flash' })).toBe(true)
    expect(isTaskModelSupported({ model: 'gemini-2.5-pro-vision', name: 'Gemini Pro Vision' })).toBe(true)
    expect(isTaskModelSupported({ model: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' })).toBe(true)
  })
})
