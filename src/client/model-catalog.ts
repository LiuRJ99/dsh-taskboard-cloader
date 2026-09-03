/**
 * Model-catalog policy for task execution.
 *
 * The host `llm.models` wire view exposes the provider directory, while the
 * optional model-capability service contributes adapter-owned service tiers.
 * Taskboard still hides only model ids/names that clearly identify a non-text
 * endpoint (for example `gemini-3.1-flash-image`) instead of showing a
 * selector entry that cannot execute a text task.
 *
 * Keep this heuristic deliberately narrow: multimodal text models such as
 * vision-capable chat models remain selectable unless their catalog identity
 * explicitly identifies a non-text endpoint.
 */

/** Minimal catalog shape needed by the task-execution filter. */
export interface TaskModelCatalogEntry {
  provider?: string
  model: string
  name?: string
}

/** Known catalog identity markers for non-text or non-agent endpoints. */
const NON_TEXT_MODEL_MARKER = /(?:^|[-_.\s])(?:audio|embedding|image|moderation|rerank|speech|tts)(?:$|[-_.\s])/i

/** Whether a catalog entry can be offered for a text task execution. */
export function isTaskModelSupported(entry: TaskModelCatalogEntry): boolean {
  return !NON_TEXT_MODEL_MARKER.test(`${entry.model} ${entry.name ?? ''}`)
}
