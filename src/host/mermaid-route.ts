/**
 * Serves the taskboard's heavy Mermaid client chunk from the host half.
 *
 * The official plugin client endpoint serves only the core client registration
 * file, so this fixed, allowlisted route provides the one optional chunk used
 * by the detail Markdown renderer. It carries an ETag so refreshes revalidate
 * without repeatedly downloading the multi-megabyte artifact.
 */
import { createHash } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ROUTE_PREFIX } from '../shared/api.ts'

/** Fixed public path; no user-controlled file name is ever accepted. */
export const MERMAID_BUNDLE_PATH = `${ROUTE_PREFIX}/bundle/mermaid.js`

/** Host modules compile under lib/host; the chunk lives in the published lib/. */
const LIB_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

interface EtagMemo {
  path: string
  mtimeMs: number
  size: number
  value: string
}

let etagMemo: EtagMemo | undefined

async function etagOf(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (etagMemo !== undefined && etagMemo.path === path && etagMemo.mtimeMs === info.mtimeMs && etagMemo.size === info.size) {
      return etagMemo.value
    }
    const hash = createHash('sha1').update(await readFile(path)).digest('hex').slice(0, 12)
    const value = `"${hash}"`
    etagMemo = { path, mtimeMs: info.mtimeMs, size: info.size, value }
    return value
  } catch {
    return undefined
  }
}

/** Build a testable handler; production defaults to the published lib dir. */
export function createMermaidBundleHandler(
  chunkDir: string = LIB_DIR,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const path = join(chunkDir, 'client-mermaid.js')
    const etag = await etagOf(path)
    if (etag === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }

    const requestEtag = req.headers['if-none-match']
    if (requestEtag === etag) {
      res.writeHead(304, { 'cache-control': 'no-cache', etag })
      res.end()
      return
    }

    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        etag,
      })
      if (req.method !== 'HEAD') res.end(body)
      else res.end()
    } catch {
      // The file may disappear during a rebuild between stat and read.
      res.writeHead(404)
      res.end('not found')
    }
  }
}

/** Register the fixed Mermaid chunk route with the current Cordis fiber. */
export function registerMermaidBundleRoute(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MERMAID_BUNDLE_PATH,
    handler: createMermaidBundleHandler(),
  })
}
