import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMermaidBundleHandler } from '../src/host/mermaid-route.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function invoke(
  handler: ReturnType<typeof createMermaidBundleHandler>,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | number>; body: string }> {
  let status = 0
  let responseHeaders: Record<string, string | number> = {}
  let body = ''
  const response = {
    writeHead(code: number, nextHeaders?: Record<string, string | number>) {
      status = code
      responseHeaders = nextHeaders ?? {}
    },
    end(value?: Uint8Array | string) {
      body = typeof value === 'string' ? value : value === undefined ? '' : new TextDecoder().decode(value)
    },
  }
  await handler({ method, headers } as never, response as never)
  return { status, headers: responseHeaders, body }
}

describe('taskboard Mermaid bundle route', () => {
  it('serves the allowlisted chunk with ETag revalidation and HEAD support', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-mermaid-route-'))
    tempDirs.push(dir)
    await writeFile(join(dir, 'client-mermaid.js'), 'globalThis.__dshTaskboardChunks__ = {}')
    const handler = createMermaidBundleHandler(dir)

    const first = await invoke(handler, 'GET')
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(first.body).toContain('__dshTaskboardChunks__')
    expect(typeof first.headers.etag).toBe('string')

    const head = await invoke(handler, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers.etag).toBe(first.headers.etag)

    const cached = await invoke(handler, 'GET', { 'if-none-match': String(first.headers.etag) })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')
  })

  it('rejects unsupported methods and missing build artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-mermaid-route-missing-'))
    tempDirs.push(dir)
    const handler = createMermaidBundleHandler(dir)

    expect((await invoke(handler, 'POST')).status).toBe(405)
    expect((await invoke(handler, 'GET')).status).toBe(404)
  })
})
