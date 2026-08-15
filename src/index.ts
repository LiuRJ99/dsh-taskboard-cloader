/**
 * Host loader entry for dsh-agent-taskboard.
 *
 * Wiring: the ledger store (one JSON file under the DSH home), the eight
 * `taskboard_*` agent tools, the agent workflow-protocol system-prompt
 * section, the /agent-taskboard JSON+SSE routes (when a webServer is served),
 * the host execution service (fresh in-project sessions, pinned models), and
 * the host-side cron scheduler for scheduled tasks.
 *
 * Export shape follows the dsh-tool-todo lesson: a function/namespace plugin —
 * `name` / `inject` / `apply`, NO default export.
 *
 * @module dsh-agent-taskboard
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only module imports: they load the cordis Context augmentations
// (ctx.tools / ctx.systemPrompt / ctx.agents) and vanish at compile time —
// the built host half keeps ZERO runtime @deepseek-ai imports.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import { PROTOCOL_SECTION_NAME, PROTOCOL_SECTION_ORDER, TASKBOARD_PROTOCOL } from './host/protocol-text.ts'
import { ExecutionService, type EventsFace } from './host/execution.ts'
import { registerTaskboardRoutes } from './host/routes.ts'
import { SchedulerService } from './host/scheduler.ts'
import { dshHomePath } from './host/sdk.ts'
import { TaskStore } from './host/store.ts'
import { registerTaskboardTools, workspaceFace } from './host/tools.ts'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'agent-taskboard.json'

/** Cordis plugin name. */
export const name = 'dsh-agent-taskboard'

/** Required host services (tool registry + prompt assembly). */
export const inject = ['tools', 'systemPrompt']

/**
 * Mount the host half.
 * @param ctx - the plugin context (tools + systemPrompt injected).
 */
export function apply(ctx: Context): void {
  const store = new TaskStore({ file: dshHomePath(LEDGER_FILE) })
  const now = () => Date.now()

  // Agent workflow protocol (claim discipline, retry rules, done-gate).
  const disposeSection = ctx.systemPrompt.section({
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
    text: TASKBOARD_PROTOCOL,
  })
  ctx.effect(() => disposeSection, 'agent-taskboard: protocol section')

  // Tools, routes, execution, and the scheduler all come up with the
  // workspace registry (claim boundary + project execution need it).
  ctx.inject(['workspaceRegistry'], (wsCtx: Context) => {
    const disposers: Array<() => void> = []
    disposers.push(...registerTaskboardTools(wsCtx, {
      store,
      workspaces: workspaceFace(wsCtx.workspaceRegistry),
      now,
    }))

    // Settlement listener over the session event bus.
    const events: EventsFace = {
      onSessionEvent: (listener) => wsCtx.on('session/event', (session, event) => {
        listener(session.id, event as { type: string; data?: unknown })
      }),
    }

    wsCtx.inject(['agents'], (agentCtx: Context) => {
      const execution = new ExecutionService({
        store,
        agents: {
          create: (options): Promise<never> => agentCtx.agents.create(options as never) as Promise<never>,
        },
        workspaces: {
          get: id => workspaceFace(wsCtx.workspaceRegistry).get(id),
          attach: async (workspaceId, sessionId) => {
            const ws = wsCtx.workspaceRegistry.get(workspaceId as never)
            if (ws !== undefined) await ws.attachSession(sessionId as never)
          },
        },
        events,
        now,
        defaultModel: () => {
          try {
            const selection = agentCtx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } | undefined } | undefined
            const read = selection?.currentSelection
            return read === undefined ? undefined : read.call(selection)
          } catch { return undefined }
        },
      })

      // /agent-taskboard routes (the run action reaches the execution service).
      let disposeRoutes: (() => void) | undefined
      agentCtx.inject(['webServer'], (webCtx: Context) => {
        disposeRoutes = registerTaskboardRoutes(webCtx, {
          store,
          workspaces: workspaceFace(wsCtx.workspaceRegistry),
          now,
          run: (taskId: string) => execution.run(taskId, 'manual'),
        })
        return () => disposeRoutes?.()
      })

      // Host-side cron scheduler: due scheduled tasks execute even with no
      // browser open.
      const scheduler = new SchedulerService({ store, execution, now })
      scheduler.start()
      disposers.push(() => scheduler.dispose())

      return () => {
        disposeRoutes?.()
        for (const dispose of disposers.splice(0)) dispose()
      }
    })

    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}
