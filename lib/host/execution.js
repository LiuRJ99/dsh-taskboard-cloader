import { effectivePrompt, newCommentId, newExecutionId, normalizeBody } from "../shared/protocol.js";
import { MessageId } from "./sdk.js";
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
	/** Live executions by execution id (settles and cancels remove entries). */
	runs = /* @__PURE__ */ new Map();
	/** @param deps - store + agents + workspaces + events + clock. */
	constructor(deps) {
		this.deps = deps;
		deps.events.onSessionEvent((sessionId, event) => {
			if (event.type !== "turn/end") return;
			const failure = isErrorTurnEnd(event.data);
			if (failure !== void 0) this.noteFailure(sessionId, failure.message);
		});
	}
	/** Record a turn failure against the running execution of that session and give the task back. */
	noteFailure(sessionId, message) {
		this.deps.store.mutate("execution-recorded", (ledger) => {
			for (const task of ledger.tasks) for (const execution of task.executions) if (execution.sessionId === sessionId && execution.outcome === "running") {
				execution.outcome = "failed";
				execution.error = message.slice(0, 500);
				execution.endedAt = this.deps.now();
				if (task.status === "in_progress" && task.claimedBy === sessionId) {
					task.status = "todo";
					task.updatedAt = this.deps.now();
					delete task.claimedBy;
					delete task.claimedAt;
					task.comments.push({
						id: newCommentId(),
						body: normalizeBody(`[系统] 执行失败：${message.slice(0, 300)}；任务已退回待办。`),
						version: 1,
						createdAt: this.deps.now()
					});
				}
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
	*
	* The in-progress gate and the execution-open write happen inside ONE
	* serial-queue mutation, so two overlapping run() calls (double click,
	* overlapping scheduler ticks) can never both pass — exactly one session
	* is opened per task.
	* @param taskId - the task to run.
	* @param trigger - what started it.
	* @returns the immediate result; settlement lands in the ledger.
	*/
	async run(taskId, trigger) {
		const max = this.deps.maxConcurrent ?? 3;
		if (this.runs.size >= max) return {
			ok: false,
			error: `execution concurrency limit reached (${this.runs.size}/${max} running)`
		};
		const task = this.deps.store.get(taskId);
		if (task === void 0 || task.trashedAt !== void 0) return {
			ok: false,
			error: `no task ${taskId}`
		};
		const workspace = this.deps.workspaces.get(task.workspaceId);
		if (workspace === void 0) return {
			ok: false,
			error: `unknown workspace ${task.workspaceId}`
		};
		const executionId = newExecutionId();
		const sessionId = this.deps.mintSessionId?.() ?? `session-taskboard-${crypto.randomUUID()}`;
		let gate;
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const target = ledger.tasks.find((t) => t.id === taskId);
			if (target === void 0 || target.trashedAt !== void 0) {
				gate = `no task ${taskId}`;
				return;
			}
			if (target.status === "in_progress") {
				gate = "task is already in progress";
				return;
			}
			target.executions.push({
				id: executionId,
				trigger,
				startedAt: this.deps.now(),
				outcome: "running"
			});
			target.status = "in_progress";
			target.updatedAt = this.deps.now();
			target.updatedBy = { kind: "user" };
			target.claimedBy = sessionId;
			target.claimedAt = this.deps.now();
			return [target];
		});
		if (gate !== void 0) return {
			ok: false,
			error: gate
		};
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
		try {
			this.deps.renameSession?.(sessionId, task.title);
		} catch {}
		await this.patchExecution(executionId, { sessionId });
		const message = {
			id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
			role: "user",
			content: [{
				type: "text",
				text: this.executionPrompt(task)
			}],
			source: { kind: "user" }
		};
		handle.agent.followup(message);
		const settle = () => {
			this.runs.delete(executionId);
			this.deps.store.mutate("execution-recorded", (ledger) => {
				for (const t of ledger.tasks) {
					const execution = t.executions.find((e) => e.id === executionId);
					if (execution !== void 0 && execution.outcome === "running") {
						const now = this.deps.now();
						execution.outcome = "succeeded";
						execution.endedAt = now;
						if (t.status === "in_progress" && t.claimedBy === sessionId) {
							delete t.claimedBy;
							delete t.claimedAt;
						}
						if (t.status === "in_progress") {
							const commented = t.comments.some((c) => c.threadId === sessionId);
							t.comments.push({
								id: newCommentId(),
								body: normalizeBody(commented ? "[系统] 执行会话已结束并留有评论，但未移至待验收；系统自动移入待验收。" : "[系统] 执行会话已结束，但未按协议交接（无评论、未移至待验收）；系统自动移入待验收，请审查后退回或验收。"),
								version: 1,
								createdAt: now
							});
							t.status = "in_review";
							t.updatedAt = now;
							t.updatedBy = { kind: "user" };
						}
						return [t];
					}
				}
			});
		};
		this.runs.set(executionId, {
			sessionId,
			settle,
			dispose: () => handle.dispose()
		});
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
	/** How many executions are currently running (for the concurrency cap). */
	inFlight() {
		return this.runs.size;
	}
	/**
	* Cancel the running execution of a task (user action): stop the agent
	* session, mark the execution cancelled, and hand the task back to todo.
	* @param taskId - the task whose execution should be stopped.
	* @returns the immediate result.
	*/
	async cancel(taskId) {
		const task = this.deps.store.get(taskId);
		if (task === void 0) return {
			ok: false,
			error: `no task ${taskId}`
		};
		const running = [...task.executions].reverse().find((e) => e.outcome === "running");
		if (running === void 0) return {
			ok: false,
			error: "no running execution"
		};
		const entry = this.runs.get(running.id);
		this.runs.delete(running.id);
		try {
			await entry?.dispose();
		} catch {}
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const target = ledger.tasks.find((t) => t.id === taskId);
			if (target === void 0) return void 0;
			const execution = target.executions.find((e) => e.id === running.id);
			if (execution === void 0 || execution.outcome !== "running") return void 0;
			execution.outcome = "cancelled";
			execution.endedAt = this.deps.now();
			if (target.status === "in_progress") {
				target.status = "todo";
				target.updatedAt = this.deps.now();
				delete target.claimedBy;
				delete target.claimedAt;
			}
			return [target];
		});
		return {
			ok: true,
			executionId: running.id
		};
	}
	/**
	* Startup reconciliation after a host restart: executions left `running`
	* by the previous process can never settle here (their settlement watchers
	* died with it), so mark them failed and hand their tasks back to todo.
	*/
	async reconcile() {
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const now = this.deps.now();
			const touched = [];
			for (const task of ledger.tasks) {
				let dirty = false;
				for (const execution of task.executions) if (execution.outcome === "running") {
					execution.outcome = "failed";
					execution.error = "interrupted by host restart";
					execution.endedAt = now;
					dirty = true;
				}
				if (!dirty) continue;
				if (task.status === "in_progress") {
					task.status = "todo";
					task.updatedAt = now;
					delete task.claimedBy;
					delete task.claimedAt;
				}
				touched.push(task);
			}
			return touched.length > 0 ? touched : void 0;
		});
	}
	/**
	* The prompt text one execution submits (task context + instructions).
	* The effective prompt supports two template variables, rendered from the
	* task's own history at submit time (valuable for recurring patrols):
	* `{{lastExecution}}` → the previous execution's trigger/outcome/error;
	* `{{lastComments}}` → the last three comments (who + body).
	*/
	executionPrompt(task) {
		const state = "本任务由执行服务启动本会话并已置为 in_progress（你无需再认领，也无需移到 done）。";
		const tail = `完成后请：1) 用 taskboard_get 读取任务 ${task.id} 拿最新 version；2) 用 taskboard_comment_add 留评论（做了什么改动、如何验证、剩余风险）；3) 用 taskboard_move 把任务 ${task.id} 移到 in_review（带 ifVersion）。`;
		const base = effectivePrompt(task);
		const lastExec = [...task.executions].reverse().find((e) => e.outcome !== "running");
		const lastExecText = lastExec === void 0 ? "（无）" : `${lastExec.trigger} · ${lastExec.outcome}${lastExec.error !== void 0 ? ` · ${lastExec.error.slice(0, 200)}` : ""} · ${new Date(lastExec.startedAt ?? 0).toISOString()}`;
		const lastCommentsText = task.comments.slice(-3).map((c) => `[${c.threadId !== void 0 ? "agent" : "user"}] ${c.body}`).join("\n") || "（无）";
		const body = base.replace(/\{\{lastExecution\}\}/g, lastExecText).replace(/\{\{lastComments\}\}/g, lastCommentsText);
		return `【任务】${task.title}（任务 ID: ${task.id}）\n\n${state}\n\n${body}\n\n${tail}`;
	}
	/** Move a task back out of in_progress (and release its hold) after a failed start. */
	async revertProgress(taskId) {
		await this.deps.store.mutate("execution-recorded", (ledger) => {
			const target = ledger.tasks.find((t) => t.id === taskId);
			if (target !== void 0 && target.status === "in_progress") {
				target.status = "todo";
				target.updatedAt = this.deps.now();
				delete target.claimedBy;
				delete target.claimedAt;
				return [target];
			}
		});
	}
};
//#endregion
export { ExecutionService };

//# sourceMappingURL=execution.js.map