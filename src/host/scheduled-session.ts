/** Adapt DSH's live-agent and durable-session APIs for recurring executions. */
import type { AgentsFace } from './execution.ts'

type CreateOptions = Parameters<AgentsFace['create']>[0]
type Handle = Awaited<ReturnType<AgentsFace['create']>>
type Header = { cwd?: string; agentPreset?: string }

export interface ScheduledSessionDeps {
  agents: {
    get(id: string): (Handle['agent'] & {
      session: { header: Header }
      options: CreateOptions['agentOptions']
      cancel(cause: { kind: 'user' }): void
    }) | undefined
    resume(options: { resumeSessionId: string; agentOptions?: CreateOptions['agentOptions']; setup?: CreateOptions['setup'] }): Promise<Handle>
  }
  persistence(): { stat(id: string): Promise<{ header: Header } | undefined> } | undefined
  isArchived(id: string): boolean
}

/**
 * Only confirmed absence, archival or incompatible configuration permits a
 * replacement session... and so does any resume obstacle: busy, locked or
 * corrupt sessions degrade to a brand-new conversation (issue #26 policy),
 * trading history continuity for guaranteed execution progress.
 */
export function scheduledSessionResumer(deps: ScheduledSessionDeps): NonNullable<AgentsFace['resumeScheduled']> {
  return async (sessionId, options) => {
    if (deps.isArchived(sessionId)) return undefined
    const compatible = (header: Header): boolean => header.cwd === options.meta?.cwd
      && header.agentPreset === options.meta?.agentPreset
    const live = deps.agents.get(sessionId)
    if (live !== undefined) {
      // Busy: never queue behind the running conversation — fall back to a
      // fresh session so the scheduled trigger still makes progress.
      if (live.status !== 'idle') return undefined
      if (!compatible(live.session.header)) return undefined
      const model = options.agentOptions
      if (live.options?.provider !== model?.provider || live.options?.model !== model?.model
        || live.options?.reasoningEffort !== model?.reasoningEffort) return undefined
      return {
        agent: live,
        borrowed: true,
        // A registry lookup grants no ownership. Cancel this activity without
        // disposing the agent owned by another service (for example the UI).
        dispose: async () => { live.cancel({ kind: 'user' }); await live.whenIdle() },
      }
    }
    // Unreadable metadata (locked/corrupt/disk trouble) degrades to a fresh
    // session rather than failing the whole scheduled run.
    let stored: { header: Header } | undefined
    try {
      const persistence = deps.persistence()
      stored = await persistence?.stat(sessionId)
    } catch { return undefined }
    if (stored === undefined || !compatible(stored.header)) return undefined
    // Recheck after the asynchronous metadata read, including a GUI resume.
    if (deps.isArchived(sessionId)) return undefined
    if (deps.agents.get(sessionId) !== undefined) return undefined
    try {
      return await deps.agents.resume({
        resumeSessionId: sessionId,
        ...(options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {}),
        ...(options.setup !== undefined ? { setup: options.setup } : {}),
      })
    } catch { return undefined }
  }
}
