window.__ModuleLoader__.load({
	id: "dsh-taskboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region src/client/api.ts
		/** Unwrap the envelope or throw a readable error. */
		async function unwrap(pending) {
			const res = await pending;
			const body = await res.json().catch(() => null);
			if (body === null) throw new Error(`taskboard: HTTP ${res.status}`);
			if (!body.ok) throw new Error(`taskboard: ${body.error.code}: ${body.error.message}`);
			return body.value;
		}
		/** Request timeout (S15: a hung fetch must never pin refreshInFlight forever). */
		const TIMEOUT_MS = 1e4;
		async function get(path) {
			return unwrap(fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
		}
		async function post(path, body) {
			return unwrap(await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(TIMEOUT_MS)
			}));
		}
		/** Build the client over fetch + EventSource. */
		function createClient() {
			return {
				state: () => get("/dsh-taskboard/state"),
				workspaces: () => get("/dsh-taskboard/workspaces"),
				create: (body) => post("/dsh-taskboard/tasks", body),
				get: (id) => get(`/dsh-taskboard/tasks/${encodeURIComponent(id)}`),
				update: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/update`, body),
				move: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/move`, body),
				reject: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/reject`, body),
				comment: (id, bodyText) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/comment`, { body: bodyText }),
				remove: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/delete`, body),
				run: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/run`, body ?? {}),
				cancel: (id) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/cancel`, {}),
				mergeBranch: (id) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/merge`, {}),
				worktreeRemove: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/worktree-remove`, body),
				diagnostics: () => get("/dsh-taskboard/diagnostics"),
				worktreeCleanup: (workspaceId, taskId) => post("/dsh-taskboard/worktree-cleanup", {
					workspaceId,
					taskId
				}),
				diff: (taskId, query) => {
					const params = new URLSearchParams({ execution: query.execution });
					if (query.commit !== void 0) params.set("commit", query.commit);
					if (query.path !== void 0) params.set("path", query.path);
					return get(`/dsh-taskboard/tasks/${encodeURIComponent(taskId)}/diff?${params.toString()}`);
				},
				importPreview: (file) => post("/dsh-taskboard/import/preview", file),
				importCommit: (mode, ledger) => post("/dsh-taskboard/import", {
					mode,
					ledger
				}),
				templates: () => get("/dsh-taskboard/templates"),
				templateUpsert: (body) => post("/dsh-taskboard/templates", body),
				templateDelete: (id) => post("/dsh-taskboard/templates/delete", { id }),
				settings: () => get("/dsh-taskboard/settings"),
				updateSettings: (body) => post("/dsh-taskboard/settings/update", body),
				promptCompletions: () => get("/dsh-taskboard/prompt-completions"),
				modelCatalog: () => get("/dsh-taskboard/model-catalog"),
				stream(onChange, onGap) {
					const es = new EventSource("/dsh-taskboard/events");
					let revision;
					const hello = (event) => {
						let payload;
						try {
							payload = JSON.parse(event.data);
						} catch {
							return;
						}
						if (revision !== void 0 && payload.revision !== revision) onGap();
						revision = payload.revision;
					};
					const change = (event) => {
						let payload;
						try {
							payload = JSON.parse(event.data);
						} catch {
							return;
						}
						if (revision !== void 0 && payload.revision !== revision + 1) onGap();
						revision = payload.revision;
						onChange(payload);
					};
					es.addEventListener("hello", hello);
					es.addEventListener("change", change);
					es.onerror = () => {};
					return () => {
						es.close();
					};
				}
			};
		}

		//#endregion
		//#region src/shared/protocol.ts
		/** Statuses shown as the five main board columns, in order. */
		const MAIN_STATUSES = [
			"backlog",
			"todo",
			"in_progress",
			"in_review",
			"done"
		];
		/** Statuses collected under the secondary tab. */
		const SECONDARY_STATUSES = ["canceled", "archived"];
		/** Every valid status, main first. */
		const ALL_STATUSES = [...MAIN_STATUSES, ...SECONDARY_STATUSES];
		/**
		* Legal forward/sideways transitions. Anything not listed is rejected with
		* `invalid_transition`. `archived` is terminal.
		*/
		const TRANSITIONS = {
			backlog: ["todo", "canceled"],
			todo: [
				"in_progress",
				"backlog",
				"canceled"
			],
			in_progress: [
				"in_review",
				"todo",
				"canceled"
			],
			in_review: [
				"in_progress",
				"todo",
				"done",
				"canceled"
			],
			done: ["archived"],
			canceled: ["archived", "todo"],
			archived: []
		};
		/**
		* Whether a status move is legal per the state machine.
		* @param from - current status.
		* @param to - requested status.
		* @returns true when the transition is allowed.
		*/
		function canTransition(from, to) {
			return TRANSITIONS[from].includes(to);
		}
		/**
		* Factory-default isolation (0.5.0): 原目录执行. Applies when neither the
		* task record nor the board setting (`BoardSettings.defaultIsolation`)
		* says otherwise. Before 0.5.0 the implicit default was 'worktree'.
		*/
		const DEFAULT_ISOLATION = "none";
		/** Factory default permission preset (0.5.5). */
		const DEFAULT_PERMISSION = "workspace-write";
		/** Validate and normalize a permission string into a valid {@link PermissionMode}. */
		function asPermission(raw) {
			if (typeof raw !== "string") return DEFAULT_PERMISSION;
			const normalized = raw.trim();
			if (normalized === "workspace-write" || normalized === "workspaceWrite") return "workspace-write";
			if (normalized === "read-only" || normalized === "readOnly") return "read-only";
			if (normalized === "danger-full-access" || normalized === "fullAccess") return "danger-full-access";
			throw new Error("permission must be 'workspace-write', 'read-only', or 'danger-full-access'");
		}
		/** The effective default isolation for NEW tasks (board setting → factory default). */
		function defaultIsolationOf(settings) {
			return settings?.defaultIsolation ?? "none";
		}
		/** The effective external session sync switch (board setting → factory default false). */
		function defaultSyncExternalSessionsOf(settings) {
			return settings?.syncExternalSessions ?? false;
		}
		/** The effective default permission preset for NEW tasks (board setting → factory default 'workspace-write'). */
		function defaultPermissionOf(settings) {
			return settings?.defaultPermission ?? "workspace-write";
		}
		/**
		* Parse a five-field cron expression. Supported field syntax: star, star/step
		* (`* / n` without spaces), a single number, an `a-b` range, and comma lists
		* of those. Day-of-week accepts both 0 and 7 as Sunday (normalized to 0).
		*
		* @param expr - the expression to parse.
		* @returns the match sets per field, or null when invalid.
		*/
		function parseCron(expr) {
			const fields = expr.trim().split(/\s+/);
			if (fields.length !== 5) return null;
			const ranges = [
				[0, 59],
				[0, 23],
				[1, 31],
				[1, 12],
				[0, 7]
			];
			const sets = [];
			for (let i = 0; i < 5; i++) {
				const [min, max] = ranges[i];
				const set = /* @__PURE__ */ new Set();
				if (!parseCronField(fields[i], min, max, set)) return null;
				sets.push(set);
			}
			const weekdays = /* @__PURE__ */ new Set();
			for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
			return {
				minutes: sets[0],
				hours: sets[1],
				days: sets[2],
				months: sets[3],
				weekdays
			};
		}
		/** Parse one cron field into a match set; false on any syntax error. */
		function parseCronField(field, min, max, out) {
			for (const part of field.split(",")) {
				const [range, stepRaw] = part.split("/");
				const step = stepRaw === void 0 ? 1 : Number.parseInt(stepRaw, 10);
				if (!Number.isInteger(step) || step < 1) return false;
				let lo;
				let hi;
				if (range === void 0 || range === "") return false;
				if (range === "*") {
					lo = min;
					hi = max;
				} else if (range.includes("-")) {
					const [a, b] = range.split("-");
					lo = Number.parseInt(a ?? "", 10);
					hi = Number.parseInt(b ?? "", 10);
					if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
				} else {
					lo = Number.parseInt(range, 10);
					if (!Number.isInteger(lo)) return false;
					hi = stepRaw === void 0 ? lo : max;
				}
				if (lo < min || hi > max || lo > hi) return false;
				for (let v = lo; v <= hi; v += step) out.add(v);
			}
			return out.size > 0;
		}
		/**
		* The next time at or after `from` matching the cron sets (local time),
		* or null when no match exists within four years (e.g. Feb 30).
		* @param match - parsed cron sets.
		* @param from - epoch ms start point (inclusive match candidate).
		* @returns the next match's epoch ms, or null.
		*/
		function nextCronTime(match, from) {
			const start = new Date(from);
			start.setSeconds(0, 0);
			start.setMinutes(start.getMinutes() + 1);
			const cap = from + 4 * 366 * 24 * 60 * 60 * 1e3;
			let t = start.getTime();
			while (t <= cap) {
				const d = new Date(t);
				if (match.months.has(d.getMonth() + 1) && match.days.has(d.getDate()) && match.weekdays.has(d.getDay()) && match.hours.has(d.getHours()) && match.minutes.has(d.getMinutes())) return t;
				t += 6e4;
			}
			return null;
		}
		/** Current ledger format version. */
		const LEDGER_SCHEMA_VERSION = 1;
		/** An empty ledger. */
		function emptyLedger() {
			return {
				schemaVersion: 1,
				revision: 0,
				tasks: []
			};
		}
		/** Checklist progress: how many items are checked (absent checklist → 0/0). */
		function checklistProgress(task) {
			const items = task.checklist ?? [];
			return {
				done: items.filter((i) => i.checked).length,
				total: items.length
			};
		}

		//#endregion
		//#region src/client/i18n/zh.ts
		/**
		* zh-CN dictionary — the taskboard UI namespace's key canon.
		*
		* Every key the board renders goes here; en.ts is type-checked against
		* this file's key set (Dict), so the two dictionaries can never drift
		* apart at compile time. Keys are flat '<domain>.<object>[.<detail>'
		* strings; values may carry {name} placeholders (translate() substitutes
		* them; unknown names are left verbatim — {{lastExecution}} survives).
		*
		* @module dsh-taskboard/client/i18n/zh
		*/
		const zh = {
			"shared.close": "关闭",
			"shared.cancel": "取消",
			"shared.loading": "读取中…",
			"shared.blocked": "受阻",
			"shared.permission": "权限",
			"shared.confirmDelete": "确认删除",
			"shared.current": "（当前：{name}）",
			"shared.entry.aria": "Agent 任务看板",
			"shared.entry.label": "任务看板",
			"shared.stats.title": "待办 {todo} ｜ 进行中 {doing} ｜ 待验收 {review}（待办|进行中|待验收）",
			"shared.duplicate.suffix": "（副本）",
			"status.column.backlog": "待规划",
			"status.column.todo": "待办",
			"status.column.in_progress": "进行中",
			"status.column.in_review": "待验收",
			"status.column.done": "已完成",
			"status.column.canceled": "已取消",
			"status.column.archived": "已归档",
			"status.pill.backlog": "待规划",
			"status.pill.todo": "待办",
			"status.pill.in_progress": "进行中",
			"status.pill.in_review": "待验收",
			"status.pill.done": "完成",
			"status.pill.canceled": "取消",
			"status.pill.archived": "归档",
			"status.move.backlog": "待规划",
			"status.move.todo": "待办",
			"status.move.in_progress": "进行中",
			"status.move.in_review": "待验收",
			"status.move.done": "完成",
			"status.move.canceled": "取消",
			"status.move.archived": "归档",
			"urgency.urgent": "紧急",
			"urgency.normal": "一般",
			"urgency.relaxed": "不急",
			"outcome.running": "执行中",
			"outcome.succeeded": "成功",
			"outcome.failed": "失败",
			"outcome.cancelled": "已取消",
			"board.title": "Agent 任务看板",
			"board.count.tasks": "{n} 任务 · rev {rev}",
			"board.action.newTask": "+ 新建任务 ▼",
			"board.action.blankTask": "空白任务",
			"board.action.manageTemplates": "⌗ 管理模板…",
			"board.search.placeholder": "搜索标题 / ID…",
			"board.filter.allProjects": "全部项目",
			"board.sort.title": "列内排序",
			"board.sort.default": "默认排序",
			"board.sort.updated": "最近更新",
			"board.sort.urgency": "按紧急度",
			"board.sort.created": "创建时间",
			"board.sort.byTitle": "按标题",
			"board.action.backToBoard": "返回看板",
			"board.action.otherTasks": "其它任务",
			"board.action.settingsTitle": "看板设置：新建任务的默认执行隔离等",
			"board.action.settings": "🛠 设置",
			"board.action.diagTitle": "健康诊断：遗留 worktree、台账基本项",
			"board.action.diag": "⚙ 诊断",
			"board.action.importTitle": "从 JSON 备份文件导入台账（预览后合并或整册替换）",
			"board.action.import": "⬆ 导入",
			"board.action.exportTitle": "导出台账：完整 JSON 备份或任务清单 CSV",
			"board.action.export": "⬇ 导出 ▼",
			"board.export.jsonTitle": "完整台账备份（含执行历史与看板设置），可用于导入恢复",
			"board.export.json": "完整台账（JSON）",
			"board.export.csvTitle": "任务清单表格（Excel 可直接打开，中文已加 BOM）",
			"board.export.csv": "任务清单（CSV）",
			"board.drag.forbidden": "无法从「{from}」拖至「{to}」",
			"board.empty": "无任务",
			"board.secondary.empty": "无已取消 / 已归档 / 已删除任务",
			"board.group.trashed": "已删除",
			"diag.title": "健康诊断",
			"diag.subtitle": "台账基本项与 worktree 遗留清理",
			"diag.revision": "台账修订号",
			"diag.tasks": "任务总数",
			"diag.running": "执行中",
			"diag.orphans": "遗留 worktree",
			"diag.orphans.heading": "遗留 worktree（台账无主但目录存在）",
			"diag.orphans.none": "无遗留 — 各项目 .dsh-worktrees 目录干净",
			"diag.orphans.cleanup": "清理",
			"diag.orphans.hint": "提示：有未提交修改的遗留目录会被拒绝清理，请先手动处理其内容。live 任务的 worktree 请在任务详情页删除。",
			"diag.gitignore.heading": "gitignore 建议",
			"diag.gitignore.none": "无待办 — 各 git 项目已忽略 .dsh-worktrees 目录",
			"diag.gitignore.suggestA": "建议在 .gitignore 加入一行",
			"diag.gitignore.suggestB": "（不会自动修改）",
			"card.drag.running": "该任务正由会话执行中（{title}），不能拖动",
			"card.badge.stale": "⏱ 认领超时",
			"card.badge.modelTitle": "固定模型: {model}",
			"card.badge.modelEffort": " · 思考强度: {effort}",
			"card.badge.checklistReview": "待验收：清单未全部勾选",
			"card.badge.checklist": "验收清单进度",
			"card.badge.pendingPurge": "待清除",
			"card.session.jumpTitle": "点击一键跳转到会话：{id}",
			"card.session.missing": "该会话已被删除（{id}），无法打开",
			"card.session.archived": "该会话已归档（{id}），已从会话列表隐藏",
			"card.session.unavailable": "会话导航不可用，会话 ID：{id}",
			"card.reject.placeholder": "退回原因（可选，agent 开工前会读）…",
			"card.reject.confirm": "退回待办",
			"card.action.doneTitle": "验收完成：移至已完成",
			"card.action.done": "✓ 完成",
			"card.action.rejectTitle": "退回待办，可附退回原因",
			"card.action.reject": "✗ 退回",
			"alert.ok": "知道了",
			"diff.commit": "提交 {hash}",
			"diff.file": "文件 {path}",
			"diff.truncated": "⚠ 内容过长已截断",
			"diff.failed": "获取失败（原因见看板顶部错误条；对象可能已随 worktree 删除丢失）",
			"checklist.title": "验收清单（DoD）",
			"checklist.unchecked": " · {n} 项未完成",
			"checklist.allDone": " · 全部完成",
			"checklist.byUser": "👤 用户",
			"checklist.uncheckedItem": "未完成",
			"checklist.evidence": "证据：{note}",
			"report.title": "执行报告",
			"report.submitted": "由执行会话提交 · {time}",
			"report.changedFiles": "改动文件",
			"report.checks": "自验情况",
			"report.artifacts": "产物",
			"report.risk": "剩余风险",
			"iso.title": "执行隔离",
			"iso.none": "📁 原目录执行",
			"iso.worktreeTitle": "执行隔离 · Worktree",
			"iso.branch": "🌿 分支",
			"iso.baseline": "基线 {base} → {head}",
			"iso.changed": "改动 {n} 个文件",
			"iso.commit.openTitle": "点击展开该提交的 diff",
			"iso.commits.more": "… 共 {n} 个提交",
			"iso.nocommit": "该次执行没有产生提交（改动可能未提交，见下方警告）",
			"iso.dirty.toggle": "⚠ 有 {n} 处未提交修改（合并前请让 agent 提交，或手动处理）",
			"iso.dirty.expand": " ▼ 查看文件",
			"iso.dirty.collapse": " ▲",
			"iso.dirty.openTitle": "点击查看该文件的未提交 diff",
			"iso.dirty.more": "… 共 {n} 处（完整列表见任务台账）",
			"iso.hint.running": "执行中 — 结束后可合并或清理",
			"iso.merge.confirm": "将分支以 --no-ff 合并到主工作区？",
			"iso.merge.go": "确认合并",
			"iso.merge.title": "在主工作区 git merge --no-ff 该任务分支（要求主区干净；冲突会原样报告）",
			"iso.merge.button": "⇥ 合并到主工作区",
			"iso.merge.failed": "合并失败：{error}",
			"iso.merge.noop": "该分支没有领先主工作区的新提交，无需合并（可退回续跑或直接清理）",
			"iso.remove.wt": "🗑 删除 worktree",
			"iso.remove.wtTitle": "git worktree remove（有未提交修改时拒绝）",
			"iso.remove.wtb": "🗑 删 worktree + 分支",
			"iso.remove.wtbTitle": "删除 worktree 并删除任务分支（有未提交修改时拒绝）",
			"iso.remove.confirmWt": "删除 worktree 目录？",
			"iso.remove.confirmWtb": "删除 worktree 并删除分支？",
			"iso.remove.failed": "删除失败：{error}",
			"iso.remove.branchFailed": "worktree 已删除，但分支删除失败：{error}",
			"iso.hint.keep": "分支与 worktree 保留中 — 可退回继续修改",
			"detail.session.jumpTitle": "一键跳转到对应会话：{id}",
			"detail.session.jump": "🤖 跳转会话 ↗",
			"detail.action.edit": "✎ 编辑",
			"detail.action.duplicateTitle": "复制此任务的全部配置为一张新卡（待办列）",
			"detail.action.duplicate": "⧉ 复制",
			"detail.action.saveTplTitle": "把此任务的配置（含清单）保存为模板，新建任务时可用",
			"detail.action.saveTplDone": "已存为模板（新建任务 ▼ 下拉可用，可在模板管理中改名）",
			"detail.action.saveTpl": "⌗ 存为模板",
			"detail.action.reuseTitle": "续跑：保留现有 worktree 与分支（上次的改动和提交都在原处），在其上继续执行；默认「立即执行」会重置为全新基线",
			"detail.action.reuse": "↻ 续跑",
			"detail.action.runTitleModel": "新会话执行（{model}）",
			"detail.action.runTitleDefault": "新会话执行（默认模型）",
			"detail.action.run": "▶ 立即执行",
			"detail.action.stopConfirm": "停止该执行会话？",
			"detail.action.stop": "停止",
			"detail.action.stopTitle": "停止执行会话 {id}（任务回到待办）",
			"detail.action.stopExec": "■ 停止执行",
			"detail.chip.nextRun": "{cron} · 下次 {time}",
			"detail.chip.checklist": "清单 {done}/{total}",
			"detail.chip.isolated": "Worktree 隔离",
			"detail.chip.holderTitle": "点击跳转至该会话：{id}",
			"detail.chip.holderStale": "认领超时 · ",
			"detail.chip.holderBy": "由 ",
			"detail.chip.holderSuffix": " 持有 ↗",
			"detail.chip.trashed": "已删除待清除",
			"detail.sub.line": "更新 {time} · 最近操作 {who}",
			"detail.updatedBy.system": "⚙️ 系统",
			"detail.updatedBy.user": "👤 用户",
			"detail.field.description": "描述",
			"detail.field.prompt": "执行 Prompt",
			"detail.move.to": "移至→{status}",
			"detail.move.confirmDoneUnchecked": "仍有 {n} 项清单未勾选，确认完成？",
			"detail.move.confirmDone": "确认完成？",
			"detail.move.confirm": "确认",
			"detail.blocked.unmark": "✓ 解除受阻",
			"detail.blocked.mark": "⛔ 标记受阻",
			"detail.release.title": "释放 {id} 的认领：任务回到待办（持有会话可能仍在工作，确认它已停止后再释放）",
			"detail.release.button": "🔓 释放认领",
			"detail.comments.title": "评论",
			"detail.comments.empty": "暂无评论 — agent 交接时会在这里汇报改动与验证结果",
			"detail.comments.user": "用户",
			"detail.composer.placeholder": "以用户身份留言（agent 开工前会读）…",
			"detail.composer.send": "发表",
			"detail.exec.title": "执行记录",
			"detail.exec.prunedTitle": "更早的 {n} 条执行记录已按保留上限清理",
			"detail.exec.pruned": "+{n} 已清理",
			"detail.exec.trigger.manual": "手动",
			"detail.exec.trigger.scheduled": "定时",
			"detail.exec.openTitle": "点击打开该执行会话：{id}",
			"detail.danger.delete": "🗑 删除（标记待清除）",
			"detail.danger.purgeConfirm": "物理清除不可恢复",
			"detail.danger.purgeGo": "确认清除",
			"detail.danger.purge": "🔥 物理清除（需确认）",
			"form.title.create": "新建任务",
			"form.title.edit": "编辑任务",
			"form.subtitle.create": "推入看板，项目内会话可认领执行",
			"form.subtitle.edit": "调整任务内容与执行配置",
			"form.field.title": "标题",
			"form.field.titlePlaceholder": "一句话说清要做什么",
			"form.field.project": "项目",
			"form.field.model": "模型（默认 = 会话默认模型）",
			"form.field.modelDefault": "默认模型",
			"form.model.option": "{name}（{provider}）",
			"form.field.effort": "思考强度（Reasoning Effort）",
			"form.field.effortTitle": "设置模型的思考强度（如 low/medium/high）；默认 = 跟随模型/提供商默认",
			"form.effort.follow": "跟随模型默认",
			"form.effort.low": "低 (low)",
			"form.effort.medium": "中 (medium)",
			"form.effort.high": "高 (high)",
			"form.effort.none": "关闭思考 (none)",
			"form.field.preset": "执行模式（preset）",
			"form.field.presetTitle": "执行会话按该 preset 组合（决定工具集与人设）；默认 = 部署默认 preset",
			"form.preset.follow": "跟随部署默认",
			"form.preset.defaultTag": "（部署默认）",
			"form.field.urgency": "紧急度",
			"form.urgency.urgent": "紧急",
			"form.urgency.urgentHint": "优先处理",
			"form.urgency.normal": "一般",
			"form.urgency.normalHint": "正常排期",
			"form.urgency.relaxed": "不急",
			"form.urgency.relaxedHint": "有空再做",
			"form.field.description": "描述",
			"form.field.descriptionOptional": "描述（可选）",
			"form.desc.placeholder": "需求细节、背景说明、验收标准…",
			"form.field.prompt": "执行 Prompt（实际 Prompt = 标题+任务描述+Prompt）",
			"form.field.promptOptional": "执行 Prompt（可选；实际 Prompt = 标题+任务描述+Prompt）",
			"form.prompt.placeholder": "追加在「标题+任务描述」之后发给执行会话的补充指令。支持模板变量：{{lastExecution}}（上次执行结果）、{{lastComments}}（最近 3 条评论）",
			"form.field.mode": "执行方式",
			"form.mode.claim": "🤝 认领制",
			"form.mode.claimHint": "项目内会话认领",
			"form.mode.scheduled": "⏰ 定时执行",
			"form.mode.scheduledHint": "到点自动开跑",
			"form.field.cron": "Cron 表达式",
			"form.cron.placeholder": "分 时 日 月 周",
			"form.cron.daily": "每天 09:00",
			"form.cron.hourly": "每小时",
			"form.cron.every10min": "每 10 分钟",
			"form.cron.weekly": "每周一 09:00",
			"form.cron.next": "下次 {time}",
			"form.field.isolation": "执行隔离",
			"form.iso.locked": "任务已有执行记录，隔离方式已锁定",
			"form.iso.lockedShort": "已锁定（执行开始后不可更改）",
			"form.iso.nonGit": "当前项目非 git 仓库",
			"form.iso.worktree": "🌿 Worktree 隔离",
			"form.iso.worktreeTitle": "每次执行在独立 worktree 分支上进行",
			"form.iso.worktreeHint": "独立分支 task/标题+ID，互不污染",
			"form.iso.none": "📁 原目录执行",
			"form.iso.noneTitle": "直接在项目目录执行（不使用 git）",
			"form.iso.noneHintNonGit": "当前项目非 git 仓库，将在原目录执行",
			"form.iso.noneHint": "不使用 git，直接在项目目录工作",
			"form.iso.nonGitNote": "当前项目非 git 仓库，将在原目录执行（任务仍按默认配置创建，运行时自动降级）",
			"form.field.checklist": "验收清单（DoD）",
			"form.field.checklistOptional": "验收清单（DoD，可选）",
			"form.check.itemPlaceholder": "验收项 {n}（完成标准）",
			"form.check.removeTitle": "删除该验收项",
			"form.check.add": "＋ 添加验收项",
			"form.check.checkedTitle": "勾选状态随保存保留（当前勾选人：{who}）",
			"form.check.notCheckedYet": "未勾选",
			"form.check.hintCreate": "共 {n} 项，执行会话按清单干活并逐项勾选，未完成项验收时高亮",
			"form.check.hintEdit": "已勾选 {checked}/{total}（保存将整体覆盖清单，勾选状态保留）",
			"form.hint.needTitle": "请填写标题",
			"form.hint.needProject": "请选择项目",
			"form.hint.cronBad": "Cron 表达式无效（分 时 日 月 周）",
			"form.hint.nextRun": "下次运行 {time}",
			"form.hint.saveVersion": "保存后版本 v{v} → v{next}",
			"form.hint.createClaim": "创建后项目内会话可认领执行",
			"form.action.runBlockedTitle": "任务正在执行中，不能重复发起",
			"form.action.runBusyTitle": "正在提交…",
			"form.action.runTitle": "保存后立即发起执行（新会话）",
			"form.action.run": "⚡ 立即执行",
			"form.action.save": "保存修改",
			"form.action.create": "创建任务",
			"tpl.aria": "管理模板",
			"tpl.title": "任务模板",
			"tpl.subtitle": "新建任务 ▼ 下拉的模板：改名 / 删除 / 直接使用；任务详情页「存为模板」可新增",
			"tpl.empty": "暂无模板 — 在任务详情页点「存为模板」把常用配置沉淀下来",
			"tpl.name.aria": "模板名 {name}",
			"tpl.builtin": "内置",
			"tpl.custom": "自建",
			"tpl.meta.checklist": " · 清单 {n} 项",
			"tpl.rename.title": "保存改名",
			"tpl.rename.button": "改名",
			"tpl.use.title": "用此模板打开新建表单",
			"tpl.use.button": "用此新建",
			"tpl.delete.title": "删除该模板",
			"tpl.renamed": "模板已改名",
			"tpl.foot.hint": "模板随台账一同保存在 DSH 主目录，升级不丢",
			"imp.aria": "导入台账",
			"imp.title": "导入台账",
			"imp.subtitle": "选择导出的 JSON 备份文件：先预览、再合并或整册替换",
			"imp.parseError": "文件不是合法 JSON",
			"imp.note": "⬇ JSON 导出的文件即为同格式备份，可直接导入恢复；导入文件的 schemaVersion 必须与当前版本一致。",
			"imp.previewing": "预览中…",
			"imp.stat.create": "新增",
			"imp.stat.overwrite": "覆盖（同 id）",
			"imp.stat.invalid": "无效（跳过）",
			"imp.sec.create": "新增任务",
			"imp.sec.overwrite": "覆盖任务（整卡替换，含执行历史与评论）",
			"imp.sec.invalid": "无效条目（不会导入）",
			"imp.noId": "（无 id）",
			"imp.mode.merge": "⊕ 合并",
			"imp.mode.mergeHint": "新增 + 按 id 覆盖，其余不动",
			"imp.mode.replace": "💣 整册替换",
			"imp.mode.replaceHint": "清空当前台账，以导入文件为准（先自动备份）",
			"imp.result.replace": "整册替换完成：导入 {n} 张（原 {total} 张已整册备份）",
			"imp.result.merge": "合并完成：新增 {n} 张、覆盖 {m} 张",
			"imp.foot.replaceConfirm": "⚠ 再次点击确认执行整册替换（不可撤销，已自动备份）",
			"imp.foot.replaceNeedConfirm": "整册替换需要二次确认",
			"imp.foot.mergeHint": "合并只写入预览中列出的任务",
			"imp.action.run": "执行导入",
			"imp.action.confirmReplace": "确认整册替换",
			"set.aria": "看板设置",
			"set.title": "看板设置",
			"set.subtitle": "新建任务与会话同步的全局默认值",
			"set.iso.heading": "默认执行隔离",
			"set.iso.noneHint": "不使用 git，直接在项目目录工作（出厂默认）",
			"set.iso.worktreeHint": "每次执行在独立 worktree 分支上进行（task/标题+ID），互不污染",
			"set.iso.current": "当前保存的默认：{current}。仅影响之后新建的任务；已有任务保持创建时的选择，非 git 项目运行时仍自动降级原目录。",
			"set.sync.heading": "自动同步工作区会话",
			"set.sync.off.name": "🚫 关闭同步",
			"set.sync.off.title": "仅管理在任务看板中创建和触发的任务",
			"set.sync.off.hint": "仅管理看板任务（出厂默认）",
			"set.sync.on.name": "🔄 自动纳入会话",
			"set.sync.on.title": "各工作区直接新建的会话也会在看板展示，运行中进入「进行中」，完成后自动进入「待验收」",
			"set.sync.on.hint": "跟踪运行并在完成后进入待验收",
			"set.sync.stateOn": "已开启：工作区直接新建并执行的会话将自动在看板生成任务卡片，并在完成后流转至「待验收」列。",
			"set.sync.stateOff": "已关闭：仅在看板内部创建与触发执行的任务会出现在看板上。",
			"set.foot.dirty": "有未保存的修改",
			"set.foot.clean": "与看板当前设置一致",
			"set.action.save": "保存设置",
			"form.field.permission": "执行权限",
			"form.perm.write": "可写入工作区",
			"form.perm.writeHint": "可读写工作区及临时目录（推荐默认）",
			"form.perm.readOnly": "仅可查看",
			"form.perm.readOnlyHint": "只读查看与检索，禁止修改文件或执行外部命令",
			"form.perm.fullAccess": "完全权限",
			"form.perm.fullAccessHint": "完全无限制权限，可访问全盘及执行外部命令",
			"form.perm.defaultTag": "（默认）",
			"set.perm.heading": "默认执行权限",
			"set.perm.writeName": "📁 可写入工作区（出厂默认）",
			"set.perm.writeHint": "可读写工作区及临时目录，写操作无需二次确认",
			"set.perm.readOnlyName": "🔒 仅可查看",
			"set.perm.readOnlyHint": "仅允许只读查看与检索，禁止修改文件或破坏性命令",
			"set.perm.fullName": "⚡ 完全权限",
			"set.perm.fullHint": "完全无限制权限，可访问全盘及执行系统外部命令",
			"set.perm.current": "当前保存的默认：{current}。新建任务时预设的执行权限。",
			"card.badge.permReadOnly": "🔒 仅查看",
			"card.badge.permReadOnlyTitle": "权限：仅可查看",
			"card.badge.permFull": "⚡ 全权限",
			"card.badge.permFullTitle": "权限：完全权限",
			"detail.chip.permReadOnly": "仅可查看",
			"detail.chip.permFull": "完全权限",
			"detail.chip.permWrite": "可写入工作区",
			"tpl.meta.permReadOnly": "仅查看",
			"tpl.meta.permFull": "全权限",
			"md.imageAlt": "图片 {n}",
			"md.imageTitle": "点击查看大图 ({alt})",
			"md.lightboxAlt": "大图预览",
			"md.closePreview": "关闭预览",
			"slash.aria": "快捷命令与技能",
			"slash.title": "快捷命令与技能补全",
			"slash.hint": "↑↓ 选择 · Enter / Tab 确认 · Esc 关闭",
			"slash.badge.command": "⚡ 命令",
			"slash.badge.skill": "🧩 技能",
			"slash.tipA": "💡 输入",
			"slash.tipB": "可快速补全 Slash 命令与 Agent 技能",
			"slash.cmd.goal.desc": "自主完成长期目标任务，持续深度推进",
			"slash.cmd.goal.hint": "<目标描述>",
			"slash.cmd.schedule.desc": "设置一次性定时或周期性 Cron 调度",
			"slash.cmd.schedule.hint": "<时间/表达式>",
			"slash.cmd.plan.desc": "在行动前制定分步实施计划并由用户确认",
			"slash.cmd.browser.desc": "启动网页浏览器交互与实时页面检索",
			"slash.cmd.grill-me.desc": "通过多轮单题访谈深入对齐需求与设计意图",
			"slash.cmd.teamwork-preview.desc": "多智能体协作与团队工作流预览",
			"slash.cmd.learn.desc": "沉淀解决经验与新规则到知识库",
			"slash.cmd.review.desc": "多维度代码审查（正确性、架构与安全）",
			"slash.cmd.security.desc": "安全加固与代码漏洞扫描",
			"slash.cmd.permission.desc": "切换当前会话权限级别 (read-only / workspace-write / full-access)",
			"slash.cmd.permission.hint": "<preset>",
			"slash.skill.frontend-ui-engineering": "构建生产级、可访问的高品质前端界面与组件",
			"slash.skill.api-and-interface-design": "设计稳定契约、清晰边界的 REST / RPC 接口",
			"slash.skill.test-driven-development": "测试驱动开发（TDD），编写单元与集成测试",
			"slash.skill.debugging-and-error-recovery": "系统化定位 Bug 根因并恢复错误",
			"slash.skill.performance-optimization": "前后端性能调优、减少渲染开销与查询优化",
			"slash.skill.ci-cd-and-automation": "自动化构建、CI/CD 流水线与质量门禁",
			"slash.skill.code-review-and-quality": "多轴向代码审查与重构指导",
			"slash.skill.code-simplification": "精简复杂逻辑，提升可读性与可维护性",
			"slash.skill.context-engineering": "优化上下文结构与提示词工程",
			"slash.skill.doubt-driven-development": "以怀疑驱动的对抗式审查，确保核心逻辑正确",
			"slash.skill.git-workflow-and-versioning": "Git 工作流、分支管理、语义化版本与变更日志",
			"slash.skill.idea-refine": "通过发散与收敛思维细化方案与假设检验",
			"slash.skill.incremental-implementation": "小步快跑、增量交付多文件变更",
			"slash.skill.interview-me": "深度访谈挖掘真实意图",
			"slash.skill.memory-leak-debugging": "排查诊断 JavaScript/Node.js 内存泄漏",
			"slash.skill.observability-and-instrumentation": "添加日志、指标打点与链路追踪",
			"slash.skill.planning-and-task-breakdown": "将复杂需求拆解为有序可执行任务",
			"slash.skill.security-and-hardening": "防御安全漏洞、输入过滤与鉴权加固",
			"slash.skill.shipping-and-launch": "生产发布前检查清单与回滚策略",
			"slash.skill.source-driven-development": "基于权威官方文档与源码进行设计实现",
			"slash.skill.spec-driven-development": "在编码前制定清晰的技术规范",
			"slash.skill.using-agent-skills": "发现并动态调用智能体各项专业技能"
		};

		//#endregion
		//#region src/client/i18n/en.ts
		const en = {
			"shared.close": "Close",
			"shared.cancel": "Cancel",
			"shared.loading": "Loading…",
			"shared.blocked": "Blocked",
			"shared.permission": "Permission",
			"shared.confirmDelete": "Delete",
			"shared.current": " (current: {name})",
			"shared.entry.aria": "Agent task board",
			"shared.entry.label": "Task board",
			"shared.stats.title": "To do {todo} | In progress {doing} | In review {review} (todo | in progress | in review)",
			"shared.duplicate.suffix": " (copy)",
			"status.column.backlog": "Backlog",
			"status.column.todo": "To do",
			"status.column.in_progress": "In progress",
			"status.column.in_review": "In review",
			"status.column.done": "Done",
			"status.column.canceled": "Canceled",
			"status.column.archived": "Archived",
			"status.pill.backlog": "Planned",
			"status.pill.todo": "To do",
			"status.pill.in_progress": "In progress",
			"status.pill.in_review": "In review",
			"status.pill.done": "Done",
			"status.pill.canceled": "Canceled",
			"status.pill.archived": "Archived",
			"status.move.backlog": "Backlog",
			"status.move.todo": "To do",
			"status.move.in_progress": "In progress",
			"status.move.in_review": "In review",
			"status.move.done": "Done",
			"status.move.canceled": "Canceled",
			"status.move.archived": "Archived",
			"urgency.urgent": "Urgent",
			"urgency.normal": "Normal",
			"urgency.relaxed": "Relaxed",
			"outcome.running": "Running",
			"outcome.succeeded": "Succeeded",
			"outcome.failed": "Failed",
			"outcome.cancelled": "Canceled",
			"board.title": "Agent Task Board",
			"board.count.tasks": "{n} tasks · rev {rev}",
			"board.action.newTask": "+ New Task ▼",
			"board.action.blankTask": "Blank task",
			"board.action.manageTemplates": "⌗ Manage templates…",
			"board.search.placeholder": "Search title / ID…",
			"board.filter.allProjects": "All projects",
			"board.sort.title": "Sort within columns",
			"board.sort.default": "Default order",
			"board.sort.updated": "Recently updated",
			"board.sort.urgency": "By urgency",
			"board.sort.created": "Creation time",
			"board.sort.byTitle": "By title",
			"board.action.backToBoard": "Back to board",
			"board.action.otherTasks": "Other tasks",
			"board.action.settingsTitle": "Board settings: default execution isolation for new tasks, etc.",
			"board.action.settings": "🛠 Settings",
			"board.action.diagTitle": "Health diagnostics: orphan worktrees, ledger basics",
			"board.action.diag": "⚙ Diagnostics",
			"board.action.importTitle": "Import the ledger from a JSON backup (preview, then merge or replace)",
			"board.action.import": "⬆ Import",
			"board.action.exportTitle": "Export the ledger: full JSON backup or task-list CSV",
			"board.action.export": "⬇ Export ▼",
			"board.export.jsonTitle": "Full ledger backup (execution history and board settings included); import it to restore",
			"board.export.json": "Full ledger (JSON)",
			"board.export.csvTitle": "Task-list spreadsheet (opens directly in Excel; BOM added for CJK text)",
			"board.export.csv": "Task list (CSV)",
			"board.drag.forbidden": "Cannot drag from \"{from}\" to \"{to}\"",
			"board.empty": "No tasks",
			"board.secondary.empty": "No canceled / archived / deleted tasks",
			"board.group.trashed": "Deleted",
			"diag.title": "Health diagnostics",
			"diag.subtitle": "Ledger basics and orphan-worktree cleanup",
			"diag.revision": "Ledger revision",
			"diag.tasks": "Total tasks",
			"diag.running": "Running",
			"diag.orphans": "Orphan worktrees",
			"diag.orphans.heading": "Orphan worktrees (no owning task, directory still present)",
			"diag.orphans.none": "None — every project’s .dsh-worktrees directory is clean",
			"diag.orphans.cleanup": "Clean up",
			"diag.orphans.hint": "Note: orphan directories with uncommitted changes are refused; handle their contents manually first. Remove a live task’s worktree from its task detail pane.",
			"diag.gitignore.heading": "gitignore suggestions",
			"diag.gitignore.none": "Nothing to do — every git project already ignores .dsh-worktrees",
			"diag.gitignore.suggestA": "suggests adding one line to .gitignore:",
			"diag.gitignore.suggestB": "(no automatic edits)",
			"card.drag.running": "This task is being executed by a session ({title}) and cannot be dragged",
			"card.badge.stale": "⏱ Claim stale",
			"card.badge.modelTitle": "Pinned model: {model}",
			"card.badge.modelEffort": " · reasoning effort: {effort}",
			"card.badge.checklistReview": "In review: checklist has unchecked items",
			"card.badge.checklist": "Acceptance checklist progress",
			"card.badge.pendingPurge": "Pending purge",
			"card.session.jumpTitle": "Click to jump to the session: {id}",
			"card.session.missing": "The session has been deleted ({id}) and cannot be opened",
			"card.session.archived": "The session is archived ({id}) and hidden from the session list",
			"card.session.unavailable": "Session navigation unavailable; session id: {id}",
			"card.reject.placeholder": "Reason for sending back (optional; the agent reads it before starting)…",
			"card.reject.confirm": "Send back to todo",
			"card.action.doneTitle": "Accept and complete: move to Done",
			"card.action.done": "✓ Done",
			"card.action.rejectTitle": "Send back to todo, optionally with a reason",
			"card.action.reject": "✗ Send back",
			"alert.ok": "Got it",
			"diff.commit": "Commit {hash}",
			"diff.file": "File {path}",
			"diff.truncated": "⚠ Content truncated (too long)",
			"diff.failed": "Failed to fetch (see the error bar at the top of the board; the object may be gone with a removed worktree)",
			"checklist.title": "Acceptance checklist (DoD)",
			"checklist.unchecked": " · {n} unchecked",
			"checklist.allDone": " · all done",
			"checklist.byUser": "👤 User",
			"checklist.uncheckedItem": "Unchecked",
			"checklist.evidence": "Evidence: {note}",
			"report.title": "Execution report",
			"report.submitted": "Submitted by the execution session · {time}",
			"report.changedFiles": "Changed files",
			"report.checks": "Self-verification",
			"report.artifacts": "Artifacts",
			"report.risk": "Remaining risks",
			"iso.title": "Execution isolation",
			"iso.none": "📁 Run in the original directory",
			"iso.worktreeTitle": "Execution isolation · Worktree",
			"iso.branch": "🌿 Branch",
			"iso.baseline": "Baseline {base} → {head}",
			"iso.changed": "{n} files changed",
			"iso.commit.openTitle": "Click to expand this commit’s diff",
			"iso.commits.more": "… {n} commits in total",
			"iso.nocommit": "This execution produced no commits (changes may be uncommitted — see the warning below)",
			"iso.dirty.toggle": "⚠ {n} uncommitted changes (have the agent commit before merging, or handle them manually)",
			"iso.dirty.expand": " ▼ view files",
			"iso.dirty.collapse": " ▲",
			"iso.dirty.openTitle": "Click to view the uncommitted diff of this file",
			"iso.dirty.more": "… {n} in total (full list in the task ledger)",
			"iso.hint.running": "Running — merge or clean up after it ends",
			"iso.merge.confirm": "Merge the branch into the main worktree with --no-ff?",
			"iso.merge.go": "Merge",
			"iso.merge.title": "git merge --no-ff the task branch into the main worktree (requires a clean main worktree; conflicts are reported as-is)",
			"iso.merge.button": "⇥ Merge into main worktree",
			"iso.merge.failed": "Merge failed: {error}",
			"iso.merge.noop": "The branch has no commits ahead of the main worktree — nothing to merge (send it back to continue running, or clean it up)",
			"iso.remove.wt": "🗑 Remove worktree",
			"iso.remove.wtTitle": "git worktree remove (refused when uncommitted changes exist)",
			"iso.remove.wtb": "🗑 Remove worktree + branch",
			"iso.remove.wtbTitle": "Remove the worktree and delete the task branch (refused when uncommitted changes exist)",
			"iso.remove.confirmWt": "Remove the worktree directory?",
			"iso.remove.confirmWtb": "Remove the worktree and delete the branch?",
			"iso.remove.failed": "Removal failed: {error}",
			"iso.remove.branchFailed": "Worktree removed, but branch deletion failed: {error}",
			"iso.hint.keep": "Branch and worktree kept — send back to continue editing",
			"detail.session.jumpTitle": "Jump to the corresponding session: {id}",
			"detail.session.jump": "🤖 Jump to session ↗",
			"detail.action.edit": "✎ Edit",
			"detail.action.duplicateTitle": "Duplicate this task’s full configuration as a new card (todo column)",
			"detail.action.duplicate": "⧉ Duplicate",
			"detail.action.saveTplTitle": "Save this task’s configuration (checklist included) as a template for new tasks",
			"detail.action.saveTplDone": "Saved as a template (available in the New Task ▼ menu; rename it in template management)",
			"detail.action.saveTpl": "⌗ Save as template",
			"detail.action.reuseTitle": "Reuse-run: keep the existing worktree and branch (last run’s changes and commits stay in place) and continue on top of them; the default \"Run\" resets to a fresh baseline",
			"detail.action.reuse": "↻ Reuse-run",
			"detail.action.runTitleModel": "Run in a new session ({model})",
			"detail.action.runTitleDefault": "Run in a new session (default model)",
			"detail.action.run": "▶ Run",
			"detail.action.stopConfirm": "Stop this execution session?",
			"detail.action.stop": "Stop",
			"detail.action.stopTitle": "Stop execution session {id} (the task returns to todo)",
			"detail.action.stopExec": "■ Stop execution",
			"detail.chip.nextRun": "{cron} · next {time}",
			"detail.chip.checklist": "Checklist {done}/{total}",
			"detail.chip.isolated": "Worktree isolation",
			"detail.chip.holderTitle": "Click to jump to the session: {id}",
			"detail.chip.holderStale": "Claim stale · ",
			"detail.chip.holderBy": "Held by ",
			"detail.chip.holderSuffix": " ↗",
			"detail.chip.trashed": "Deleted, pending purge",
			"detail.sub.line": "Updated {time} · last change by {who}",
			"detail.updatedBy.system": "⚙️ System",
			"detail.updatedBy.user": "👤 User",
			"detail.field.description": "Description",
			"detail.field.prompt": "Execution prompt",
			"detail.move.to": "Move to → {status}",
			"detail.move.confirmDoneUnchecked": "{n} checklist items are still unchecked — confirm done?",
			"detail.move.confirmDone": "Confirm done?",
			"detail.move.confirm": "Confirm",
			"detail.blocked.unmark": "✓ Unblock",
			"detail.blocked.mark": "⛔ Mark blocked",
			"detail.release.title": "Release {id}’s claim: the task returns to todo (the holding session may still be working — make sure it has stopped first)",
			"detail.release.button": "🔓 Release claim",
			"detail.comments.title": "Comments",
			"detail.comments.empty": "No comments yet — the agent reports changes and verification here at handoff",
			"detail.comments.user": "User",
			"detail.composer.placeholder": "Leave a comment as the user (the agent reads it before starting)…",
			"detail.composer.send": "Post",
			"detail.exec.title": "Executions",
			"detail.exec.prunedTitle": "{n} older execution records were pruned at the retention cap",
			"detail.exec.pruned": "+{n} pruned",
			"detail.exec.trigger.manual": "Manual",
			"detail.exec.trigger.scheduled": "Scheduled",
			"detail.exec.openTitle": "Click to open the execution session: {id}",
			"detail.danger.delete": "🗑 Delete (mark for purge)",
			"detail.danger.purgeConfirm": "Physical purge is irreversible",
			"detail.danger.purgeGo": "Purge",
			"detail.danger.purge": "🔥 Purge physically (confirm required)",
			"form.title.create": "New task",
			"form.title.edit": "Edit task",
			"form.subtitle.create": "Push onto the board; sessions in the project can claim and run it",
			"form.subtitle.edit": "Adjust the task content and execution configuration",
			"form.field.title": "Title",
			"form.field.titlePlaceholder": "One line: what should be done",
			"form.field.project": "Project",
			"form.field.model": "Model (default = session default model)",
			"form.field.modelDefault": "Default model",
			"form.model.option": "{name} ({provider})",
			"form.field.effort": "Reasoning effort",
			"form.field.effortTitle": "Set the model’s reasoning effort (e.g. low/medium/high); default = follow the model/provider default",
			"form.effort.follow": "Follow model default",
			"form.effort.low": "Low (low)",
			"form.effort.medium": "Medium (medium)",
			"form.effort.high": "High (high)",
			"form.effort.none": "Off (none)",
			"form.field.preset": "Execution preset",
			"form.field.presetTitle": "The execution session is composed from this preset (tool set and persona); default = the deployment default preset",
			"form.preset.follow": "Follow deployment default",
			"form.preset.defaultTag": " (deployment default)",
			"form.field.urgency": "Urgency",
			"form.urgency.urgent": "Urgent",
			"form.urgency.urgentHint": "Handle first",
			"form.urgency.normal": "Normal",
			"form.urgency.normalHint": "Normal scheduling",
			"form.urgency.relaxed": "Relaxed",
			"form.urgency.relaxedHint": "When there is time",
			"form.field.description": "Description",
			"form.field.descriptionOptional": "Description (optional)",
			"form.desc.placeholder": "Requirement details, background, acceptance criteria…",
			"form.field.prompt": "Execution prompt (the actual prompt = title + description + prompt)",
			"form.field.promptOptional": "Execution prompt (optional; the actual prompt = title + description + prompt)",
			"form.prompt.placeholder": "Extra instructions appended after \"title + task description\" and sent to the execution session. Template variables: {{lastExecution}} (last execution result), {{lastComments}} (latest 3 comments)",
			"form.field.mode": "Execution mode",
			"form.mode.claim": "🤝 Claim-based",
			"form.mode.claimHint": "Sessions in the project claim it",
			"form.mode.scheduled": "⏰ Scheduled",
			"form.mode.scheduledHint": "Starts automatically on schedule",
			"form.field.cron": "Cron expression",
			"form.cron.placeholder": "min hour day month weekday",
			"form.cron.daily": "Daily 09:00",
			"form.cron.hourly": "Hourly",
			"form.cron.every10min": "Every 10 minutes",
			"form.cron.weekly": "Mondays 09:00",
			"form.cron.next": "Next {time}",
			"form.field.isolation": "Execution isolation",
			"form.iso.locked": "The task has execution history; isolation is locked",
			"form.iso.lockedShort": "Locked (cannot change once execution has started)",
			"form.iso.nonGit": "This project is not a git repository",
			"form.iso.worktree": "🌿 Worktree isolation",
			"form.iso.worktreeTitle": "Each execution runs on its own worktree branch",
			"form.iso.worktreeHint": "Isolated branch task/title+ID, no cross-contamination",
			"form.iso.none": "📁 Run in the project directory",
			"form.iso.noneTitle": "Run directly in the project directory (no git)",
			"form.iso.noneHintNonGit": "Not a git repository; will run in the project directory",
			"form.iso.noneHint": "No git; works directly in the project directory",
			"form.iso.nonGitNote": "This project is not a git repository; the task will run in its directory (still created with the default configuration; the runtime degrades automatically)",
			"form.field.checklist": "Acceptance checklist (DoD)",
			"form.field.checklistOptional": "Acceptance checklist (DoD, optional)",
			"form.check.itemPlaceholder": "Checklist item {n} (definition of done)",
			"form.check.removeTitle": "Remove this checklist item",
			"form.check.add": "＋ Add checklist item",
			"form.check.checkedTitle": "Checked state is preserved on save (currently checked by: {who})",
			"form.check.notCheckedYet": "not checked yet",
			"form.check.hintCreate": "{n} items; the execution session works through them and checks each off; unfinished items are highlighted at review",
			"form.check.hintEdit": "{checked}/{total} checked (saving replaces the whole list; checked state is preserved)",
			"form.hint.needTitle": "Enter a title",
			"form.hint.needProject": "Select a project",
			"form.hint.cronBad": "Invalid cron expression (min hour day month weekday)",
			"form.hint.nextRun": "Next run {time}",
			"form.hint.saveVersion": "On save: v{v} → v{next}",
			"form.hint.createClaim": "After creation, sessions in the project can claim and run it",
			"form.action.runBlockedTitle": "The task is running; cannot start another",
			"form.action.runBusyTitle": "Submitting…",
			"form.action.runTitle": "Save, then immediately start an execution (new session)",
			"form.action.run": "⚡ Run now",
			"form.action.save": "Save changes",
			"form.action.create": "Create task",
			"tpl.aria": "Manage templates",
			"tpl.title": "Task templates",
			"tpl.subtitle": "Templates from the New Task ▼ menu: rename / delete / use directly; \"Save as template\" in the task detail pane adds new ones",
			"tpl.empty": "No templates yet — click \"Save as template\" in a task detail pane to capture a common configuration",
			"tpl.name.aria": "Template name {name}",
			"tpl.builtin": "Built-in",
			"tpl.custom": "Custom",
			"tpl.meta.checklist": " · {n} checklist items",
			"tpl.rename.title": "Save rename",
			"tpl.rename.button": "Rename",
			"tpl.use.title": "Open the new-task form with this template",
			"tpl.use.button": "Use",
			"tpl.delete.title": "Delete this template",
			"tpl.renamed": "Template renamed",
			"tpl.foot.hint": "Templates are stored with the ledger in the DSH home directory and survive upgrades",
			"imp.aria": "Import ledger",
			"imp.title": "Import ledger",
			"imp.subtitle": "Pick an exported JSON backup: preview first, then merge or replace everything",
			"imp.parseError": "The file is not valid JSON",
			"imp.note": "The ⬇ JSON export is a same-format backup and can be imported to restore; the file’s schemaVersion must match the current version.",
			"imp.previewing": "Previewing…",
			"imp.stat.create": "New",
			"imp.stat.overwrite": "Overwrite (same id)",
			"imp.stat.invalid": "Invalid (skipped)",
			"imp.sec.create": "New tasks",
			"imp.sec.overwrite": "Overwritten tasks (whole-card replacement, execution history and comments included)",
			"imp.sec.invalid": "Invalid entries (not imported)",
			"imp.noId": "(no id)",
			"imp.mode.merge": "⊕ Merge",
			"imp.mode.mergeHint": "Adds new + overwrites by id; everything else untouched",
			"imp.mode.replace": "💣 Replace all",
			"imp.mode.replaceHint": "Clears the current ledger and adopts the imported file (automatic backup first)",
			"imp.result.replace": "Replace complete: imported {n} tasks ({total} former tasks backed up)",
			"imp.result.merge": "Merge complete: {n} added, {m} overwritten",
			"imp.foot.replaceConfirm": "⚠ Click again to confirm the full replacement (irreversible; a backup has been taken)",
			"imp.foot.replaceNeedConfirm": "Full replacement requires a second confirmation",
			"imp.foot.mergeHint": "Merge writes only the tasks listed in the preview",
			"imp.action.run": "Import",
			"imp.action.confirmReplace": "Confirm replace",
			"set.aria": "Board settings",
			"set.title": "Board settings",
			"set.subtitle": "Global defaults for new tasks and session sync",
			"set.iso.heading": "Default execution isolation",
			"set.iso.noneHint": "No git; works directly in the project directory (factory default)",
			"set.iso.worktreeHint": "Each execution runs on its own worktree branch (task/title+ID), isolated from the others",
			"set.iso.current": "Currently saved default: {current}. Affects only tasks created hereafter; existing tasks keep their creation-time choice, and non-git projects still degrade to the project directory at run time.",
			"set.sync.heading": "Auto-sync workspace sessions",
			"set.sync.off.name": "🚫 Sync off",
			"set.sync.off.title": "Manage only tasks created and triggered in the task board",
			"set.sync.off.hint": "Board tasks only (factory default)",
			"set.sync.on.name": "🔄 Auto-include sessions",
			"set.sync.on.title": "Sessions created directly in workspaces also appear on the board: In progress while running, In review automatically when done",
			"set.sync.on.hint": "Tracks runs and enters review on completion",
			"set.sync.stateOn": "On: sessions created and run directly in workspaces automatically become board cards and flow to the \"In review\" column when done.",
			"set.sync.stateOff": "Off: only tasks created and triggered inside the board appear on the board.",
			"set.foot.dirty": "Unsaved changes",
			"set.foot.clean": "Matches the current board settings",
			"set.action.save": "Save settings",
			"form.field.permission": "Execution permission",
			"form.perm.write": "Workspace write",
			"form.perm.writeHint": "Read-write access to the workspace and temp directories (recommended default)",
			"form.perm.readOnly": "Read-only",
			"form.perm.readOnlyHint": "View and search only; no file changes or external commands",
			"form.perm.fullAccess": "Full access",
			"form.perm.fullAccessHint": "Unrestricted: whole-disk access and external commands",
			"form.perm.defaultTag": " (default)",
			"set.perm.heading": "Default execution permission",
			"set.perm.writeName": "📁 Workspace write (factory default)",
			"set.perm.writeHint": "Read-write access to the workspace and temp directories; writes need no extra confirmation",
			"set.perm.readOnlyName": "🔒 Read-only",
			"set.perm.readOnlyHint": "Read-only viewing and search only; no file changes or destructive commands",
			"set.perm.fullName": "⚡ Full access",
			"set.perm.fullHint": "Unrestricted: whole-disk access and external system commands",
			"set.perm.current": "Currently saved default: {current}. The execution permission preset applied to new tasks.",
			"card.badge.permReadOnly": "🔒 Read-only",
			"card.badge.permReadOnlyTitle": "Permission: read-only",
			"card.badge.permFull": "⚡ Full access",
			"card.badge.permFullTitle": "Permission: full access",
			"detail.chip.permReadOnly": "Read-only",
			"detail.chip.permFull": "Full access",
			"detail.chip.permWrite": "Workspace write",
			"tpl.meta.permReadOnly": "read-only",
			"tpl.meta.permFull": "full access",
			"md.imageAlt": "Image {n}",
			"md.imageTitle": "Click to view full size ({alt})",
			"md.lightboxAlt": "Full-size preview",
			"md.closePreview": "Close preview",
			"slash.aria": "Quick commands and skills",
			"slash.title": "Quick command and skill completion",
			"slash.hint": "↑↓ navigate · Enter / Tab pick · Esc close",
			"slash.badge.command": "⚡ command",
			"slash.badge.skill": "🧩 skill",
			"slash.tipA": "💡 Type",
			"slash.tipB": "to autocomplete slash commands and agent skills",
			"slash.cmd.goal.desc": "Autonomously drive long-horizon goals to completion",
			"slash.cmd.goal.hint": "<goal description>",
			"slash.cmd.schedule.desc": "Set one-off or recurring cron schedules",
			"slash.cmd.schedule.hint": "<time or expression>",
			"slash.cmd.plan.desc": "Draft a step-by-step plan and get user confirmation before acting",
			"slash.cmd.browser.desc": "Launch a browser for page interaction and live search",
			"slash.cmd.grill-me.desc": "Align requirements and design intent through one-question-at-a-time interviews",
			"slash.cmd.teamwork-preview.desc": "Multi-agent collaboration and team workflow preview",
			"slash.cmd.learn.desc": "Capture solutions and new rules into the knowledge base",
			"slash.cmd.review.desc": "Multi-axis code review (correctness, architecture, security)",
			"slash.cmd.security.desc": "Security hardening and vulnerability scanning",
			"slash.cmd.permission.desc": "Switch the session permission level (read-only / workspace-write / full-access)",
			"slash.cmd.permission.hint": "<preset>",
			"slash.skill.frontend-ui-engineering": "Build production-grade, accessible frontend interfaces and components",
			"slash.skill.api-and-interface-design": "Design stable, well-bounded REST / RPC interfaces",
			"slash.skill.test-driven-development": "Test-driven development (TDD): unit and integration tests",
			"slash.skill.debugging-and-error-recovery": "Systematically locate bug root causes and recover",
			"slash.skill.performance-optimization": "Frontend/backend performance tuning and query optimization",
			"slash.skill.ci-cd-and-automation": "Build automation, CI/CD pipelines and quality gates",
			"slash.skill.code-review-and-quality": "Multi-axis code review and refactoring guidance",
			"slash.skill.code-simplification": "Simplify complex logic for readability and maintainability",
			"slash.skill.context-engineering": "Optimize context structure and prompt engineering",
			"slash.skill.doubt-driven-development": "Adversarial, doubt-driven review of core logic",
			"slash.skill.git-workflow-and-versioning": "Git workflow, branching, semantic versioning and changelogs",
			"slash.skill.idea-refine": "Refine ideas and test hypotheses via divergent-convergent thinking",
			"slash.skill.incremental-implementation": "Deliver multi-file changes in small, incremental steps",
			"slash.skill.interview-me": "Deep interviews to surface true intent",
			"slash.skill.memory-leak-debugging": "Diagnose JavaScript/Node.js memory leaks",
			"slash.skill.observability-and-instrumentation": "Add logging, metrics and distributed tracing",
			"slash.skill.planning-and-task-breakdown": "Break complex requirements into ordered, executable tasks",
			"slash.skill.security-and-hardening": "Harden against vulnerabilities; input filtering and auth hardening",
			"slash.skill.shipping-and-launch": "Pre-launch checklists and rollback strategies",
			"slash.skill.source-driven-development": "Design from authoritative docs and source code",
			"slash.skill.spec-driven-development": "Write clear technical specs before coding",
			"slash.skill.using-agent-skills": "Discover and invoke agent skills dynamically"
		};

		//#endregion
		//#region src/client/i18n/runtime.ts
		/**
		* Taskboard i18n runtime: the zh/en dictionary lookup plus the locale
		* SOURCE adapter.
		*
		* Locale source, in priority order:
		* 1. The DSH locale service (ctx.get('locale'), the same plugin that backs
		*    设置 → 通用设置 → 语言). Consumed through a NARROW structural face and
		*    attached SOFTLY — the plugin must keep working on compositions where
		*    the service is absent, so 'locale' is deliberately NOT in the client
		*    inject list (a hard inject would wait forever there).
		* 2. A local fallback: <html lang> when the DSH locale plugin maintains it
		*    (it points <html lang> at the active locale), else navigator.language,
		*    else 'en' (matches DSH: zh only when something asked for Chinese).
		*
		* Preference WRITES are never made here: switching languages is the DSH
		* settings page's job; this module only reads.
		*
		* React re-render: useT() subscribes via useSyncExternalStore; the snapshot
		* object is replaced only on locale change, so renders are stable.
		*
		* @module dsh-taskboard/client/i18n/runtime
		*/
		const DICTS = {
			zh,
			en
		};
		let unsubscribeService;
		let snapshot = {
			active: detectFallbackLocale(),
			revision: 0
		};
		const listeners = /* @__PURE__ */ new Set();
		function isLocaleId(value) {
			return value === "zh" || value === "en";
		}
		/** Derive the fallback locale without the DSH service (zh only when asked). */
		function detectFallbackLocale() {
			try {
				if (typeof document !== "undefined") {
					const lang = document.documentElement.lang;
					if (typeof lang === "string" && lang.length > 0) {
						const lower = lang.toLowerCase();
						if (lower.startsWith("zh")) return "zh";
						if (lower.startsWith("en")) return "en";
					}
				}
			} catch {}
			try {
				if (typeof navigator !== "undefined") return (navigator.language ?? "en").toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {}
			return "en";
		}
		function publish(next) {
			if (next.active === snapshot.active && next.revision === snapshot.revision) return;
			snapshot = next;
			for (const fn of listeners) fn();
		}
		/**
		* Attach the DSH locale service (call from the client entry's apply with
		* ctx.get('locale')). Absent/malformed services are ignored — the fallback
		* detection stays in charge.
		* @param localeService - the ctx 'locale' service, when provided.
		*/
		function initI18n(localeService) {
			const face = localeService;
			if (face === null || face === void 0 || typeof face.getSnapshot !== "function" || typeof face.subscribe !== "function") {
				publish({
					active: detectFallbackLocale(),
					revision: 0
				});
				return;
			}
			const sync = () => {
				try {
					const s = face.getSnapshot();
					publish({
						active: isLocaleId(s.active) ? s.active : detectFallbackLocale(),
						revision: s.revision
					});
				} catch {}
			};
			sync();
			unsubscribeService = face.subscribe(sync);
		}
		/** Detach the service and return to fallback detection (tests, dispose). */
		function disposeI18n() {
			try {
				unsubscribeService?.();
			} catch {}
			unsubscribeService = void 0;
			publish({
				active: detectFallbackLocale(),
				revision: 0
			});
		}
		/** Subscribe-side store face for useSyncExternalStore. */
		const localeStore = {
			getSnapshot() {
				return snapshot;
			},
			subscribe(fn) {
				listeners.add(fn);
				return () => {
					listeners.delete(fn);
				};
			}
		};
		const PLACEHOLDER = /\{(\w+)\}/g;
		/** Translate through the active dictionary, {name} placeholders substituted. */
		const translate = (key, params) => {
			const template = DICTS[snapshot.active][key] ?? DICTS.en[key] ?? key;
			if (params === void 0) return template;
			return template.replace(PLACEHOLDER, (match, name) => {
				const value = params[name];
				return value === void 0 ? match : String(value);
			});
		};
		/**
		* React hook: subscribes the component to locale changes and returns the
		* translate function (stable identity — it reads the active locale at call
		* time, so any re-render triggered by the subscription renders fresh text).
		*/
		function useT() {
			(0, react.useSyncExternalStore)(localeStore.subscribe, localeStore.getSnapshot);
			return translate;
		}

		//#endregion
		//#region src/client/controller.ts
		/** localStorage key for persisted view state (filters + sort). */
		const VIEW_KEY = "dsh-taskboard-view-v1";
		/** Load the persisted view state (never throws; fresh on any parse error). */
		function loadView() {
			try {
				const raw = localStorage.getItem(VIEW_KEY);
				if (raw === null) return {
					urgencies: [],
					sortBy: "default"
				};
				const parsed = JSON.parse(raw);
				const sortBy = parsed.sortBy === "updated" || parsed.sortBy === "urgency" || parsed.sortBy === "created" || parsed.sortBy === "title" ? parsed.sortBy : "default";
				return {
					workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : void 0,
					urgencies: Array.isArray(parsed.urgencies) ? parsed.urgencies.filter((u) => u === "urgent" || u === "normal" || u === "relaxed") : [],
					sortBy
				};
			} catch {
				return {
					urgencies: [],
					sortBy: "default"
				};
			}
		}
		/** Instantiate the default state (view state hydrated from localStorage). */
		function initialState() {
			const view = loadView();
			return {
				boardOpen: false,
				ledger: emptyLedger(),
				workspaces: [],
				filters: {
					workspaceId: view.workspaceId,
					urgencies: view.urgencies
				},
				search: "",
				sortBy: view.sortBy,
				composerOpen: false,
				secondaryOpen: false,
				diagOpen: false,
				templates: [],
				tplManagerOpen: false,
				importOpen: false,
				settingsOpen: false
			};
		}
		/**
		* The board controller.
		*/
		var BoardController = class {
			client;
			state = initialState();
			subscribers = /* @__PURE__ */ new Set();
			disposed = false;
			disposeStream;
			refreshInFlight;
			/** Newest change-frame revision seen on the SSE stream (S16 refresh chase). */
			seenRevision;
			sessionJumper;
			/** Composer catalog faces, installed formally by the client entry (T13). */
			catalogFaces = {};
			/** @param client - the route client. */
			constructor(client) {
				this.client = client;
			}
			/** Current snapshot (render input). */
			getSnapshot() {
				return this.state;
			}
			/** Subscribe; returns unsubscribe. */
			subscribe(fn) {
				this.subscribers.add(fn);
				return () => this.subscribers.delete(fn);
			}
			emit() {
				if (this.disposed) return;
				for (const fn of this.subscribers) fn();
			}
			setState(patch) {
				this.state = {
					...this.state,
					...patch
				};
				this.emit();
			}
			/** Start subscriptions; call once after construction. */
			start() {
				this.refresh();
				this.disposeStream = this.client.stream((change) => {
					this.seenRevision = change.revision;
					this.refresh();
				}, () => {
					this.refresh();
				});
			}
			/** Full refetch (state + workspaces + open detail). */
			async refresh() {
				if (this.refreshInFlight !== void 0) return this.refreshInFlight;
				this.refreshInFlight = (async () => {
					try {
						for (let round = 0; round < 3; round++) {
							const [ledger, workspaces] = await Promise.all([this.client.state(), this.client.workspaces()]);
							let selected;
							if (this.state.selectedId !== void 0) selected = ledger.tasks.find((t) => t.id === this.state.selectedId);
							this.setState({
								ledger,
								workspaces,
								error: void 0,
								selectedId: selected === void 0 ? void 0 : this.state.selectedId
							});
							if (this.seenRevision === void 0 || ledger.revision >= this.seenRevision) break;
						}
					} catch (error) {
						this.setState({ error: error instanceof Error ? error.message : String(error) });
					} finally {
						this.refreshInFlight = void 0;
					}
				})();
				return this.refreshInFlight;
			}
			/** Stop everything. */
			dispose() {
				this.disposed = true;
				this.disposeStream?.();
				this.subscribers.clear();
			}
			/** Open the board (sidebar entry). */
			openBoard() {
				this.setState({ boardOpen: true });
			}
			/** Close the board. */
			closeBoard() {
				this.setState({ boardOpen: false });
			}
			/** Toggle the board. */
			toggleBoard() {
				this.setState({ boardOpen: !this.state.boardOpen });
			}
			/** Set the project filter (persisted). */
			setWorkspaceFilter(workspaceId) {
				this.setState({ filters: {
					...this.state.filters,
					workspaceId
				} });
				this.persistView();
			}
			/** Toggle one urgency chip (persisted). */
			toggleUrgency(urgency) {
				const set = new Set(this.state.filters.urgencies);
				if (set.has(urgency)) set.delete(urgency);
				else set.add(urgency);
				this.setState({ filters: {
					...this.state.filters,
					urgencies: [...set]
				} });
				this.persistView();
			}
			/** Set the free-text search (transient — not persisted). */
			setSearch(search) {
				this.setState({ search });
			}
			/** Set the column sort order (persisted). */
			setSortBy(sortBy) {
				this.setState({ sortBy });
				this.persistView();
			}
			/** Write the current view state to localStorage (best effort). */
			persistView() {
				try {
					localStorage.setItem(VIEW_KEY, JSON.stringify({
						workspaceId: this.state.filters.workspaceId,
						urgencies: this.state.filters.urgencies,
						sortBy: this.state.sortBy
					}));
				} catch {}
			}
			/** Select a task (open detail). */
			select(id) {
				this.setState({ selectedId: id });
			}
			/** Show/hide the task form (create mode when opening); always blank (no template prefill). */
			setComposer(open) {
				this.setState({
					composerOpen: open,
					editingId: void 0,
					templatePrefill: void 0
				});
			}
			/** Open the create form prefilled from a chosen template (0.4.0). */
			newFromTemplate(spec) {
				this.setState({
					composerOpen: true,
					editingId: void 0,
					templatePrefill: spec
				});
			}
			/** Open the form modal editing an existing task (clears any template prefill). */
			openEditor(id) {
				this.setState({
					composerOpen: true,
					editingId: id,
					templatePrefill: void 0
				});
			}
			/** Close the form modal whatever its mode. */
			closeForm() {
				this.setState({
					composerOpen: false,
					editingId: void 0,
					templatePrefill: void 0
				});
			}
			/** Toggle the secondary tab. */
			toggleSecondary() {
				this.setState({ secondaryOpen: !this.state.secondaryOpen });
			}
			/** Whether a workspace passed git detection (form toggle enablement). */
			gitAvailable(workspaceId) {
				if (workspaceId === void 0) return true;
				return this.state.workspaces.find((w) => w.id === workspaceId)?.gitAvailable === true;
			}
			/**
			* Install the session-jump bridge (built from the runtime sessions service
			* by the client entry). Without it openSession reports 'unavailable'.
			* @param jumper - the jump function from createSessionJumper.
			*/
			installSessionJumper(jumper) {
				this.sessionJumper = jumper;
			}
			/** T13: formal installers for the composer catalog faces (was a monkeypatch from the client entry). */
			installModelCatalog(fn) {
				this.catalogFaces.models = fn;
			}
			/** T13: formal installer for the preset roster face. */
			installPresetRoster(fn) {
				this.catalogFaces.presets = fn;
			}
			/** The installed model catalog face, when the runtime provides one. */
			get modelCatalog() {
				return this.catalogFaces.models;
			}
			/** The installed preset roster face, when the runtime provides one. */
			get presetCatalog() {
				return this.catalogFaces.presets;
			}
			/**
			* Fetch model catalog: prefers installed runtime face, falls back to Taskboard client API (0.5.5).
			*/
			async fetchModelCatalog() {
				if (this.catalogFaces.models !== void 0) try {
					const list = await this.catalogFaces.models();
					if (list !== void 0 && list.length > 0) return list;
				} catch {}
				try {
					return (await this.client.modelCatalog()).models ?? [];
				} catch {
					return [];
				}
			}
			/**
			* Fetch preset roster: prefers installed runtime face, falls back to Taskboard client API (0.5.5).
			*/
			async fetchPresetCatalog() {
				if (this.catalogFaces.presets !== void 0) try {
					const roster = await this.catalogFaces.presets();
					if (roster !== void 0 && roster.presets !== void 0 && roster.presets.length > 0) return roster;
				} catch {}
				try {
					const res = await this.client.modelCatalog();
					return {
						presets: res.presets ?? [],
						...res.defaultPresetId !== void 0 ? { defaultId: res.defaultPresetId } : {}
					};
				} catch {
					return { presets: [] };
				}
			}
			/**
			* Jump to an execution's session (open it in the GUI). On success the board
			* closes so the conversation shows; a deleted-or-archived session reports
			* 'missing' for the caller to prompt about.
			* @param sessionId - the execution's session id.
			* @returns the jump outcome.
			*/
			async openSession(sessionId) {
				if (this.sessionJumper === void 0) return "unavailable";
				let result;
				try {
					result = await this.sessionJumper(sessionId);
				} catch {
					return "unavailable";
				}
				if (result === "opened") this.closeBoard();
				return result;
			}
			/** Create a task (composer submit); returns the new task id, undefined on failure. */
			async create(body) {
				try {
					const summary = await this.client.create(body);
					this.setState({
						composerOpen: false,
						error: void 0
					});
					await this.refresh();
					return summary.id;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
			/** Edit task fields (form modal submit; the GUI is the owner surface). */
			async update(id, ifVersion, body) {
				try {
					await this.client.update(id, {
						ifVersion,
						...body
					});
					this.setState({
						composerOpen: false,
						editingId: void 0,
						error: void 0
					});
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Move a task (user surface: done allowed). */
			async move(id, ifVersion, status) {
				try {
					await this.client.move(id, {
						ifVersion,
						status
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/**
			* Quick-reject (card ✗ button): move back to todo with an optional user
			* comment, committed atomically host-side. Returns whether the task moved.
			* @param id - task id.
			* @param ifVersion - optimistic version (captured at click time).
			* @param comment - optional comment text; blank = move only.
			*/
			async reject(id, ifVersion, comment) {
				const body = comment !== void 0 && comment.trim().length > 0 ? comment.trim() : void 0;
				try {
					await this.client.reject(id, body === void 0 ? { ifVersion } : {
						ifVersion,
						body
					});
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Toggle the blocked marker. */
			async toggleBlocked(task) {
				try {
					await this.client.update(task.id, {
						ifVersion: task.version,
						blocked: !task.blocked
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/**
			* Toggle one checklist item as the USER (0.4.0): flips the item, records
			* `checkedBy: 'user'`, keeps other items as they are (one update call).
			*/
			async toggleChecklistItem(task, itemId) {
				const items = (task.checklist ?? []).map((item) => item.id === itemId ? item.checked ? {
					id: item.id,
					text: item.text,
					checked: false
				} : {
					id: item.id,
					text: item.text,
					checked: true,
					checkedBy: "user",
					checkedAt: Date.now(),
					...item.note !== void 0 ? { note: item.note } : {}
				} : item);
				try {
					await this.client.update(task.id, {
						ifVersion: task.version,
						checklist: items
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Diff view (0.4.0): one execution's commit or changed path; errors surface via throw. */
			async fetchDiff(taskId, query) {
				try {
					return await this.client.diff(taskId, query);
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
			/**
			* Append a user comment. Returns whether it landed — the composer keeps its
			* text on failure (T13: it used to clear unconditionally and lose the draft).
			*/
			async comment(id, body) {
				try {
					await this.client.comment(id, body);
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Trigger a manual run (fresh in-project session, pinned model); `reuse` = 续跑. */
			async run(id, reuse = false) {
				try {
					await this.client.run(id, reuse ? { reuse: true } : {});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Cancel the running execution (stops the agent session; task returns to todo). */
			async cancel(id) {
				try {
					await this.client.cancel(id);
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/**
			* ⇥ 合并 (detail page): merge the task branch into the main worktree.
			* @returns the outcome; `noop` means the branch had no new commits (nothing merged).
			*/
			async mergeBranch(id) {
				try {
					const value = await this.client.mergeBranch(id);
					await this.refresh();
					return value.noop === true ? {
						ok: true,
						noop: true
					} : { ok: true };
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
			/**
			* 🗑 删除 worktree (detail page), optionally deleting the task branch too.
			* @returns the outcome; failures carry the git message for an alert.
			*/
			async removeWorktree(id, deleteBranch) {
				try {
					const value = await this.client.worktreeRemove(id, { deleteBranch });
					await this.refresh();
					return value.branchError !== void 0 ? {
						ok: true,
						branchError: value.branchError
					} : { ok: true };
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
			/** Open the ⚙ diagnostics panel and fetch a fresh snapshot. */
			openDiagnostics() {
				this.setState({ diagOpen: true });
				this.client.diagnostics().then((diagnostics) => this.setState({ diagnostics })).catch((error) => this.setState({ error: error instanceof Error ? error.message : String(error) }));
			}
			/** Close the ⚙ diagnostics panel. */
			closeDiagnostics() {
				this.setState({ diagOpen: false });
			}
			/** Open the board-settings modal (0.5.0). */
			openSettings() {
				this.setState({ settingsOpen: true });
			}
			/** Close the board-settings modal. */
			closeSettings() {
				this.setState({ settingsOpen: false });
			}
			/**
			* Replace board settings (0.5.0). The host broadcasts a settings-updated
			* frame; refresh() pulls ledger.settings so every open view follows.
			* @returns whether the write succeeded.
			*/
			async updateSettings(body) {
				try {
					await this.client.updateSettings(body);
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Clean one orphan worktree (⚙ panel); refreshes the diagnostics payload. */
			async cleanupOrphan(workspaceId, taskId) {
				try {
					await this.client.worktreeCleanup(workspaceId, taskId);
					const diagnostics = await this.client.diagnostics();
					this.setState({
						diagnostics,
						error: void 0
					});
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Soft-delete (agent parity) then optional purge. */
			async remove(id, ifVersion, purge) {
				try {
					await this.client.remove(id, purge ? { purge: true } : { ifVersion });
					if (purge) this.setState({ selectedId: void 0 });
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Duplicate a task into a fresh todo card (same project/urgency/prompt/execution/model/isolation/checklist). */
			async duplicate(task) {
				try {
					await this.client.create({
						title: task.title.slice(0, 196) + translate("shared.duplicate.suffix"),
						workspaceId: task.workspaceId,
						urgency: task.urgency,
						description: task.description.length > 0 ? task.description : void 0,
						prompt: task.prompt.length > 0 ? task.prompt : void 0,
						execution: task.execution.mode === "scheduled" && task.execution.cron !== void 0 ? {
							mode: "scheduled",
							cron: task.execution.cron
						} : { mode: "claim" },
						model: task.model,
						isolation: task.isolation,
						...task.presetId !== void 0 ? { presetId: task.presetId } : {},
						...task.permission !== void 0 ? { permission: task.permission } : {},
						...task.checklist !== void 0 && task.checklist.length > 0 ? { checklist: task.checklist.map((i) => i.text) } : {}
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Load the template list (best effort; errors surface). */
			async loadTemplates() {
				try {
					const value = await this.client.templates();
					this.setState({
						templates: value.templates,
						error: void 0
					});
					return value.templates;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return [];
				}
			}
			/** Open the + 新建任务 dropdown's template list fresh (called on menu open). */
			prepareTemplateMenu() {
				if (this.state.templates.length === 0) this.loadTemplates();
			}
			/** Open the template manager modal. */
			openTemplateManager() {
				this.setState({ tplManagerOpen: true });
				this.loadTemplates();
			}
			/** Close the template manager modal. */
			closeTemplateManager() {
				this.setState({ tplManagerOpen: false });
			}
			/** Create or replace a template; refreshes the list. */
			async upsertTemplate(body) {
				try {
					await this.client.templateUpsert(body);
					await this.loadTemplates();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Delete a template by id; refreshes the list. */
			async deleteTemplate(id) {
				try {
					await this.client.templateDelete(id);
					await this.loadTemplates();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** 存为模板 from a task card: carries every configurable field incl. checklist texts. */
			async saveAsTemplate(task) {
				return this.upsertTemplate({
					name: task.title.slice(0, 60),
					task: {
						title: task.title,
						description: task.description.length > 0 ? task.description : void 0,
						prompt: task.prompt.length > 0 ? task.prompt : void 0,
						urgency: task.urgency,
						execution: task.execution.mode === "scheduled" && task.execution.cron !== void 0 ? {
							mode: "scheduled",
							cron: task.execution.cron
						} : { mode: "claim" },
						model: task.model,
						isolation: task.isolation,
						...task.presetId !== void 0 ? { presetId: task.presetId } : {},
						...task.permission !== void 0 ? { permission: task.permission } : {},
						...task.checklist !== void 0 && task.checklist.length > 0 ? { checklist: task.checklist.map((i) => i.text) } : {}
					}
				});
			}
			/** Load prompt completions (skills + slash commands) from host (0.5.5). */
			async fetchPromptCompletions() {
				try {
					return await this.client.promptCompletions();
				} catch {
					return;
				}
			}
			/** Open the import modal. */
			openImport() {
				this.setState({ importOpen: true });
			}
			/** Close the import modal. */
			closeImport() {
				this.setState({ importOpen: false });
			}
			/** Dry-run an import file: classify its tasks against the live ledger. */
			async importPreview(file) {
				try {
					return (await this.client.importPreview(file)).plan;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
			/** Commit an import; refreshes the ledger afterwards. */
			async importCommit(mode, ledger) {
				try {
					const value = await this.client.importCommit(mode, ledger);
					await this.refresh();
					return value;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
			/** Download the whole ledger as a JSON backup file. */
			exportJson() {
				const stamp = /* @__PURE__ */ new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const name = `dsh-taskboard-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
				const body = JSON.stringify(this.state.ledger, null, 2);
				this.download(name, body, "application/json");
			}
			/** Download the task list as a CSV (BOM-prefixed for Excel + Chinese text). */
			exportCsv() {
				const esc = (v) => {
					let s = String(v ?? "");
					if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
					return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
				};
				const header = [
					"id",
					"title",
					"status",
					"urgency",
					"blocked",
					"project",
					"claimedBy",
					"mode",
					"cron",
					"nextRunAt",
					"model",
					"createdAt",
					"updatedAt",
					"comments",
					"executions"
				];
				const rows = this.state.ledger.tasks.map((t) => [
					t.id,
					t.title,
					t.status,
					t.urgency,
					t.blocked ? "yes" : "no",
					t.workspaceId,
					t.claimedBy ?? "",
					t.execution.mode,
					t.execution.cron ?? "",
					t.execution.nextRunAt !== void 0 ? new Date(t.execution.nextRunAt).toISOString() : "",
					t.model !== void 0 ? `${t.model.provider}/${t.model.model}` : "",
					new Date(t.createdAt).toISOString(),
					new Date(t.updatedAt).toISOString(),
					t.comments.length,
					t.executions.length
				].map(esc).join(","));
				const stamp = /* @__PURE__ */ new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const name = `dsh-taskboard-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.csv`;
				this.download(name, `\uFEFF${[header.join(","), ...rows].join("\r\n")}`, "text/csv");
			}
			/** Trigger a browser download (no-op when the DOM is unavailable). */
			download(filename, body, type) {
				try {
					const blob = new Blob([body], { type });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = filename;
					a.click();
					setTimeout(() => URL.revokeObjectURL(url), 5e3);
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
		};

		//#endregion
		//#region src/client/styles.ts
		/**
		* Board styles, injected as one global stylesheet with dsh-atb- prefixed
		* classes. Colors ride the shell's --dsw-* design tokens where available so
		* the board follows the active theme/skin; urgency accents are the fixed
		* red/purple/blue of the protocol.
		*
		* @module dsh-taskboard/client/styles
		*/
		/** The stylesheet text. */
		const STYLES = `
		.dsh-atb-entry {
		  display: flex; align-items: center; gap: 8px; position: relative;
		  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
		  border: none; border-radius: 8px; background: transparent;
		  color: var(--dsw-text-secondary, inherit); font: inherit; font-size: 13px;
		  cursor: pointer; text-align: left;
		}
		.dsh-atb-entry:hover { background: var(--dsw-hover, rgba(128,128,128,.12)); color: var(--dsw-text-primary, inherit); }
		.dsh-atb-entry[data-active="true"] { background: var(--dsw-active, rgba(128,128,128,.18)); color: var(--dsw-text-primary, inherit); font-weight: 500; }
		.dsh-atb-entry svg { flex: none; }
		/* Status strip on the entry row's right: todo|in_progress|in_review counts. */
		.dsh-atb-entry-stats {
		  margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
		  font-size: 11px; line-height: 1; color: var(--dsw-text-secondary, gray);
		  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: help;
		}
		.dsh-atb-entry-sep { opacity: .5; }
		/* Each rolling count wears its status color (todo blue | in_progress orange |
		   in_review purple); the separators stay in the strip's neutral gray. */
		.dsh-atb-roll[data-stat="todo"] { color: #3e63dd; }
		.dsh-atb-roll[data-stat="in_progress"] { color: #d9822b; }
		.dsh-atb-roll[data-stat="in_review"] { color: #8e4ec6; }
		/* One rolling number: fixed one-line window, overflow hidden. */
		.dsh-atb-roll {
		  position: relative; display: inline-block; overflow: hidden;
		  height: 12px; min-width: 1ch; text-align: center; vertical-align: middle;
		}
		.dsh-atb-rn { display: block; height: 12px; line-height: 12px; text-align: center; }
		/* The incoming value sits just outside the window (below for up-scroll). */
		.dsh-atb-rn-next { position: absolute; left: 0; right: 0; top: 100%; }
		.dsh-atb-roll[data-dir="down"] .dsh-atb-rn-next { top: auto; bottom: 100%; }
		.dsh-atb-roll .dsh-atb-rn { transition: transform .3s cubic-bezier(.25, .1, .25, 1); }
		.dsh-atb-roll[data-anim="1"][data-dir="up"] .dsh-atb-rn { transform: translateY(-100%); }
		.dsh-atb-roll[data-anim="1"][data-dir="down"] .dsh-atb-rn { transform: translateY(100%); }
		@media (prefers-reduced-motion: reduce) {
		  .dsh-atb-roll .dsh-atb-rn { transition: none; }
		}

		/* 0.4.3: collapsed rail. Collapsing the sidebar narrows it to an icon rail
		 * (layout frame carries data-sidebar-collapsed; the sidebar root toggles its
		 * CSS-Module *_collapsed class — dual signals, per the 0.4.2 shell doctrine).
		 * The entry then mirrors the native rail geometry (36×36 icon button, no
		 * label/stats) — matches .hHd-Xa_collapsed .hHd-Xa_newSession. */
		[data-sidebar-collapsed] [data-dsh-atb-entry],
		[class*="_collapsed"] [data-dsh-atb-entry] {
		  width: 36px; height: 36px; min-width: 36px;
		  margin: 0 0 12px; padding: 0;
		  justify-content: center; gap: 0; text-align: center;
		}
		[data-sidebar-collapsed] [data-dsh-atb-entry] .dsh-atb-entry-label,
		[data-sidebar-collapsed] [data-dsh-atb-entry] .dsh-atb-entry-stats,
		[class*="_collapsed"] [data-dsh-atb-entry] .dsh-atb-entry-label,
		[class*="_collapsed"] [data-dsh-atb-entry] .dsh-atb-entry-stats { display: none; }
		/* Native rail icons render ~16-20px; scale ours up from 14px to read at parity. */
		[data-sidebar-collapsed] [data-dsh-atb-entry] svg,
		[class*="_collapsed"] [data-dsh-atb-entry] svg { width: 16px; height: 16px; }

		.dsh-atb-search { width: 130px; }
		.dsh-atb-badge[data-kind="stale"] { background: rgba(217,130,43,.15); color: #d9822b; }

		/* Triple-generation column matching — dev shell's data-pane pane, the
		 * official layout shell's CSS-Module hashed centerCol (0.4.2), or DSH
		 * Desktop's non-compat extended frame surface (0.5.2, see board-mount.tsx). */
		html[data-dsh-atb-active] [data-pane="conversation"] > *:not([data-dsh-atb-view]),
		html[data-dsh-atb-active] [class*="centerCol"] > *:not([data-dsh-atb-view]),
		html[data-dsh-atb-active] .dshDesktopConversationSurface > *:not([data-dsh-atb-view]) { display: none !important; }
		.dsh-atb-view { display: none; }
		html[data-dsh-atb-active] .dsh-atb-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

		.dsh-atb-board { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 12px 16px; gap: 10px; box-sizing: border-box; }
		.dsh-atb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.dsh-atb-title { font-size: 15px; font-weight: 600; margin: 0; }
		.dsh-atb-count { font-size: 12px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-ver {
		  font-size: 11px; color: var(--dsw-text-secondary, gray);
		  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
		  text-decoration: none;
		  padding: 1px 9px; border-radius: 999px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.1));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.22));
		  transition: border-color .12s ease, color .12s ease;
		}
		.dsh-atb-ver:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-spacer { flex: 1; }
		.dsh-atb-select, .dsh-atb-input {
		  font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px;
		  border: 1px solid var(--dsw-border, var(--dsw-alias-border-l2, rgba(128,128,128,.35)));
		  background: var(--dsw-alias-bg-module-platform, var(--dsw-bg-elevated, var(--dsw-bg, transparent)));
		  color: var(--dsw-alias-label-primary, var(--dsw-text-primary, inherit));
		  color-scheme: light dark;
		}
		.dsh-atb-select option,
		.dsh-atb-modal-body select option {
		  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-module-platform, #252830));
		  color: var(--dsw-alias-label-primary, var(--dsw-text-primary, #e6e8eb));
		}
		body[data-ds-dark-theme] .dsh-atb-board,
		body[data-ds-dark-theme] .dsh-atb-modal,
		body[data-ds-dark-theme] .dsh-atb-select,
		body[data-ds-dark-theme] .dsh-atb-input,
		body[data-ds-dark-theme] .dsh-atb-modal-body select,
		body[data-ds-dark-theme] .dsh-atb-modal-body input,
		body[data-ds-dark-theme] .dsh-atb-modal-body textarea {
		  color-scheme: dark;
		}
		body[data-ds-dark-theme] .dsh-atb-select option,
		body[data-ds-dark-theme] .dsh-atb-modal-body select option {
		  background: #252830;
		  color: #e6e8eb;
		}
		@media (prefers-color-scheme: dark) {
		  .dsh-atb-select,
		  .dsh-atb-input,
		  .dsh-atb-modal-body select,
		  .dsh-atb-modal-body input,
		  .dsh-atb-modal-body textarea {
		    color-scheme: dark;
		  }
		  .dsh-atb-select option,
		  .dsh-atb-modal-body select option {
		    background: #252830;
		    color: #e6e8eb;
		  }
		}
		.dsh-atb-chip {
		  display: inline-flex; align-items: center; gap: 5px;
		  font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: transparent; color: var(--dsw-text-secondary, inherit);
		}
		.dsh-atb-chip[data-on="true"] { color: #fff; border-color: transparent; }
		.dsh-atb-chip[data-urgency="urgent"][data-on="true"] { background: #e5484d; }
		.dsh-atb-chip[data-urgency="normal"][data-on="true"] { background: #8e4ec6; }
		.dsh-atb-chip[data-urgency="relaxed"][data-on="true"] { background: #3e63dd; }
		.dsh-atb-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
		.dsh-atb-dot[data-urgency="urgent"] { background: #e5484d; }
		.dsh-atb-dot[data-urgency="normal"] { background: #8e4ec6; }
		.dsh-atb-dot[data-urgency="relaxed"] { background: #3e63dd; }
		/* Status dots (column heads): one fixed color per lifecycle status, matching
		   the detail pane's status pills. Canceled/archived share the resting gray;
		   trashed (pending purge) keeps the red of the 待清除 badge. */
		.dsh-atb-dot[data-status="backlog"] { background: #8a8f98; }
		.dsh-atb-dot[data-status="todo"] { background: #3e63dd; }
		.dsh-atb-dot[data-status="in_progress"] { background: #d9822b; }
		.dsh-atb-dot[data-status="in_review"] { background: #8e4ec6; }
		.dsh-atb-dot[data-status="done"] { background: #2ea043; }
		.dsh-atb-dot[data-status="canceled"], .dsh-atb-dot[data-status="archived"] { background: #8a8f98; }
		.dsh-atb-dot[data-status="trashed"] { background: #e5484d; }

		.dsh-atb-btn {
		  font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.08)); color: inherit;
		}
		.dsh-atb-btn:hover { background: var(--dsw-hover, rgba(128,128,128,.18)); }
		.dsh-atb-btn:disabled { opacity: .45; cursor: default; }
		.dsh-atb-btn[data-primary="true"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
		.dsh-atb-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 45%, transparent); }

		.dsh-atb-columns { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; flex: 1; min-height: 0; overflow-x: auto; }

		.dsh-atb-detailpanel {
		  display: flex; flex-direction: column;
		  flex: none; max-height: 55%; min-height: 180px; overflow: hidden;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.25)); border-radius: 12px;
		  background: var(--dsw-bg-panel, var(--dsw-bg-elevated, rgba(128,128,128,.05)));
		  padding: 10px 12px; box-shadow: 0 -4px 18px rgba(0,0,0,.12);
		}
		.dsh-atb-detailpanel .dsh-atb-detail { flex: 1; min-height: 0; }
		.dsh-atb-column { display: flex; flex-direction: column; min-width: 200px; min-height: 0; border-radius: 10px; background: var(--dsw-bg-inset, rgba(128,128,128,.07)); padding: 8px; gap: 8px; }
		.dsh-atb-colhead { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; padding: 2px 4px; }
		.dsh-atb-colcount { font-size: 11px; font-weight: 400; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-cards { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; flex: 1; padding: 2px; }

		.dsh-atb-card {
		  position: relative; border-radius: 9px; padding: 8px 10px 8px 13px; cursor: pointer;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.1));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.25));
		  font-size: 13px; text-align: left; color: inherit; width: 100%; box-sizing: border-box;
		}
		.dsh-atb-card:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.55)); }
		.dsh-atb-card[draggable="true"] { cursor: grab; }
		.dsh-atb-card[data-dragging] { opacity: .45; }
		.dsh-atb-column[data-dragover] { outline: 2px dashed var(--dsw-border-strong, rgba(128,128,128,.55)); outline-offset: -2px; background: var(--dsw-bg-hover, rgba(128,128,128,.12)); }
		.dsh-atb-card::before {
		  content: ""; position: absolute; left: 4px; top: 6px; bottom: 6px; width: 3.5px; border-radius: 3px;
		}
		.dsh-atb-card[data-urgency="urgent"]::before { background: #e5484d; }
		.dsh-atb-card[data-urgency="normal"]::before { background: #8e4ec6; }
		.dsh-atb-card[data-urgency="relaxed"]::before { background: #3e63dd; }
		.dsh-atb-card-title { font-weight: 550; line-height: 1.35; word-break: break-word; }
		.dsh-atb-card-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11px; color: var(--dsw-text-secondary, gray); flex-wrap: wrap; }
		.dsh-atb-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 5px; background: rgba(128,128,128,.18); }
		.dsh-atb-badge[data-kind="blocked"] { background: rgba(229,72,77,.18); color: #e5484d; }
		.dsh-atb-badge[data-kind="scheduled"] { background: rgba(62,99,221,.16); color: #3e63dd; }
		.dsh-atb-badge[data-kind="trashed"] { background: rgba(229,72,77,.14); color: #e5484d; text-decoration: line-through; }
		.dsh-atb-badge[data-kind="done"] { background: rgba(46,160,67,.16); color: #2ea043; }
		.dsh-atb-badge[data-kind="running"] { background: rgba(229,152,42,.16); color: #e69842; }
		.dsh-atb-card-session {
		  font: inherit; font-size: 10.5px; line-height: 1; padding: 2px 6px; border-radius: 5px;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.3));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.14));
		  color: var(--dsw-text-secondary, inherit);
		  cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
		  transition: all .15s ease;
		}
		.dsh-atb-card-session:hover {
		  border-color: var(--dsw-alias-brand-primary, #1f2328);
		  background: var(--dsw-hover, rgba(128,128,128,.24));
		  color: var(--dsw-alias-label-primary, inherit);
		}

		/* ---------- card quick review (in_review column) ---------- */
		.dsh-atb-quick { display: flex; gap: 6px; margin-top: 7px; }
		.dsh-atb-quickbtn {
		  flex: 1; font-size: 11.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.3));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.12)); color: inherit;
		}
		.dsh-atb-quickbtn:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); }
		.dsh-atb-quickbtn[data-act="done"] { background: rgba(46,160,67,.14); color: #2ea043; border-color: rgba(46,160,67,.4); }
		.dsh-atb-quickbtn[data-act="done"]:hover { background: rgba(46,160,67,.22); }
		.dsh-atb-quickbtn[data-act="reject"] { background: rgba(229,152,42,.12); color: #d9822b; border-color: rgba(229,152,42,.4); }
		.dsh-atb-quickbtn[data-act="reject"]:hover { background: rgba(229,152,42,.2); }
		.dsh-atb-quick-reject { display: flex; gap: 6px; margin-top: 7px; align-items: stretch; }
		.dsh-atb-quick-note { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 8px; }

		.dsh-atb-error { font-size: 12px; color: #e5484d; padding: 4px 8px; border-radius: 6px; background: rgba(229,72,77,.1); }
		.dsh-atb-empty { font-size: 12px; color: var(--dsw-text-secondary, gray); padding: 10px 4px; }

		/* ---------- detail pane (polished) ---------- */
		.dsh-atb-detail {
		  display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; flex: 1;
		  padding: 2px; position: relative;
		}
		.dsh-atb-detail::before {
		  content: ""; position: sticky; top: 0; height: 3px; border-radius: 3px; flex: none;
		}
		.dsh-atb-detail[data-urgency="urgent"]::before { background: linear-gradient(90deg, #e5484d, rgba(229,72,77,.15)); }
		.dsh-atb-detail[data-urgency="normal"]::before { background: linear-gradient(90deg, #8e4ec6, rgba(142,78,198,.15)); }
		.dsh-atb-detail[data-urgency="relaxed"]::before { background: linear-gradient(90deg, #3e63dd, rgba(62,99,221,.15)); }

		.dsh-atb-detail-head { display: flex; align-items: flex-start; gap: 10px; }
		.dsh-atb-detail-titlewrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
		.dsh-atb-detail-titlebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.dsh-atb-detail-titlebar h3 { margin: 0; font-size: 15.5px; line-height: 1.35; word-break: break-word; }
		.dsh-atb-detail-close {
		  flex: none; width: 26px; height: 26px; border-radius: 7px; border: none; cursor: pointer;
		  background: transparent; color: var(--dsw-text-secondary, gray); font-size: 13px; line-height: 1;
		}
		.dsh-atb-detail-close:hover { background: var(--dsw-hover, rgba(128,128,128,.18)); color: inherit; }
		.dsh-atb-detail-topbtns { display: flex; align-items: center; gap: 6px; flex: none; }
		.dsh-atb-detail-edit {
		  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07)); color: var(--dsw-text-secondary, inherit);
		}
		.dsh-atb-detail-edit:hover { border-color: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary, inherit); }
		.dsh-atb-detail-session {
		  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.1));
		  color: var(--dsw-alias-label-primary, inherit);
		  display: inline-flex; align-items: center; gap: 4px;
		}
		.dsh-atb-detail-session:hover {
		  border-color: var(--dsw-alias-brand-primary, #1f2328);
		  background: var(--dsw-hover, rgba(128,128,128,.22));
		}

		.dsh-atb-statuspill {
		  flex: none; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; letter-spacing: .02em;
		}
		.dsh-atb-statuspill[data-status="backlog"] { background: rgba(128,128,128,.18); color: var(--dsw-text-secondary, #888); }
		.dsh-atb-statuspill[data-status="todo"] { background: rgba(62,99,221,.15); color: #3e63dd; }
		.dsh-atb-statuspill[data-status="in_progress"] { background: rgba(230,152,66,.16); color: #d9822b; }
		.dsh-atb-statuspill[data-status="in_review"] { background: rgba(142,78,198,.16); color: #8e4ec6; }
		.dsh-atb-statuspill[data-status="done"] { background: rgba(46,160,67,.16); color: #2ea043; }
		.dsh-atb-statuspill[data-status="canceled"], .dsh-atb-statuspill[data-status="archived"] { background: rgba(128,128,128,.14); color: var(--dsw-text-secondary, #888); }

		.dsh-atb-detail-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-chip2 {
		  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1;
		  padding: 3px 8px; border-radius: 6px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.09)); color: var(--dsw-text-secondary, #999);
		}
		button.dsh-atb-chip2.dsh-atb-chip-btn {
		  font: inherit; border: 1px solid var(--dsw-border, rgba(128,128,128,.25)); cursor: pointer;
		}
		button.dsh-atb-chip2.dsh-atb-chip-btn:hover {
		  border-color: var(--dsw-alias-brand-primary, #1f2328);
		  color: var(--dsw-alias-label-primary, inherit);
		  background: var(--dsw-hover, rgba(128,128,128,.2));
		}
		.dsh-atb-chip2-icon { font-size: 10.5px; opacity: .85; }
		.dsh-atb-chip2[data-tone="urgent"] { background: rgba(229,72,77,.15); color: #e5484d; }
		.dsh-atb-chip2[data-tone="normal"] { background: rgba(142,78,198,.14); color: #a06ce0; }
		.dsh-atb-chip2[data-tone="relaxed"] { background: rgba(62,99,221,.13); color: #6d92e8; }
		.dsh-atb-detail-sub { font-size: 11.5px; color: var(--dsw-text-secondary, gray); }

		.dsh-atb-fieldcard {
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.22)); border-radius: 10px;
		  padding: 9px 11px; display: flex; flex-direction: column; gap: 5px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.06));
		}
		.dsh-atb-fieldcard-label {
		  font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
		  color: var(--dsw-text-secondary, gray);
		}
		.dsh-atb-fieldcard[data-kind="prompt"] .dsh-atb-fieldcard-label { color: #8e63c8; }
		.dsh-atb-promptbox {
		  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		  font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.08)); border-radius: 7px; padding: 8px 10px;
		  border: 1px dashed var(--dsw-border, rgba(128,128,128,.25));
		}
		.dsh-atb-desc { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.55; }

		.dsh-atb-detail-actions { display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-detail-run {
		  font: inherit; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 7px; cursor: pointer;
		  border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); color: var(--dsw-alias-label-primary-foreground, #fff);
		  transition: filter .12s ease;
		}
		.dsh-atb-detail-run:hover { filter: brightness(1.1); }
		.dsh-atb-detail-run[data-danger="true"] { background: rgba(229,72,77,.92); }
		.dsh-atb-movebtns { display: flex; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-movebtn {
		  font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07)); color: var(--dsw-text-secondary, inherit);
		  transition: border-color .12s ease, color .12s ease;
		}
		.dsh-atb-movebtn:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-movebtn[data-to="done"] { border-color: rgba(46,160,67,.55); color: #2ea043; }
		.dsh-atb-movebtn[data-to="done"]:hover { background: rgba(46,160,67,.12); }
		.dsh-atb-movebtn[data-to="canceled"], .dsh-atb-movebtn[data-to="archived"] { opacity: .75; }
		.dsh-atb-movebtn[data-to="blocked"] { border-color: rgba(229,72,77,.45); }
		.dsh-atb-movebtn[data-to="blocked"]:hover { background: rgba(229,72,77,.1); }
		.dsh-atb-confirm { display: inline-flex; align-items: center; gap: 6px; }
		.dsh-atb-confirm-label { font-size: 11.5px; color: var(--dsw-text-secondary, gray); }

		.dsh-atb-section { font-size: 13px; display: flex; flex-direction: column; gap: 7px; }
		.dsh-atb-section h4 {
		  margin: 0; font-size: 11px; color: var(--dsw-text-secondary, gray);
		  text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; gap: 6px;
		}
		.dsh-atb-count2 {
		  font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 999px; line-height: 16px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.14)); color: var(--dsw-text-secondary, gray);
		}
		.dsh-atb-empty2 { font-size: 12px; color: var(--dsw-text-secondary, gray); padding: 8px 0; }

		.dsh-atb-commentlist { display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-bubble { display: flex; gap: 8px; }
		.dsh-atb-bubble-avatar {
		  flex: none; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
		  font-size: 13px; background: var(--dsw-bg-inset, rgba(128,128,128,.12));
		}
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-avatar { background: rgba(142,78,198,.15); }
		.dsh-atb-bubble-main {
		  flex: 1; min-width: 0; border-radius: 10px; padding: 6px 10px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.08));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.18));
		}
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-main { border-color: rgba(142,78,198,.3); background: rgba(142,78,198,.07); }
		.dsh-atb-bubble-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
		.dsh-atb-bubble-meta b { font-size: 11.5px; font-weight: 600; color: var(--dsw-text-primary, inherit); }
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-meta b { color: #a06ce0; }
		.dsh-atb-bubble-meta span { font-size: 10.5px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-bubble-body { font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }

		.dsh-atb-composer { display: flex; gap: 7px; align-items: flex-end; margin-top: 2px; }
		.dsh-atb-composer-input {
		  flex: 1; font: inherit; font-size: 12.5px; line-height: 1.5; padding: 7px 10px; border-radius: 9px;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg, transparent); color: inherit; resize: vertical; min-height: 38px;
		}
		.dsh-atb-composer-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #1f2328); }
		.dsh-atb-composer-send {
		  flex: none; font: inherit; font-size: 12.5px; padding: 7px 14px; border-radius: 9px; cursor: pointer;
		  border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); color: var(--dsw-alias-label-primary-foreground, #fff);
		}
		.dsh-atb-composer-send:disabled { opacity: .4; cursor: default; }

		.dsh-atb-execlist { display: flex; flex-direction: column; gap: 5px; }
		.dsh-atb-exec-row {
		  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px;
		  padding: 5px 9px; border-radius: 8px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.16));
		}
		.dsh-atb-exec-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgba(128,128,128,.5); }
		.dsh-atb-exec-dot[data-outcome="succeeded"] { background: #2ea043; box-shadow: 0 0 0 3px rgba(46,160,67,.15); }
		.dsh-atb-exec-dot[data-outcome="failed"] { background: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
		.dsh-atb-exec-dot[data-outcome="running"] { background: #d9822b; box-shadow: 0 0 0 3px rgba(217,130,43,.18); animation: dsh-atb-pulse 1.6s ease-in-out infinite; }
		@keyframes dsh-atb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
		.dsh-atb-exec-trigger { font-size: 11px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-outcome { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; }
		.dsh-atb-exec-outcome[data-outcome="succeeded"] { background: rgba(46,160,67,.15); color: #2ea043; }
		.dsh-atb-exec-outcome[data-outcome="failed"] { background: rgba(229,72,77,.14); color: #e5484d; }
		.dsh-atb-exec-outcome[data-outcome="running"] { background: rgba(217,130,43,.15); color: #d9822b; }
		.dsh-atb-exec-outcome[data-outcome="cancelled"] { background: rgba(128,128,128,.15); color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-time { font-size: 11px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-session {
		  font: inherit; font-size: 11px; color: var(--dsw-text-secondary, gray);
		  background: none; border: none; padding: 0; cursor: pointer;
		}
		.dsh-atb-exec-session:hover { color: var(--dsw-alias-brand-primary, inherit); text-decoration: underline dotted; }
		.dsh-atb-exec-error { flex-basis: 100%; font-size: 11px; color: #e5484d; word-break: break-all; }

		.dsh-atb-dangerzone {
		  display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 8px;
		  border-top: 1px dashed var(--dsw-border, rgba(128,128,128,.25));
		}

		/* ---------- task form modal (create + edit, polished) ---------- */
		.dsh-atb-modal-backdrop {
		  position: fixed; inset: 0; z-index: 80;
		  background: var(--dsw-alias-bg-mask-drop, rgba(28,30,36,.4)); backdrop-filter: var(--dsw-mask-blur, blur(2px));
		  display: flex; align-items: center; justify-content: center;
		  animation: dsh-atb-fade .14s ease;
		}
		@keyframes dsh-atb-fade { from { opacity: 0; } }
		.dsh-atb-modal {
		  width: min(560px, calc(100vw - 48px)); max-height: calc(100vh - 80px);
		  display: flex; flex-direction: column; overflow: hidden; border-radius: 14px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
		  animation: dsh-atb-pop .16s ease;
		}
		.dsh-atb-taskform-modal {
		  width: min(960px, calc(100vw - 40px));
		  max-height: calc(100vh - 50px);
		}
		@keyframes dsh-atb-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
		.dsh-atb-modal-head {
		  display: flex; align-items: center; gap: 10px;
		  padding: 13px 16px 11px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
		}
		.dsh-atb-modal-headicon {
		  flex: none; width: 30px; height: 30px; border-radius: 9px;
		  display: flex; align-items: center; justify-content: center;
		  font-size: 14px; background: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff);
		}
		.dsh-atb-modal-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
		.dsh-atb-modal-headtext h3 { margin: 0; font-size: 15px; line-height: 1.3; }
		.dsh-atb-modal-headtext p { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary, gray); }
		.dsh-atb-modal-close {
		  flex: none; width: 26px; height: 26px; border-radius: 7px; border: none; cursor: pointer;
		  background: transparent; color: var(--dsw-alias-label-tertiary, gray); font-size: 13px; line-height: 1;
		}
		.dsh-atb-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); color: var(--dsw-alias-label-primary, inherit); }

		.dsh-atb-modal-body {
		  padding: 13px 16px; overflow-y: auto;
		  display: grid; grid-template-columns: 1fr 1fr; gap: 11px 10px;
		}
		.dsh-atb-taskform-body {
		  padding: 14px 18px;
		  display: grid;
		  grid-template-columns: 1.05fr 1.15fr;
		  gap: 18px;
		}
		.dsh-atb-form-col {
		  display: flex;
		  flex-direction: column;
		  gap: 11px;
		  min-width: 0;
		}
		.dsh-atb-form-left {
		  border-right: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14));
		  padding-right: 18px;
		}
		.dsh-atb-form-right {
		  display: flex;
		  flex-direction: column;
		  gap: 14px;
		}
		.dsh-atb-form-right .dsh-atb-field {
		  flex: 1;
		  display: flex;
		  flex-direction: column;
		}
		.dsh-atb-form-right .dsh-atb-prompt-wrap {
		  flex: 1;
		  display: flex;
		  flex-direction: column;
		}
		.dsh-atb-form-right .dsh-atb-prompt-inner {
		  flex: 1;
		  display: flex;
		  flex-direction: column;
		}
		.dsh-atb-form-right .dsh-atb-prompt-input {
		  flex: 1;
		  min-height: 130px;
		  resize: vertical;
		}
		.dsh-atb-form-subgrid {
		  display: grid;
		  grid-template-columns: 1fr 1fr;
		  gap: 10px;
		}

		@media (max-width: 768px) {
		  .dsh-atb-taskform-modal { width: calc(100vw - 20px); }
		  .dsh-atb-taskform-body { grid-template-columns: 1fr; gap: 14px; padding: 12px 14px; }
		  .dsh-atb-form-left { border-right: none; padding-right: 0; }
		  .dsh-atb-form-right .dsh-atb-prompt-input { min-height: 90px; }
		}
		.dsh-atb-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
		.dsh-atb-field[data-span="full"] { grid-column: 1 / -1; }
		.dsh-atb-field-label {
		  display: flex; align-items: center; gap: 3px;
		  font-size: 11px; font-weight: 600; letter-spacing: .03em;
		  color: var(--dsw-alias-label-secondary, gray);
		}
		.dsh-atb-req { color: var(--dsw-alias-state-error-primary, #e5484d); font-style: normal; }
		.dsh-atb-modal-body input, .dsh-atb-modal-body textarea, .dsh-atb-modal-body select {
		  font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px;
		  width: 100%; box-sizing: border-box;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: var(--dsw-specific-input-major, transparent); color: var(--dsw-alias-label-primary, inherit);
		  transition: border-color .12s ease, box-shadow .12s ease;
		}
		.dsh-atb-modal-body textarea { min-height: 64px; resize: vertical; }
		.dsh-atb-modal-body input:focus, .dsh-atb-modal-body textarea:focus, .dsh-atb-modal-body select:focus {
		  outline: none; border-color: var(--dsw-alias-brand-primary, #1f2328);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 18%, transparent);
		}
		.dsh-atb-modal-body .dsh-atb-input-bad { border-color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-modal-body .dsh-atb-input-bad:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 20%, transparent); }

		.dsh-atb-urgency-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
		.dsh-atb-urgency-opt {
		  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
		  padding: 8px 10px; border-radius: 9px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: inherit;
		  transition: border-color .12s ease, background .12s ease;
		}
		.dsh-atb-urgency-name { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; }
		.dsh-atb-urgency-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-urgency-opt:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="urgent"] { border-color: rgba(229,72,77,.65); background: rgba(229,72,77,.1); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="normal"] { border-color: rgba(142,78,198,.65); background: rgba(142,78,198,.1); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="relaxed"] { border-color: rgba(62,99,221,.65); background: rgba(62,99,221,.1); }

		.dsh-atb-mode-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
		.dsh-atb-mode-opt {
		  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
		  padding: 8px 10px; border-radius: 9px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: inherit;
		  transition: border-color .12s ease, background .12s ease;
		}
		.dsh-atb-mode-name { font-size: 12.5px; font-weight: 600; }
		.dsh-atb-mode-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-mode-opt:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }
		.dsh-atb-mode-opt[data-on="true"] { border-color: var(--dsw-alias-brand-primary, #1f2328); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 8%, transparent); }

		.dsh-atb-cron-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-cron-preset {
		  font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: var(--dsw-alias-label-secondary, inherit);
		}
		.dsh-atb-cron-preset:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-cron-preset[data-on="true"] { border-color: transparent; background: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff); }
		.dsh-atb-cron-next { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }

		.dsh-atb-modal-foot {
		  display: flex; align-items: center; gap: 10px;
		  padding: 11px 16px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04));
		}
		.dsh-atb-modal-hint { flex: 1; min-width: 0; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-modal-hint[data-tone="bad"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-modal-footbtns { display: flex; gap: 8px; }

		.dsh-atb-secondary { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-link { color: var(--dsw-alias-state-business-primary, #3e63dd); cursor: pointer; text-decoration: none; }
		.dsh-atb-link:hover { text-decoration: underline; }

		/* ---------- alert modal ---------- */
		.dsh-atb-alert-backdrop {
		  position: fixed; inset: 0; z-index: 90;
		  background: var(--dsw-alias-bg-mask-drop, rgba(28,30,36,.4)); backdrop-filter: var(--dsw-mask-blur, blur(2px));
		  display: flex; align-items: center; justify-content: center;
		  animation: dsh-atb-fade .12s ease;
		}
		.dsh-atb-alert {
		  min-width: 280px; max-width: 380px; padding: 20px 24px; border-radius: 14px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
		  display: flex; flex-direction: column; align-items: center; gap: 14px;
		  animation: dsh-atb-pop .14s ease;
		}
		.dsh-atb-alert-icon { font-size: 28px; line-height: 1; }
		.dsh-atb-alert-msg {
		  font-size: 13.5px; line-height: 1.55; text-align: center;
		  word-break: break-word; white-space: pre-wrap;
		  color: var(--dsw-alias-label-primary, inherit);
		}
		.dsh-atb-alert .dsh-atb-btn { padding: 6px 28px; font-size: 13px; }

		/* ---------- 0.3.0 isolation ---------- */
		.dsh-atb-isolation-note { display: block; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-mode-picker[data-disabled="true"] .dsh-atb-mode-opt { cursor: not-allowed; opacity: .55; }
		.dsh-atb-iso-none { font-size: 12.5px; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-facts { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 8px; }
		.dsh-atb-iso-fact { font-size: 11.5px; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-fact b { font-weight: 600; color: var(--dsw-alias-state-business-primary, #3e63dd); }
		.dsh-atb-iso-commits { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
		.dsh-atb-iso-commit { display: flex; gap: 8px; font-size: 11.5px; align-items: baseline; }
		.dsh-atb-iso-commit code {
		  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
		  color: var(--dsh-alias-state-business-primary, #3e63dd); flex-shrink: 0;
		}
		.dsh-atb-iso-commit span { word-break: break-all; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-more { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-iso-nocommit { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, gray); margin-bottom: 8px; }
		.dsh-atb-iso-dirty {
		  font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5484d);
		  background: rgba(229,72,77,.09); border: 1px solid rgba(229,72,77,.35);
		  border-radius: 8px; padding: 6px 10px; margin-bottom: 8px;
		}
		.dsh-atb-iso-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.dsh-atb-iso-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }

		/* ---------- 0.3.0 diagnostics ---------- */
		.dsh-atb-diag { max-width: 520px; width: min(520px, 92vw); }
		.dsh-atb-diag-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
		.dsh-atb-diag-item {
		  display: flex; flex-direction: column; align-items: center; gap: 2px;
		  padding: 10px 6px; border-radius: 10px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04));
		}
		.dsh-atb-diag-item b { font-size: 18px; font-weight: 700; }
		.dsh-atb-diag-item span { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-diag-item[data-bad="true"] b { color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-diag-sec h4 { margin: 0 0 8px; font-size: 12.5px; }
		.dsh-atb-diag-orphans { display: flex; flex-direction: column; gap: 6px; }
		.dsh-atb-diag-orphan {
		  display: flex; align-items: center; gap: 10px; justify-content: space-between;
		  padding: 7px 10px; border-radius: 8px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		}
		.dsh-atb-diag-orphan-path { font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }

		/* ---------- 0.4.0 checklist ---------- */
		.dsh-atb-cke { display: flex; flex-direction: column; gap: 6px; }
		.dsh-atb-cke-row { display: flex; align-items: center; gap: 8px; }
		.dsh-atb-cke-box { flex-shrink: 0; width: 15px; height: 15px; cursor: pointer; }
		.dsh-atb-cke-text {
		  flex: 1; min-width: 0; font-size: 12.5px; padding: 6px 9px;
		  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
		  background: var(--dsw-alias-bg-layer-1, transparent); color: inherit;
		}
		.dsh-atb-cke-del {
		  flex-shrink: 0; border: none; background: none; cursor: pointer; padding: 4px;
		  color: var(--dsw-alias-label-tertiary, gray); font-size: 12px; border-radius: 6px;
		}
		.dsh-atb-cke-del:hover { color: var(--dsw-alias-state-error-primary, #e5484d); background: rgba(229,72,77,.08); }
		.dsh-atb-cke-add {
		  align-self: flex-start; border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4));
		  background: none; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer;
		  font-size: 11.5px; padding: 5px 12px; border-radius: 8px;
		}
		.dsh-atb-cke-add:hover { color: var(--dsw-alias-state-business-primary, #3e63dd); border-color: var(--dsw-alias-state-business-primary, #3e63dd); }
		.dsh-atb-cke-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }

		.dsh-atb-cl-progress { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-cl-progress[data-tone="bad"] { color: var(--dsw-alias-state-error-primary, #e5484d); font-weight: 600; }
		.dsh-atb-cl-items { display: flex; flex-direction: column; gap: 5px; }
		.dsh-atb-cl-item {
		  display: flex; align-items: baseline; gap: 9px; padding: 6px 9px; border-radius: 8px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.03)); cursor: pointer;
		}
		.dsh-atb-cl-item:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.4)); }
		.dsh-atb-cl-item input { flex-shrink: 0; transform: translateY(1px); cursor: pointer; }
		.dsh-atb-cl-item[data-checked="true"] .dsh-atb-cl-text { text-decoration: line-through; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-cl-item[data-alert="true"] {
		  border-color: rgba(229,72,77,.45); background: rgba(229,72,77,.06);
		}
		.dsh-atb-cl-text { flex: 1; min-width: 0; font-size: 12.5px; word-break: break-word; }
		.dsh-atb-cl-meta { flex-shrink: 0; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); display: flex; flex-direction: column; gap: 2px; align-items: flex-end; }
		.dsh-atb-cl-note { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, inherit); }

		/* ---------- 0.4.0 report ---------- */
		.dsh-atb-rpt-summary { font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
		.dsh-atb-rpt-sec { margin-bottom: 8px; }
		.dsh-atb-rpt-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); margin-bottom: 4px; }
		.dsh-atb-rpt-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.55; word-break: break-all; }
		.dsh-atb-rpt-risk {
		  font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
		  color: var(--dsw-alias-state-warn-primary, #f5a524);
		  background: rgba(245,165,36,.08); border: 1px solid rgba(245,165,36,.3);
		  border-radius: 8px; padding: 6px 10px;
		}

		/* ---------- 0.4.0 diff viewer ---------- */
		.dsh-atb-iso-commit { display: flex; flex-direction: column; gap: 3px; }
		.dsh-atb-iso-commit-btn {
		  display: flex; gap: 8px; font-size: 11.5px; align-items: baseline; text-align: left;
		  border: none; background: none; padding: 2px 4px; margin: 0 -4px; border-radius: 6px; cursor: pointer;
		  color: inherit; width: fit-content; max-width: 100%;
		}
		.dsh-atb-iso-commit-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }
		.dsh-atb-iso-commit-btn code {
		  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
		  color: var(--dsw-alias-state-business-primary, #3e63dd); flex-shrink: 0;
		}
		.dsh-atb-iso-commit-btn span { word-break: break-all; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-commit[data-open="true"] > .dsh-atb-iso-commit-btn code { font-weight: 700; }
		.dsh-atb-iso-dirty { display: flex; flex-direction: column; gap: 6px;
		  font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5484d);
		  background: rgba(229,72,77,.09); border: 1px solid rgba(229,72,77,.35);
		  border-radius: 8px; padding: 6px 10px; margin-bottom: 8px;
		}
		.dsh-atb-iso-dirty-toggle { border: none; background: none; cursor: pointer; padding: 0; text-align: left; color: inherit; font-size: inherit; }
		.dsh-atb-iso-dirty-files { display: flex; flex-direction: column; gap: 2px; }
		.dsh-atb-iso-dirty-file {
		  border: none; background: none; cursor: pointer; text-align: left; padding: 1px 2px;
		  font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); border-radius: 4px; word-break: break-all;
		}
		.dsh-atb-iso-dirty-file:hover { background: rgba(128,128,128,.1); color: var(--dsw-alias-state-business-primary, #3e63dd); }
		.dsh-atb-iso-dirty-file code { font-family: ui-monospace, Consolas, monospace; font-size: 10px; margin-right: 6px; }
		.dsh-atb-diffview { margin-top: 6px; border-radius: 8px; overflow: hidden;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
		.dsh-atb-diffview-head { display: flex; align-items: center; gap: 10px; padding: 5px 10px;
		  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }
		.dsh-atb-diffview-title { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
		  color: var(--dsw-alias-state-business-primary, #3e63dd); word-break: break-all; }
		.dsh-atb-diffview-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-diffview-error { padding: 8px 10px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-diffview-pre {
		  margin: 0; padding: 8px 10px; max-height: 340px; overflow: auto;
		  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; line-height: 1.5;
		  white-space: pre; color: var(--dsw-alias-label-secondary, inherit);
		}

		/* ---------- 0.4.0 new-task menu + template manager + import ---------- */
		.dsh-atb-newmenu { position: relative; display: inline-flex; }
		.dsh-atb-newmenu-backdrop { position: fixed; inset: 0; z-index: 40; }
		.dsh-atb-newmenu-list {
		  position: absolute; top: calc(100% + 4px); left: 0; z-index: 41; min-width: 180px;
		  display: flex; flex-direction: column; padding: 5px; border-radius: 10px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
		}
		.dsh-atb-newmenu-opt {
		  border: none; background: none; text-align: left; cursor: pointer; padding: 7px 10px;
		  font-size: 12.5px; color: inherit; border-radius: 7px; white-space: nowrap;
		}
		.dsh-atb-newmenu-opt:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); }
		.dsh-atb-newmenu-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }

		.dsh-atb-tplm { max-width: 600px; width: min(600px, 92vw); }
		.dsh-atb-tplm .dsh-atb-modal-body,
		.dsh-atb-set .dsh-atb-modal-body,
		.dsh-atb-diag .dsh-atb-modal-body,
		.dsh-atb-imp .dsh-atb-modal-body {
		  display: flex; flex-direction: column; gap: 10px;
		}
		.dsh-atb-tplm-list { display: flex; flex-direction: column; gap: 8px; width: 100%; }
		.dsh-atb-tplm-row {
		  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: 8px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.02));
		}
		.dsh-atb-tplm-name {
		  flex: 0 0 150px; width: 150px; max-width: 150px; font-size: 12.5px; padding: 5px 8px; border-radius: 7px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
		  background: var(--dsw-alias-bg-layer-1, transparent); color: inherit;
		  box-sizing: border-box;
		}
		.dsh-atb-tplm-meta {
		  flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, gray);
		  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.dsh-atb-tplm-btns { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

		.dsh-atb-imp { max-width: 600px; width: min(600px, 92vw); }
		.dsh-atb-imp-picker { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
		.dsh-atb-imp-picker input[type="file"] { font-size: 12px; }
		.dsh-atb-imp-filename { font-size: 11.5px; color: var(--dsw-alias-state-business-primary, #3e63dd); word-break: break-all; }
		.dsh-atb-imp-note { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); margin-bottom: 10px; }
		.dsh-atb-imp-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #e5484d); margin-bottom: 8px; }
		.dsh-atb-imp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
		.dsh-atb-imp-stat {
		  display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 9px 6px; border-radius: 9px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		}
		.dsh-atb-imp-stat b { font-size: 17px; font-weight: 700; }
		.dsh-atb-imp-stat span { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-imp-stat[data-tone="ok"] b { color: var(--dsw-alias-state-success-primary, #30a46c); }
		.dsh-atb-imp-stat[data-tone="warn"] b { color: var(--dsw-alias-state-warn-primary, #f5a524); }
		.dsh-atb-imp-stat[data-tone="bad"] b { color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-imp-sec h4 { margin: 0 0 6px; font-size: 12px; }
		.dsh-atb-imp-sec { margin-bottom: 10px; }
		.dsh-atb-imp-list { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; }
		.dsh-atb-imp-row {
		  display: flex; align-items: center; gap: 10px; justify-content: space-between;
		  padding: 5px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));
		}
		.dsh-atb-imp-row[data-tone="bad"] { border-color: rgba(229,72,77,.35); }
		.dsh-atb-imp-row-title { font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dsh-atb-imp-row-status { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); flex-shrink: 0; }
		.dsh-atb-imp-result { font-size: 12px; color: var(--dsw-alias-state-success-primary, #30a46c); margin-top: 10px; }
		.dsh-atb-badge[data-kind="checklist"] { color: var(--dsw-alias-label-secondary, inherit); }
		/* ---------- 0.5.0 board settings ---------- */
		.dsh-atb-set { max-width: 460px; width: min(460px, 92vw); }
		.dsh-atb-set .dsh-atb-mode-picker { margin-top: 8px; }
		.dsh-atb-set .dsh-atb-isolation-note { margin-top: 10px; }

		/* ---------- 0.5.5 SlashPromptInput & Permission Picker ---------- */
		.dsh-atb-perm-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 4px; }
		.dsh-atb-perm-opt {
		  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
		  padding: 8px 10px; border-radius: 9px; cursor: pointer; text-align: left;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: inherit;
		  transition: border-color .12s ease, background .12s ease;
		}
		.dsh-atb-perm-name { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
		.dsh-atb-perm-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); line-height: 1.35; }
		.dsh-atb-perm-opt:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }
		.dsh-atb-perm-opt[data-on="true"] {
		  border-color: var(--dsw-alias-brand-primary, #1f2328);
		  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 9%, transparent);
		}

		.dsh-atb-prompt-wrap {
		  display: flex; flex-direction: column; gap: 6px; position: relative; width: 100%;
		  border-radius: 9px; transition: border-color .12s ease;
		}
		.dsh-atb-prompt-wrap[data-drag-over="true"] {
		  outline: 2px dashed var(--dsw-alias-brand-primary, #1f2328);
		  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 6%, transparent);
		}
		.dsh-atb-prompt-inner { position: relative; width: 100%; }
		.dsh-atb-prompt-input {
		  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.5;
		  padding: 7px 10px; border-radius: 8px; resize: vertical; min-height: 68px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: var(--dsw-specific-input-major, transparent); color: var(--dsw-alias-label-primary, inherit);
		}
		.dsh-atb-prompt-input:focus {
		  outline: none; border-color: var(--dsw-alias-brand-primary, #1f2328);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 18%, transparent);
		}

		/* Slash Autocomplete Popup */
		.dsh-atb-slash-popup {
		  position: absolute; left: 0; bottom: calc(100% + 6px); width: 100%; max-height: 240px; z-index: 100;
		  display: flex; flex-direction: column; overflow: hidden; border-radius: 10px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
		  box-shadow: var(--dsw-shadow-lv3, 0 10px 28px rgba(0,0,0,.22));
		}
		.dsh-atb-slash-head {
		  display: flex; align-items: center; justify-content: space-between;
		  padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.15));
		  background: var(--dsw-alias-bg-elevated, rgba(128,128,128,.06));
		}
		.dsh-atb-slash-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, gray); }
		.dsh-atb-slash-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-slash-list { overflow-y: auto; max-height: 200px; display: flex; flex-direction: column; padding: 4px; }
		.dsh-atb-slash-item {
		  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
		  cursor: pointer; font-size: 12px; transition: background .1s ease;
		}
		.dsh-atb-slash-item[data-active="true"], .dsh-atb-slash-item:hover {
		  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));
		}
		.dsh-atb-slash-badge {
		  font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
		}
		.dsh-atb-slash-badge[data-kind="command"] { background: rgba(217,130,43,.15); color: #d9822b; }
		.dsh-atb-slash-badge[data-kind="skill"] { background: rgba(142,78,198,.15); color: #a06ce0; }
		.dsh-atb-slash-name { font-weight: 600; font-family: monospace; font-size: 12.5px; }
		.dsh-atb-slash-param { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); font-family: monospace; }
		.dsh-atb-slash-desc { font-size: 11px; color: var(--dsw-alias-label-secondary, gray); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }

		/* Prompt Foot Toolbar */
		.dsh-atb-prompt-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.dsh-atb-prompt-tip { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-prompt-tip code { font-size: 10.5px; padding: 1px 4px; border-radius: 4px; background: rgba(128,128,128,.14); }
		`;
		/** Style element id (stable since 0.1.x: hook for tests and debugging). */
		const STYLE_ID = "dsh-taskboard-styles";
		/**
		* Ownership tag for the shell's client-module bookkeeping. The web shell
		* claims every UNTAGGED `<style>` for whichever plugin module materializes
		* next (claimStyles in dsh-client-modules), and the client HMR driver
		* deletes `<style>` tags by this attribute on every rebuilt entry
		* (removeOwnedStyles in dsh-client-hmr).
		*/
		const PLUGIN_ID = "dsh-taskboard";
		/** Per-stylesheet identity, mirroring the shell's own data-plugin-css. */
		const CSS_TAG = "dsh-taskboard/styles";
		/**
		* Ensure the stylesheet lives in <head>: create when absent, re-attach when
		* removed, always carry the ownership tags.
		*
		* 0.4.4 fix (field report: CSS randomly dropped, board renders as unstyled
		* HTML until refresh): injection runs from cordis apply(), which resolves
		* AFTER this module's materialization, so the old untagged <style> could be
		* claimed by ANY sibling plugin module that materialized later (observed
		* with lazily-materializing profile bundles). That sibling's next HMR
		* rebuild then deleted OUR stylesheet, and the old module-level `injected`
		* flag blocked re-injection until a full page refresh. Pre-tagging pins
		* ownership to this plugin: sibling claims skip tagged styles, and only
		* THIS plugin's rebuild removes it — the fresh apply re-injects. Idempotency
		* is DOM-based for the same reason: a module flag cannot see removals,
		* getElementById can. A found element is re-tagged too, so a leftover
		* pre-0.4.4 element adopted across a hot swap heals its ownership.
		*/
		function injectStyles() {
			if (typeof document === "undefined") return;
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLES;
				document.head.append(style);
			}
			style.dataset.plugin = PLUGIN_ID;
			style.dataset.pluginCss = CSS_TAG;
		}

		//#endregion
		//#region src/client/sidebar-entry.ts
		/** Stable data attribute identifying this entry row. */
		const ENTRY_SELECTOR = "[data-dsh-atb-entry]";
		/** Inline icon: a three-lane kanban board (16px nav-icon look). */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M6 2v12M10 2v12\"/></svg>";
		/**
		* Find the sidebar shell root element, or undefined while not yet mounted.
		* Triple-generation matching (0.5.2): the dev shell's data-pane pane, the
		* official layout's CSS-Module sidebarCol, and DSH Desktop's non-compat
		* (extended) frame — which disables the official ui-layout row and owns
		* the columns itself (aside.dshDesktopSidebarSurface >
		* div.dshDesktopUpstreamSidebar wrapping the unchanged official sidebar).
		* logoRow-owner resolution is identical on all three generations.
		*/
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/**
		* The New Session button: nested in the logo row on current shells, a direct
		* child BUTTON on the real shell (the family plugins' fallback), with
		* aria-label/text fallbacks for other shells. The direct-child scan skips
		* our own entry (0.4.1): on shells where the insertion anchor lands inside a
		* class-carrying container, a self-referential anchor would pin the entry
		* against that container's own geometry instead of the family block.
		*/
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child instanceof HTMLButtonElement && !child.matches("[data-dsh-atb-entry]")) return child;
			const byAria = root.querySelector("button[aria-label=\"新建会话\"], button[aria-label=\"New Session\"], button[aria-label*=\"新会话\"], button[aria-label*=\"new session\" i]");
			if (byAria !== null) return byAria;
			return Array.from(root.querySelectorAll("button")).find((button) => !button.matches("[data-dsh-atb-entry]") && /新会话|新建会话|new session/i.test(button.textContent ?? ""));
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshAtbEntry = "";
			entry.className = "dsh-atb-entry";
			entry.setAttribute("aria-label", translate("shared.entry.aria"));
			entry.innerHTML = `<span class="dsh-atb-entry-icon">${ICON}</span><span class="dsh-atb-entry-label">${translate("shared.entry.label")}</span><span class="dsh-atb-entry-stats"></span>`;
			entry.addEventListener("click", () => {
				controller.toggleBoard();
			});
			return entry;
		}
		/**
		* Live status counts shown at the right of the entry row:
		* `[todo, in_progress, in_review]` (trashed tasks excluded).
		*/
		function entryStats(controller) {
			let todo = 0;
			let inProgress = 0;
			let inReview = 0;
			for (const task of controller.getSnapshot().ledger.tasks) {
				if (task.trashedAt !== void 0) continue;
				if (task.status === "todo") todo++;
				else if (task.status === "in_progress") inProgress++;
				else if (task.status === "in_review") inReview++;
			}
			return [
				todo,
				inProgress,
				inReview
			];
		}
		/**
		* Set one rolling-number slot. Unchanged values no-op; changes animate the
		* old value out and the new value in with a vertical scroll (up when the
		* count grows, down when it shrinks). Plain DOM, no React.
		*/
		function setRollValue(slot, value) {
			const text = String(value);
			if (slot.dataset.value === text) return;
			const previous = slot.dataset.value;
			slot.dataset.value = text;
			slot.style.minWidth = `${text.length}ch`;
			if (previous === void 0) {
				slot.textContent = text;
				return;
			}
			if (slot.dataset.busy === "1") {
				slot.dataset.busy = "";
				slot.dataset.anim = "";
			}
			const oldEl = document.createElement("span");
			oldEl.className = "dsh-atb-rn";
			oldEl.textContent = previous;
			const newEl = document.createElement("span");
			newEl.className = "dsh-atb-rn dsh-atb-rn-next";
			newEl.textContent = text;
			slot.replaceChildren(oldEl, newEl);
			slot.dataset.dir = value > Number(previous) ? "up" : "down";
			slot.dataset.busy = "1";
			requestAnimationFrame(() => {
				slot.dataset.anim = "1";
			});
			const finish = () => {
				if (slot.dataset.busy !== "1") return;
				slot.dataset.busy = "";
				slot.dataset.anim = "";
				slot.textContent = slot.dataset.value ?? "";
			};
			slot.addEventListener("transitionend", finish, { once: true });
			setTimeout(finish, 400);
		}
		/**
		* Wire the stats strip into the entry: builds the three slots and keeps them
		* (plus the tooltip) in sync with every controller emit.
		* @returns the update function (also called once immediately).
		*/
		function wireStats(entry, controller) {
			const stats = entry.querySelector(".dsh-atb-entry-stats");
			if (stats === null) return () => {};
			const statKeys = [
				"todo",
				"in_progress",
				"in_review"
			];
			const slots = [];
			for (let i = 0; i < 3; i++) {
				if (i > 0) {
					const sep = document.createElement("span");
					sep.className = "dsh-atb-entry-sep";
					sep.textContent = "|";
					stats.append(sep);
				}
				const slot = document.createElement("span");
				slot.className = "dsh-atb-roll";
				slot.dataset.stat = statKeys[i];
				stats.append(slot);
				slots.push(slot);
			}
			const update = () => {
				const [todo, inProgress, inReview] = entryStats(controller);
				setRollValue(slots[0], todo);
				setRollValue(slots[1], inProgress);
				setRollValue(slots[2], inReview);
				stats.title = translate("shared.stats.title", {
					todo,
					doing: inProgress,
					review: inReview
				});
			};
			return update;
		}
		/** Re-insert the entry after the New Session row (before the browser region). */
		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches("[data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]"));
				const anchor = family.length > 0 ? family[0] ?? null : base.nextElementSibling ?? null;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param controller - the board controller the entry toggles.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(controller) {
			const entry = createEntry(controller);
			const debug = {
				attempts: 0,
				found: false,
				placed: false
			};
			const host = globalThis.location?.hostname;
			if (host === "localhost" || host === "127.0.0.1") window.__atbDebug = debug;
			let root;
			let placed = false;
			const tryPlace = () => {
				debug.attempts++;
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				debug.found = newSessionButton(root) !== void 0;
				placed = placeEntry(root, entry);
				debug.placed = placed;
				if (placed) rootObserver.observe(root, {
					childList: true,
					subtree: true
				});
			};
			const waitObserver = new MutationObserver(() => {
				tryPlace();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected) {
					placed = false;
					tryPlace();
					return;
				}
				if (!root.contains(entry)) placed = placeEntry(root, entry);
			});
			const retry = setInterval(() => {
				tryPlace();
			}, 2e3);
			const syncStats = wireStats(entry, controller);
			const syncActive = () => {
				if (controller.getSnapshot().boardOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
				syncStats();
			};
			const unsubscribe = controller.subscribe(syncActive);
			const unsubscribeLocale = localeStore.subscribe(() => {
				entry.setAttribute("aria-label", translate("shared.entry.aria"));
				const label = entry.querySelector(".dsh-atb-entry-label");
				if (label !== null) label.textContent = translate("shared.entry.label");
				syncStats();
			});
			syncActive();
			tryPlace();
			return () => {
				clearInterval(retry);
				waitObserver.disconnect();
				rootObserver.disconnect();
				unsubscribeLocale();
				unsubscribe();
				entry.remove();
			};
		}

		//#endregion
		//#region src/shared/version.ts
		/**
		* The plugin package version shown in the board UI. Kept in sync with
		* package.json by a regression test (tests lock drift).
		*
		* @module dsh-taskboard/shared/version
		*/
		/** The package version (must equal package.json "version"). */
		const PLUGIN_VERSION = "0.6.0";

		//#endregion
		//#region src/client/board/labels.ts
		/** Column header keys on the five-column main board (+ secondary tab). */
		const COLUMN_KEYS = {
			backlog: "status.column.backlog",
			todo: "status.column.todo",
			in_progress: "status.column.in_progress",
			in_review: "status.column.in_review",
			done: "status.column.done",
			canceled: "status.column.canceled",
			archived: "status.column.archived"
		};
		/** Status pill keys (detail pane) — historical wording kept verbatim:
		*  terminal states read short here, the column headers carry the full forms. */
		const STATUS_KEYS = {
			backlog: "status.pill.backlog",
			todo: "status.pill.todo",
			in_progress: "status.pill.in_progress",
			in_review: "status.pill.in_review",
			done: "status.pill.done",
			canceled: "status.pill.canceled",
			archived: "status.pill.archived"
		};
		/** Move-button verb keys (shorter than the pill text). */
		const MOVE_KEYS = {
			backlog: "status.move.backlog",
			todo: "status.move.todo",
			in_progress: "status.move.in_progress",
			in_review: "status.move.in_review",
			done: "status.move.done",
			canceled: "status.move.canceled",
			archived: "status.move.archived"
		};
		/** Urgency chip keys. */
		const URGENCY_KEYS = {
			urgent: "urgency.urgent",
			normal: "urgency.normal",
			relaxed: "urgency.relaxed"
		};
		/** Execution outcome keys. */
		const OUTCOME_KEYS = {
			running: "outcome.running",
			succeeded: "outcome.succeeded",
			failed: "outcome.failed",
			cancelled: "outcome.cancelled"
		};

		//#endregion
		//#region src/client/board/format.ts
		/** Format an epoch ms as a short local stamp. */
		function fmtTime(ms) {
			if (ms === void 0) return "";
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** A claim idle for longer than this is highlighted as stale (ms). */
		const STALE_CLAIM_MS = 30 * 6e4;
		/** Whether the task's claim is stale (in_progress, held, idle too long). */
		function isStaleClaim(task, now) {
			return task.status === "in_progress" && task.claimedAt !== void 0 && now - task.claimedAt > 18e5;
		}

		//#endregion
		//#region src/client/board/TaskCard.tsx
		/**
		* One board card: urgency edge, title, project/urgency/model/schedule/
		* blocked/trashed badges, comment count, and the last execution outcome.
		* Click opens the detail pane; cards in the backlog/todo columns are
		* draggable between those two columns (HTML5 drag & drop). Cards sitting
		* in the in_review column also carry quick-review actions (✓ complete /
		* ✗ send back with an optional note).
		*
		* The root is a div[role=button] (not a <button>) so the quick actions can
		* be real nested buttons — valid HTML and native keyboard activation.
		*
		* @module dsh-taskboard/client/board/TaskCard
		*/
		/** dataTransfer type carrying the dragged task id. */
		const DRAG_TYPE = "application/x-dsh-atb-task";
		/** Compact session-id display (execution sessions carry the taskboard infix). */
		function shortId$1(id) {
			if (id === void 0) return "";
			return id.replace(/^session-(taskboard-)?/, "").slice(0, 8);
		}
		/**
		* The card view.
		* @param task - the task record.
		* @param controller - the controller.
		* @param draggable - enable dragging.
		* @param now - current epoch ms (stale-claim highlight).
		* @param onAlert - show an alert message (replaces native alert).
		*/
		function TaskCard({ task, controller, draggable = false, now, onAlert }) {
			const t = useT();
			const [rejectOpen, setRejectOpen] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)("");
			const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : void 0;
			const running = task.executions.find((ex) => ex.outcome === "running");
			const stale = now !== void 0 && isStaleClaim(task, now);
			const reviewing = task.status === "in_review" && task.trashedAt === void 0;
			const sessionExecution = [...task.executions].reverse().find((ex) => ex.sessionId !== void 0);
			const targetSessionId = running?.sessionId ?? sessionExecution?.sessionId ?? (task.claimedBy?.startsWith("session-") ? task.claimedBy : void 0);
			/** Submit the quick-reject: one atomic route (move + optional note). */
			const submitReject = () => {
				controller.reject(task.id, task.version, note).then((ok) => {
					if (ok) {
						setRejectOpen(false);
						setNote("");
					}
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "button",
				tabIndex: 0,
				className: "dsh-atb-card",
				"data-urgency": task.urgency,
				draggable: draggable && !rejectOpen,
				onDragStart: (e) => {
					if (running !== void 0) {
						e.preventDefault();
						const msg = t("card.drag.running", { title: task.title });
						if (onAlert !== void 0) onAlert(msg);
						else alert(msg);
						return;
					}
					e.dataTransfer.setData(DRAG_TYPE, task.id);
					e.dataTransfer.effectAllowed = "move";
					e.currentTarget.dataset.dragging = "true";
				},
				onDragEnd: (e) => {
					delete e.currentTarget.dataset.dragging;
				},
				onClick: () => controller.select(task.id),
				onKeyDown: (e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						controller.select(task.id);
					}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-card-title",
						children: task.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-card-meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								children: t(URGENCY_KEYS[task.urgency])
							}),
							task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "blocked",
								children: t("shared.blocked")
							}),
							stale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "stale",
								children: t("card.badge.stale")
							}),
							task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-badge",
								"data-kind": "scheduled",
								children: ["⏰ ", fmtTime(task.execution.nextRunAt)]
							}),
							task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-badge",
								title: t("card.badge.modelTitle", { model: task.model.provider + "/" + task.model.model }) + (task.model.reasoningEffort !== void 0 ? t("card.badge.modelEffort", { effort: task.model.reasoningEffort }) : ""),
								children: [task.model.model, task.model.reasoningEffort !== void 0 ? ` (${task.model.reasoningEffort})` : ""]
							}),
							task.permission === "read-only" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "blocked",
								title: t("card.badge.permReadOnlyTitle"),
								children: t("card.badge.permReadOnly")
							}),
							task.permission === "danger-full-access" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "urgent",
								title: t("card.badge.permFullTitle"),
								children: t("card.badge.permFull")
							}),
							task.checklist !== void 0 && task.checklist.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-badge",
								"data-kind": task.status === "in_review" && task.checklist.some((i) => !i.checked) ? "blocked" : "checklist",
								title: task.status === "in_review" && task.checklist.some((i) => !i.checked) ? t("card.badge.checklistReview") : t("card.badge.checklist"),
								children: [
									"☑ ",
									task.checklist.filter((i) => i.checked).length,
									"/",
									task.checklist.length
								]
							}),
							task.status === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "done",
								children: t("status.pill.done")
							}),
							last !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": last.outcome === "running" ? "running" : last.outcome,
								children: t(OUTCOME_KEYS[last.outcome] ?? last.outcome)
							}),
							targetSessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-card-session",
								title: t("card.session.jumpTitle", { id: targetSessionId }),
								onClick: (e) => {
									e.stopPropagation();
									controller.openSession(targetSessionId).then((result) => {
										if (result === "missing") {
											const msg = t("card.session.missing", { id: shortId$1(targetSessionId) });
											if (onAlert !== void 0) onAlert(msg);
											else alert(msg);
										} else if (result === "archived") {
											const msg = t("card.session.archived", { id: shortId$1(targetSessionId) });
											if (onAlert !== void 0) onAlert(msg);
											else alert(msg);
										} else if (result === "unavailable") {
											const msg = t("card.session.unavailable", { id: targetSessionId });
											if (onAlert !== void 0) onAlert(msg);
											else alert(msg);
										}
									});
								},
								children: [
									"🤖 ",
									shortId$1(targetSessionId),
									" ↗"
								]
							}),
							task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["💬 ", task.comments.length] }),
							task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "trashed",
								children: t("card.badge.pendingPurge")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { marginLeft: "auto" },
								children: fmtTime(task.updatedAt)
							})
						]
					}),
					reviewing && (rejectOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-quick-reject",
						onClick: (e) => e.stopPropagation(),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsh-atb-input dsh-atb-quick-note",
								value: note,
								placeholder: t("card.reject.placeholder"),
								autoFocus: true,
								spellCheck: false,
								onChange: (e) => setNote(e.target.value),
								onKeyDown: (e) => {
									if (e.key === "Enter") submitReject();
									else if (e.key === "Escape") {
										setRejectOpen(false);
										setNote("");
									}
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-quickbtn",
								"data-act": "reject-confirm",
								onClick: submitReject,
								children: t("card.reject.confirm")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-quickbtn",
								"data-act": "reject-cancel",
								onClick: () => {
									setRejectOpen(false);
									setNote("");
								},
								children: t("shared.cancel")
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-quick",
						onClick: (e) => e.stopPropagation(),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-quickbtn",
							"data-act": "done",
							title: t("card.action.doneTitle"),
							onClick: () => void controller.move(task.id, task.version, "done"),
							children: t("card.action.done")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-quickbtn",
							"data-act": "reject",
							title: t("card.action.rejectTitle"),
							onClick: () => setRejectOpen(true),
							children: t("card.action.reject")
						})]
					}))
				]
			});
		}

		//#endregion
		//#region src/client/board/AlertModal.tsx
		/**
		* A lightweight alert modal — replaces native alert() with a themed overlay
		* that matches the shell design tokens.
		*
		* @module dsh-taskboard/client/board/AlertModal
		*/
		/** Show a non-blocking alert modal. Returns true when opened. */
		function useAlert() {
			const [msg, setMsg] = (0, react.useState)(null);
			const show = (m) => setMsg(m);
			const close = () => setMsg(null);
			return {
				alert: show,
				el: msg !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlertModal, {
					message: msg,
					onClose: close
				}) : null
			};
		}
		function AlertModal({ message, onClose }) {
			const t = useT();
			(0, react.useEffect)(() => {
				const handler = (e) => {
					if (e.key === "Escape") onClose();
				};
				window.addEventListener("keydown", handler);
				return () => window.removeEventListener("keydown", handler);
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-alert-backdrop",
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-alert",
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-alert-icon",
							children: "⛔"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-alert-msg",
							children: message
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-primary": "true",
							onClick: onClose,
							children: t("alert.ok")
						})
					]
				})
			});
		}

		//#endregion
		//#region src/client/board/TaskDetail.tsx
		/**
		* The task detail pane — visually polished: urgency accent header with
		* status pill and meta chips, card-wrapped description/prompt, chat-style
		* comment bubbles distinguishing user vs agent authors, a timeline of
		* executions with outcome pills, grouped actions (run / transitions /
		* danger zone), and the user comment composer.
		*
		* @module dsh-taskboard/client/board/TaskDetail
		*/
		/** Statuses a user may move this task to, per the state machine. */
		function moveTargets(task) {
			return [
				"backlog",
				"todo",
				"in_progress",
				"in_review",
				"done",
				"canceled",
				"archived"
			].filter((to) => canTransition(task.status, to));
		}
		/** Compact session-id display (execution sessions carry the taskboard infix). */
		function shortId(id) {
			if (id === void 0) return "";
			return id.replace(/^session-(taskboard-)?/, "").slice(0, 8);
		}
		/** Execution duration between start and end. */
		function duration(startedAt, endedAt) {
			if (startedAt === void 0 || endedAt === void 0) return "";
			const s = Math.max(0, Math.round((endedAt - startedAt) / 1e3));
			if (s < 60) return `${s}s`;
			if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
			return `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`;
		}
		/** Small labelled meta chip. */
		function Chip({ icon, children, tone, title }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-atb-chip2",
				"data-tone": tone,
				title,
				children: [icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-atb-chip2-icon",
					children: icon
				}), children]
			});
		}
		/** Render markdown text with embedded clickable images and lightbox preview. */
		function MarkdownContent({ text }) {
			const t = useT();
			const [lightboxUrl, setLightboxUrl] = (0, react.useState)(null);
			const regex = /!\[(.*?)\]\(((?:data:image\/[^)]+)|(?:https?:\/\/[^)]+)|(?:[^)]+\.(?:png|jpg|jpeg|gif|webp|svg)))\)/gi;
			const parts = [];
			let lastIndex = 0;
			let match;
			let count = 0;
			while ((match = regex.exec(text)) !== null) {
				if (match.index > lastIndex) parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text.slice(lastIndex, match.index) }, `txt-${lastIndex}`));
				const alt = match[1] || t("md.imageAlt", { n: ++count });
				const url = match[2] ?? "";
				parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-detail-img-wrap",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
						src: url,
						alt,
						className: "dsh-atb-detail-img",
						onClick: () => setLightboxUrl(url),
						title: t("md.imageTitle", { alt })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-atb-detail-img-caption",
						children: alt
					})]
				}, `img-${match.index}`));
				lastIndex = regex.lastIndex;
			}
			if (lastIndex < text.length) parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text.slice(lastIndex) }, `txt-${lastIndex}`));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-markdown-body",
				children: parts
			}), lightboxUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-lightbox-backdrop",
				onClick: () => setLightboxUrl(null),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-lightbox-content",
					onClick: (e) => e.stopPropagation(),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
						src: lightboxUrl,
						alt: t("md.lightboxAlt"),
						className: "dsh-atb-lightbox-img"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-atb-lightbox-close",
						title: t("md.closePreview"),
						onClick: () => setLightboxUrl(null),
						children: "✕"
					})]
				})
			})] });
		}
		/** The most recent execution carrying isolation facts, newest first. */
		function latestIsolated(task) {
			return [...task.executions].reverse().find((e) => e.isolation !== void 0 || e.worktreePath !== void 0 || e.isolationNote !== void 0);
		}
		/** Short commit hash for display. */
		function shortHash(hash) {
			return hash === void 0 ? "" : hash.slice(0, 8);
		}
		/** Extract the path from one `git status --porcelain` line (rename-aware). */
		function porcelainPath(line) {
			let p = line.slice(3);
			const arrow = p.indexOf(" -> ");
			if (arrow >= 0) p = p.slice(arrow + 4);
			if (p.startsWith("\"") && p.endsWith("\"") && p.length > 1) p = p.slice(1, -1);
			return p;
		}
		/**
		* Lazy diff viewer (0.4.0): loads on mount, renders inside a capped <pre>.
		* @param spec - what to show: one commit hash, or one changed path.
		*/
		function DiffView({ controller, task, execution, commit, path }) {
			const t = useT();
			const [state, setState] = (0, react.useState)({ loading: true });
			(0, react.useEffect)(() => {
				let alive = true;
				setState({ loading: true });
				controller.fetchDiff(task.id, {
					execution: execution.id,
					...commit !== void 0 ? { commit } : { path: path ?? "" }
				}).then((result) => {
					if (!alive) return;
					if (result === void 0) setState({
						loading: false,
						failed: true
					});
					else setState({
						loading: false,
						diff: result.diff,
						truncated: result.truncated
					});
				});
				return () => {
					alive = false;
				};
			}, [
				controller,
				task.id,
				execution.id,
				commit,
				path
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-diffview",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-diffview-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-diffview-title",
							children: commit !== void 0 ? t("diff.commit", { hash: shortHash(commit) }) : t("diff.file", { path: path ?? "" })
						}),
						state.loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-diffview-hint",
							children: t("shared.loading")
						}),
						state.truncated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-diffview-hint",
							children: t("diff.truncated")
						})
					]
				}), state.failed === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-diffview-error",
					children: t("diff.failed")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: "dsh-atb-diffview-pre",
					children: state.diff ?? ""
				})]
			});
		}
		/**
		* The DoD checklist block (0.4.0): user-togglable items, checker + evidence
		* per row; unchecked items highlight while the task sits in in_review.
		*/
		function ChecklistBlock({ task, controller }) {
			const t = useT();
			const items = task.checklist ?? [];
			if (items.length === 0) return null;
			const { done, total } = checklistProgress(task);
			const unchecked = total - done;
			const reviewing = task.status === "in_review";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "checklist",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-fieldcard-label",
					children: [t("checklist.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsh-atb-cl-progress",
						"data-tone": reviewing && unchecked > 0 ? "bad" : void 0,
						children: [
							"☑ ",
							done,
							"/",
							total,
							reviewing && unchecked > 0 ? t("checklist.unchecked", { n: unchecked }) : done === total ? t("checklist.allDone") : ""
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-cl-items",
					children: items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "dsh-atb-cl-item",
						"data-checked": item.checked ? "true" : void 0,
						"data-alert": reviewing && !item.checked ? "true" : void 0,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: item.checked,
								onChange: () => void controller.toggleChecklistItem(task, item.id)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-cl-text",
								children: item.text
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-cl-meta",
								children: [item.checked ? `${item.checkedBy === "user" ? t("checklist.byUser") : `🤖 ${shortId(item.checkedBy)}`} · ${fmtTime(item.checkedAt)}` : t("checklist.uncheckedItem"), item.note !== void 0 && item.note.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-cl-note",
									title: item.note,
									children: t("checklist.evidence", { note: item.note })
								})]
							})
						]
					}, item.id))
				})]
			});
		}
		/**
		* The structured execution report block (0.4.0): the newest execution that
		* carries one, rendered section by section for the reviewer.
		*/
		function ReportBlock({ task }) {
			const t = useT();
			const execution = [...task.executions].reverse().find((e) => e.report !== void 0);
			const report = execution?.report;
			if (execution === void 0 || report === void 0) return null;
			const section = (label, rows) => rows !== void 0 && rows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-rpt-sec",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-rpt-label",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "dsh-atb-rpt-list",
					children: rows.map((row, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: row }, i))
				})]
			}) : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "report",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard-label",
						children: [t("report.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-cl-progress",
							children: t("report.submitted", { time: fmtTime(execution.endedAt ?? execution.startedAt) })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-rpt-summary",
						children: report.summary
					}),
					section(t("report.changedFiles"), report.changedFiles),
					section(t("report.checks"), report.checks),
					section(t("report.artifacts"), report.artifacts),
					report.risk.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-rpt-sec",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-rpt-label",
							children: t("report.risk")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-rpt-risk",
							children: report.risk
						})]
					})
				]
			});
		}
		/**
		* The 0.3.0 isolation block: branch / baseline→head commits / change stats /
		* uncommitted-changes warning, plus the user-only git actions (merge /
		* remove worktree — plan §3.3).
		*/
		function IsolationBlock({ task, controller }) {
			const t = useT();
			const { alert: showAlert, el: alertEl } = useAlert();
			const [confirmMerge, setConfirmMerge] = (0, react.useState)(false);
			const [confirmRemove, setConfirmRemove] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [openDiff, setOpenDiff] = (0, react.useState)(null);
			const [dirtyOpen, setDirtyOpen] = (0, react.useState)(false);
			const execution = latestIsolated(task);
			const running = task.executions.some((e) => e.outcome === "running");
			if (execution === void 0) return null;
			const doMerge = () => {
				setBusy(true);
				controller.mergeBranch(task.id).then((result) => {
					setBusy(false);
					setConfirmMerge(false);
					if (!result.ok) showAlert(t("iso.merge.failed", { error: result.error }));
					else if (result.noop === true) showAlert(t("iso.merge.noop"));
				});
			};
			const doRemove = (deleteBranch) => {
				setBusy(true);
				controller.removeWorktree(task.id, deleteBranch).then((result) => {
					setBusy(false);
					setConfirmRemove(null);
					if (!result.ok) showAlert(t("iso.remove.failed", { error: result.error }));
					else if (result.branchError !== void 0) showAlert(t("iso.remove.branchFailed", { error: result.branchError }));
				});
			};
			if (execution.isolation !== "worktree" || execution.worktreePath === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "isolation",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-fieldcard-label",
						children: t("iso.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-none",
						children: [t("iso.none"), execution.isolationNote !== void 0 ? ` · ${execution.isolationNote}` : ""]
					}),
					alertEl
				]
			});
			const commits = execution.commits ?? [];
			const commitTotal = execution.commitsTotal ?? commits.length;
			const dirty = execution.dirtyFiles ?? [];
			const dirtyTotal = execution.dirtyFilesTotal ?? dirty.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "isolation",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-fieldcard-label",
						children: t("iso.worktreeTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-iso-fact",
								title: execution.worktreePath,
								children: [
									t("iso.branch"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: execution.branch ?? task.branch })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-fact",
								children: t("iso.baseline", {
									base: shortHash(execution.baseCommit),
									head: shortHash(execution.headCommit)
								})
							}),
							execution.changedFiles !== void 0 && execution.changedFiles > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-fact",
								children: t("iso.changed", { n: execution.changedFiles })
							}),
							execution.diffStat !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-fact",
								title: execution.diffStat,
								children: execution.diffStat
							})
						]
					}),
					commits.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-commits",
						children: [commits.slice(0, 10).map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-iso-commit",
							"data-open": openDiff?.commit === c.hash ? "true" : void 0,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-iso-commit-btn",
								title: t("iso.commit.openTitle"),
								onClick: () => setOpenDiff(openDiff?.commit === c.hash ? null : { commit: c.hash }),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: shortHash(c.hash) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: c.subject })]
							}), openDiff?.commit === c.hash && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffView, {
								controller,
								task,
								execution,
								commit: c.hash
							})]
						}, c.hash)), commitTotal > 10 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-iso-more",
							children: t("iso.commits.more", { n: commitTotal })
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-iso-nocommit",
						children: t("iso.nocommit")
					}),
					dirtyTotal > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-dirty",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-iso-dirty-toggle",
								onClick: () => setDirtyOpen(!dirtyOpen),
								children: [t("iso.dirty.toggle", { n: dirtyTotal }), dirtyOpen ? t("iso.dirty.collapse") : t("iso.dirty.expand")]
							}),
							dirtyOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-iso-dirty-files",
								children: [dirty.slice(0, 30).map((line, index) => {
									const filePath = porcelainPath(line);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dsh-atb-iso-dirty-file",
										title: t("iso.dirty.openTitle"),
										onClick: () => setOpenDiff(openDiff?.path === filePath ? null : { path: filePath }),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: line.slice(0, 2) }),
											" ",
											filePath
										]
									}, `${line}-${index}`);
								}), dirtyTotal > 30 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-iso-more",
									children: t("iso.dirty.more", { n: dirtyTotal })
								})]
							}),
							openDiff?.path !== void 0 && dirtyOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffView, {
								controller,
								task,
								execution,
								path: openDiff.path
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-actions",
						children: [
							running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-hint",
								children: t("iso.hint.running")
							}) : confirmMerge ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-confirm",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-confirm-label",
										children: t("iso.merge.confirm")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-primary": "true",
										disabled: busy,
										onClick: doMerge,
										children: t("iso.merge.go")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => setConfirmMerge(false),
										children: t("shared.cancel")
									})
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								disabled: busy,
								title: t("iso.merge.title"),
								onClick: () => setConfirmMerge(true),
								children: t("iso.merge.button")
							}),
							!running && (confirmRemove === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-danger": "true",
								disabled: busy,
								title: t("iso.remove.wtTitle"),
								onClick: () => setConfirmRemove("wt"),
								children: t("iso.remove.wt")
							}), task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-danger": "true",
								disabled: busy,
								title: t("iso.remove.wtbTitle"),
								onClick: () => setConfirmRemove("wtb"),
								children: t("iso.remove.wtb")
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-confirm",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-confirm-label",
										children: confirmRemove === "wtb" ? t("iso.remove.confirmWtb") : t("iso.remove.confirmWt")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-danger": "true",
										disabled: busy,
										onClick: () => doRemove(confirmRemove === "wtb"),
										children: t("shared.confirmDelete")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => setConfirmRemove(null),
										children: t("shared.cancel")
									})
								]
							})),
							!running && confirmRemove === null && !confirmMerge && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-hint",
								children: t("iso.hint.keep")
							})
						]
					}),
					alertEl
				]
			});
		}
		/**
		* The detail view.
		* @param task - the task record.
		* @param controller - the controller.
		* @param now - current epoch ms (stale-claim highlight).
		*/
		function TaskDetail({ task, controller, now }) {
			const t = useT();
			const [comment, setComment] = (0, react.useState)("");
			const [confirmDone, setConfirmDone] = (0, react.useState)(false);
			const [confirmPurge, setConfirmPurge] = (0, react.useState)(false);
			const [confirmCancel, setConfirmCancel] = (0, react.useState)(false);
			const [actionBusy, setActionBusy] = (0, react.useState)(false);
			const { alert: showAlert, el: alertEl } = useAlert();
			const ws = controller.getSnapshot().workspaces.find((w) => w.id === task.workspaceId);
			const canRun = task.status !== "in_progress" && task.status !== "done" && task.status !== "archived";
			const runningExecution = task.executions.find((e) => e.outcome === "running");
			const holder = task.status === "in_progress" ? task.claimedBy : void 0;
			const stale = now !== void 0 && isStaleClaim(task, now);
			const unchecked = (task.checklist ?? []).filter((i) => !i.checked).length;
			const sessionExecution = [...task.executions].reverse().find((e) => e.sessionId !== void 0);
			const targetSessionId = runningExecution?.sessionId ?? sessionExecution?.sessionId ?? (task.claimedBy?.startsWith("session-") ? task.claimedBy : void 0);
			/** Fire one top action under the shared busy guard; re-enable on settle. */
			const runAction = (action) => {
				if (actionBusy) return;
				setActionBusy(true);
				action().catch(() => void 0).finally(() => setActionBusy(false));
			};
			/** Jump to an execution's session; prompt precisely when it cannot open. */
			const jumpToSession = (sessionId) => {
				controller.openSession(sessionId).then((result) => {
					if (result === "missing") showAlert(t("card.session.missing", { id: shortId(sessionId) }));
					else if (result === "archived") showAlert(t("card.session.archived", { id: shortId(sessionId) }));
					else if (result === "unavailable") showAlert(t("card.session.unavailable", { id: sessionId }));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-detail",
				"data-urgency": task.urgency,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-detail-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-detail-titlewrap",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-titlebar",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: task.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-statuspill",
										"data-status": task.status,
										children: t(STATUS_KEYS[task.status] ?? task.status)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-chips",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											tone: task.urgency,
											children: ["● ", t(URGENCY_KEYS[task.urgency] ?? task.urgency)]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "📁",
											children: ws?.title ?? shortId(task.workspaceId)
										}),
										task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: "✦",
											title: t("card.badge.modelTitle", { model: task.model.provider + "/" + task.model.model }) + (task.model.reasoningEffort !== void 0 ? t("card.badge.modelEffort", { effort: task.model.reasoningEffort }) : ""),
											children: [task.model.model, task.model.reasoningEffort !== void 0 ? ` · ${task.model.reasoningEffort}` : ""]
										}),
										task.presetId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🎛",
											children: task.presetId
										}),
										task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "⏰",
											children: t("detail.chip.nextRun", {
												cron: task.execution.cron ?? "",
												time: fmtTime(task.execution.nextRunAt)
											})
										}),
										task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "⛔",
											tone: "urgent",
											children: t("shared.blocked")
										}),
										task.checklist !== void 0 && task.checklist.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "☑",
											tone: task.status === "in_review" && task.checklist.some((i) => !i.checked) ? "urgent" : void 0,
											children: t("detail.chip.checklist", {
												done: checklistProgress(task).done,
												total: task.checklist.length
											})
										}),
										task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: "🌿",
											tone: void 0,
											children: ["Worktree · ", task.branch.length > 28 ? `${task.branch.slice(0, 28)}…` : task.branch]
										}),
										(task.isolation === void 0 || task.isolation === "worktree") && task.branch === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🌿",
											children: t("detail.chip.isolated")
										}),
										task.permission === "read-only" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🔒",
											tone: "urgent",
											children: t("detail.chip.permReadOnly")
										}),
										task.permission === "danger-full-access" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "⚡",
											tone: "urgent",
											children: t("detail.chip.permFull")
										}),
										(task.permission === "workspace-write" || task.permission === void 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "📁",
											children: t("detail.chip.permWrite")
										}),
										holder !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-chip2 dsh-atb-chip-btn",
											"data-tone": stale ? "urgent" : void 0,
											title: t("detail.chip.holderTitle", { id: holder }),
											onClick: () => jumpToSession(holder),
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-chip2-icon",
													children: stale ? "⏱" : "🤖"
												}),
												stale ? t("detail.chip.holderStale") : t("detail.chip.holderBy"),
												shortId(holder),
												t("detail.chip.holderSuffix")
											]
										}),
										task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🗑",
											tone: "urgent",
											children: t("detail.chip.trashed")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, { children: ["v", task.version] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-detail-sub",
									children: t("detail.sub.line", {
										time: fmtTime(task.updatedAt),
										who: task.updatedBy.kind === "agent" ? `🤖 ${shortId(task.updatedBy.sessionId)}` : task.updatedBy.kind === "system" ? t("detail.updatedBy.system") : t("detail.updatedBy.user")
									})
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-detail-topbtns",
							children: [
								targetSessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-session",
									title: t("detail.session.jumpTitle", { id: targetSessionId }),
									onClick: () => jumpToSession(targetSessionId),
									children: t("detail.session.jump")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-edit",
									onClick: () => controller.openEditor(task.id),
									children: t("detail.action.edit")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-edit",
									title: t("detail.action.duplicateTitle"),
									disabled: actionBusy,
									onClick: () => runAction(() => controller.duplicate(task)),
									children: t("detail.action.duplicate")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-edit",
									title: t("detail.action.saveTplTitle"),
									disabled: actionBusy,
									onClick: () => runAction(async () => {
										if (await controller.saveAsTemplate(task)) showAlert(t("detail.action.saveTplDone"));
									}),
									children: t("detail.action.saveTpl")
								}),
								canRun && task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									title: t("detail.action.reuseTitle"),
									disabled: actionBusy,
									onClick: () => runAction(() => controller.run(task.id, true)),
									children: t("detail.action.reuse")
								}),
								canRun && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									title: task.model !== void 0 ? t("detail.action.runTitleModel", { model: task.model.model }) : t("detail.action.runTitleDefault"),
									disabled: actionBusy,
									onClick: () => runAction(() => controller.run(task.id)),
									children: t("detail.action.run")
								}),
								runningExecution !== void 0 && (confirmCancel ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-atb-confirm",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-confirm-label",
											children: t("detail.action.stopConfirm")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											"data-danger": "true",
											onClick: () => {
												controller.cancel(task.id);
												setConfirmCancel(false);
											},
											children: t("detail.action.stop")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											onClick: () => setConfirmCancel(false),
											children: t("shared.cancel")
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									"data-danger": "true",
									title: t("detail.action.stopTitle", { id: runningExecution.sessionId ?? "" }),
									onClick: () => setConfirmCancel(true),
									children: t("detail.action.stopExec")
								})),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-close",
									"aria-label": t("shared.close"),
									onClick: () => controller.select(void 0),
									children: "✕"
								})
							]
						})]
					}),
					task.description.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: t("detail.field.description")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-desc",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownContent, { text: task.description })
						})]
					}),
					task.prompt.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						"data-kind": "prompt",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: t("detail.field.prompt")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-promptbox",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownContent, { text: task.prompt })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IsolationBlock, {
						task,
						controller
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReportBlock, { task }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChecklistBlock, {
						task,
						controller
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-detail-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-movebtns",
							children: [
								moveTargets(task).map((to) => to === "done" ? confirmDone ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-atb-confirm",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-confirm-label",
											"data-tone": unchecked > 0 ? "bad" : void 0,
											children: unchecked > 0 ? t("detail.move.confirmDoneUnchecked", { n: unchecked }) : t("detail.move.confirmDone")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											"data-primary": "true",
											onClick: () => {
												controller.move(task.id, task.version, "done");
												setConfirmDone(false);
											},
											children: t("detail.move.confirm")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											onClick: () => setConfirmDone(false),
											children: t("shared.cancel")
										})
									]
								}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": to,
									onClick: () => setConfirmDone(true),
									children: t("detail.move.to", { status: t(MOVE_KEYS[to]) })
								}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": to,
									onClick: () => void controller.move(task.id, task.version, to),
									children: t("detail.move.to", { status: t(MOVE_KEYS[to]) })
								}, to)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": "blocked",
									onClick: () => void controller.toggleBlocked(task),
									children: task.blocked ? t("detail.blocked.unmark") : t("detail.blocked.mark")
								}),
								holder !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": "release",
									title: t("detail.release.title", { id: holder }),
									onClick: () => void controller.move(task.id, task.version, "todo"),
									children: t("detail.release.button")
								})
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [t("detail.comments.title"), task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								children: task.comments.length
							})] }),
							task.comments.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-empty2",
								children: t("detail.comments.empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-commentlist",
								children: task.comments.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-bubble",
									"data-from": c.threadId !== void 0 ? "agent" : "user",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-bubble-avatar",
										children: c.threadId !== void 0 ? "🤖" : "👤"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-bubble-main",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-bubble-meta",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: c.threadId !== void 0 ? `agent ${shortId(c.threadId)}` : t("detail.comments.user") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fmtTime(c.createdAt) })]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-bubble-body",
											children: c.body
										})]
									})]
								}, c.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-composer",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "dsh-atb-composer-input",
									value: comment,
									placeholder: t("detail.composer.placeholder"),
									onChange: (e) => setComment(e.target.value),
									onKeyDown: (e) => {
										if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && comment.trim().length > 0) controller.comment(task.id, comment).then((ok) => {
											if (ok) setComment("");
										});
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-composer-send",
									disabled: comment.trim().length === 0,
									onClick: () => {
										controller.comment(task.id, comment).then((ok) => {
											if (ok) setComment("");
										});
									},
									children: t("detail.composer.send")
								})]
							})
						]
					}),
					task.executions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
							t("detail.exec.title"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								children: task.executions.length
							}),
							task.executionsPruned !== void 0 && task.executionsPruned > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								title: t("detail.exec.prunedTitle", { n: task.executionsPruned }),
								children: t("detail.exec.pruned", { n: task.executionsPruned })
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-execlist",
							children: [...task.executions].reverse().map((e) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-exec-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-dot",
										"data-outcome": e.outcome
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-trigger",
										children: e.trigger === "manual" ? t("detail.exec.trigger.manual") : t("detail.exec.trigger.scheduled")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-outcome",
										"data-outcome": e.outcome,
										children: t(OUTCOME_KEYS[e.outcome] ?? e.outcome)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-time",
										children: [fmtTime(e.startedAt), e.endedAt !== void 0 && ` · ${duration(e.startedAt, e.endedAt)}`]
									}),
									e.sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dsh-atb-exec-session",
										title: t("detail.exec.openTitle", { id: e.sessionId }),
										onClick: () => jumpToSession(e.sessionId),
										children: [
											"🤖 ",
											shortId(e.sessionId),
											" ↗"
										]
									}),
									e.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-error",
										title: e.error,
										children: [e.error.slice(0, 80), e.error.length > 80 ? "…" : ""]
									})
								]
							}, e.id))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-dangerzone",
						children: task.trashedAt === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-danger": "true",
							onClick: () => void controller.remove(task.id, task.version, false),
							children: t("detail.danger.delete")
						}) : confirmPurge ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-atb-confirm",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-confirm-label",
									children: t("detail.danger.purgeConfirm")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-danger": "true",
									onClick: () => {
										controller.remove(task.id, task.version, true);
										setConfirmPurge(false);
									},
									children: t("detail.danger.purgeGo")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: () => setConfirmPurge(false),
									children: t("shared.cancel")
								})
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-danger": "true",
							onClick: () => setConfirmPurge(true),
							children: t("detail.danger.purge")
						})
					}),
					alertEl
				]
			});
		}

		//#endregion
		//#region src/client/board/SlashPromptInput.tsx
		/**
		* SlashPromptInput: Rich text input component for task description & execution prompt.
		* Features:
		* - Slash autocomplete popup for commands and skills with keyboard navigation.
		* - Clean text editing without image base64 pollution.
		*
		* @module dsh-taskboard/client/board/SlashPromptInput
		*/
		/** Default built-in slash commands (descriptions resolve through t at render,
		* so they follow the GUI language live; host-provided items override by name). */
		const defaultCommands = (t) => [
			{
				name: "goal",
				kind: "command",
				description: t("slash.cmd.goal.desc"),
				hint: t("slash.cmd.goal.hint")
			},
			{
				name: "schedule",
				kind: "command",
				description: t("slash.cmd.schedule.desc"),
				hint: t("slash.cmd.schedule.hint")
			},
			{
				name: "plan",
				kind: "command",
				description: t("slash.cmd.plan.desc")
			},
			{
				name: "browser",
				kind: "command",
				description: t("slash.cmd.browser.desc")
			},
			{
				name: "grill-me",
				kind: "command",
				description: t("slash.cmd.grill-me.desc")
			},
			{
				name: "teamwork-preview",
				kind: "command",
				description: t("slash.cmd.teamwork-preview.desc")
			},
			{
				name: "learn",
				kind: "command",
				description: t("slash.cmd.learn.desc")
			},
			{
				name: "review",
				kind: "command",
				description: t("slash.cmd.review.desc")
			},
			{
				name: "security",
				kind: "command",
				description: t("slash.cmd.security.desc")
			},
			{
				name: "permission",
				kind: "command",
				description: t("slash.cmd.permission.desc"),
				hint: t("slash.cmd.permission.hint")
			}
		];
		/** Default built-in skills (descriptions resolve through t at render). */
		const defaultSkills = (t) => [
			{
				name: "frontend-ui-engineering",
				kind: "skill",
				description: t("slash.skill.frontend-ui-engineering")
			},
			{
				name: "api-and-interface-design",
				kind: "skill",
				description: t("slash.skill.api-and-interface-design")
			},
			{
				name: "test-driven-development",
				kind: "skill",
				description: t("slash.skill.test-driven-development")
			},
			{
				name: "debugging-and-error-recovery",
				kind: "skill",
				description: t("slash.skill.debugging-and-error-recovery")
			},
			{
				name: "performance-optimization",
				kind: "skill",
				description: t("slash.skill.performance-optimization")
			},
			{
				name: "ci-cd-and-automation",
				kind: "skill",
				description: t("slash.skill.ci-cd-and-automation")
			},
			{
				name: "code-review-and-quality",
				kind: "skill",
				description: t("slash.skill.code-review-and-quality")
			},
			{
				name: "code-simplification",
				kind: "skill",
				description: t("slash.skill.code-simplification")
			},
			{
				name: "context-engineering",
				kind: "skill",
				description: t("slash.skill.context-engineering")
			},
			{
				name: "doubt-driven-development",
				kind: "skill",
				description: t("slash.skill.doubt-driven-development")
			},
			{
				name: "git-workflow-and-versioning",
				kind: "skill",
				description: t("slash.skill.git-workflow-and-versioning")
			},
			{
				name: "idea-refine",
				kind: "skill",
				description: t("slash.skill.idea-refine")
			},
			{
				name: "incremental-implementation",
				kind: "skill",
				description: t("slash.skill.incremental-implementation")
			},
			{
				name: "interview-me",
				kind: "skill",
				description: t("slash.skill.interview-me")
			},
			{
				name: "memory-leak-debugging",
				kind: "skill",
				description: t("slash.skill.memory-leak-debugging")
			},
			{
				name: "observability-and-instrumentation",
				kind: "skill",
				description: t("slash.skill.observability-and-instrumentation")
			},
			{
				name: "planning-and-task-breakdown",
				kind: "skill",
				description: t("slash.skill.planning-and-task-breakdown")
			},
			{
				name: "security-and-hardening",
				kind: "skill",
				description: t("slash.skill.security-and-hardening")
			},
			{
				name: "shipping-and-launch",
				kind: "skill",
				description: t("slash.skill.shipping-and-launch")
			},
			{
				name: "source-driven-development",
				kind: "skill",
				description: t("slash.skill.source-driven-development")
			},
			{
				name: "spec-driven-development",
				kind: "skill",
				description: t("slash.skill.spec-driven-development")
			},
			{
				name: "using-agent-skills",
				kind: "skill",
				description: t("slash.skill.using-agent-skills")
			}
		];
		/**
		* Rich prompt textarea with / autocomplete for slash commands & skills.
		*/
		function SlashPromptInput({ value, onChange, controller, placeholder, rows = 4, maxLength = 8e3, disabled = false, autoFocus = false, className, ariaLabel }) {
			const t = useT();
			const textareaRef = (0, react.useRef)(null);
			const [hostCompletions, setHostCompletions] = (0, react.useState)(void 0);
			const completions = (0, react.useMemo)(() => {
				const merge = (defaults, host) => {
					const map = /* @__PURE__ */ new Map();
					for (const d of defaults) map.set(d.name, d);
					for (const h of host ?? []) map.set(h.name, h);
					return Array.from(map.values());
				};
				return {
					commands: merge(defaultCommands(t), hostCompletions?.commands),
					skills: merge(defaultSkills(t), hostCompletions?.skills)
				};
			}, [t, hostCompletions]);
			const [popupOpen, setPopupOpen] = (0, react.useState)(false);
			const [slashQuery, setSlashQuery] = (0, react.useState)("");
			const [slashStart, setSlashStart] = (0, react.useState)(-1);
			const [selectedIndex, setSelectedIndex] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (controller === void 0) return;
				let alive = true;
				controller.fetchPromptCompletions().then((res) => {
					if (!alive || res === void 0) return;
					setHostCompletions({
						commands: res.commands.map((c) => ({
							...c,
							kind: "command"
						})),
						skills: res.skills.map((s) => ({
							...s,
							kind: "skill"
						}))
					});
				});
				return () => {
					alive = false;
				};
			}, [controller]);
			const filteredItems = (0, react.useMemo)(() => {
				const q = slashQuery.toLowerCase().trim();
				const all = [...completions.commands, ...completions.skills];
				if (q.length === 0) return all;
				return all.filter((item) => item.name.toLowerCase().includes(q) || item.description !== void 0 && item.description.toLowerCase().includes(q));
			}, [completions, slashQuery]);
			(0, react.useEffect)(() => {
				if (selectedIndex >= filteredItems.length) setSelectedIndex(Math.max(0, filteredItems.length - 1));
			}, [filteredItems.length, selectedIndex]);
			const checkSlashTrigger = () => {
				const el = textareaRef.current;
				if (el === null) return;
				const pos = el.selectionStart;
				const currentText = el.value.slice(0, pos);
				const lastSlash = currentText.lastIndexOf("/");
				if (lastSlash >= 0) {
					const charBefore = lastSlash > 0 ? currentText[lastSlash - 1] ?? "\n" : "\n";
					const isWordStart = /\s/.test(charBefore) || lastSlash === 0;
					const queryPart = currentText.slice(lastSlash + 1);
					const noWhitespaceInQuery = !/\s/.test(queryPart);
					if (isWordStart && noWhitespaceInQuery) {
						setSlashStart(lastSlash);
						setSlashQuery(queryPart);
						setPopupOpen(true);
						return;
					}
				}
				setPopupOpen(false);
			};
			const applyCompletion = (item) => {
				const el = textareaRef.current;
				if (el === null || slashStart < 0) return;
				const pos = el.selectionStart;
				const before = value.slice(0, slashStart);
				const after = value.slice(pos);
				const inserted = `/${item.name} `;
				onChange(before + inserted + after);
				setPopupOpen(false);
				setTimeout(() => {
					if (textareaRef.current !== null) {
						const nextPos = slashStart + inserted.length;
						textareaRef.current.focus();
						textareaRef.current.setSelectionRange(nextPos, nextPos);
					}
				}, 0);
			};
			const handleKeyDown = (e) => {
				if (popupOpen && filteredItems.length > 0) {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
						return;
					}
					if (e.key === "ArrowUp") {
						e.preventDefault();
						setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
						return;
					}
					if (e.key === "Enter" || e.key === "Tab") {
						const picked = filteredItems[selectedIndex];
						if (picked !== void 0) {
							e.preventDefault();
							applyCompletion(picked);
							return;
						}
					}
					if (e.key === "Escape") {
						e.preventDefault();
						setPopupOpen(false);
						return;
					}
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dsh-atb-prompt-wrap ${className ?? ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-prompt-inner",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						ref: textareaRef,
						className: "dsh-atb-prompt-input",
						value,
						rows,
						maxLength,
						disabled,
						autoFocus,
						placeholder,
						"aria-label": ariaLabel,
						onChange: (e) => {
							onChange(e.target.value);
							checkSlashTrigger();
						},
						onKeyUp: checkSlashTrigger,
						onClick: checkSlashTrigger,
						onKeyDown: handleKeyDown
					}), popupOpen && filteredItems.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-slash-popup",
						role: "listbox",
						"aria-label": t("slash.aria"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-slash-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-slash-title",
								children: t("slash.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-slash-hint",
								children: t("slash.hint")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-slash-list",
							children: filteredItems.map((item, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								role: "option",
								"aria-selected": idx === selectedIndex,
								className: "dsh-atb-slash-item",
								"data-active": idx === selectedIndex ? "true" : void 0,
								"data-kind": item.kind,
								onClick: () => applyCompletion(item),
								onMouseEnter: () => setSelectedIndex(idx),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-slash-badge",
										"data-kind": item.kind,
										children: item.kind === "command" ? t("slash.badge.command") : t("slash.badge.skill")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-slash-name",
										children: ["/", item.name]
									}),
									item.hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-slash-param",
										children: item.hint
									}),
									item.description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-slash-desc",
										children: item.description
									})
								]
							}, `${item.kind}-${item.name}`))
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-prompt-foot",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsh-atb-prompt-tip",
						children: [
							t("slash.tipA"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/" }),
							" ",
							t("slash.tipB")
						]
					})
				})]
			});
		}

		//#endregion
		//#region src/client/board/TaskFormModal.tsx
		/**
		* The task form modal — create and edit in one polished dialog: header with
		* icon / subtitle / close, a sectioned field grid (title, project, model,
		* urgency tri-picker with hints, description, prompt, execution-mode
		* segmented picker, cron with presets and a live next-run preview), and a
		* footer bar carrying the validation hint and the actions. Esc closes;
		* the title input is focused on open.
		*
		* @module dsh-taskboard/client/board/TaskFormModal
		*/
		/** Local storage key for remembering the last selected model in create mode. */
		const LAST_MODEL_KEY = "dsh-taskboard-last-model-v1";
		/** Read the remembered model from localStorage. */
		function loadLastModel() {
			try {
				const raw = localStorage.getItem(LAST_MODEL_KEY);
				if (raw === null) return void 0;
				const parsed = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null) {
					const { provider, model, reasoningEffort } = parsed;
					if (typeof provider === "string" && typeof model === "string" && provider.trim().length > 0 && model.trim().length > 0) return {
						provider: provider.trim(),
						model: model.trim(),
						...typeof reasoningEffort === "string" && reasoningEffort.trim().length > 0 ? { reasoningEffort: reasoningEffort.trim() } : {}
					};
				}
				return;
			} catch {
				return;
			}
		}
		/** Save the remembered model to localStorage. */
		function saveLastModel(model) {
			try {
				if (model === void 0) localStorage.removeItem(LAST_MODEL_KEY);
				else localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(model));
			} catch {}
		}
		/** Urgency segmented options with a one-line hint each (translated per render). */
		const urgencyOptions = (t) => [
			{
				value: "urgent",
				label: t("form.urgency.urgent"),
				hint: t("form.urgency.urgentHint")
			},
			{
				value: "normal",
				label: t("form.urgency.normal"),
				hint: t("form.urgency.normalHint")
			},
			{
				value: "relaxed",
				label: t("form.urgency.relaxed"),
				hint: t("form.urgency.relaxedHint")
			}
		];
		/** Cron presets offered in the scheduled mode (translated per render). */
		const cronPresets = (t) => [
			{
				label: t("form.cron.daily"),
				cron: "0 9 * * *"
			},
			{
				label: t("form.cron.hourly"),
				cron: "0 * * * *"
			},
			{
				label: t("form.cron.every10min"),
				cron: "*/10 * * * *"
			},
			{
				label: t("form.cron.weekly"),
				cron: "0 9 * * 1"
			}
		];
		/** Permission presets aligned with DSH (translated per render). */
		const permissionOptions = (t) => [
			{
				value: "workspace-write",
				label: t("form.perm.write"),
				hint: t("form.perm.writeHint"),
				icon: "📁"
			},
			{
				value: "read-only",
				label: t("form.perm.readOnly"),
				hint: t("form.perm.readOnlyHint"),
				icon: "🔒"
			},
			{
				value: "danger-full-access",
				label: t("form.perm.fullAccess"),
				hint: t("form.perm.fullAccessHint"),
				icon: "⚡"
			}
		];
		/** Field shell: label + control, optionally spanning the full grid row. */
		function Field({ label, required = false, full = false, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: "dsh-atb-field",
				"data-span": full ? "full" : void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dsh-atb-field-label",
					children: [label, required && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("em", {
						className: "dsh-atb-req",
						children: "*"
					})]
				}), children]
			});
		}
		/**
		* The checklist (DoD) editor: toggle + text + remove per row, add button,
		* cap-enforced. Edit mode preserves checked state and notes (the GUI
		* replaces the whole list on save).
		*/
		function ChecklistEditor({ rows, onChange, editing }) {
			const t = useT();
			const setRow = (index, patch) => {
				onChange(rows.map((row, i) => i === index ? {
					...row,
					...patch
				} : row));
			};
			const checked = rows.filter((r) => r.checked).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-cke",
				children: [
					rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-cke-row",
						children: [
							editing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								className: "dsh-atb-cke-box",
								checked: row.checked,
								title: t("form.check.checkedTitle", { who: row.checkedBy ?? t("form.check.notCheckedYet") }),
								onChange: (e) => setRow(index, { checked: e.target.checked })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsh-atb-cke-text",
								value: row.text,
								maxLength: 200,
								placeholder: t("form.check.itemPlaceholder", { n: index + 1 }),
								spellCheck: false,
								onChange: (e) => setRow(index, { text: e.target.value })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-cke-del",
								title: t("form.check.removeTitle"),
								onClick: () => onChange(rows.filter((_, i) => i !== index)),
								children: "✕"
							})
						]
					}, row.id ?? `new-${index}`)),
					rows.length < 30 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-atb-cke-add",
						onClick: () => onChange([...rows, {
							text: "",
							checked: false
						}]),
						children: t("form.check.add")
					}),
					rows.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-atb-cke-hint",
						children: editing ? t("form.check.hintEdit", {
							checked,
							total: rows.length
						}) : t("form.check.hintCreate", { n: rows.length })
					})
				]
			});
		}
		/**
		* The form modal. Without `task` it composes a new task (optionally
		* prefilled from a chosen template); with `task` it edits that record
		* (project, urgency, execution, model included — the GUI is the owner
		* surface).
		* @param controller - the controller.
		* @param task - the task being edited (create mode when absent).
		*/
		function TaskFormModal({ controller, task }) {
			const t = useT();
			const state = controller.getSnapshot();
			const prefill = state.templatePrefill;
			const editing = task !== void 0;
			const [title, setTitle] = (0, react.useState)(task?.title ?? prefill?.title ?? "");
			const [description, setDescription] = (0, react.useState)(task?.description ?? prefill?.description ?? "");
			const [prompt, setPrompt] = (0, react.useState)(task?.prompt ?? prefill?.prompt ?? "");
			const [workspaceId, setWorkspaceId] = (0, react.useState)(task?.workspaceId ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? "");
			const [urgency, setUrgency] = (0, react.useState)(task?.urgency ?? (prefill?.urgency === "urgent" || prefill?.urgency === "relaxed" ? prefill.urgency : "normal"));
			const [mode, setMode] = (0, react.useState)(task?.execution.mode === "scheduled" || prefill?.execution?.mode === "scheduled" ? "scheduled" : "claim");
			const [cron, setCron] = (0, react.useState)(task?.execution.cron ?? prefill?.execution?.cron ?? "0 9 * * *");
			const [catalog, setCatalog] = (0, react.useState)([]);
			const initialModel = task?.model ?? prefill?.model ?? (!editing ? loadLastModel() : void 0);
			const [model, setModel] = (0, react.useState)(initialModel !== void 0 ? JSON.stringify({
				provider: initialModel.provider,
				model: initialModel.model
			}) : "");
			const [reasoningEffort, setReasoningEffort] = (0, react.useState)(initialModel?.reasoningEffort ?? "");
			const initialPreset = task?.presetId ?? prefill?.presetId ?? "";
			const [presetId, setPresetId] = (0, react.useState)(initialPreset);
			const [presets, setPresets] = (0, react.useState)([]);
			const [presetDefault, setPresetDefault] = (0, react.useState)(void 0);
			const [permission, setPermission] = (0, react.useState)(task?.permission ?? (prefill?.permission ? asPermission(prefill.permission) : defaultPermissionOf(state.ledger.settings)));
			const [isolation, setIsolation] = (0, react.useState)(task?.isolation ?? (prefill?.isolation === "none" ? "none" : prefill?.isolation === "worktree" ? "worktree" : defaultIsolationOf(state.ledger.settings)));
			const [checkRows, setCheckRows] = (0, react.useState)(task?.checklist !== void 0 && task.checklist.length > 0 ? task.checklist.map((i) => ({ ...i })) : (prefill?.checklist ?? []).map((text) => ({
				text,
				checked: false
			})));
			const titleRef = (0, react.useRef)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				titleRef.current?.focus();
				const onKey = (e) => {
					if (e.key === "Escape") controller.closeForm();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [controller]);
			(0, react.useEffect)(() => {
				controller.fetchModelCatalog().then(setCatalog).catch(() => setCatalog([]));
			}, [controller]);
			(0, react.useEffect)(() => {
				controller.fetchPresetCatalog().then((roster) => {
					setPresets(roster.presets);
					setPresetDefault(roster.defaultId);
					if (!editing && initialPreset === "" && roster.defaultId !== void 0) setPresetId(roster.defaultId);
				}).catch(() => setPresets([]));
			}, [
				controller,
				editing,
				task?.presetId,
				initialPreset
			]);
			const cronMatch = mode === "scheduled" ? parseCron(cron.trim()) : null;
			const nextRun = cronMatch !== null ? nextCronTime(cronMatch, Date.now()) : null;
			const cronBad = mode === "scheduled" && (cronMatch === null || nextRun === null);
			const valid = title.trim().length > 0 && workspaceId !== "" && !cronBad;
			const runBlocked = editing && task.status === "in_progress";
			const isolationLocked = editing && ((task.executions?.length ?? 0) > 0 || task.status === "in_progress");
			const gitOk = controller.gitAvailable(workspaceId);
			const isolationDisabled = isolationLocked || !gitOk;
			/**
			* Isolation payload for submit: undefined lets the HOST materialize the
			* current board default at creation (non-git projects degrade naturally).
			*/
			const isolationPayload = () => {
				if (!gitOk) return void 0;
				return isolation;
			};
			/** Preset payload: '' = follow the deployment default (submit omits). */
			const presetPayload = () => presetId.trim().length > 0 ? presetId.trim() : void 0;
			/** Checklist rows with non-empty text (blank rows are dropped on submit). */
			const filledRows = () => checkRows.map((r) => ({
				...r,
				text: r.text.trim()
			})).filter((r) => r.text.length > 0);
			const parsedModel = model !== "" ? JSON.parse(model) : void 0;
			const modelReasoning = (parsedModel !== void 0 ? catalog.find((m) => m.provider === parsedModel.provider && m.model === parsedModel.model) : void 0)?.reasoning;
			const buildPickedModel = () => {
				if (parsedModel === void 0) return void 0;
				const eff = reasoningEffort.trim();
				return {
					provider: parsedModel.provider,
					model: parsedModel.model,
					...eff.length > 0 ? { reasoningEffort: eff } : {}
				};
			};
			const submit = () => {
				if (!valid || busy) return;
				const picked = buildPickedModel();
				if (!editing) saveLastModel(picked);
				const isolationOut = isolationPayload();
				const presetOut = presetPayload();
				const rows = filledRows();
				setBusy(true);
				(editing ? controller.update(task.id, task.version, {
					title,
					description,
					prompt,
					urgency,
					workspaceId,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked ?? null,
					...isolationOut !== void 0 && !isolationLocked ? { isolation: isolationOut } : {},
					presetId: presetOut ?? null,
					permission,
					checklist: rows.length > 0 ? rows : null
				}) : controller.create({
					title,
					workspaceId,
					urgency,
					description: description.length > 0 ? description : void 0,
					prompt: prompt.length > 0 ? prompt : void 0,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked,
					...isolationOut !== void 0 ? { isolation: isolationOut } : {},
					...presetOut !== void 0 ? { presetId: presetOut } : {},
					permission,
					...rows.length > 0 ? { checklist: rows.map((r) => r.text) } : {}
				})).catch(() => void 0).finally(() => setBusy(false));
			};
			/** Save the form, then immediately trigger a manual run of the task. */
			const submitAndRun = () => {
				if (!valid || runBlocked || busy) return;
				const picked = buildPickedModel();
				if (!editing) saveLastModel(picked);
				const isolationOut = isolationPayload();
				const presetOut = presetPayload();
				const rows = filledRows();
				setBusy(true);
				(async () => {
					if (editing) {
						if (await controller.update(task.id, task.version, {
							title,
							description,
							prompt,
							urgency,
							workspaceId,
							execution: mode === "scheduled" ? {
								mode,
								cron: cron.trim()
							} : { mode },
							model: picked ?? null,
							...isolationOut !== void 0 && !isolationLocked ? { isolation: isolationOut } : {},
							presetId: presetOut ?? null,
							permission,
							checklist: rows.length > 0 ? rows : null
						})) await controller.run(task.id);
					} else {
						const id = await controller.create({
							title,
							workspaceId,
							urgency,
							description: description.length > 0 ? description : void 0,
							prompt: prompt.length > 0 ? prompt : void 0,
							execution: mode === "scheduled" ? {
								mode,
								cron: cron.trim()
							} : { mode },
							model: picked,
							...isolationOut !== void 0 ? { isolation: isolationOut } : {},
							...presetOut !== void 0 ? { presetId: presetOut } : {},
							permission,
							...rows.length > 0 ? { checklist: rows.map((r) => r.text) } : {}
						});
						if (id !== void 0) await controller.run(id);
					}
				})().catch(() => void 0).finally(() => setBusy(false));
			};
			const hint = !valid ? title.trim().length === 0 ? t("form.hint.needTitle") : workspaceId === "" ? t("form.hint.needProject") : t("form.hint.cronBad") : mode === "scheduled" && nextRun !== null ? t("form.hint.nextRun", { time: fmtTime(nextRun) }) : editing ? t("form.hint.saveVersion", {
				v: task.version,
				next: task.version + 1
			}) : t("form.hint.createClaim");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeForm();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-taskform-modal",
					"data-mode": editing ? "edit" : "create",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": editing ? t("form.title.edit") : t("form.title.create"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-modal-headicon",
									children: editing ? "✎" : "✚"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-modal-headtext",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: editing ? t("form.title.edit") : t("form.title.create") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: editing ? t("form.subtitle.edit") : t("form.subtitle.create") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": t("shared.close"),
									onClick: () => controller.closeForm(),
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-body dsh-atb-taskform-body",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-form-col dsh-atb-form-left",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("form.field.title"),
										required: true,
										full: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											ref: titleRef,
											value: title,
											onChange: (e) => setTitle(e.target.value),
											placeholder: t("form.field.titlePlaceholder"),
											maxLength: 200
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-form-subgrid",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
												label: t("form.field.project"),
												required: true,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
													value: workspaceId,
													onChange: (e) => setWorkspaceId(e.target.value),
													children: state.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: ws.id,
														children: ws.title || ws.path
													}, ws.id))
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
												label: t("form.field.model"),
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: model,
													onChange: (e) => {
														const val = e.target.value;
														setModel(val);
														if (val === "") setReasoningEffort("");
														else {
															const pm = JSON.parse(val);
															const cm = catalog.find((m) => m.provider === pm.provider && m.model === pm.model);
															if (cm?.reasoning?.defaultEffort !== void 0) setReasoningEffort(cm.reasoning.defaultEffort);
															else setReasoningEffort("");
														}
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "",
														children: t("form.field.modelDefault")
													}), catalog.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: JSON.stringify({
															provider: m.provider,
															model: m.model
														}),
														children: t("form.model.option", {
															name: m.name ?? m.model,
															provider: m.provider
														})
													}, `${m.provider}/${m.model}`))]
												})
											}),
											parsedModel !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
												label: t("form.field.effort"),
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: reasoningEffort,
													onChange: (e) => setReasoningEffort(e.target.value),
													title: t("form.field.effortTitle"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: "",
														children: [t("form.effort.follow"), modelReasoning?.defaultEffort !== void 0 ? t("shared.current", { name: modelReasoning.efforts.find((ef) => ef.id === modelReasoning.defaultEffort)?.name ?? modelReasoning.defaultEffort }) : ""]
													}), modelReasoning !== void 0 && modelReasoning.efforts.length > 0 ? modelReasoning.efforts.map((eff) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: eff.id,
														children: [eff.name, eff.description ? ` (${eff.description})` : ""]
													}, eff.id)) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "low",
															children: t("form.effort.low")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "medium",
															children: t("form.effort.medium")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "high",
															children: t("form.effort.high")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "none",
															children: t("form.effort.none")
														})
													] })]
												})
											}),
											presets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
												label: t("form.field.preset"),
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: presetId,
													onChange: (e) => setPresetId(e.target.value),
													title: t("form.field.presetTitle"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: "",
														children: [t("form.preset.follow"), presetDefault !== void 0 ? t("shared.current", { name: presets.find((p) => p.id === presetDefault)?.name ?? presetDefault }) : ""]
													}), presets.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: p.id,
														children: [p.name ?? p.id, p.id === presetDefault ? t("form.preset.defaultTag") : ""]
													}, p.id))]
												})
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("form.field.urgency"),
										full: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-urgency-picker",
											children: urgencyOptions(t).map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-urgency-opt",
												"data-urgency": o.value,
												"data-on": urgency === o.value,
												onClick: () => setUrgency(o.value),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dsh-atb-urgency-name",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-dot",
														"data-urgency": o.value
													}), o.label]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-urgency-hint",
													children: o.hint
												})]
											}, o.value))
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("form.field.permission"),
										full: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-perm-picker",
											children: permissionOptions(t).map((opt) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-perm-opt",
												"data-on": permission === opt.value,
												onClick: () => setPermission(opt.value),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dsh-atb-perm-name",
													children: [
														opt.icon,
														" ",
														opt.label,
														opt.value === "workspace-write" ? t("form.perm.defaultTag") : ""
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-perm-hint",
													children: opt.hint
												})]
											}, opt.value))
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("form.field.mode"),
										full: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-mode-picker",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": mode === "claim",
												onClick: () => setMode("claim"),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("form.mode.claim")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: t("form.mode.claimHint")
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": mode === "scheduled",
												onClick: () => setMode("scheduled"),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("form.mode.scheduled")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: t("form.mode.scheduledHint")
												})]
											})]
										})
									}),
									mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
										label: t("form.field.cron"),
										required: true,
										full: true,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: cronBad ? "dsh-atb-input-bad" : void 0,
											value: cron,
											onChange: (e) => setCron(e.target.value),
											placeholder: t("form.cron.placeholder"),
											spellCheck: false
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-cron-presets",
											children: [cronPresets(t).map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsh-atb-cron-preset",
												"data-on": cron.trim() === p.cron,
												onClick: () => setCron(p.cron),
												children: p.label
											}, p.cron)), !cronBad && nextRun !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-cron-next",
												children: t("form.cron.next", { time: fmtTime(nextRun) })
											})]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
										label: t("form.field.isolation"),
										full: true,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-mode-picker",
											"data-disabled": isolationDisabled ? "true" : void 0,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": isolation === "worktree",
												disabled: isolationDisabled,
												title: isolationLocked ? t("form.iso.locked") : !gitOk ? t("form.iso.nonGit") : t("form.iso.worktreeTitle"),
												onClick: () => setIsolation("worktree"),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("form.iso.worktree")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: isolationLocked ? t("form.iso.lockedShort") : !gitOk ? t("form.iso.nonGit") : t("form.iso.worktreeHint")
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": isolation === "none",
												disabled: isolationDisabled,
												title: isolationLocked ? t("form.iso.locked") : t("form.iso.noneTitle"),
												onClick: () => setIsolation("none"),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("form.iso.none")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: isolationLocked ? t("form.iso.lockedShort") : !gitOk ? t("form.iso.noneHintNonGit") : t("form.iso.noneHint")
												})]
											})]
										}), !gitOk && !isolationLocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-isolation-note",
											children: t("form.iso.nonGitNote")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: editing ? t("form.field.checklist") : t("form.field.checklistOptional"),
										full: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChecklistEditor, {
											rows: checkRows,
											onChange: setCheckRows,
											editing
										})
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-form-col dsh-atb-form-right",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: editing ? t("form.field.description") : t("form.field.descriptionOptional"),
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SlashPromptInput, {
										value: description,
										onChange: setDescription,
										controller,
										rows: 7,
										placeholder: t("form.desc.placeholder")
									})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: editing ? t("form.field.prompt") : t("form.field.promptOptional"),
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SlashPromptInput, {
										value: prompt,
										onChange: setPrompt,
										controller,
										rows: 7,
										placeholder: t("form.prompt.placeholder")
									})
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								"data-tone": valid ? void 0 : "bad",
								children: hint
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-modal-footbtns",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => controller.closeForm(),
										children: t("shared.cancel")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										disabled: !valid || runBlocked || busy,
										title: runBlocked ? t("form.action.runBlockedTitle") : busy ? t("form.action.runBusyTitle") : t("form.action.runTitle"),
										onClick: submitAndRun,
										children: t("form.action.run")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-primary": "true",
										disabled: !valid || busy,
										onClick: submit,
										children: editing ? t("form.action.save") : t("form.action.create")
									})
								]
							})]
						})
					]
				})
			});
		}

		//#endregion
		//#region src/client/board/SettingsModal.tsx
		/**
		* Board-settings modal (0.5.0): the user-owned defaults applied when a NEW
		* task is created without an explicit choice. Currently one section — 默认执行
		* 隔离 (worktree vs original directory); further sections can slot into the
		* body below. Saving goes through the host route (whole-object replace) and
		* the SSE change stream refreshes every open view.
		*
		* @module dsh-taskboard/client/board/SettingsModal
		*/
		/** The isolation options with one-line hints (mirrors the task form; translated per render). */
		const isolationOptions = (t) => [{
			value: "none",
			name: t("form.iso.none"),
			hint: t("set.iso.noneHint")
		}, {
			value: "worktree",
			name: t("form.iso.worktree"),
			hint: t("set.iso.worktreeHint")
		}];
		/**
		* The 看板设置 modal: reads the live ledger settings, stages a local draft,
		* and writes back through the controller on save.
		* @param controller - the board controller.
		*/
		function SettingsModal({ controller }) {
			const t = useT();
			const state = controller.getSnapshot();
			const currentIso = state.ledger.settings?.defaultIsolation ?? "none";
			const currentSync = defaultSyncExternalSessionsOf(state.ledger.settings);
			const currentPerm = defaultPermissionOf(state.ledger.settings);
			const [draftIso, setDraftIso] = (0, react.useState)(currentIso);
			const [draftSync, setDraftSync] = (0, react.useState)(currentSync);
			const [draftPerm, setDraftPerm] = (0, react.useState)(currentPerm);
			const dirty = draftIso !== currentIso || draftSync !== currentSync || draftPerm !== currentPerm;
			const save = () => {
				controller.updateSettings({
					defaultIsolation: draftIso,
					syncExternalSessions: draftSync,
					defaultPermission: draftPerm
				}).then((ok) => {
					if (ok) controller.closeSettings();
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeSettings();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-set",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("set.aria"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-modal-headicon",
									children: "🛠"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-modal-headtext",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("set.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("set.subtitle") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": t("shared.close"),
									onClick: () => controller.closeSettings(),
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-body",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "dsh-atb-diag-sec",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("set.iso.heading") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-mode-picker",
											children: isolationOptions(t).map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": draftIso === o.value,
												title: o.hint,
												onClick: () => setDraftIso(o.value),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: o.name
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: o.hint
												})]
											}, o.value))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-isolation-note",
											children: t("set.iso.current", { current: currentIso === "worktree" ? t("form.iso.worktree") : t("form.iso.none") })
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "dsh-atb-diag-sec",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("set.sync.heading") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-mode-picker",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": !draftSync,
												title: t("set.sync.off.title"),
												onClick: () => setDraftSync(false),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("set.sync.off.name")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: t("set.sync.off.hint")
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dsh-atb-mode-opt",
												"data-on": draftSync,
												title: t("set.sync.on.title"),
												onClick: () => setDraftSync(true),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-name",
													children: t("set.sync.on.name")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-mode-hint",
													children: t("set.sync.on.hint")
												})]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-isolation-note",
											children: currentSync ? t("set.sync.stateOn") : t("set.sync.stateOff")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "dsh-atb-diag-sec",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("set.perm.heading") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-perm-picker",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "dsh-atb-perm-opt",
													"data-on": draftPerm === "workspace-write",
													onClick: () => setDraftPerm("workspace-write"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-name",
														children: t("set.perm.writeName")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-hint",
														children: t("set.perm.writeHint")
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "dsh-atb-perm-opt",
													"data-on": draftPerm === "read-only",
													onClick: () => setDraftPerm("read-only"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-name",
														children: t("set.perm.readOnlyName")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-hint",
														children: t("set.perm.readOnlyHint")
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "dsh-atb-perm-opt",
													"data-on": draftPerm === "danger-full-access",
													onClick: () => setDraftPerm("danger-full-access"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-name",
														children: t("set.perm.fullName")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsh-atb-perm-hint",
														children: t("set.perm.fullHint")
													})]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-isolation-note",
											children: t("set.perm.current", { current: currentPerm === "read-only" ? t("set.perm.readOnlyName") : currentPerm === "danger-full-access" ? t("set.perm.fullName") : t("set.perm.writeName") })
										})
									]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								children: dirty ? t("set.foot.dirty") : t("set.foot.clean")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-modal-footbtns",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: () => controller.closeSettings(),
									children: t("shared.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-primary": "true",
									disabled: !dirty,
									onClick: save,
									children: t("set.action.save")
								})]
							})]
						})
					]
				})
			});
		}

		//#endregion
		//#region src/client/board/ImportModal.tsx
		/**
		* The ledger-import modal (0.4.0): pick a JSON file → dry-run preview
		* (create / overwrite / invalid classification) → commit as merge or
		* replace. Replace swaps the WHOLE ledger after an automatic backup and a
		* double confirmation. Files exported by ⬇ JSON import as-is.
		*
		* @module dsh-taskboard/client/board/ImportModal
		*/
		/** One classified row (create / overwrite). */
		function PlanRow({ row }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-imp-row",
				title: row.id,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-atb-imp-row-title",
					children: row.title
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-atb-imp-row-status",
					children: row.status
				})]
			});
		}
		/**
		* The import modal.
		* @param controller - the controller.
		*/
		function ImportModal({ controller }) {
			const t = useT();
			const [fileName, setFileName] = (0, react.useState)("");
			const [parsed, setParsed] = (0, react.useState)(null);
			const [parseError, setParseError] = (0, react.useState)(void 0);
			const [plan, setPlan] = (0, react.useState)(void 0);
			const [mode, setMode] = (0, react.useState)("merge");
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(void 0);
			const [confirmReplace, setConfirmReplace] = (0, react.useState)(false);
			const fileRef = (0, react.useRef)(null);
			const { alert: showAlert, el: alertEl } = useAlert();
			/** Read + parse the picked file, then dry-run the preview. */
			const onFile = (file) => {
				setPlan(void 0);
				setParseError(void 0);
				setResult(void 0);
				setConfirmReplace(false);
				setFileName("");
				setParsed(null);
				if (file === void 0) return;
				file.text().then((text) => {
					try {
						const value = JSON.parse(text);
						setParsed(value);
						setFileName(file.name);
						controller.importPreview(value).then((p) => {
							if (p !== void 0) setPlan(p);
						});
					} catch {
						setParseError(t("imp.parseError"));
					}
				});
			};
			/** Commit the import (replace requires the inline double confirmation). */
			const commit = () => {
				if (parsed === null || plan === void 0 || busy) return;
				if (mode === "replace" && !confirmReplace) {
					setConfirmReplace(true);
					return;
				}
				setBusy(true);
				controller.importCommit(mode, parsed).then((r) => {
					setBusy(false);
					setConfirmReplace(false);
					if (r === void 0) return;
					setResult(r.mode === "replace" ? t("imp.result.replace", {
						n: r.created + r.overwritten,
						total: r.replacedTotal ?? 0
					}) : t("imp.result.merge", {
						n: r.created,
						m: r.overwritten
					}));
				});
			};
			const close = () => controller.closeImport();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) close();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-imp",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("imp.aria"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-modal-headicon",
									children: "⬆"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-modal-headtext",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("imp.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("imp.subtitle") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": t("shared.close"),
									onClick: close,
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-body",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-imp-picker",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										ref: fileRef,
										type: "file",
										accept: ".json,application/json",
										onChange: (e) => onFile(e.target.files?.[0])
									}), fileName.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-imp-filename",
										children: fileName
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-imp-note",
									children: t("imp.note")
								}),
								parseError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-imp-error",
									children: parseError
								}),
								plan === void 0 && parseError === void 0 && fileName.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-empty2",
									children: t("imp.previewing")
								}),
								plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-imp-stats",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-atb-imp-stat",
												"data-tone": "ok",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: plan.create.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("imp.stat.create") })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-atb-imp-stat",
												"data-tone": "warn",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: plan.overwrite.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("imp.stat.overwrite") })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-atb-imp-stat",
												"data-tone": plan.invalid.length > 0 ? "bad" : void 0,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: plan.invalid.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("imp.stat.invalid") })]
											})
										]
									}),
									plan.create.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-imp-sec",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("imp.sec.create") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-imp-list",
											children: plan.create.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlanRow, { row: r }, r.id))
										})]
									}),
									plan.overwrite.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-imp-sec",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("imp.sec.overwrite") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-imp-list",
											children: plan.overwrite.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlanRow, { row: r }, r.id))
										})]
									}),
									plan.invalid.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-imp-sec",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("imp.sec.invalid") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-imp-list",
											children: plan.invalid.map((r, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-atb-imp-row",
												"data-tone": "bad",
												title: r.id ?? "",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-imp-row-title",
													children: r.id ?? t("imp.noId")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-imp-row-status",
													children: r.reason
												})]
											}, r.id ?? `invalid-${i}`))
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-mode-picker",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": mode === "merge",
											onClick: () => {
												setMode("merge");
												setConfirmReplace(false);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: t("imp.mode.merge")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: t("imp.mode.mergeHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": mode === "replace",
											onClick: () => setMode("replace"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: t("imp.mode.replace")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: t("imp.mode.replaceHint")
											})]
										})]
									}),
									result !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-imp-result",
										children: result
									})
								] })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								children: mode === "replace" ? confirmReplace ? t("imp.foot.replaceConfirm") : t("imp.foot.replaceNeedConfirm") : t("imp.foot.mergeHint")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-modal-footbtns",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: close,
									children: result !== void 0 ? t("shared.close") : t("shared.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-primary": "true",
									"data-danger": mode === "replace" && confirmReplace ? "true" : void 0,
									disabled: plan === void 0 || busy,
									onClick: commit,
									children: mode === "replace" && confirmReplace ? t("imp.action.confirmReplace") : t("imp.action.run")
								})]
							})]
						})
					]
				}), alertEl]
			});
		}

		//#endregion
		//#region src/client/board/TemplateManager.tsx
		/**
		* The template-manager modal (0.4.0): rename / delete / use the stored task
		* templates. Templates live host-side (side file next to the ledger) and
		* prefill the create form from the + 新建任务 ▼ dropdown.
		*
		* @module dsh-taskboard/client/board/TemplateManager
		*/
		/**
		* The template manager modal.
		* @param controller - the controller.
		*/
		function TemplateManager({ controller }) {
			const t = useT();
			const state = controller.getSnapshot();
			const [edits, setEdits] = (0, react.useState)({});
			const [confirmId, setConfirmId] = (0, react.useState)(void 0);
			const { alert: showAlert, el: alertEl } = useAlert();
			const close = () => controller.closeTemplateManager();
			const nameOf = (id, fallback) => edits[id] ?? fallback;
			/** Save one template's rename. */
			const save = (id, name) => {
				const template = state.templates.find((t) => t.id === id);
				if (template === void 0 || name === template.name) return;
				controller.upsertTemplate({
					id,
					name,
					task: template.task
				}).then((ok) => {
					if (ok) {
						setEdits((prev) => {
							const next = { ...prev };
							delete next[id];
							return next;
						});
						showAlert(t("tpl.renamed"));
					}
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) close();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-tplm",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("tpl.aria"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-modal-headicon",
									children: "⌗"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-modal-headtext",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("tpl.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("tpl.subtitle") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": t("shared.close"),
									onClick: close,
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-modal-body",
							children: state.templates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-empty2",
								children: t("tpl.empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-tplm-list",
								children: state.templates.map((tpl) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-tplm-row",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "dsh-atb-tplm-name",
											value: nameOf(tpl.id, tpl.name),
											maxLength: 60,
											spellCheck: false,
											"aria-label": t("tpl.name.aria", { name: tpl.name }),
											onChange: (e) => setEdits((prev) => ({
												...prev,
												[tpl.id]: e.target.value
											})),
											onKeyDown: (e) => {
												if (e.key === "Enter") save(tpl.id, nameOf(tpl.id, tpl.name));
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-tplm-meta",
											title: `${tpl.builtin === true ? t("tpl.builtin") : t("tpl.custom")}${tpl.task.checklist !== void 0 && tpl.task.checklist.length > 0 ? t("tpl.meta.checklist", { n: tpl.task.checklist.length }) : ""}${tpl.task.urgency !== void 0 ? ` · ${tpl.task.urgency}` : ""}${tpl.task.permission !== void 0 ? ` · ${t("shared.permission")}: ${tpl.task.permission}` : ""}`,
											children: [
												tpl.builtin === true ? t("tpl.builtin") : t("tpl.custom"),
												tpl.task.checklist !== void 0 && tpl.task.checklist.length > 0 ? t("tpl.meta.checklist", { n: tpl.task.checklist.length }) : "",
												tpl.task.urgency !== void 0 ? ` · ${tpl.task.urgency}` : "",
												tpl.task.permission !== void 0 && tpl.task.permission !== "workspace-write" ? ` · ${tpl.task.permission === "read-only" ? t("tpl.meta.permReadOnly") : t("tpl.meta.permFull")}` : ""
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-tplm-btns",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsh-atb-btn",
													disabled: nameOf(tpl.id, tpl.name) === tpl.name || nameOf(tpl.id, tpl.name).trim().length === 0,
													title: t("tpl.rename.title"),
													onClick: () => save(tpl.id, nameOf(tpl.id, tpl.name)),
													children: t("tpl.rename.button")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsh-atb-btn",
													title: t("tpl.use.title"),
													onClick: () => {
														close();
														controller.newFromTemplate(tpl.task);
													},
													children: t("tpl.use.button")
												}),
												confirmId === tpl.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsh-atb-btn",
													"data-danger": "true",
													onClick: () => {
														controller.deleteTemplate(tpl.id);
														setConfirmId(void 0);
													},
													children: t("shared.confirmDelete")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsh-atb-btn",
													onClick: () => setConfirmId(void 0),
													children: t("shared.cancel")
												})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsh-atb-btn",
													"data-danger": "true",
													title: t("tpl.delete.title"),
													onClick: () => setConfirmId(tpl.id),
													children: "🗑"
												})
											]
										})
									]
								}, tpl.id))
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								children: t("tpl.foot.hint")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-footbtns",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: close,
									children: t("shared.close")
								})
							})]
						})
					]
				}), alertEl]
			});
		}

		//#endregion
		//#region src/client/board/TaskBoard.tsx
		/**
		* The main board view: toolbar (project filter, urgency chips, secondary tab,
		* composer), five status columns, the detail pane, and the new-task modal.
		*
		* @module dsh-taskboard/client/board/TaskBoard
		*/
		/** Urgency sort rank (urgent first). */
		const URGENCY_RANK = {
			urgent: 0,
			normal: 1,
			relaxed: 2
		};
		/** Apply the active filters + search + sort to a task list. */
		function filterTasks(state, tasks) {
			const q = state.search.trim().toLowerCase();
			const filtered = tasks.filter((t) => (state.filters.workspaceId === void 0 || t.workspaceId === state.filters.workspaceId) && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(t.urgency)) && (q.length === 0 || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)));
			if (state.sortBy === "default") return filtered;
			const sorted = [...filtered];
			if (state.sortBy === "updated") sorted.sort((a, b) => b.updatedAt - a.updatedAt);
			else if (state.sortBy === "created") sorted.sort((a, b) => b.createdAt - a.createdAt);
			else if (state.sortBy === "urgency") sorted.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || b.updatedAt - a.updatedAt);
			else if (state.sortBy === "title") sorted.sort((a, b) => a.title.localeCompare(b.title, void 0, { numeric: true }));
			return sorted;
		}
		/**
		* The board view root.
		* @param controller - the controller.
		*/
		function TaskBoard({ controller }) {
			const t = useT();
			const state = (0, react.useSyncExternalStore)((cb) => controller.subscribe(cb), () => controller.getSnapshot());
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				const timer = setInterval(() => setNow(Date.now()), 6e4);
				return () => clearInterval(timer);
			}, []);
			const live = filterTasks(state, state.ledger.tasks.filter((t) => t.trashedAt === void 0));
			const selected = state.selectedId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.selectedId);
			const { alert: showAlert, el: alertEl } = useAlert();
			const [newMenuOpen, setNewMenuOpen] = (0, react.useState)(false);
			const closeMenu = () => setNewMenuOpen(false);
			const [exportOpen, setExportOpen] = (0, react.useState)(false);
			const closeExport = () => setExportOpen(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-board",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "dsh-atb-title",
								children: t("board.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count",
								children: t("board.count.tasks", {
									n: live.length,
									rev: state.ledger.revision
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-newmenu",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-primary": "true",
									onClick: () => {
										const next = !newMenuOpen;
										setNewMenuOpen(next);
										if (next) controller.prepareTemplateMenu();
									},
									children: t("board.action.newTask")
								}), newMenuOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-newmenu-backdrop",
									onClick: closeMenu
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-newmenu-list",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-newmenu-opt",
											onClick: () => {
												closeMenu();
												controller.setComposer(true);
											},
											children: t("board.action.blankTask")
										}),
										state.templates.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-newmenu-opt",
											title: t.task.description !== void 0 && t.task.description.length > 0 ? t.task.description.slice(0, 120) : t.name,
											onClick: () => {
												closeMenu();
												controller.newFromTemplate(t.task);
											},
											children: t.name
										}, t.id)),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsh-atb-newmenu-sep" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-newmenu-opt",
											onClick: () => {
												closeMenu();
												controller.openTemplateManager();
											},
											children: t("board.action.manageTemplates")
										})
									]
								})] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsh-atb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsh-atb-input dsh-atb-search",
								value: state.search,
								placeholder: t("board.search.placeholder"),
								spellCheck: false,
								onChange: (e) => controller.setSearch(e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsh-atb-select",
								value: state.filters.workspaceId ?? "",
								onChange: (e) => controller.setWorkspaceFilter(e.target.value === "" ? void 0 : e.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("board.filter.allProjects")
								}), state.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: ws.id,
									children: ws.title || ws.path
								}, ws.id))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsh-atb-select",
								value: state.sortBy,
								title: t("board.sort.title"),
								onChange: (e) => controller.setSortBy(e.target.value),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "default",
										children: t("board.sort.default")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "updated",
										children: t("board.sort.updated")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "urgency",
										children: t("board.sort.urgency")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "created",
										children: t("board.sort.created")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "title",
										children: t("board.sort.byTitle")
									})
								]
							}),
							[
								"urgent",
								"normal",
								"relaxed"
							].map((u) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-chip",
								"data-urgency": u,
								"data-on": state.filters.urgencies.includes(u),
								onClick: () => controller.toggleUrgency(u),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-dot",
									"data-urgency": u
								}), t(URGENCY_KEYS[u])]
							}, u)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								onClick: () => controller.toggleSecondary(),
								children: state.secondaryOpen ? t("board.action.backToBoard") : t("board.action.otherTasks")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: t("board.action.settingsTitle"),
								onClick: () => controller.openSettings(),
								children: t("board.action.settings")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: t("board.action.diagTitle"),
								onClick: () => controller.openDiagnostics(),
								children: t("board.action.diag")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: t("board.action.importTitle"),
								onClick: () => controller.openImport(),
								children: t("board.action.import")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-newmenu",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									title: t("board.action.exportTitle"),
									onClick: () => setExportOpen(!exportOpen),
									children: t("board.action.export")
								}), exportOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-newmenu-backdrop",
									onClick: closeExport
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-newmenu-list",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-newmenu-opt",
										title: t("board.export.jsonTitle"),
										onClick: () => {
											closeExport();
											controller.exportJson();
										},
										children: t("board.export.json")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-newmenu-opt",
										title: t("board.export.csvTitle"),
										onClick: () => {
											closeExport();
											controller.exportCsv();
										},
										children: t("board.export.csv")
									})]
								})] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
								className: "dsh-atb-ver",
								href: "https://github.com/cloader/dsh-taskboard",
								target: "_blank",
								rel: "noopener noreferrer",
								children: ["V", PLUGIN_VERSION]
							})
						]
					}),
					state.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-error",
						children: state.error
					}),
					state.secondaryOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SecondaryTab, {
						controller,
						tasks: filterTasks(state, state.ledger.tasks)
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-columns",
						children: MAIN_STATUSES.map((status) => {
							const columnTasks = live.filter((t) => t.status === status);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-column",
								onDragOver: (e) => {
									if (e.dataTransfer.types.includes("application/x-dsh-atb-task")) {
										e.preventDefault();
										e.dataTransfer.dropEffect = "move";
										e.currentTarget.dataset.dragover = "true";
									}
								},
								onDragLeave: (e) => {
									delete e.currentTarget.dataset.dragover;
								},
								onDrop: (e) => {
									e.preventDefault();
									delete e.currentTarget.dataset.dragover;
									const id = e.dataTransfer.getData(DRAG_TYPE);
									if (id.length === 0) return;
									const task = state.ledger.tasks.find((t) => t.id === id);
									if (task === void 0 || task.status === status) return;
									if (!canTransition(task.status, status)) {
										showAlert(t("board.drag.forbidden", {
											from: t(COLUMN_KEYS[task.status]),
											to: t(COLUMN_KEYS[status])
										}));
										return;
									}
									controller.move(id, task.version, status);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-colhead",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-dot",
											"data-status": status
										}),
										t(COLUMN_KEYS[status]),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-colcount",
											children: columnTasks.length
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-cards",
									children: [columnTasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
										task,
										controller,
										draggable: true,
										now,
										onAlert: showAlert
									}, task.id)), columnTasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty",
										children: t("board.empty")
									})]
								})]
							}, status);
						})
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-detailpanel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetail, {
							task: selected,
							controller,
							now
						}, selected.id)
					}),
					state.composerOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskFormModal, {
						controller,
						task: state.editingId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.editingId)
					}),
					state.diagOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnosticsPanel, { controller }),
					state.settingsOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsModal, { controller }),
					state.importOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImportModal, { controller }),
					state.tplManagerOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TemplateManager, { controller }),
					alertEl
				]
			});
		}
		/** ⚙ Health-diagnostics panel (plan §3.6): ledger basics + orphan worktrees + one-click cleanup. */
		function DiagnosticsPanel({ controller }) {
			const t = useT();
			const state = controller.getSnapshot();
			const diag = state.diagnostics;
			const wsName = (id) => {
				const ws = state.workspaces.find((w) => w.id === id);
				return ws?.title ?? ws?.path ?? id.slice(0, 8);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeDiagnostics();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-diag",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("diag.title"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-modal-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-headicon",
								children: "⚙"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-modal-headtext",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("diag.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("diag.subtitle") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-modal-close",
								"aria-label": t("shared.close"),
								onClick: () => controller.closeDiagnostics(),
								children: "✕"
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-modal-body",
						children: diag === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-empty2",
							children: t("shared.loading")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-grid",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.revision }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("diag.revision") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.tasks }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("diag.tasks") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										"data-bad": diag.staleRunning > 0 ? "true" : void 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.staleRunning }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("diag.running") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										"data-bad": diag.orphanWorktrees.length > 0 ? "true" : void 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.orphanWorktrees.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("diag.orphans") })]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-sec",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("diag.orphans.heading") }),
									diag.orphanWorktrees.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty2",
										children: t("diag.orphans.none")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-diag-orphans",
										children: diag.orphanWorktrees.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-diag-orphan",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsh-atb-diag-orphan-path",
												title: o.path,
												children: [
													wsName(o.workspaceId),
													" · ",
													o.taskId
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsh-atb-btn",
												"data-danger": "true",
												onClick: () => void controller.cleanupOrphan(o.workspaceId, o.taskId),
												children: t("diag.orphans.cleanup")
											})]
										}, o.path))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty2",
										children: t("diag.orphans.hint")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-sec",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("diag.gitignore.heading") }), (diag.gitIgnoreSuggestions ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-empty2",
									children: t("diag.gitignore.none")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-diag-orphans",
									children: diag.gitIgnoreSuggestions.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-diag-orphan",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-diag-orphan-path",
											title: s.workspacePath,
											children: [
												wsName(s.workspaceId),
												" · ",
												t("diag.gitignore.suggestA"),
												" ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".dsh-worktrees/" }),
												t("diag.gitignore.suggestB")
											]
										})
									}, s.workspaceId))
								})]
							})
						] })
					})]
				})
			});
		}
		/** Secondary tab: tasks grouped into canceled / archived / trashed columns. */
		function SecondaryTab({ controller, tasks }) {
			const t = useT();
			const trashed = tasks.filter((t) => t.trashedAt !== void 0);
			const archived = tasks.filter((t) => t.trashedAt === void 0 && t.status === "archived");
			const canceled = tasks.filter((t) => t.trashedAt === void 0 && t.status === "canceled");
			const groups = [
				{
					label: t("status.column.canceled"),
					dot: "canceled",
					rows: canceled
				},
				{
					label: t("status.column.archived"),
					dot: "archived",
					rows: archived
				},
				{
					label: t("board.group.trashed"),
					dot: "trashed",
					rows: trashed
				}
			];
			if (trashed.length + archived.length + canceled.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-secondary",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-empty",
					children: t("board.secondary.empty")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-columns",
				children: groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-column",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-colhead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-dot",
								"data-status": group.dot
							}),
							group.label,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-colcount",
								children: group.rows.length
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-cards",
						children: [group.rows.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
							task,
							controller
						}, task.id)), group.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-empty",
							children: t("board.empty")
						})]
					})]
				}, group.label))
			});
		}

		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Board view mounting: a container appended inside the center column (a
		* trailing child React never manages), with a stylesheet rule hiding the
		* conversation content while the board is active. Toggling rides a data
		* attribute on <html> — no React involvement in the shell.
		*
		* Column matching is TRIPLE-generation: the dev shell marks the column
		* with `data-pane="conversation"`; the official layout shell
		* (dsh-client-ui-layout) dropped data-pane and uses CSS-Module hashed
		* class names (`pI_x6G_centerCol`) — and DSH Desktop's non-compat
		* (extended) mode disables the official layout row entirely, owning the
		* columns itself (`main.dshDesktopConversationSurface`, 0.5.2) — the
		* fallbacks keep all three mounting, exactly like sidebar-entry's column
		* selector.
		*
		* @module dsh-taskboard/client/board-mount
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"], .dshDesktopConversationSurface";
		const ACTIVE_ATTR = "data-dsh-atb-active";
		/** Sibling panels' activation attributes, evicted when this board opens. */
		const OTHER_ACTIVE_ATTRS = ["data-dsh-taskboard-active", "data-dsh-ssh-active"];
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "dsh-taskboard";
		/** Find the center column. */
		function conversationColumn() {
			return document.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
		}
		/**
		* Mount the board React tree and bind visibility to the controller.
		* @param controller - the controller.
		* @returns disposer.
		*/
		function mountBoard(controller) {
			let root;
			let container;
			const ensure = () => {
				if (container !== void 0) return;
				const column = conversationColumn();
				if (column === void 0) return;
				container = document.createElement("div");
				container.dataset.dshAtbView = "";
				container.className = "dsh-atb-view";
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskBoard, { controller }));
			};
			const waitObserver = new MutationObserver(() => {
				ensure();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const applyActive = () => {
				if (controller.getSnapshot().boardOpen) {
					for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
					document.documentElement.setAttribute(ACTIVE_ATTR, "");
					document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
				} else document.documentElement.removeAttribute(ACTIVE_ATTR);
			};
			const onOtherActivate = (event) => {
				if (event.detail !== PANEL_NAME && controller.getSnapshot().boardOpen) controller.closeBoard();
			};
			const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
			const onClickSidebarRow = (event) => {
				if (!controller.getSnapshot().boardOpen) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest("[data-dsh-atb-entry]") !== null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			const unsubscribe = controller.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				waitObserver.disconnect();
				unsubscribe();
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				root?.unmount();
				container?.remove();
			};
		}

		//#endregion
		//#region src/client/session-jump.ts
		/**
		* Build the jump function the controller installs.
		* @param access - lazy service accessors, consulted on every jump.
		* @returns the jump function: `(sessionId) => Promise<SessionJumpResult>`.
		*/
		function createSessionJumper(access) {
			const lookup = (sessions, workspaces, sessionId) => {
				if (sessions.list.getSnapshot().byId[sessionId] === void 0) return "absent";
				return workspaces?.list.getSnapshot().archivedSessionIds.includes(sessionId) ?? false ? "archived" : "openable";
			};
			return async (sessionId) => {
				const sessions = access.getSessions();
				if (sessions === void 0) return "unavailable";
				try {
					let state = lookup(sessions, access.getWorkspaces(), sessionId);
					if (state === "absent") {
						try {
							await sessions.refresh();
						} catch {}
						state = lookup(sessions, access.getWorkspaces(), sessionId);
					}
					if (state === "archived") return "archived";
					if (state === "absent") return "missing";
					sessions.open(sessionId);
					return "opened";
				} catch {
					return "unavailable";
				}
			};
		}

		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half entry for dsh-taskboard: wires the route client and the
		* board controller, exposes the model catalog (via the runtime's llm.models
		* RPC when the connection service is present), mounts the sidebar entry and
		* the board view.
		*
		* Failure policy: DOM mounting problems are logged, never thrown — the web
		* shell fails the whole boot when a plugin apply throws.
		*
		* Export shape: `name` / `inject` / `apply`, no default.
		*
		* @module dsh-taskboard/client
		*/
		/** Client plugin name. */
		const name = "dsh-taskboard/client";
		/** Required client services (fiber inject waiting). */
		const inject = ["connection"];
		/**
		* Client entry: installs styles, starts the controller, mounts DOM seats.
		* @param ctx - the cordis client context.
		*/
		function apply(ctx) {
			try {
				injectStyles();
				initI18n(ctx.get?.("locale"));
				const client = createClient();
				const controller = new BoardController(client);
				controller.installModelCatalog(async () => {
					try {
						const modelDirs = ctx.get?.("modelDirectories") ?? ctx.modelDirectories;
						if (modelDirs?.catalog?.load !== void 0) {
							const res = await modelDirs.catalog.load();
							if (res?.groups !== void 0 && res.groups.length > 0) {
								const out = [];
								for (const group of res.groups) for (const model of group.models) out.push({
									provider: group.id,
									model: model.id,
									name: model.name,
									...model.description !== void 0 ? { description: model.description } : {},
									...model.reasoning !== void 0 ? { reasoning: model.reasoning } : {}
								});
								if (out.length > 0) return out;
							}
						}
					} catch {}
					try {
						const remote = ctx.get?.("remote") ?? ctx.remote;
						if (remote?.session?.modelCatalog !== void 0) {
							const res = await remote.session.modelCatalog();
							if (res.ok && res.value?.groups !== void 0 && res.value.groups.length > 0) {
								const out = [];
								for (const group of res.value.groups) for (const model of group.models) out.push({
									provider: group.id,
									model: model.id,
									name: model.name,
									...model.description !== void 0 ? { description: model.description } : {},
									...model.reasoning !== void 0 ? { reasoning: model.reasoning } : {}
								});
								if (out.length > 0) return out;
							}
						}
						if (remote?.llm?.models !== void 0) {
							const res = await remote.llm.models({});
							if (res.result.ok && res.result.value?.groups !== void 0 && res.result.value.groups.length > 0) {
								const out = [];
								for (const group of res.result.value.groups) for (const model of group.models) out.push({
									provider: group.id,
									model: model.id,
									name: model.name,
									...model.description !== void 0 ? { description: model.description } : {},
									...model.reasoning !== void 0 ? { reasoning: model.reasoning } : {}
								});
								if (out.length > 0) return out;
							}
						}
					} catch {}
					try {
						const connection = ctx.get?.("connection") ?? ctx.connection;
						if (connection?.api?.llm?.models !== void 0) {
							const res = await connection.api.llm.models({});
							if (res.result.ok && res.result.value?.groups !== void 0 && res.result.value.groups.length > 0) {
								const out = [];
								for (const group of res.result.value.groups) for (const model of group.models) out.push({
									provider: group.id,
									model: model.id,
									name: model.name,
									...model.description !== void 0 ? { description: model.description } : {},
									...model.reasoning !== void 0 ? { reasoning: model.reasoning } : {}
								});
								if (out.length > 0) return out;
							}
						}
					} catch {}
					try {
						const res = await client.modelCatalog();
						if (res.models !== void 0 && res.models.length > 0) return res.models;
					} catch {}
					return [];
				});
				controller.installPresetRoster(async () => {
					try {
						const remote = ctx.get?.("remote") ?? ctx.remote;
						if (remote?.agentPresets?.list !== void 0) {
							const res = await remote.agentPresets.list();
							const rawPresets = res.ok === true ? res.value.presets : res.result?.ok === true ? res.result.value.presets : void 0;
							if (rawPresets !== void 0 && rawPresets.length > 0) {
								const presets = rawPresets.map((p) => ({
									id: p.id,
									name: p.name
								}));
								const def = rawPresets.find((p) => p.isDefault);
								return {
									presets,
									...def !== void 0 ? { defaultId: def.id } : {}
								};
							}
						}
					} catch {}
					try {
						const connection = ctx.get?.("connection") ?? ctx.connection;
						if (connection?.api?.agentPresets?.list !== void 0) {
							const res = await connection.api.agentPresets.list({});
							if (res.result.ok && res.result.value?.presets !== void 0 && res.result.value.presets.length > 0) {
								const presets = res.result.value.presets.map((p) => ({
									id: p.id,
									name: p.name
								}));
								const def = res.result.value.presets.find((p) => p.isDefault);
								return {
									presets,
									...def !== void 0 ? { defaultId: def.id } : {}
								};
							}
						}
					} catch {}
					try {
						const res = await client.modelCatalog();
						if (res.presets !== void 0 && res.presets.length > 0) return {
							presets: res.presets,
							...res.defaultPresetId !== void 0 ? { defaultId: res.defaultPresetId } : {}
						};
					} catch {}
					return { presets: [] };
				});
				controller.installSessionJumper(createSessionJumper({
					getSessions: () => ctx.get?.("sessions"),
					getWorkspaces: () => ctx.get?.("workspaces")
				}));
				controller.start();
				const disposers = [];
				try {
					disposers.push(mountSidebarEntry(controller));
					disposers.push(mountBoard(controller));
				} catch (error) {
					console.error("[dsh-taskboard] mount failed:", error);
				}
				ctx.effect?.(() => () => {
					for (const d of disposers.splice(0)) d();
					controller.dispose();
					disposeI18n();
				}, "dsh-taskboard: client mount");
			} catch (error) {
				console.error("[dsh-taskboard] client half failed to start:", error);
			}
		}

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
