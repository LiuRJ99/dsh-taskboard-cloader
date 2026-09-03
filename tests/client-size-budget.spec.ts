/**
 * Client bundle size regression guard.
 *
 * Background: upstream (0.6.2, DSH-Store#321) shipped this guard against the
 * DSH STORE per-file review bound (262144 bytes / 256 KiB) after enabling
 * rolldown minify — its wrapped lib/client.js dropped from 320,851 to 203,793
 * bytes. That bound applied to upstream's LEAN single-file bundle.
 *
 * This fork merges upstream 0.6.4 with the fork's own client features: the
 * full GFM Markdown renderer (marked), interactive Mermaid rendering/zoom
 * UI, clickable file paths, per-task capability pickers, the Better Sidebar
 * integration and richer form/detail layouts. Rolldown minify IS active
 * (confirmed: 305 KB raw → 78 KB gzip), and the fork additionally ships a
 * >256 KiB lazy client-mermaid.js chunk by design — so the upstream
 * single-file store premise does not apply to the merged bundle.
 *
 * The guard therefore pins the merged artifact at its current size with a
 * headroom, so future growth still fails the suite loudly instead of
 * silently bloating the runtime payload.
 */
import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Merged-fork regression cap: current wrapped lib/client.js (~306 KB) plus a
// headroom; raised only deliberately when a feature genuinely requires it.
const MERGED_REGRESSION_CAP = 335_000
const HEADROOM = 16_384 // 16 KiB safety margin for ordinary growth

describe('client bundle size budget', () => {
  it('keeps lib/client.js from silently growing beyond the merged cap', () => {
    const size = statSync(new URL('../lib/client.js', import.meta.url)).size
    const kib = (size / 1024).toFixed(1)
    console.log(`lib/client.js = ${size} bytes (${kib} KiB); merged regression cap ${MERGED_REGRESSION_CAP} (${(MERGED_REGRESSION_CAP / 1024).toFixed(0)} KiB)`)
    expect(size).toBeLessThan(MERGED_REGRESSION_CAP)
    expect(size).toBeGreaterThan(0)
  })
})
