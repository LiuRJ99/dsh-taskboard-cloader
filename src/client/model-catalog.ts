/**
 * Model-catalog policy for task execution.
 *
 * The host `llm.models` wire view intentionally exposes only models advertised
 * by a provider; it does not carry the adapter's modality/capability details.
 * Taskboard therefore hides only model ids/names that clearly identify a
 * non-text endpoint (for example `gemini-3.1-flash-image`) instead of showing
 * a selector entry that cannot execute a text task.
 *
 * Keep this heuristic deliberately narrow: multimodal text models such as
 * vision-capable chat models remain selectable unless their catalog identity
 * explicitly identifies a non-text endpoint.
 */

/** Minimal catalog shape needed by the task-execution filter. */
export interface TaskModelCatalogEntry {
  model: string
  name?: string
}

/** Known catalog identity markers for non-text or non-agent endpoints. */
const NON_TEXT_MODEL_MARKER = /(?:^|[-_.\s])(?:audio|embedding|image|moderation|rerank|speech|tts)(?:$|[-_.\s])/i

/** Whether a catalog entry can be offered for a text task execution. */
export function isTaskModelSupported(entry: TaskModelCatalogEntry): boolean {
  return !NON_TEXT_MODEL_MARKER.test(`${entry.model} ${entry.name ?? ''}`)
}
