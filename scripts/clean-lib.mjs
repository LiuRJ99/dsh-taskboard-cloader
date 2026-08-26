/**
 * Wipe lib/ before a full rebuild.
 *
 * Both tsdown configs historically ran with clean:false, so modules from
 * renamed/deleted src files survived in lib/ and shipped via the
 * package.json "files" globs. `npm run build` now removes everything first,
 * then rebuilds host + client halves into a fresh lib/. Single-half builds
 * (build:host / build:client alone) stay additive on purpose.
 */
import { rmSync } from 'node:fs'

rmSync(new URL('../lib/', import.meta.url), { recursive: true, force: true })
console.log('cleaned lib/')
