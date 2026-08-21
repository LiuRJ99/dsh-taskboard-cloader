/**
 * Provider-neutral model capability bridge.
 *
 * The service name and wire shape are intentionally independent of any one
 * adapter. A provider plugin may expose this service; consumers must treat it
 * as optional and hide unsupported controls when capability data is absent.
 */

/** Cordis service name used by optional capability providers. */
export const MODEL_CAPABILITY_SERVICE = 'dshModelCapabilities'

/** CLIProxyAPI's low-latency service tier, exposed as a generic tier id. */
export const PRIORITY_SERVICE_TIER = 'priority'

export interface ModelServiceTier {
  id: string
  name?: string
  description?: string
}

export interface ModelCapability {
  provider: string
  model: string
  serviceTiers: readonly ModelServiceTier[]
}

export interface ModelCapabilityProvider {
  listModelCapabilities(signal?: AbortSignal): Promise<readonly ModelCapability[]>
}

/** Whether one exact provider/model route advertises a service tier. */
export function hasServiceTier(
  provider: string | undefined,
  model: string | undefined,
  capabilities: readonly ModelCapability[] | undefined,
  tier: string,
): boolean {
  if (provider === undefined || model === undefined || capabilities === undefined) return false
  return capabilities.some(entry =>
    entry.provider === provider
    && entry.model === model
    && entry.serviceTiers.some(serviceTier => serviceTier.id === tier),
  )
}

/** Whether one catalog entry can request taskboard's Fast mode. */
export function supportsTaskFastSpeed(entry: {
  provider: string
  model: string
  serviceTiers?: readonly ModelServiceTier[]
} | undefined): boolean {
  return entry?.serviceTiers?.some(tier => tier.id === PRIORITY_SERVICE_TIER) === true
}

/** Map a task-level speed choice to the adapter-facing service tier. */
export function serviceTierForTaskSpeed(
  speed: 'standard' | 'fast' | undefined,
  provider: string | undefined,
  model: string | undefined,
  capabilities: readonly ModelCapability[] | undefined,
): string | undefined {
  return speed === 'fast' && hasServiceTier(provider, model, capabilities, PRIORITY_SERVICE_TIER)
    ? PRIORITY_SERVICE_TIER
    : undefined
}
