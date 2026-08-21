//#region src/shared/model-execution.ts
/**
* Optional provider-neutral execution-state bridge.
*
* This is deliberately separate from model capability discovery. It lets a
* provider-backed plugin mirror a task's effective speed into its session
* state even when the installed DSH runtime predates the first-class
* `LlmCallConfig.serviceTier` field.
*/
/** Cordis service name used by optional execution-state providers. */
const MODEL_EXECUTION_SERVICE = "dshModelExecution";
//#endregion
export { MODEL_EXECUTION_SERVICE };

//# sourceMappingURL=model-execution.js.map