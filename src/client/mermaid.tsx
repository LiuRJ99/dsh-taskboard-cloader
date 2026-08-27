import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { loadMermaid } from './mermaid-chunk-loader.ts'
import { sanitizeSvg } from './mermaid-sanitize.ts'

/** Monotonic render id; Mermaid requires ids unique within the document. */
let renderSequence = 0

function nextRenderId(): string {
  renderSequence += 1
  return `dsh-atb-mermaid-${renderSequence}`
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 3).join('\n')
}

function isMermaidCodeBlock(pre: HTMLElement): boolean {
  const code = pre.querySelector('code')
  if (code === null) return false
  return [...code.classList].some(name => {
    const normalized = name.toLowerCase()
    return normalized === 'language-mermaid' || normalized.startsWith('language-mermaid{')
  })
}

function showSource(mount: HTMLElement, source: string, error?: string): void {
  const fallback = document.createElement('div')
  fallback.className = 'dsh-atb-mermaid-fallback'
  fallback.dataset.mermaidState = error === undefined ? 'loading' : 'error'

  if (error !== undefined) {
    const errorEl = document.createElement('div')
    errorEl.className = 'dsh-atb-mermaid-error'
    errorEl.title = error
    errorEl.textContent = 'Mermaid 渲染失败，已显示源码'
    fallback.append(errorEl)
  }

  const pre = document.createElement('pre')
  pre.className = 'dsh-atb-mermaid-source'
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  // textContent is intentional: all failure-path source remains plain text.
  code.textContent = source
  pre.append(code)
  fallback.append(pre)
  mount.replaceChildren(fallback)
}

function showSvg(mount: HTMLElement, svg: string): void {
  const diagram = document.createElement('div')
  diagram.className = 'dsh-atb-mermaid-svg'
  diagram.dataset.mermaidDiagram = ''
  // SECURITY CONTRACT: only sanitizeSvg output may reach this sink. Never put
  // the Mermaid source or an unsanitized render result here.
  diagram.innerHTML = svg
  mount.replaceChildren(diagram)
}

/**
 * Post-process one already-rendered Markdown document. The original source is
 * kept visible while the chunk/render promise is pending and on every failure.
 * Only a sanitized SVG replaces it after a successful render.
 */
export function MermaidMarkdown({
  html,
  className,
  onOpenFile,
}: {
  html: string
  className: string
  onOpenFile?: (path: string) => void
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    let alive = true

    for (const pre of [...container.querySelectorAll<HTMLElement>('pre')]) {
      if (!isMermaidCodeBlock(pre)) continue
      const source = pre.querySelector('code')?.textContent ?? ''
      const mount = document.createElement('div')
      mount.className = 'dsh-atb-mermaid-mount'
      pre.replaceWith(mount)
      showSource(mount, source)

      if (source.trim().length === 0) {
        showSource(mount, source, 'empty Mermaid source')
        continue
      }

      void loadMermaid()
        .then(runtime => {
          runtime.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            // Keep labels in SVG text rather than foreignObject HTML.
            htmlLabels: false,
            // Invalid diagrams should reject into the source fallback.
            suppressErrorRendering: true,
            theme: 'default',
          })
          return runtime.render(nextRenderId(), source)
        })
        .then(result => {
          if (!alive) return
          const clean = sanitizeSvg(result.svg)
          if (clean.length === 0) {
            showSource(mount, source, 'Mermaid SVG rejected by sanitizer')
            return
          }
          showSvg(mount, clean)
        })
        .catch(reason => {
          if (alive) showSource(mount, source, errorText(reason))
        })
    }

    return () => { alive = false }
  }, [html])

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (onOpenFile === undefined) return
    const target = event.target
    if (!(target instanceof Element)) return
    const fileLink = target.closest<HTMLButtonElement>('[data-dsh-atb-file]')
    if (fileLink === null || !event.currentTarget.contains(fileLink)) return
    const path = fileLink.dataset.dshAtbFile
    if (path === undefined || path.length === 0) return
    event.stopPropagation()
    onOpenFile(path)
  }

  return (
    <div
      ref={containerRef}
      className={className}
      onClick={onOpenFile === undefined ? undefined : handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
