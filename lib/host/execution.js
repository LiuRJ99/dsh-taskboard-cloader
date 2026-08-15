import { effectivePrompt, newExecutionId } from "../shared/protocol.js";
import { MessageId } from "./sdk.js";
//#region src/host/execution.ts
/**
* Host execution service: runs a task through dsh's REAL session machinery —
* a fresh agent+session inside the task's project workspace (creation carries
* the pinned model when the task has one), the session is attached to the
* workspace so it appears in the GUI's project session list, the effective
* prompt is submitted as an ordinary user message, and the turn settlement
* (turn/end reason) is folded back into the task's execution record.
*
* Every execution is a NEW session: clean context, no reuse of previous runs.
*
* @module dsh-taskboard/host/execution
*/
/** Whether a turn/end payload closed with an error reason. */
function isErrorTurnEnd(data) {
	if (typeof data !== "object" || data === null) return void 0;
	const reason = data.reason;
	if (typeof reason !== "object" || reason === null) return void 0;
	if (reason.kind !== "error") return void 0;
	const error = reason.error;
	const detail = JSON.stringify(error) ?? "";
	const message = typeof error?.message === "string" ? error.message : "turn failed";
	console.error("[dsh-taskboard] turn error detail:", detail.slice(0, 2e3));
	return { message };
}
/**
* The execution service.
*/
var ExecutionService = class {
	deps;
	/** Execution ids currently settling. */
	settling = /* @__PURE__ */ new Map();
	/** @param deps - store + agents + workspaces + events + clock. */
	constructor(deps) {
		this.deps = deps;
		deps.events.onSessionEvent((sessionId, event) => {
			if (event.type !== "turn/end") return;
			const failure = isErrorTurnEnd(event.data);
			if (failure !== void 0) this.noteFailure(sessionId, failure.message);
		});
	}
	/** Record a turn failure against the running execution of that session. */
	noteFailure(sessionId, message) {
		this.deps.store.mutate("execution-recorded", (ledger) => {
			for (const task of ledger.tasks) for (const execution of task.executions) if (execution.sessionId === sessionId && execution.outcome === "running") {
				execution.outcome = "failed";
				execution.error = message.slice(0, 500);
				execution.endedAt = this.deps.now();
				return [task];
			}
		});
	}
	/** Patch one task's execution record in the ledger. */
	async patchExecution(executionId, patch) {
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			for (const task of ledger.tasks) {
				const execution = task.executions.find((e) => e.id === executionId);
				if (execution !== void 0) {
					Object.assign(execution, patch);
					return [task];
				}
			}
		});
	}
	/**
	* Run one task now (manual button or scheduler tick).
	* @param taskId - the task to run.
	* @param trigger - what started it.
	* @returns the immediate result; settlement lands in the ledger.
	*/
	async run(taskId, trigger) {
		const task = this.deps.store.get(taskId);
		if (task === void 0 || task.trashedAt !== void 0) return {
			ok: false,
			error: `no task ${taskId}`
		};
		if (task.status === "in_progress") return {
			ok: false,
			error: "task is already in progress"
		};
		const workspace = this.deps.workspaces.get(task.workspaceId);
		if (workspace === void 0) return {
			ok: false,
			error: `unknown workspace ${task.workspaceId}`
		};
		const executionId = newExecutionId();
		const sessionId = this.deps.mintSessionId?.() ?? `session-taskboard-${crypto.randomUUID()}`;
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const target = ledger.tasks.find((t) => t.id === taskId);
			if (target === void 0) return void 0;
			target.executions.push({
				id: executionId,
				trigger,
				startedAt: this.deps.now(),
				outcome: "running"
			});
			target.status = "in_progress";
			target.updatedAt = this.deps.now();
			target.updatedBy = { kind: "user" };
			return [target];
		});
		let handle;
		try {
			const model = task.model ?? this.deps.defaultModel?.();
			handle = await this.deps.agents.create({
				sessionId,
				meta: { cwd: workspace.path },
				...model !== void 0 ? { agentOptions: {
					provider: model.provider,
					model: model.model
				} } : {}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.patchExecution(executionId, {
				outcome: "failed",
				error: message.slice(0, 500),
				endedAt: this.deps.now()
			});
			await this.revertProgress(taskId);
			return {
				ok: false,
				error: message
			};
		}
		await this.deps.workspaces.attach(task.workspaceId, sessionId).catch(() => {});
		await this.patchExecution(executionId, { sessionId });
		const message = {
			id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
			role: "user",
			content: [{
				type: "text",
				text: this.executionPrompt(task)
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-taskboard"
			}
		};
		handle.agent.followup(message);
		const settle = () => {
			this.settling.delete(executionId);
			this.deps.store.mutate("execution-recorded", (ledger) => {
				for (const t of ledger.tasks) {
					const execution = t.executions.find((e) => e.id === executionId);
					if (execution !== void 0 && execution.outcome === "running") {
						execution.outcome = "succeeded";
						execution.endedAt = this.deps.now();
						return [t];
					}
				}
			});
		};
		this.settling.set(executionId, settle);
		handle.agent.whenIdle().then(settle, () => {
			this.noteFailure(sessionId, "agent did not reach quiescence");
			settle();
		});
		return {
			ok: true,
			executionId,
			sessionId
		};
	}
	/** The prompt text one execution submits (task context + instructions). */
	executionPrompt(task) {
		const head = `【任务看板执行】${task.title}（任务 ID: ${task.id}）`;
		const state = "本任务由执行服务启动本会话并已置为 in_progress（你无需再认领，也无需移到 done）。";
		const tail = `完成后请：1) 用 taskboard_get 读取任务 ${task.id} 拿最新 version；2) 用 taskboard_comment_add 留评论（做了什么改动、如何验证、剩余风险）；3) 用 taskboard_move 把任务 ${task.id} 移到 in_review（带 ifVersion）。`;
		return `${head}\n\n${state}\n\n${effectivePrompt(task)}\n\n${tail}`;
	}
	/** Move a task back out of in_progress after a failed start. */
	async revertProgress(taskId) {
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const target = ledger.tasks.find((t) => t.id === taskId);
			if (target !== void 0 && target.status === "in_progress") {
				target.status = "todo";
				target.updatedAt = this.deps.now();
				return [target];
			}
		});
	}
};
//#endregion
export { ExecutionService };

//# sourceMappingURL=execution.js.map