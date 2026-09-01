/**
 * Taskboard i18n runtime: the zh/en dictionary lookup plus the locale
 * SOURCE adapter.
 *
 * Locale source, in priority order:
 * 1. The DSH locale service (ctx.get('locale'), the same plugin that backs
 *    设置 → 通用设置 → 语言). Consumed through a NARROW structural face and
 *    attached SOFTLY — the plugin must keep working on compositions where
 *    the service is absent, so 'locale' is deliberately NOT in the client
 *    inject list (a hard inject would wait forever there).
 * 2. A local fallback: <html lang> when the DSH locale plugin maintains it
 *    (it points <html lang> at the active locale), else navigator.language,
 *    else 'en' (matches DSH: zh only when something asked for Chinese).
 *
 * Preference WRITES are never made here: switching languages is the DSH
 * settings page's job; this module only reads.
 *
 * React re-render: useT() subscribes via useSyncExternalStore; the snapshot
 * object is replaced only on locale change, so renders are stable.
 *
 * @module dsh-taskboard/client/i18n/runtime
 */
import { useSyncExternalStore } from 'react'
import { zh, type TaskboardDict } from './zh.ts'
import { en } from './en.ts'

/** Shipped locales (mirrors the DSH locale plugin's LOCALE_IDS). */
export type LocaleId = 'zh' | 'en'

/** Immutable locale state published on every change. */
export interface TaskboardLocaleSnapshot {
  active: LocaleId
  /** Monotonic change counter (source snapshot revision or local bumps). */
  revision: number
}

/** Translate function: flat key lookup + {name} substitution. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

const DICTS: Record<LocaleId, TaskboardDict> = { zh, en }

/**
 * Narrow structural face of the DSH LocaleRuntime this module consumes.
 * Only the source side (snapshot/subscribe) — translation and preference
 * writes stay local, which keeps us decoupled from the DSH Translate
 * signature and the ns/common lookup chain.
 */
interface LocaleServiceFace {
  getSnapshot(): { active: string; revision: number }
  subscribe(fn: () => void): () => void
}

let service: LocaleServiceFace | undefined
let unsubscribeService: (() => void) | undefined
let snapshot: TaskboardLocaleSnapshot = { active: detectFallbackLocale(), revision: 0 }
const listeners = new Set<() => void>()

function isLocaleId(value: string): value is LocaleId {
  return value === 'zh' || value === 'en'
}

/** Derive the fallback locale without the DSH service (zh only when asked). */
function detectFallbackLocale(): LocaleId {
  try {
    if (typeof document !== 'undefined') {
      const lang = document.documentElement.lang
      if (typeof lang === 'string' && lang.length > 0) {
        const lower = lang.toLowerCase()
        if (lower.startsWith('zh')) return 'zh'
        if (lower.startsWith('en')) return 'en'
      }
    }
  } catch { /* no DOM — fall through */ }
  try {
    if (typeof navigator !== 'undefined') {
      const lang = navigator.language ?? 'en'
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
  } catch { /* no navigator — fall through */ }
  return 'en'
}

function publish(next: TaskboardLocaleSnapshot): void {
  if (next.active === snapshot.active && next.revision === snapshot.revision) return
  snapshot = next
  for (const fn of listeners) fn()
}

/**
 * Attach the DSH locale service (call from the client entry's apply with
 * ctx.get('locale')). Absent/malformed services are ignored — the fallback
 * detection stays in charge.
 * @param localeService - the ctx 'locale' service, when provided.
 */
export function initI18n(localeService: unknown): void {
  const face = localeService as LocaleServiceFace | null | undefined
  if (face === null || face === undefined || typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function') {
    // No usable service: resolve the fallback NOW so a caller that inits
    // after the DOM is up gets the current detection, never a stale
    // module-load snapshot.
    publish({ active: detectFallbackLocale(), revision: 0 })
    return
  }
  service = face
  const sync = (): void => {
    try {
      const s = face.getSnapshot()
      const active = isLocaleId(s.active) ? s.active : detectFallbackLocale()
      publish({ active, revision: s.revision })
    } catch { /* a throwing source must not break the board */ }
  }
  sync()
  unsubscribeService = face.subscribe(sync)
}

/** Detach the service and return to fallback detection (tests, dispose). */
export function disposeI18n(): void {
  try { unsubscribeService?.() } catch { /* source already gone */ }
  unsubscribeService = undefined
  service = undefined
  publish({ active: detectFallbackLocale(), revision: 0 })
}

/** Subscribe-side store face for useSyncExternalStore. */
export const localeStore = {
  getSnapshot(): TaskboardLocaleSnapshot {
    return snapshot
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}

const PLACEHOLDER = /\{(\w+)\}/g

/** Translate through the active dictionary, {name} placeholders substituted. */
export const translate: Translate = (key, params) => {
  const template = DICTS[snapshot.active][key as keyof TaskboardDict] ?? DICTS.en[key as keyof TaskboardDict] ?? key
  if (params === undefined) return template
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * React hook: subscribes the component to locale changes and returns the
 * translate function (stable identity — it reads the active locale at call
 * time, so any re-render triggered by the subscription renders fresh text).
 */
export function useT(): Translate {
  useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot)
  return translate
}
