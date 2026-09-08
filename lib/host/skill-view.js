//#region src/host/skill-view.ts
/**
* Read the skill catalog through the layered view.
*
* Falls back to an unscoped read when the scoped one rejects: a host whose
* roster or preset layer is unavailable must still serve the globally
* registered runtime skills instead of an empty picker.
*
* @param skills - the host skill registry.
* @param deps - roster + workspace faces and the requested workspace id.
* @returns the winning skill summaries (never throws).
*/
async function listSkillsForView(skills, deps) {
	const view = await resolveSkillView(deps);
	try {
		return await skills.list(view);
	} catch {
		try {
			return await skills.list();
		} catch {
			return [];
		}
	}
}
/**
* Resolve the layered view options for one board-wide skill read.
*
* Every step degrades to `undefined` rather than throwing: a bare host
* composition without a preset roster keeps the historical unscoped behavior,
* and an unknown workspace simply contributes no cwd (user-level skills such as
* `~/.agents/skills` are cwd-independent and still appear).
*
* @param deps - roster + workspace faces and the requested workspace id.
* @returns `{ cwd, scope }` for `skills.list()`, each field independently optional.
*/
async function resolveSkillView(deps) {
	const view = {};
	const cwd = resolveWorkspacePath(deps);
	if (cwd !== void 0) view.cwd = cwd;
	const scope = await resolveStandingScope(deps.presets);
	if (scope !== void 0) view.scope = scope;
	return view;
}
/** The requested workspace's project root, or undefined when unknown/absent. */
function resolveWorkspacePath(deps) {
	if (deps.workspaceId === void 0 || deps.workspaces?.get === void 0) return void 0;
	try {
		const path = deps.workspaces.get(deps.workspaceId)?.path;
		return typeof path === "string" && path.length > 0 ? path : void 0;
	} catch {
		return;
	}
}
/**
* The default preset's standing scope key — the layer chain local skill
* discovery lives in. `resolve()` with no id returns the deployment default,
* exactly like the task form's own preset pre-selection.
*/
async function resolveStandingScope(presets) {
	if (presets?.resolve === void 0 || presets.standingKeyFor === void 0) return void 0;
	try {
		const preset = await presets.resolve();
		return await presets.standingKeyFor(preset.id);
	} catch {
		return;
	}
}
//#endregion
export { listSkillsForView, resolveSkillView };

//# sourceMappingURL=skill-view.js.map