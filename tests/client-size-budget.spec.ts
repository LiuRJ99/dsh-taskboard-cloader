/**
 * DSH STORE source-contract guard: the automatic catalog review reads a
 * bounded runtime source tree and hard-rejects any single file above
 * 262144 bytes (256 KiB) — lib/client.js is this plugin's largest artifact
 * and is exactly what deferred the 0.6.x store update (DSH-Store#321).
 * Keep it below the bound with headroom so the per-file gate never trips
 * again; a regression fails the suite instead of silently re-blocking the
 * catalog listing.
 */
import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const STORE_PER_FILE_BOUND = 262_144 // 256 KiB hard bound in DSH STORE review
const HEADROOM = 16_384 // 16 KiB safety margin for future growth

describe('client bundle size budget', () => {
  it('keeps lib/client.js under the DSH STORE per-file bound with headroom', () => {
    const size = statSync(new URL('../lib/client.js', import.meta.url)).size
    const kib = (size / 1024).toFixed(1)
    console.log(`lib/client.js = ${size} bytes (${kib} KiB); store bound ${STORE_PER_FILE_BOUND}, budget ${STORE_PER_FILE_BOUND - HEADROOM}`)
    expect(size).toBeLessThan(STORE_PER_FILE_BOUND - HEADROOM)
  })
})
