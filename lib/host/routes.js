import { asStatus, asUrgency, canTransition, newCommentId, newTaskId, normalizeBody, normalizeExecution, normalizePrompt, normalizeTitle, summarize } from "../shared/protocol.js";
import { ROUTE_PREFIX, SSE_PATH } from "../shared/api.js";
//#region src/host/routes.ts
/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 2e4;
/** JSON-envelope writer. */
function json(res, payload, status = 200) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
/** Domain failure → envelope + HTTP status. */
function fail(code, message) {
	return {
		res: {
			ok: false,
			error: {
				code,
				message
			}
		},
		status: code === "invalid_input" ? 400 : code === "not_found" ? 404 : code === "version_conflict" ? 409 : code === "forbidden" ? 403 : 500
	};
}
/** Read one JSON body (null on parse failure). */
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}
/** String field accessor (null when absent/not a string). */
function str(body, key) {
	const v = body[key];
	return typeof v === "string" ? v : null;
}
/** Number field accessor (undefined when absent; null when present but not a number). */
function num(body, key) {
	const v = body[key];
	if (v === void 0) return void 0;
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** Map a thrown domain error to the envelope. */
function toFail(error) {
	const message = error instanceof Error ? error.message : String(error);
	const code = message.startsWith("Error: ") ? message.slice(7).split(":")[0] : void 0;
	if (code !== void 0 && [
		"invalid_input",
		"not_found",
		"version_conflict",
		"invalid_transition",
		"forbidden",
		"internal"
	].includes(code)) return fail(code, message.slice(7 + code.length + 2));
	if (code === "workspace_mismatch") return fail("forbidden", message.slice(7 + code.length + 2));
	return fail("invalid_input", message);
}
/**
* Register the taskboard routes.
* @param ctx - context carrying the webServer service.
* @param options - store + workspaces + clock.
* @returns the disposer.
*/
function registerTaskboardRoutes(ctx, options) {
	const { store, workspaces } = options;
	const subscribers = /* @__PURE__ */ new Set();
	let heartbeat;
	const broadcast = (change) => {
		const frame = `event: change\ndata: ${JSON.stringify({
			revision: change.revision,
			kind: change.kind,
			tasks: change.tasks.map(summarize)
		})}\n\n`;
		for (const res of subscribers) res.write(frame);
	};
	store.subscribe(broadcast);
	const handler = async (req, res) => {
		try {
			const pathname = new URL(req.url ?? "/", "http://x").pathname;
			if (req.method === "GET") {
				if (pathname === `/dsh-taskboard/state`) {
					await store.load();
					json(res, {
						ok: true,
						value: store.snapshot()
					});
					return;
				}
				if (pathname === `/dsh-taskboard/workspaces`) {
					json(res, {
						ok: true,
						value: workspaces.list()
					});
					return;
				}
				const taskMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)$`));
				if (taskMatch !== null) {
					const task = store.get(taskMatch[1]);
					if (task === void 0) {
						const f = fail("not_found", "no such task");
						json(res, f.res, f.status);
						return;
					}
					json(res, {
						ok: true,
						value: task
					});
					return;
				}
				res.writeHead(404);
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				json(res, fail("invalid_input", "content-type must be application/json").res, 415);
				return;
			}
			const body = await readBody(req);
			if (body === null) {
				json(res, fail("invalid_input", "body is not a JSON object").res, 400);
				return;
			}
			if (pathname === `/dsh-taskboard/tasks`) {
				try {
					const title = normalizeTitle(str(body, "title") ?? "");
					const workspaceId = str(body, "workspaceId") ?? "";
					if (workspaces.get(workspaceId) === void 0) throw new Error("Error: not_found: unknown workspace");
					const urgency = asUrgency(str(body, "urgency") ?? "");
					const status = str(body, "status") === null ? "todo" : asStatus(str(body, "status"));
					const execution = normalizeExecution(body.execution ?? {}, options.now());
					const model = body.model;
					const now = options.now();
					const task = {
						id: newTaskId(),
						title,
						description: (str(body, "description") ?? "").trim(),
						prompt: normalizePrompt(str(body, "prompt") ?? void 0),
						workspaceId,
						urgency,
						status,
						blocked: false,
						execution,
						model,
						version: 1,
						createdAt: now,
						updatedAt: now,
						createdBy: { kind: "user" },
						updatedBy: { kind: "user" },
						comments: [],
						executions: []
					};
					await store.mutate("task-created", (ledger) => {
						ledger.tasks.push(task);
						return [task];
					});
					json(res, {
						ok: true,
						value: summarize(task)
					}, 201);
				} catch (error) {
					const f = toFail(error);
					json(res, f.res, f.status);
				}
				return;
			}
			const actionMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)/(\\w+)$`));
			if (actionMatch !== null) {
				const id = actionMatch[1];
				const action = actionMatch[2];
				try {
					const task = store.get(id);
					if (task === void 0) throw new Error("Error: not_found: no such task");
					if (action === "update") {
						const ifVersion = num(body, "ifVersion");
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const next = structuredClone(task);
						const title = str(body, "title");
						if (title !== null) next.title = normalizeTitle(title);
						const description = str(body, "description");
						if (description !== null) next.description = description.trim();
						const prompt = str(body, "prompt");
						if (prompt !== null) next.prompt = normalizePrompt(prompt);
						const urgency = str(body, "urgency");
						if (urgency !== null) next.urgency = asUrgency(urgency);
						const workspaceId = str(body, "workspaceId");
						if (workspaceId !== null) {
							if (workspaces.get(workspaceId) === void 0) throw new Error("Error: not_found: unknown workspace");
							next.workspaceId = workspaceId;
						}
						if (typeof body.blocked === "boolean") next.blocked = body.blocked;
						if (body.execution !== void 0) next.execution = normalizeExecution(body.execution, options.now());
						if (body.model === null) next.model = void 0;
						else if (body.model !== void 0) next.model = body.model;
						next.version = task.version + 1;
						next.updatedAt = options.now();
						next.updatedBy = { kind: "user" };
						await store.mutate("task-updated", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: summarize(next)
						});
						return;
					}
					if (action === "move") {
						const ifVersion = num(body, "ifVersion");
						const status = str(body, "status") ?? "";
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const to = asStatus(status);
						if (!canTransition(task.status, to)) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → ${to}`);
						const next = structuredClone(task);
						next.status = to;
						next.version = task.version + 1;
						next.updatedAt = options.now();
						next.updatedBy = { kind: "user" };
						if (task.status === "todo" && to === "in_progress") next.blocked = false;
						await store.mutate("task-moved", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: summarize(next)
						});
						return;
					}
					if (action === "comment") {
						const bodyText = str(body, "body") ?? "";
						const comment = {
							id: newCommentId(),
							body: normalizeBody(bodyText),
							version: 1,
							createdAt: options.now()
						};
						const next = structuredClone(task);
						next.comments.push(comment);
						next.version = task.version + 1;
						next.updatedAt = options.now();
						await store.mutate("comment-added", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: comment
						}, 201);
						return;
					}
					if (action === "delete") {
						if (body.purge === true) {
							if (task.trashedAt === void 0) throw new Error("Error: invalid_input: purge requires a trashed task (soft-delete first)");
							await store.mutate("task-deleted", (ledger) => {
								ledger.tasks = ledger.tasks.filter((t) => t.id !== id);
								return [];
							});
							json(res, {
								ok: true,
								value: { purged: true }
							});
							return;
						}
						const ifVersion = num(body, "ifVersion");
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const next = structuredClone(task);
						next.trashedAt = options.now();
						next.version = task.version + 1;
						await store.mutate("task-deleted", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: { trashed: true }
						});
						return;
					}
					if (action === "run") {
						if (options.run === void 0) {
							json(res, fail("invalid_input", "execution service unavailable").res, 501);
							return;
						}
						const result = await options.run(id);
						if (result.ok) json(res, {
							ok: true,
							value: result
						}, 202);
						else {
							const f = fail("invalid_input", result.error);
							json(res, f.res, f.status);
						}
						return;
					}
					const f = fail("not_found", `unknown action ${action}`);
					json(res, f.res, f.status);
				} catch (error) {
					const f = toFail(error);
					json(res, f.res, f.status);
				}
				return;
			}
			res.writeHead(404);
			res.end();
		} catch (error) {
			const f = fail("internal", error instanceof Error ? error.message : String(error));
			json(res, f.res, f.status);
		}
	};
	const sse = (req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		res.write("retry: 2000\n\n");
		res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`);
		subscribers.add(res);
		if (heartbeat === void 0) heartbeat = setInterval(() => {
			for (const current of subscribers) current.write(": ping\n\n");
		}, HEARTBEAT_MS);
		req.on("close", () => {
			subscribers.delete(res);
			if (subscribers.size === 0 && heartbeat !== void 0) {
				clearInterval(heartbeat);
				heartbeat = void 0;
			}
		});
	};
	const disposers = [ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	}), ctx.webServer.register({
		kind: "exact",
		path: SSE_PATH,
		handler: sse
	})];
	return () => {
		for (const dispose of disposers) dispose();
		if (heartbeat !== void 0) clearInterval(heartbeat);
		for (const res of subscribers) res.end();
		subscribers.clear();
	};
}
//#endregion
export { registerTaskboardRoutes };

//# sourceMappingURL=routes.js.map