//#region src/host/skill.ts
/**
* The user-facing `/taskboard` authorization skill.
*
* `modelInvocable: false` is important: the model must not be able to load the
* authorization skill itself and then appear to have user authorization.
*/
const TASKBOARD_SKILL = {
	name: "taskboard",
	description: "Unlock the taskboard_* tools for this session after you explicitly invoke /taskboard.",
	whenToUse: "Use when the task requires reading or managing tasks on the DSH task board.",
	content: [
		"# Taskboard",
		"",
		"Taskboard access is now unlocked for this session.",
		"Use the taskboard_* tools according to the task-board workflow protocol."
	].join("\n"),
	source: "dsh-taskboard",
	invocation: {
		modelInvocable: false,
		userInvocable: true
	},
	metadata: { "dsh:gate": {
		toolPrefixes: ["taskboard_"],
		promptSections: ["plugin:dsh-taskboard"]
	} }
};
//#endregion
export { TASKBOARD_SKILL };

//# sourceMappingURL=skill.js.map