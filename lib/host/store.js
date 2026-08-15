import { emptyLedger } from "../shared/protocol.js";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
//#region src/host/store.ts
/**
* Host-side task ledger: one JSON file under the DSH home, mutated through a
* serial write queue, published as immutable snapshots with a global
* monotonic revision. Change subscribers (P2: SSE route) observe every
* committed mutation.
*
* @module dsh-taskboard/host/store
*/
/**
* The durable ledger. All mutations run through {@link mutate}, which:
* validates the resulting document, bumps the global revision, persists
* atomically (temp file + rename), and only then notifies subscribers.
*/
var TaskStore = class {
	file;
	ledger = emptyLedger();
	subscribers = /* @__PURE__ */ new Set();
	queue = Promise.resolve();
	loaded = false;
	/** @param options - file location. */
	constructor(options) {
		this.file = options.file;
	}
	/** Load (once) from disk; a missing file starts empty; a corrupt file is quarantined, not thrown. */
	async load() {
		if (this.loaded) return;
		try {
			const raw = await readFile(this.file, "utf8");
			const parsed = JSON.parse(raw);
			if (typeof parsed.revision === "number" && Array.isArray(parsed.tasks)) this.ledger = {
				schemaVersion: 1,
				revision: parsed.revision,
				tasks: parsed.tasks
			};
		} catch (error) {
			if (error.code !== "ENOENT") try {
				await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
			} catch {}
		}
		this.loaded = true;
	}
	/** The current immutable snapshot. */
	snapshot() {
		return this.ledger;
	}
	/** Find a task by id. */
	get(id) {
		return this.ledger.tasks.find((t) => t.id === id);
	}
	/** Subscribe to committed changes; returns the unsubscribe. */
	subscribe(fn) {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}
	/**
	* Run one mutation inside the serial queue. The mutator works on a
	* structured clone; returning `undefined` aborts with no write.
	* @param kind - change kind for subscribers.
	* @param mutator - receives the cloned ledger; mutate tasks in place; return the touched tasks.
	*/
	async mutate(kind, mutator) {
		const run = async () => {
			await this.load();
			const draft = structuredClone(this.ledger);
			const changed = mutator(draft);
			if (changed === void 0) return {
				ledger: this.ledger,
				changed: []
			};
			draft.revision += 1;
			const json = JSON.stringify(draft);
			await persistAtomic(this.file, json);
			this.ledger = draft;
			const change = {
				revision: draft.revision,
				tasks: changed,
				kind
			};
			for (const fn of this.subscribers) try {
				fn(change);
			} catch {}
			return {
				ledger: draft,
				changed
			};
		};
		return this.queue = this.queue.then(run, run);
	}
	/** Persist the current ledger now (used after external reconciliation). */
	async flush(kind, changed) {
		await this.mutate(kind, (ledger) => {
			const byId = new Map(this.ledger.tasks.map((t) => [t.id, t]));
			ledger.tasks = ledger.tasks.map((t) => byId.get(t.id) ?? t);
			return [...changed];
		});
	}
};
/** Atomic file persist: write temp, then rename over the target. */
async function persistAtomic(file, contents) {
	await mkdir(dirname(file), { recursive: true });
	const temp = join(dirname(file), `.${Math.random().toString(36).slice(2)}.tmp`);
	await writeFile(temp, contents, "utf8");
	await rename(temp, file);
}
//#endregion
export { TaskStore };

//# sourceMappingURL=store.js.map