/**
 * Optional provider-neutral execution-state bridge.
 *
 * This is deliberately separate from model capability discovery. It lets a
 * provider-backed plugin mirror a task's effective speed into its session
 * state even when the installed DSH runtime predates the first-class
 * `LlmCallConfig.serviceTier` field.
 */

/** Cordis service name used by optional execution-state providers. */
export const MODEL_EXECUTION_SERVICE = 'dshModelExecution'

export type ModelExecutionSpeed = 'standard' | 'fast'

export interface ModelExecutionProvider {
  setSessionSpeed(
    sessionId: string,
    provider: string,
    model: string,
    speed: ModelExecutionSpeed,
  ): void | Promise<void>
}
