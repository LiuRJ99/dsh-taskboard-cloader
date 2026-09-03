/**
 * Build-time fallback for the optional dsh-better-sidebar peer.
 *
 * The published companion package owns the canonical declarations. This small
 * structural seam lets the taskboard build in a clean checkout where optional
 * peers are intentionally not installed; the runtime still probes the
 * `betterSidebar` service and never imports the companion bundle.
 */
declare module 'dsh-better-sidebar' {}

declare module 'dsh-better-sidebar/client/service' {
  interface SessionScope {
    sessionId: string
    cwd?: string
    repoRoot?: string
  }

  interface TabComponentProps {
    ctx: { get?(name: string): unknown }
    scope: SessionScope
    visible: boolean
    onReferenceFile?: (path: string) => void
  }

  interface TabDescriptor {
    id: string
    title: string | (() => string)
    icon?: unknown
    order?: number
    single?: boolean
    component: (props: TabComponentProps) => unknown
  }

  interface OpenTabSeed {
    type: string
    title?: string
    path?: string
    diff?: unknown
    id?: string
    url?: string
    meta?: unknown
  }

  interface BetterSidebarService {
    registerTab(descriptor: TabDescriptor): () => void
    /** Optional in older peers; present in Better Sidebar >= 0.12.0. */
    openTab?(seed: OpenTabSeed, scope?: SessionScope): void
    /** Optional in older peers; close active or specific tab. */
    closeTab?(id: string, scope?: SessionScope): void
    readonly features: readonly string[]
    /** Optional in older peers; absent means enabled by default. */
    isTabEnabled?(id: string): boolean
    openFile(scope: SessionScope, path: string, title?: string): void
  }

  export type { SessionScope, TabComponentProps, TabDescriptor, OpenTabSeed, BetterSidebarService }
}
