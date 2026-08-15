// Smoke: load the built host half in Node and run apply() against a fake
// context — proves the P1 wiring (section + dynamic inject + tool register)
// executes against the REAL built artifacts and the REAL @deepseek-ai SDK
// packages from this package's node_modules.
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../lib/index.js')
console.log('plugin name:', plugin.name)
console.log('plugin inject:', plugin.inject)

const sectionCalls = []
const registeredTools = []
const fakeCtx = {
  systemPrompt: {
    section: (spec) => { sectionCalls.push(spec); return () => {} },
  },
  effect: () => {},
  inject: (names, cb) => {
    console.log('dynamic inject requested:', names)
    const wsCtx = {
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        get: () => undefined,
        list: () => [],
      },
      tools: { register: (tool) => { registeredTools.push(tool.name); return () => {} } },
      effect: () => {},
    }
    const dispose = cb(wsCtx)
    console.log('dynamic inject callback returned:', typeof dispose)
    return () => dispose?.()
  },
}
plugin.apply(fakeCtx)
console.log('sections registered:', sectionCalls.map(s => `${s.name}@${s.order} (${s.text.length} chars)`))
console.log('tools registered:', registeredTools.join(', '))
if (sectionCalls.length !== 1) throw new Error('expected exactly one section')
if (registeredTools.length !== 8) throw new Error(`expected 8 tools, got ${registeredTools.length}`)
try { rmSync(join(tmpdir(), 'taskboard-smoke'), { recursive: true, force: true }) } catch { }
console.log('SMOKE OK')
