//#region src/shared/model-capabilities.ts
/**
* Provider-neutral model capability bridge.
*
* The service name and wire shape are intentionally independent of any one
* adapter. A provider plugin may expose this service; consumers must treat it
* as optional and hide unsupported controls when capability data is absent.
*/
/** Cordis service name used by optional capability providers. */
const MODEL_CAPABILITY_SERVICE = "dshModelCapabilities";
/** CLIProxyAPI's low-latency service tier, exposed as a generic tier id. */
const PRIORITY_SERVICE_TIER = "priority";
/** Whether one exact provider/model route advertises a service tier. */
function hasServiceTier(provider, model, capabilities, tier) {
	if (provider === void 0 || model === void 0 || capabilities === void 0) return false;
	return capabilities.some((entry) => entry.provider === provider && entry.model === model && entry.serviceTiers.some((serviceTier) => serviceTier.id === tier));
}
/** Map a task-level speed choice to the adapter-facing service tier. */
function serviceTierForTaskSpeed(speed, provider, model, capabilities) {
	return speed === "fast" && hasServiceTier(provider, model, capabilities, "priority") ? PRIORITY_SERVICE_TIER : void 0;
}
//#endregion
export { MODEL_CAPABILITY_SERVICE, PRIORITY_SERVICE_TIER, hasServiceTier, serviceTierForTaskSpeed };

//# sourceMappingURL=model-capabilities.js.map