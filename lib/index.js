import { PROTOCOL_SECTION_NAME, TASKBOARD_PROTOCOL } from "./host/protocol-text.js";
import { createGitFace } from "./host/git.js";
import { dshHomePath } from "./host/sdk.js";
import { PRIORITY_SERVICE_TIER } from "./shared/model-capabilities.js";
import { ExecutionService } from "./host/execution.js";
import { registerTaskboardTools, workspaceFace } from "./host/tools.js";
import { registerTaskboardRoutes } from "./host/routes.js";
import { SchedulerService } from "./host/scheduler.js";
import { TaskStore } from "./host/store.js";
import { TemplateStore } from "./host/templates.js";
import { MODEL_EXECUTION_SERVICE } from "./shared/model-execution.js";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
//#region src/index.ts
/** Ledger file name under the DSH home. */
const LEDGER_FILE = "dsh-taskboard.json";
/** Task-template side file name under the DSH home (0.4.0). */
const TEMPLATES_FILE = "dsh-taskboard-templates.json";
/** Cordis plugin name. */
const name = "dsh-taskboard";
/** Required host services (tool registry + prompt assembly). */
const inject = ["tools", "systemPrompt"];
/** Install the DSH model selector plus the provider-neutral service-tier hint. */
function installTaskModelOptions(agentCtx, selection, speed, serviceTier) {
	if (selection !== void 0) installModelSelection(agentCtx, {
		current: selection,
		assembled: void 0
	});
	if (speed !== "fast" || serviceTier !== "priority") return;
	const scoped = agentCtx;
	if (scoped.get("llm")?.supportsServiceTier !== true) return;
	scoped.on("agent/request", (async (_payload, next) => ({
		...await next(),
		serviceTier: PRIORITY_SERVICE_TIER
	})));
}
/**
* Mount the host half.
* @param ctx - the plugin context (tools + systemPrompt injected).
*/
function apply(ctx) {
	const store = new TaskStore({ file: dshHomePath(LEDGER_FILE) });
	const templates = new TemplateStore(dshHomePath(TEMPLATES_FILE));
	store.load();
	const now = () => Date.now();
	const maxConcurrent = Math.max(1, Number.parseInt(process.env.DSH_TASKBOARD_MAX_CONCURRENT ?? "", 10) || 3);
	const disposeSection = ctx.systemPrompt.section({
		name: PROTOCOL_SECTION_NAME,
		order: 180,
		text: TASKBOARD_PROTOCOL
	});
	ctx.effect(() => disposeSection, "dsh-taskboard: protocol section");
	ctx.inject(["workspaceRegistry"], (wsCtx) => {
		const disposers = [];
		const modelProviders = () => {
			try {
				const llm = wsCtx.get("llm");
				return llm === void 0 || typeof llm.listProviders !== "function" ? void 0 : llm.listProviders().map((p) => p.id);
			} catch {
				return;
			}
		};
		disposers.push(...registerTaskboardTools(wsCtx, {
			store,
			workspaces: workspaceFace(wsCtx.workspaceRegistry),
			now,
			modelProviders
		}));
		const events = { onSessionEvent: (listener) => wsCtx.on("session/event", (session, event) => {
			listener(session.id, event);
		}) };
		const git = createGitFace();
		wsCtx.inject(["agents"], (agentCtx) => {
			const modelCapabilities = () => {
				return agentCtx.get("dshModelCapabilities")?.listModelCapabilities() ?? Promise.resolve([]);
			};
			const modelExecution = (sessionId, model, speed) => {
				if (model === void 0) return;
				return agentCtx.get(MODEL_EXECUTION_SERVICE)?.setSessionSpeed(sessionId, model.provider, model.model, speed);
			};
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
				installModelSelection: installTaskModelOptions,
				modelCapabilities,
				modelExecution,
				applyPermissionMode: (session, mode) => {
					const presets = agentCtx.get("permissionPresets");
					if (presets?.set !== void 0 && presets.names?.includes(mode) === true) {
						presets.set(session, mode);
						return;
					}
					const target = session;
					if (typeof target.append !== "function") throw new Error("permission mode unavailable: no session append face");
					target.append("sandbox/mode", { mode });
					target.append("approval/policy", { policy: mode === "danger-full-access" ? "never" : "ask" });
				},
				now,
				git,
				composeAgent: async (presetId) => {
					const presets = agentCtx.get("agentPresets");
					if (presets === void 0) return void 0;
					const resolved = await presets.resolve(presetId);
					return {
						agentPreset: resolved.id,
						setup: async (ctx) => {
							await presets.mount(ctx, resolved.id);
						}
					};
				},
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
				},
				maxConcurrent
			});
			let disposeRoutes;
			agentCtx.inject(["webServer"], (webCtx) => {
				disposeRoutes = registerTaskboardRoutes(webCtx, {
					store,
					workspaces: workspaceFace(wsCtx.workspaceRegistry),
					now,
					run: (taskId, runOptions) => execution.run(taskId, "manual", runOptions),
					cancel: (taskId) => execution.cancel(taskId),
					modelProviders,
					git,
					templates
				});
				return () => disposeRoutes?.();
			});
			execution.reconcile();
			const scheduler = new SchedulerService({
				store,
				execution,
				now,
				maxConcurrent
			});
			scheduler.start();
			disposers.push(() => scheduler.dispose());
			disposers.push(() => execution.dispose());
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
export { LEDGER_FILE, TEMPLATES_FILE, apply, inject, name };

//# sourceMappingURL=index.js.map