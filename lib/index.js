import { PROTOCOL_SECTION_NAME, TASKBOARD_PROTOCOL } from "./host/protocol-text.js";
import { dshHomePath } from "./host/sdk.js";
import { ExecutionService } from "./host/execution.js";
import { registerTaskboardRoutes } from "./host/routes.js";
import { SchedulerService } from "./host/scheduler.js";
import { TaskStore } from "./host/store.js";
import { registerTaskboardTools, workspaceFace } from "./host/tools.js";
//#region src/index.ts
/** Ledger file name under the DSH home. */
const LEDGER_FILE = "dsh-taskboard.json";
/** Cordis plugin name. */
const name = "dsh-taskboard";
/** Required host services (tool registry + prompt assembly). */
const inject = ["tools", "systemPrompt"];
/**
* Mount the host half.
* @param ctx - the plugin context (tools + systemPrompt injected).
*/
function apply(ctx) {
	const store = new TaskStore({ file: dshHomePath(LEDGER_FILE) });
	const now = () => Date.now();
	const disposeSection = ctx.systemPrompt.section({
		name: PROTOCOL_SECTION_NAME,
		order: 180,
		text: TASKBOARD_PROTOCOL
	});
	ctx.effect(() => disposeSection, "dsh-taskboard: protocol section");
	ctx.inject(["workspaceRegistry"], (wsCtx) => {
		const disposers = [];
		disposers.push(...registerTaskboardTools(wsCtx, {
			store,
			workspaces: workspaceFace(wsCtx.workspaceRegistry),
			now
		}));
		const events = { onSessionEvent: (listener) => wsCtx.on("session/event", (session, event) => {
			listener(session.id, event);
		}) };
		wsCtx.inject(["agents"], (agentCtx) => {
			const execution = new ExecutionService({
				store,
				agents: { create: (options) => agentCtx.agents.create(options) },
				workspaces: {
					get: (id) => workspaceFace(wsCtx.workspaceRegistry).get(id),
					attach: async (workspaceId, sessionId) => {
						const ws = wsCtx.workspaceRegistry.get(workspaceId);
						if (ws !== void 0) await ws.attachSession(sessionId);
					}
				},
				events,
				now,
				renameSession: (sessionId, title) => {
					try {
						const sessions = agentCtx.get("sessions");
						const sessionTitle = agentCtx.get("sessionTitle");
						const session = sessions?.get(sessionId);
						if (session !== void 0 && sessionTitle !== void 0) sessionTitle.rename(session, title);
					} catch {}
				},
				defaultModel: () => {
					try {
						const selection = agentCtx.get("agentDefaultModel");
						const read = selection?.currentSelection;
						return read === void 0 ? void 0 : read.call(selection);
					} catch {
						return;
					}
				}
			});
			let disposeRoutes;
			agentCtx.inject(["webServer"], (webCtx) => {
				disposeRoutes = registerTaskboardRoutes(webCtx, {
					store,
					workspaces: workspaceFace(wsCtx.workspaceRegistry),
					now,
					run: (taskId) => execution.run(taskId, "manual")
				});
				return () => disposeRoutes?.();
			});
			const scheduler = new SchedulerService({
				store,
				execution,
				now
			});
			scheduler.start();
			disposers.push(() => scheduler.dispose());
			return () => {
				disposeRoutes?.();
				for (const dispose of disposers.splice(0)) dispose();
			};
		});
		return () => {
			for (const dispose of disposers.splice(0)) dispose();
		};
	});
}
//#endregion
export { LEDGER_FILE, apply, inject, name };

//# sourceMappingURL=index.js.map