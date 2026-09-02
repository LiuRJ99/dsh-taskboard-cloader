// @vitest-environment jsdom
/**
 * i18n suite: bilingual key parity, translate() lookup + placeholder
 * substitution, fallback-locale detection, the DSH locale service
 * soft-attach (live switch), and a source scan asserting every t('...')
 * literal in the client actually exists in both dictionaries.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../src/client/i18n/en.ts'
import { zh } from '../src/client/i18n/zh.ts'
import { COLUMN_KEYS, MOVE_KEYS, OUTCOME_KEYS, STATUS_KEYS, URGENCY_KEYS } from '../src/client/board/labels.ts'
import { disposeI18n, initI18n, localeStore, translate } from '../src/client/i18n/runtime.ts'

describe('dictionaries', () => {
  it('zh and en carry identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('no value is empty (glue fragments may carry intentional edge spaces)', () => {
    for (const [dict, name] of [[zh, 'zh'], [en, 'en']] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.length, name + ':' + key).toBeGreaterThan(0)
        expect(value.trim().length, name + ':' + key).toBeGreaterThan(0)
      }
    }
  })

  it('enum key maps (labels.ts) reference existing dictionary keys', () => {
    for (const map of [COLUMN_KEYS, STATUS_KEYS, MOVE_KEYS, URGENCY_KEYS, OUTCOME_KEYS]) {
      for (const key of Object.values(map)) {
        expect(zh, key).toHaveProperty(key)
        expect(en, key).toHaveProperty(key)
      }
    }
  })
})

describe('translate()', () => {
  it('resolves the active dictionary (zh via <html lang>)', () => {
    document.documentElement.lang = 'zh-CN'
    disposeI18n()
    expect(localeStore.getSnapshot().active).toBe('zh')
    expect(translate('board.title')).toBe(zh['board.title'])
  })

  it('resolves en and falls back to the key itself (fail loud, never blank)', () => {
    document.documentElement.lang = 'en-US'
    disposeI18n()
    expect(localeStore.getSnapshot().active).toBe('en')
    expect(translate('board.title')).toBe(en['board.title'])
    expect(translate('no.such.key')).toBe('no.such.key')
  })

  it('substitutes {name} placeholders and leaves unknown names verbatim', () => {
    document.documentElement.lang = 'en-US'
    disposeI18n()
    expect(translate('board.count.tasks', { n: 3, rev: 7 })).toBe('3 tasks · rev 7')
    // the prompt placeholder documents DSH template variables {{...}} —
    // a missing param must NOT eat the braces
    expect(translate('form.prompt.placeholder')).toContain('{{lastExecution}}')
  })

  it('navigator.language drives detection when <html lang> is empty', () => {
    document.documentElement.lang = ''
    disposeI18n()
    // jsdom defaults navigator.language to 'en-US'
    expect(localeStore.getSnapshot().active).toBe('en')
  })
})

describe('DSH locale service soft-attach', () => {
  /** Minimal LocaleRuntime double: snapshot + subscribe only. */
  function fakeService(initial: string): { face: unknown; set(active: string): void } {
    let snap = { active: initial, revision: 1 }
    const listeners = new Set<() => void>()
    return {
      face: {
        getSnapshot: () => snap,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
      set(active: string) { snap = { active, revision: snap.revision + 1 }; for (const fn of listeners) fn() },
    }
  }

  it('follows a live locale switch without re-init', () => {
    document.documentElement.lang = ''
    const svc = fakeService('zh')
    initI18n(svc.face)
    expect(localeStore.getSnapshot().active).toBe('zh')
    svc.set('en')
    expect(localeStore.getSnapshot().active).toBe('en')
    expect(translate('board.title')).toBe(en['board.title'])
    disposeI18n()
  })

  it('ignores absent and malformed services (fallback takes over)', () => {
    document.documentElement.lang = 'zh-CN'
    expect(() => initI18n(undefined)).not.toThrow()
    expect(() => initI18n({ nope: true })).not.toThrow()
    expect(localeStore.getSnapshot().active).toBe('zh')
    disposeI18n()
  })

  it('subscribe/unsubscribe round-trips through the store face', () => {
    document.documentElement.lang = ''
    const svc = fakeService('zh')
    initI18n(svc.face)
    let calls = 0
    const off = localeStore.subscribe(() => { calls++ })
    svc.set('en')
    expect(calls).toBe(1)
    off()
    svc.set('zh')
    expect(calls).toBe(1)
    disposeI18n()
  })
})

describe('late locale activation (issue #16)', () => {
  /** Minimal LocaleRuntime double (same shape as the soft-attach suite). */
  function fakeService(initial: string): { face: unknown; set(active: string): void } {
    let snap = { active: initial, revision: 1 }
    const listeners = new Set<() => void>()
    return {
      face: {
        getSnapshot: () => snap,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
      set(active: string) { snap = { active, revision: snap.revision + 1 }; for (const fn of listeners) fn() },
    }
  }

  it('no service at apply: a later <html lang> sync re-detects (SSR "en" → zh)', async () => {
    document.documentElement.lang = 'en' // the static server-rendered value
    initI18n(undefined)
    expect(localeStore.getSnapshot().active).toBe('en') // the one-shot fallback…
    document.documentElement.lang = 'zh-CN' // …but the locale runtime syncs late
    await new Promise(r => setTimeout(r, 50)) // MutationObserver delivery
    expect(localeStore.getSnapshot().active).toBe('zh') // …and we follow (#16)
    expect(translate('board.title')).toBe(zh['board.title'])
    disposeI18n()
  })

  it('no service at apply: the retry poll attaches the late-provided service', async () => {
    document.documentElement.lang = 'en'
    const svc = fakeService('zh')
    let provided = false
    initI18n(undefined, () => (provided ? svc.face : undefined))
    expect(localeStore.getSnapshot().active).toBe('en') // fallback until then
    await new Promise(r => setTimeout(r, 50))
    provided = true // the locale plugin provides after our activation
    await new Promise(r => setTimeout(r, 400)) // the next 250ms poll tick
    expect(localeStore.getSnapshot().active).toBe('zh') // service took over
    svc.set('en') // and live switches flow through the subscription
    expect(localeStore.getSnapshot().active).toBe('en')
    disposeI18n()
  })

  it('dispose tears the late attach down (no post-dispose flips)', async () => {
    document.documentElement.lang = 'en'
    initI18n(undefined)
    disposeI18n() // re-detects NOW (lang still "en") and removes the observer
    expect(localeStore.getSnapshot().active).toBe('en')
    document.documentElement.lang = 'zh-CN'
    await new Promise(r => setTimeout(r, 50))
    expect(localeStore.getSnapshot().active).toBe('en') // observer is gone — stays put
    document.documentElement.lang = 'en'
    await new Promise(r => setTimeout(r, 50))
    expect(localeStore.getSnapshot().active).toBe('en')
  })
})

describe('source scan', () => {
  const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (/\.tsx?$/.test(entry.name)) out.push(p)
    }
    return out
  }

  it('every t(quoted-literal) in the client exists in BOTH dictionaries', () => {
    const missing: string[] = []
    for (const file of walk(clientDir)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\b(?:t|translate)\('([a-z][a-z0-9.]*)'/g)) {
        const key = m[1] ?? ''
        if (!(key in zh)) missing.push('zh missing: ' + key)
        if (!(key in en)) missing.push('en missing: ' + key)
      }
    }
    expect(missing).toEqual([])
  })
})