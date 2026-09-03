/**
 * Standalone browser chunk for the taskboard detail Mermaid renderer.
 *
 * This module must stay out of the core client bundle. The build wraps it as a
 * plugin-owned chunk factory and the detail Markdown component loads it only
 * after detecting a Mermaid fence.
 */
import mermaid from 'mermaid'

export { mermaid }
