/**
 * On-demand loader for the Mermaid browser chunk.
 *
 * The taskboard core client is served through DSH's single plugin bundle. The
 * Mermaid runtime is intentionally served separately by the taskboard host
 * route so opening ordinary tasks does not download or parse Mermaid's heavy
 * graph dependencies.
 */

/** Narrow runtime face consumed by the React diagram component. */
export interface MermaidRuntime {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

type MermaidChunkFactory = () => Record<string, unknown>

type TaskboardChunkRegistry = {
  mermaid?: MermaidChunkFactory
}

const CHUNK_URL = '/dsh-taskboard/bundle/mermaid.js'
const REGISTRY_KEY = '__dshTaskboardChunks__'

let inFlight: Promise<MermaidRuntime> | undefined
let runtimeOverride: MermaidRuntime | undefined

function registry(): TaskboardChunkRegistry {
  const globals = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: TaskboardChunkRegistry
  }
  return globals[REGISTRY_KEY] ??= {}
}

function asRuntime(value: unknown): MermaidRuntime | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<MermaidRuntime>
  return typeof candidate.initialize === 'function' && typeof candidate.render === 'function'
    ? candidate as MermaidRuntime
    : undefined
}

function materialize(): MermaidRuntime | undefined {
  const factory = registry().mermaid
  if (factory === undefined) return undefined
  try {
    const exports = factory()
    return asRuntime(exports.mermaid) ?? asRuntime(exports.default) ?? asRuntime(exports)
  } catch {
    return undefined
  }
}

function injectChunkScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('Mermaid requires a browser document'))
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = CHUNK_URL
    script.addEventListener('load', () => {
      script.remove()
      resolve()
    }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error(`Mermaid chunk failed to load: ${CHUNK_URL}`))
    }, { once: true })
    document.head.append(script)
  })
}

/** Load and cache Mermaid once per browser page. Failed loads remain retryable. */
export function loadMermaid(): Promise<MermaidRuntime> {
  if (runtimeOverride !== undefined) return Promise.resolve(runtimeOverride)
  if (inFlight !== undefined) return inFlight

  const existing = materialize()
  if (existing !== undefined) return Promise.resolve(existing)

  inFlight = (async () => {
    await injectChunkScript()
    const runtime = materialize()
    if (runtime === undefined) throw new Error('Mermaid chunk did not register a usable runtime')
    return runtime
  })().catch(error => {
    inFlight = undefined
    throw error
  })
  return inFlight
}

/** Test hook; does not affect production behavior unless explicitly called. */
export function setMermaidRuntimeForTests(runtime: MermaidRuntime | undefined): void {
  runtimeOverride = runtime
  inFlight = undefined
}
