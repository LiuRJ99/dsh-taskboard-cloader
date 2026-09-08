// @vitest-environment jsdom
/**
 * Slash-popup placement (0.6.5): the height the popup is given must be a FIXED
 * POINT of the measurement, otherwise the layout effect that repositions the
 * popup on every render feeds its own clamped height back in and grows the box
 * a little each pass until React throws #185 ("Maximum update depth exceeded").
 * The regression that motivated these tests: a short list (one match) followed
 * by a longer one grew the popup 2px (the border) per render.
 */
import { describe, expect, it } from 'vitest'
import { measurePopupNaturalHeight, placeSlashPopup } from '../src/client/board/SlashPromptInput.tsx'

const anchor = (top: number, bottom: number, left = 100, width = 400) => ({ top, bottom, left, width })

describe('placeSlashPopup (0.6.5)', () => {
  it('gives a height that renders exactly that height (fixed point)', () => {
    for (const viewportHeight of [560, 720, 843, 1080]) {
      for (const natural of [37, 67, 209, 400, 1400]) {
        for (const [top, bottom] of [[100, 220], [400, 520], [624, 745], [40, 120]] as Array<[number, number]>) {
          const p = placeSlashPopup({ rect: anchor(top, bottom), viewportHeight, naturalHeight: natural })
          // The popup renders at min(natural, height); a stable placement means
          // that value equals the height we just wrote.
          expect(Math.min(natural, p.height)).toBe(p.height)
          expect(p.height).toBeLessThanOrEqual(natural)
        }
      }
    }
  })

  it('opens above by preference and flips below when the top is tight', () => {
    const above = placeSlashPopup({ rect: anchor(600, 700), viewportHeight: 843, naturalHeight: 200 })
    expect(above.openBelow).toBe(false)
    expect(above.top).toBe(600 - 6 - above.height)

    const below = placeSlashPopup({ rect: anchor(60, 160), viewportHeight: 843, naturalHeight: 200 })
    expect(below.openBelow).toBe(true)
    expect(below.top).toBe(160 + 6)
  })

  it('clamps to the room on the chosen side but never below the minimum', () => {
    // Tight below, roomier above → above, clamped to the room above.
    const tight = placeSlashPopup({ rect: anchor(300, 500), viewportHeight: 520, naturalHeight: 400 })
    expect(tight.openBelow).toBe(false)
    expect(tight.height).toBeLessThan(400)
    // Both sides smaller than the floor → the floor wins (popup overflows).
    const floor = placeSlashPopup({ rect: anchor(90, 100), viewportHeight: 130, naturalHeight: 400 })
    expect(floor.height).toBe(120)
  })

  it('carries the anchor geometry through unchanged', () => {
    const p = placeSlashPopup({ rect: anchor(200, 320, 42.5, 507), viewportHeight: 843, naturalHeight: 150 })
    expect(p.left).toBe(42.5)
    expect(p.width).toBe(507)
  })
})

describe('measurePopupNaturalHeight (0.6.5)', () => {
  it('clears and restores the applied maxHeight around the measurement', () => {
    const node = document.createElement('div')
    node.style.maxHeight = '67px'
    Object.defineProperty(node, 'offsetHeight', {
      get() {
        // Reports the unclamped height only while maxHeight is cleared.
        return node.style.maxHeight === 'none' ? 209 : 67
      },
    })
    expect(measurePopupNaturalHeight(node)).toBe(209)
    expect(node.style.maxHeight).toBe('67px')
  })

  it('falls back when there is no node or the box reports no height', () => {
    expect(measurePopupNaturalHeight(null)).toBe(240)
    const zero = document.createElement('div')
    Object.defineProperty(zero, 'offsetHeight', { get: () => 0 })
    expect(measurePopupNaturalHeight(zero)).toBe(240)
  })
})
