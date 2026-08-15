window.__ModuleLoader__.load({
	id: "dsh-taskboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
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
		async function post(path, body) {
			return unwrap(await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}));
		}
		/** Build the client over fetch + EventSource. */
		function createClient() {
			return {
				state: () => unwrap(fetch("/dsh-taskboard/state")),
				workspaces: () => unwrap(fetch("/dsh-taskboard/workspaces")),
				create: (body) => post("/dsh-taskboard/tasks", body),
				get: (id) => unwrap(fetch(`/dsh-taskboard/tasks/${encodeURIComponent(id)}`)),
				update: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/update`, body),
				move: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/move`, body),
				comment: (id, bodyText) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/comment`, { body: bodyText }),
				remove: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/delete`, body),
				run: (id) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/run`, {}),
				stream(onChange, onGap) {
					const es = new EventSource("/dsh-taskboard/events");
					let revision;
					const hello = (event) => {
						const payload = JSON.parse(event.data);
						if (revision !== void 0 && payload.revision !== revision) onGap();
						revision = payload.revision;
					};
					const change = (event) => {
						const payload = JSON.parse(event.data);
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

		//#endregion
		//#region src/client/controller.ts
		/** Instantiate the default state. */
		function initialState() {
			return {
				boardOpen: false,
				ledger: emptyLedger(),
				workspaces: [],
				filters: { urgencies: [] },
				composerOpen: false,
				secondaryOpen: false
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
					this.setState({ ledger: {
						...this.state.ledger,
						revision: change.revision
					} });
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
						const [ledger, workspaces] = await Promise.all([this.client.state(), this.client.workspaces()]);
						let selected;
						if (this.state.selectedId !== void 0) selected = ledger.tasks.find((t) => t.id === this.state.selectedId);
						this.setState({
							ledger,
							workspaces,
							error: void 0,
							selectedId: selected === void 0 ? void 0 : this.state.selectedId
						});
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
			/** Set the project filter. */
			setWorkspaceFilter(workspaceId) {
				this.setState({ filters: {
					...this.state.filters,
					workspaceId
				} });
			}
			/** Toggle one urgency chip. */
			toggleUrgency(urgency) {
				const set = new Set(this.state.filters.urgencies);
				if (set.has(urgency)) set.delete(urgency);
				else set.add(urgency);
				this.setState({ filters: {
					...this.state.filters,
					urgencies: [...set]
				} });
			}
			/** Select a task (open detail). */
			select(id) {
				this.setState({ selectedId: id });
			}
			/** Show/hide the task form (create mode when opening). */
			setComposer(open) {
				this.setState({
					composerOpen: open,
					editingId: void 0
				});
			}
			/** Open the form modal editing an existing task. */
			openEditor(id) {
				this.setState({
					composerOpen: true,
					editingId: id
				});
			}
			/** Close the form modal whatever its mode. */
			closeForm() {
				this.setState({
					composerOpen: false,
					editingId: void 0
				});
			}
			/** Toggle the secondary tab. */
			toggleSecondary() {
				this.setState({ secondaryOpen: !this.state.secondaryOpen });
			}
			/** Create a task (composer submit). */
			async create(body) {
				try {
					await this.client.create(body);
					this.setState({
						composerOpen: false,
						error: void 0
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
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
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
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
			/** Append a user comment. */
			async comment(id, body) {
				try {
					await this.client.comment(id, body);
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Trigger a manual run (fresh in-project session, pinned model). */
			async run(id) {
				try {
					await this.client.run(id);
					await this.refresh();
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
		  display: flex; align-items: center; gap: 8px;
		  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
		  border: none; border-radius: 8px; background: transparent;
		  color: var(--dsw-text-secondary, inherit); font: inherit; font-size: 13px;
		  cursor: pointer; text-align: left;
		}
		.dsh-atb-entry:hover { background: var(--dsw-hover, rgba(128,128,128,.12)); color: var(--dsw-text-primary, inherit); }
		.dsh-atb-entry[data-active="true"] { background: var(--dsw-active, rgba(128,128,128,.18)); color: var(--dsw-text-primary, inherit); font-weight: 500; }
		.dsh-atb-entry svg { flex: none; }

		html[data-dsh-atb-active] [data-pane="conversation"] > *:not([data-dsh-atb-view]) { display: none !important; }
		.dsh-atb-view { display: none; }
		html[data-dsh-atb-active] .dsh-atb-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

		.dsh-atb-board { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 12px 16px; gap: 10px; box-sizing: border-box; }
		.dsh-atb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.dsh-atb-title { font-size: 15px; font-weight: 600; margin: 0; }
		.dsh-atb-count { font-size: 12px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-spacer { flex: 1; }
		.dsh-atb-select, .dsh-atb-input {
		  font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: var(--dsw-bg, transparent); color: inherit;
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
		.dsh-atb-runbtn {
		  font: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 9px; cursor: pointer;
		  border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); color: var(--dsw-alias-label-primary-foreground, #fff); text-align: center;
		  transition: filter .12s ease;
		}
		.dsh-atb-runbtn:hover { filter: brightness(1.1); }
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
		.dsh-atb-exec-session { font-size: 11px; color: var(--dsw-text-secondary, gray); }
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
		`;
		let injected = false;
		/** Inject the stylesheet once (idempotent). */
		function injectStyles() {
			if (injected || typeof document === "undefined") return;
			const style = document.createElement("style");
			style.id = "dsh-taskboard-styles";
			style.textContent = STYLES;
			document.head.append(style);
			injected = true;
		}

		//#endregion
		//#region src/client/sidebar-entry.ts
		/** Inline icon (16px nav-icon look). */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2.5\" width=\"12\" height=\"11\" rx=\"1.5\"/><path d=\"M2 6.5h12M6.5 6.5v7\"/></svg>";
		/**
		* Find the sidebar shell root element, or undefined while not yet mounted.
		* (Same as the working family plugins: sidebarCol pane → logoRow owner.)
		*/
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/**
		* The New Session button: nested in the logo row on current shells, a direct
		* child BUTTON on the real shell (the family plugins' fallback), with
		* aria-label/text fallbacks for other shells.
		*/
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child instanceof HTMLButtonElement) return child;
			const byAria = root.querySelector("button[aria-label=\"新建会话\"], button[aria-label=\"New Session\"], button[aria-label*=\"新会话\"], button[aria-label*=\"new session\" i]");
			if (byAria !== null) return byAria;
			return Array.from(root.querySelectorAll("button")).find((button) => /新会话|新建会话|new session/i.test(button.textContent ?? ""));
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshAtbEntry = "";
			entry.className = "dsh-atb-entry";
			entry.setAttribute("aria-label", "Agent 任务看板");
			entry.innerHTML = `<span class="dsh-atb-entry-icon">${ICON}</span><span class="dsh-atb-entry-label">任务看板</span>`;
			entry.addEventListener("click", () => {
				controller.toggleBoard();
			});
			return entry;
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
			window.__atbDebug = debug;
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
			const syncActive = () => {
				if (controller.getSnapshot().boardOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			tryPlace();
			return () => {
				clearInterval(retry);
				waitObserver.disconnect();
				rootObserver.disconnect();
				unsubscribe();
				entry.remove();
			};
		}

		//#endregion
		//#region src/client/board/TaskCard.tsx
		const URGENCY_LABEL$1 = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		const OUTCOME_LABEL$1 = {
			running: "执行中",
			succeeded: "成功",
			failed: "失败",
			cancelled: "已取消"
		};
		/** dataTransfer type carrying the dragged task id. */
		const DRAG_TYPE = "application/x-dsh-atb-task";
		/**
		* The card view.
		* @param task - the task record.
		* @param controller - the controller.
		* @param draggable - enable dragging (backlog/todo columns only).
		*/
		function TaskCard({ task, controller, draggable = false }) {
			const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dsh-atb-card",
				"data-urgency": task.urgency,
				draggable,
				onDragStart: (e) => {
					e.dataTransfer.setData(DRAG_TYPE, task.id);
					e.dataTransfer.effectAllowed = "move";
					e.currentTarget.dataset.dragging = "true";
				},
				onDragEnd: (e) => {
					delete e.currentTarget.dataset.dragging;
				},
				onClick: () => controller.select(task.id),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-card-title",
					children: task.title
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-card-meta",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							children: URGENCY_LABEL$1[task.urgency]
						}),
						task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							"data-kind": "blocked",
							children: "受阻"
						}),
						task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-atb-badge",
							"data-kind": "scheduled",
							children: ["⏰ ", fmtTime(task.execution.nextRunAt)]
						}),
						task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							children: task.model.model
						}),
						task.status === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							"data-kind": "done",
							children: "完成"
						}),
						last !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							"data-kind": last.outcome === "running" ? "running" : last.outcome,
							children: OUTCOME_LABEL$1[last.outcome] ?? last.outcome
						}),
						task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["💬 ", task.comments.length] }),
						task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-badge",
							"data-kind": "trashed",
							children: "待清除"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { marginLeft: "auto" },
							children: fmtTime(task.updatedAt)
						})
					]
				})]
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
		const MOVE_LABEL = {
			backlog: "待规划",
			todo: "待办",
			in_progress: "进行中",
			in_review: "待验收",
			done: "完成",
			canceled: "取消",
			archived: "归档"
		};
		const STATUS_LABEL = { ...MOVE_LABEL };
		const URGENCY_LABEL = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		const OUTCOME_LABEL = {
			running: "执行中",
			succeeded: "成功",
			failed: "失败",
			cancelled: "已取消"
		};
		/** Compact session-id display. */
		function shortId(id) {
			if (id === void 0) return "";
			return id.replace(/^session-/, "").slice(0, 8);
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
		function Chip({ icon, children, tone }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-atb-chip2",
				"data-tone": tone,
				children: [icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-atb-chip2-icon",
					children: icon
				}), children]
			});
		}
		/**
		* The detail view.
		* @param task - the task record.
		* @param controller - the controller.
		*/
		function TaskDetail({ task, controller }) {
			const [comment, setComment] = (0, react.useState)("");
			const [confirmDone, setConfirmDone] = (0, react.useState)(false);
			const [confirmPurge, setConfirmPurge] = (0, react.useState)(false);
			const ws = controller.getSnapshot().workspaces.find((w) => w.id === task.workspaceId);
			const canRun = task.status !== "in_progress" && task.status !== "done" && task.status !== "archived";
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
										children: STATUS_LABEL[task.status] ?? task.status
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-chips",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											tone: task.urgency,
											children: ["● ", URGENCY_LABEL[task.urgency] ?? task.urgency]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "📁",
											children: ws?.title ?? shortId(task.workspaceId)
										}),
										task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "✦",
											children: task.model.model
										}),
										task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: "⏰",
											children: [
												task.execution.cron,
												" · 下次 ",
												fmtTime(task.execution.nextRunAt)
											]
										}),
										task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "⛔",
											tone: "urgent",
											children: "受阻"
										}),
										task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🗑",
											tone: "urgent",
											children: "已删除待清除"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, { children: ["v", task.version] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-sub",
									children: [
										"更新 ",
										fmtTime(task.updatedAt),
										" · 最近操作 ",
										task.updatedBy.kind === "agent" ? `🤖 ${shortId(task.updatedBy.sessionId)}` : "👤 用户"
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-detail-topbtns",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-detail-edit",
								onClick: () => controller.openEditor(task.id),
								children: "✎ 编辑"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-detail-close",
								"aria-label": "关闭",
								onClick: () => controller.select(void 0),
								children: "✕"
							})]
						})]
					}),
					task.description.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: "描述"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-desc",
							children: task.description
						})]
					}),
					task.prompt.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						"data-kind": "prompt",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: "执行 Prompt"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-promptbox",
							children: task.prompt
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-detail-actions",
						children: [canRun && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "dsh-atb-runbtn",
							onClick: () => void controller.run(task.id),
							children: ["▶ 执行 · 新会话", task.model !== void 0 ? `（${task.model.model}）` : "（默认模型）"]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-movebtns",
							children: [moveTargets(task).map((to) => to === "done" ? confirmDone ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-confirm",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-confirm-label",
										children: "确认完成？"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-primary": "true",
										onClick: () => {
											controller.move(task.id, task.version, "done");
											setConfirmDone(false);
										},
										children: "确认"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => setConfirmDone(false),
										children: "取消"
									})
								]
							}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-movebtn",
								"data-to": to,
								onClick: () => setConfirmDone(true),
								children: ["✓ ", MOVE_LABEL[to]]
							}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-movebtn",
								"data-to": to,
								onClick: () => void controller.move(task.id, task.version, to),
								children: MOVE_LABEL[to]
							}, to)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-movebtn",
								"data-to": "blocked",
								onClick: () => void controller.toggleBlocked(task),
								children: task.blocked ? "✓ 解除受阻" : "⛔ 标记受阻"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: ["评论", task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								children: task.comments.length
							})] }),
							task.comments.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-empty2",
								children: "暂无评论 — agent 交接时会在这里汇报改动与验证结果"
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
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: c.threadId !== void 0 ? `agent ${shortId(c.threadId)}` : "用户" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fmtTime(c.createdAt) })]
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
									placeholder: "以用户身份留言（agent 开工前会读）…",
									onChange: (e) => setComment(e.target.value),
									onKeyDown: (e) => {
										if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && comment.trim().length > 0) {
											controller.comment(task.id, comment);
											setComment("");
										}
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-composer-send",
									disabled: comment.trim().length === 0,
									onClick: () => {
										controller.comment(task.id, comment);
										setComment("");
									},
									children: "发表"
								})]
							})
						]
					}),
					task.executions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: ["执行记录", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-atb-count2",
							children: task.executions.length
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-execlist",
							children: task.executions.map((e) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-exec-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-dot",
										"data-outcome": e.outcome
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-trigger",
										children: e.trigger === "manual" ? "手动" : "定时"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-outcome",
										"data-outcome": e.outcome,
										children: OUTCOME_LABEL[e.outcome] ?? e.outcome
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-time",
										children: [fmtTime(e.startedAt), e.endedAt !== void 0 && ` · ${duration(e.startedAt, e.endedAt)}`]
									}),
									e.sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-session",
										title: e.sessionId,
										children: ["🤖 ", shortId(e.sessionId)]
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
							children: "🗑 删除（标记待清除）"
						}) : confirmPurge ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-atb-confirm",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-confirm-label",
									children: "物理清除不可恢复"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-danger": "true",
									onClick: () => {
										controller.remove(task.id, task.version, true);
										setConfirmPurge(false);
									},
									children: "确认清除"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: () => setConfirmPurge(false),
									children: "取消"
								})
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-danger": "true",
							onClick: () => setConfirmPurge(true),
							children: "🔥 物理清除（需确认）"
						})
					})
				]
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
		/** Urgency segmented options with a one-line hint each. */
		const URGENCY_OPTIONS = [
			{
				value: "urgent",
				label: "紧急",
				hint: "优先处理"
			},
			{
				value: "normal",
				label: "一般",
				hint: "正常排期"
			},
			{
				value: "relaxed",
				label: "不急",
				hint: "有空再做"
			}
		];
		/** Cron presets offered in the scheduled mode. */
		const CRON_PRESETS = [
			{
				label: "每天 09:00",
				cron: "0 9 * * *"
			},
			{
				label: "每小时",
				cron: "0 * * * *"
			},
			{
				label: "每 10 分钟",
				cron: "*/10 * * * *"
			},
			{
				label: "每周一 09:00",
				cron: "0 9 * * 1"
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
		* The form modal. Without `task` it composes a new task; with `task` it
		* edits that record (project, urgency, execution, model included — the GUI
		* is the owner surface).
		* @param controller - the controller.
		* @param task - the task being edited (create mode when absent).
		*/
		function TaskFormModal({ controller, task }) {
			const state = controller.getSnapshot();
			const editing = task !== void 0;
			const [title, setTitle] = (0, react.useState)(task?.title ?? "");
			const [description, setDescription] = (0, react.useState)(task?.description ?? "");
			const [prompt, setPrompt] = (0, react.useState)(task?.prompt ?? "");
			const [workspaceId, setWorkspaceId] = (0, react.useState)(task?.workspaceId ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? "");
			const [urgency, setUrgency] = (0, react.useState)(task?.urgency ?? "normal");
			const [mode, setMode] = (0, react.useState)(task?.execution.mode === "scheduled" ? "scheduled" : "claim");
			const [cron, setCron] = (0, react.useState)(task?.execution.cron ?? "0 9 * * *");
			const [catalog, setCatalog] = (0, react.useState)([]);
			const [model, setModel] = (0, react.useState)(task?.model !== void 0 ? JSON.stringify(task.model) : "");
			const titleRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				titleRef.current?.focus();
				const onKey = (e) => {
					if (e.key === "Escape") controller.closeForm();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [controller]);
			(0, react.useEffect)(() => {
				const face = controller.modelCatalog;
				if (face === void 0) return;
				face().then(setCatalog).catch(() => setCatalog([]));
			}, [controller]);
			const cronMatch = mode === "scheduled" ? parseCron(cron.trim()) : null;
			const nextRun = cronMatch !== null ? nextCronTime(cronMatch, Date.now()) : null;
			const cronBad = mode === "scheduled" && (cronMatch === null || nextRun === null);
			const valid = title.trim().length > 0 && workspaceId !== "" && !cronBad;
			const submit = () => {
				if (!valid) return;
				const picked = model !== "" ? JSON.parse(model) : void 0;
				if (editing) controller.update(task.id, task.version, {
					title,
					description,
					prompt,
					urgency,
					workspaceId,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked ?? null
				});
				else controller.create({
					title,
					workspaceId,
					urgency,
					description: description.length > 0 ? description : void 0,
					prompt: prompt.length > 0 ? prompt : void 0,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked
				});
			};
			const hint = !valid ? title.trim().length === 0 ? "请填写标题" : workspaceId === "" ? "请选择项目" : "Cron 表达式无效（分 时 日 月 周）" : mode === "scheduled" && nextRun !== null ? `下次运行 ${fmtTime(nextRun)}` : editing ? `保存后版本 v${task.version} → v${task.version + 1}` : "创建后项目内会话可认领执行";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeForm();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal",
					"data-mode": editing ? "edit" : "create",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": editing ? "编辑任务" : "新建任务",
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: editing ? "编辑任务" : "新建任务" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: editing ? "调整任务内容与执行配置" : "推入看板，项目内会话可认领执行" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": "关闭",
									onClick: () => controller.closeForm(),
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-body",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "标题",
									required: true,
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										ref: titleRef,
										value: title,
										onChange: (e) => setTitle(e.target.value),
										placeholder: "一句话说清要做什么",
										maxLength: 200
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "项目",
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
									label: "模型（默认 = 会话默认模型）",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: model,
										onChange: (e) => setModel(e.target.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "默认模型"
										}), catalog.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: JSON.stringify({
												provider: m.provider,
												model: m.model
											}),
											children: [
												m.name ?? m.model,
												"（",
												m.provider,
												"）"
											]
										}, `${m.provider}/${m.model}`))]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "紧急度",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-urgency-picker",
										children: URGENCY_OPTIONS.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
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
									label: editing ? "描述" : "描述（可选）",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										value: description,
										onChange: (e) => setDescription(e.target.value),
										placeholder: "需求细节、验收标准…"
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: editing ? "执行 Prompt" : "执行 Prompt（可选，默认 = 标题+描述）",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										value: prompt,
										onChange: (e) => setPrompt(e.target.value),
										placeholder: "发给执行会话的完整指令"
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "执行方式",
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
												children: "🤝 认领制"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: "项目内会话认领"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": mode === "scheduled",
											onClick: () => setMode("scheduled"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: "⏰ 定时执行"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: "到点自动开跑"
											})]
										})]
									})
								}),
								mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
									label: "Cron 表达式",
									required: true,
									full: true,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: cronBad ? "dsh-atb-input-bad" : void 0,
										value: cron,
										onChange: (e) => setCron(e.target.value),
										placeholder: "分 时 日 月 周",
										spellCheck: false
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-cron-presets",
										children: [CRON_PRESETS.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-cron-preset",
											"data-on": cron.trim() === p.cron,
											onClick: () => setCron(p.cron),
											children: p.label
										}, p.cron)), !cronBad && nextRun !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-cron-next",
											children: ["下次 ", fmtTime(nextRun)]
										})]
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								"data-tone": valid ? void 0 : "bad",
								children: hint
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-modal-footbtns",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: () => controller.closeForm(),
									children: "取消"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-primary": "true",
									disabled: !valid,
									onClick: submit,
									children: editing ? "保存修改" : "创建任务"
								})]
							})]
						})
					]
				})
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
		/** Column labels. */
		const COLUMN_LABELS = {
			backlog: "待规划",
			todo: "待办",
			in_progress: "进行中",
			in_review: "待验收",
			done: "已完成",
			canceled: "已取消",
			archived: "已归档"
		};
		/** The two columns between which cards may be dragged both ways. */
		const DRAGGABLE_STATUSES = /* @__PURE__ */ new Set(["backlog", "todo"]);
		/** Urgency chip labels. */
		const URGENCY_LABELS = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		/** Format an epoch ms as a short local stamp. */
		function fmtTime(ms) {
			if (ms === void 0) return "";
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** Apply the active filters to a task list. */
		function filterTasks(state, tasks) {
			return tasks.filter((t) => (state.filters.workspaceId === void 0 || t.workspaceId === state.filters.workspaceId) && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(t.urgency)));
		}
		/**
		* The board view root.
		* @param controller - the controller.
		*/
		function TaskBoard({ controller }) {
			const state = (0, react.useSyncExternalStore)((cb) => controller.subscribe(cb), () => controller.getSnapshot());
			const live = filterTasks(state, state.ledger.tasks.filter((t) => t.trashedAt === void 0));
			const selected = state.selectedId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.selectedId);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-board",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "dsh-atb-title",
								children: "Agent 任务看板"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-count",
								children: [
									live.length,
									" 任务 · rev ",
									state.ledger.revision
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsh-atb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsh-atb-select",
								value: state.filters.workspaceId ?? "",
								onChange: (e) => controller.setWorkspaceFilter(e.target.value === "" ? void 0 : e.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "全部项目"
								}), state.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: ws.id,
									children: ws.title || ws.path
								}, ws.id))]
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
								}), URGENCY_LABELS[u]]
							}, u)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								onClick: () => controller.toggleSecondary(),
								children: state.secondaryOpen ? "返回看板" : "其它任务"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-primary": "true",
								onClick: () => controller.setComposer(true),
								children: "+ 新建任务"
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
							const dropTarget = DRAGGABLE_STATUSES.has(status);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-column",
								onDragOver: dropTarget ? (e) => {
									if (e.dataTransfer.types.includes("application/x-dsh-atb-task")) {
										e.preventDefault();
										e.dataTransfer.dropEffect = "move";
										e.currentTarget.dataset.dragover = "true";
									}
								} : void 0,
								onDragLeave: dropTarget ? (e) => {
									delete e.currentTarget.dataset.dragover;
								} : void 0,
								onDrop: dropTarget ? (e) => {
									e.preventDefault();
									delete e.currentTarget.dataset.dragover;
									const id = e.dataTransfer.getData(DRAG_TYPE);
									if (id.length === 0) return;
									const task = state.ledger.tasks.find((t) => t.id === id);
									if (task === void 0 || task.status === status) return;
									controller.move(id, task.version, status);
								} : void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-colhead",
									children: [COLUMN_LABELS[status], /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-colcount",
										children: columnTasks.length
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-cards",
									children: [columnTasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
										task,
										controller,
										draggable: dropTarget
									}, task.id)), columnTasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty",
										children: "无任务"
									})]
								})]
							}, status);
						})
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-detailpanel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetail, {
							task: selected,
							controller
						})
					}),
					state.composerOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskFormModal, {
						controller,
						task: state.editingId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.editingId)
					})
				]
			});
		}
		/** Secondary tab: canceled/archived/trashed rows. */
		function SecondaryTab({ controller, tasks }) {
			const rows = tasks.filter((t) => t.status === "canceled" || t.status === "archived" || t.trashedAt !== void 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-secondary",
				children: [
					rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-empty",
						children: "无已取消 / 已归档 / 已删除任务"
					}),
					rows.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
						task,
						controller
					}, task.id)),
					void 0
				]
			});
		}

		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Board view mounting: a container appended inside the `[data-pane=
		* "conversation"]` grid item (a trailing child React never manages), with a
		* stylesheet rule hiding the conversation content while the board is active.
		* Toggling rides a data attribute on <html> — no React involvement in the
		* shell.
		*
		* @module dsh-taskboard/client/board-mount
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"]";
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
		* Mount the client half.
		* @param ctx - the client context (connection injected).
		*/
		function apply(ctx) {
			try {
				injectStyles();
				const controller = new BoardController(createClient());
				const connection = ctx.get?.("connection");
				if (connection !== void 0) controller.modelCatalog = async () => {
					const response = await connection.api.llm.models({});
					if (!response.result.ok) return [];
					const out = [];
					for (const group of response.result.value.groups) for (const model of group.models) out.push({
						provider: group.id,
						model: model.id,
						name: model.name
					});
					return out;
				};
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
