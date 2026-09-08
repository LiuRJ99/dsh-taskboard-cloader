/**
 * Skill-catalog VIEW resolution for the board's prompt-completions face.
 *
 * The host `skills` registry is layered per scope (the tools-registry shape):
 * `SkillRegistry.list(options)` merges the GLOBAL layer with the viewing
 * scope's chain (`chainLayers(options.scope)`), and DSH's web bundle disables
 * the host-plane `skill-filesystem` row precisely because "presets own local
 * discovery" — each agent preset mounts its own `skill-filesystem` into that
 * preset's layer (see `@deepseek-ai/dsh-web-app/cordis.patch.yml` and the
 * `standard` preset composition). An UNSCOPED `list()` therefore sees only the
 * globally registered runtime skills (the gated `browser` / `computer-use` /
 * `taskboard` authorizations) and never the user's local skills — no `comet*`,
 * no `~/.agents/skills` entries, no project skills.
 *
 * The official `SessionSkillCatalog.list()` reads the catalog with
 * `{ cwd, scope }`, where `scope` is the session's live agent (or the standing
 * preset key of a cold session). This module resolves the same view for the
 * board, which is not bound to one session: the standing scope of the default
 * agent preset, plus the project cwd of the workspace the composer targets.
 *
 * @module dsh-taskboard/host/skill-view
 */

/** Structural slice of the optional agent-preset roster. */
export interface PresetRosterFace {
  /** Resolve a preset id; `undefined` means the deployment default. */
  resolve?(id?: string): Promise<{ id: string }>
  /** Standing mount key of one preset (mounting it if needed). */
  standingKeyFor?(id: string): Promise<unknown>
}

/** Structural slice of the optional workspace registry face. */
export interface WorkspacePathFace {
  get?(id: string): { path?: string } | undefined
}

/** Options handed to `skills.list()`. */
export interface SkillView {
  cwd?: string
  scope?: unknown
}

/** Structural slice of the host skill registry. */
export interface SkillsCatalogFace {
  list(options?: unknown): Promise<Array<{ name: string; description?: string }>>
}

/** Dependencies the resolver reads; every one is optional. */
export interface SkillViewDeps {
  presets?: PresetRosterFace
  /** Workspace lookup, used only when the request named a workspace. */
  workspaces?: WorkspacePathFace
  /** Workspace the composer targets (query parameter); undefined = board-wide. */
  workspaceId?: string
}

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
export async function listSkillsForView(
  skills: SkillsCatalogFace,
  deps: SkillViewDeps,
): Promise<Array<{ name: string; description?: string }>> {
  const view = await resolveSkillView(deps)
  try {
    return await skills.list(view)
  } catch {
    try {
      return await skills.list()
    } catch {
      return []
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
export async function resolveSkillView(deps: SkillViewDeps): Promise<SkillView> {
  const view: SkillView = {}
  const cwd = resolveWorkspacePath(deps)
  if (cwd !== undefined) view.cwd = cwd
  const scope = await resolveStandingScope(deps.presets)
  if (scope !== undefined) view.scope = scope
  return view
}

/** The requested workspace's project root, or undefined when unknown/absent. */
function resolveWorkspacePath(deps: SkillViewDeps): string | undefined {
  if (deps.workspaceId === undefined || deps.workspaces?.get === undefined) return undefined
  try {
    const path = deps.workspaces.get(deps.workspaceId)?.path
    return typeof path === 'string' && path.length > 0 ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * The default preset's standing scope key — the layer chain local skill
 * discovery lives in. `resolve()` with no id returns the deployment default,
 * exactly like the task form's own preset pre-selection.
 */
async function resolveStandingScope(presets: PresetRosterFace | undefined): Promise<unknown> {
  if (presets?.resolve === undefined || presets.standingKeyFor === undefined) return undefined
  try {
    const preset = await presets.resolve()
    return await presets.standingKeyFor(preset.id)
  } catch {
    // Roster absent/broken or the preset failed to mount: an unscoped read is
    // still better than no catalog at all.
    return undefined
  }
}
