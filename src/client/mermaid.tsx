import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { loadMermaid } from './mermaid-chunk-loader.ts'
import { sanitizeSvg } from './mermaid-sanitize.ts'

/** Monotonic render id; Mermaid requires ids unique within the document. */
let renderSequence = 0

function nextRenderId(): string {
  renderSequence += 1
  return `dsh-atb-mermaid-${renderSequence}`
}

/** Check whether the host/browser environment is in dark mode. */
export function isDarkScheme(): boolean {
  if (typeof document === 'undefined') return true
  if (document.body.hasAttribute('data-ds-dark-theme')) return true
  if (document.documentElement.style.colorScheme === 'dark') return true
  if (document.documentElement.style.colorScheme === 'light') return false
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Subscribe to DSH theme changes via body attribute observer. */
export function subscribeColorScheme(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(() => { callback() })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => { observer.disconnect() }
}

/** Robust clipboard write helper with fallback for all browser contexts. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    if (typeof document !== 'undefined') {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const successful = document.execCommand('copy')
      document.body.removeChild(textarea)
      return successful
    }
  } catch {}
  return false
}

/** Truncate long error stacks to the most informative opening lines. */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 4).join('\n')
}

/** Identify code blocks destined for Mermaid diagram rendering. */
export function isMermaidCodeBlock(pre: HTMLElement): boolean {
  const code = pre.querySelector('code')
  if (code === null) return false
  return [...code.classList].some(name => {
    const normalized = name.toLowerCase()
    return normalized === 'language-mermaid' || normalized.startsWith('language-mermaid{')
  })
}

/**
 * Click-to-enlarge zoom and pan modal for a rendered Mermaid diagram.
 * Mounts via portal to document.body, isolated from card/sidebar layout boundaries.
 */
export function MermaidZoomModal({
  svg,
  onClose,
}: {
  svg: SVGSVGElement
  onClose: () => void
}): ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0 })
  const zoomRef = useRef({ scale: 1, tx: 0, ty: 0 })

  const applyTransform = (): void => {
    const node = svgRef.current
    if (node === null) return
    const { scale, tx, ty } = zoomRef.current
    node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  const zoom = useCallback((delta: number, centerX?: number, centerY?: number): void => {
    const stage = stageRef.current
    if (stage === null) return
    const rect = stage.getBoundingClientRect()
    const cx = centerX ?? rect.width / 2
    const cy = centerY ?? rect.height / 2
    const current = zoomRef.current
    const newScale = Math.min(8, Math.max(0.2, current.scale * delta))
    const sx = rect.width / 2
    const sy = rect.height / 2
    const ratio = newScale / current.scale
    current.tx = cx - sx - (cx - sx - current.tx) * ratio
    current.ty = cy - sy - (cy - sy - current.ty) * ratio
    current.scale = newScale
    applyTransform()
  }, [])

  const reset = useCallback((): void => {
    zoomRef.current = { scale: 1, tx: 0, ty: 0 }
    applyTransform()
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    svgRef.current = svg
    stage.appendChild(svg)
    return () => {
      svg.remove()
      svgRef.current = null
    }
  }, [svg])

  useEffect(() => {
    const stage = stageRef.current
    const node = svgRef.current
    const overlay = overlayRef.current
    if (stage === null || node === null || overlay === null) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key === '+' || event.key === '=') zoom(1.2)
      else if (event.key === '-') zoom(1 / 1.2)
      else if (event.key === '0') reset()
    }

    const onMouseDown = (event: MouseEvent): void => {
      event.preventDefault()
      dragRef.current = {
        active: true,
        startX: event.clientX - zoomRef.current.tx,
        startY: event.clientY - zoomRef.current.ty,
      }
    }

    const onMouseMove = (event: MouseEvent): void => {
      if (!dragRef.current.active) return
      zoomRef.current.tx = event.clientX - dragRef.current.startX
      zoomRef.current.ty = event.clientY - dragRef.current.startY
      applyTransform()
    }

    const onMouseUp = (): void => {
      dragRef.current.active = false
    }

    const onOverlayClick = (event: MouseEvent): void => {
      if (event.target === overlay) onClose()
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKey)
    overlay.addEventListener('click', onOverlayClick)

    return () => {
      stage.removeEventListener('wheel', onWheel)
      node.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKey)
      overlay.removeEventListener('click', onOverlayClick)
    }
  }, [zoom, reset, onClose])

  return createPortal(
    <div className="dsh-atb-mermaid-modal" data-mermaid-modal ref={overlayRef}>
      <div className="dsh-atb-mermaid-modal-toolbar">
        <button
          type="button"
          className="dsh-atb-mermaid-modal-btn"
          title="缩小 (-)"
          aria-label="缩小"
          onClick={() => zoom(1 / 1.2)}
        >
          −
        </button>
        <button
          type="button"
          className="dsh-atb-mermaid-modal-btn"
          title="放大 (+)"
          aria-label="放大"
          onClick={() => zoom(1.2)}
        >
          +
        </button>
        <button
          type="button"
          className="dsh-atb-mermaid-modal-btn"
          title="重置 (0)"
          aria-label="重置"
          onClick={reset}
        >
          ⟳
        </button>
        <button
          type="button"
          className="dsh-atb-mermaid-modal-btn"
          title="关闭 (Esc)"
          aria-label="关闭"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="dsh-atb-mermaid-modal-stage" ref={stageRef} />
      <div className="dsh-atb-mermaid-modal-hint">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
    </div>,
    document.body,
  )
}

/**
 * Individual Mermaid diagram card with header toolbar, copy action,
 * error state fallback, theme reactivity, and click-to-enlarge modal.
 */
export function MermaidDiagram({ code }: { code: string }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [dark, setDark] = useState(() => isDarkScheme())
  const [zoomSvg, setZoomSvg] = useState<SVGSVGElement | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  useEffect(() => {
    let alive = true
    setSvg(null)
    setError(null)

    if (code.trim().length === 0) {
      setError('empty Mermaid source')
      return () => { alive = false }
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
          theme: isDarkScheme() ? 'dark' : 'default',
        })
        return runtime.render(nextRenderId(), code)
      })
      .then(result => {
        if (!alive) return
        const clean = sanitizeSvg(result.svg)
        if (clean.length === 0) {
          setError('Mermaid SVG rejected by sanitizer')
          return
        }
        setSvg(clean)
      })
      .catch(reason => {
        if (!alive) return
        setError(summarizeError(reason))
      })

    return () => { alive = false }
  }, [code, dark])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(code).then(ok => {
      if (!ok) return
      setCopied(true)
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [code, copied])

  const onBodyClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const svgEl = (event.target as Element).closest('svg') ?? event.currentTarget.querySelector('svg')
    if (svgEl === null) return
    const clone = svgEl.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('style')
    clone.removeAttribute('width')
    clone.removeAttribute('height')
    setZoomSvg(clone)
  }

  const rawDisplayCode = code.endsWith('\n') ? code : `${code}\n`

  return (
    <div className="dsh-atb-mermaid-wrap">
      <div className="dsh-atb-mermaid-head">
        <span className="dsh-atb-mermaid-title">mermaid</span>
        <button
          type="button"
          className="dsh-atb-mermaid-copy"
          aria-label={copied ? '已复制' : '复制代码'}
          title={copied ? '已复制' : '复制代码'}
          onClick={onCopy}
        >
          {copied ? '✓ 已复制' : '⧉ 复制'}
        </button>
      </div>
      {error !== null && (
        <div className="dsh-atb-mermaid-error" data-mermaid-state="error" title={error}>
          Mermaid 渲染失败，已显示源码
        </div>
      )}
      {svg !== null && (
        <div
          className="dsh-atb-mermaid-body"
          data-mermaid-diagram=""
          title="点击放大查看"
          onClick={onBodyClick}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {error !== null && (
        <pre className="dsh-atb-mermaid-code"><code className="language-mermaid">{rawDisplayCode}</code></pre>
      )}
      {zoomSvg !== null && <MermaidZoomModal svg={zoomSvg} onClose={() => setZoomSvg(null)} />}
    </div>
  )
}

/** Record representing one swapped Mermaid mount and its React root. */
interface MermaidMount {
  root: Root
  source: string
}

/**
 * Post-process one already-rendered Markdown document.
 * Swaps Mermaid fences into rich interactive MermaidDiagram components while
 * preserving document flow and onOpenFile delegation.
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
  const mountsRef = useRef<MermaidMount[]>([])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return

    // Clean up any previously mounted React roots asynchronously to prevent
    // nested unmount warnings during React commit cycles.
    const staleMounts = mountsRef.current.splice(0)
    if (staleMounts.length > 0) {
      queueMicrotask(() => {
        for (const mount of staleMounts) {
          mount.root.unmount()
        }
      })
    }

    const preElements = [...container.querySelectorAll<HTMLElement>('pre')]
    for (const pre of preElements) {
      if (!isMermaidCodeBlock(pre)) continue
      const rawSource = pre.querySelector('code')?.textContent ?? ''
      const source = rawSource.replace(/\r\n?/g, '\n').replace(/\n$/, '')
      const mountEl = document.createElement('div')
      mountEl.className = 'dsh-atb-mermaid-mount'
      pre.replaceWith(mountEl)

      const root = createRoot(mountEl)
      mountsRef.current.push({ root, source })
      root.render(<MermaidDiagram code={source} />)
    }
  }, [html])

  useEffect(() => () => {
    const mounts = mountsRef.current.splice(0)
    if (mounts.length > 0) {
      queueMicrotask(() => {
        for (const mount of mounts) {
          mount.root.unmount()
        }
      })
    }
  }, [])

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
