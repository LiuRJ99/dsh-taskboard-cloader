/**
 * Skill-catalog view resolution (0.6.5): the board's prompt-completions face
 * must read the host registry through the DEFAULT PRESET'S SCOPE, because DSH's
 * web bundle disables the host-plane `skill-filesystem` row and each preset
 * registers local discovery into its own layer — an unscoped list() returns
 * only the globally registered runtime skills.
 */
import { describe, expect, it } from 'vitest'
import { listSkillsForView, resolveSkillView } from '../src/host/skill-view.ts'

const PRESET = { id: 'standard' }
const SCOPE = { agentPreset: 'standard' }

describe('resolveSkillView (0.6.5)', () => {
  it('passes the default preset standing scope and the requested workspace cwd', async () => {
    const view = await resolveSkillView({
      presets: {
        resolve: async (id) => { expect(id).toBeUndefined(); return PRESET },
        standingKeyFor: async (id) => { expect(id).toBe('standard'); return SCOPE },
      },
      workspaces: { get: id => (id === 'ws-a' ? { path: '/proj/a' } : undefined) },
      workspaceId: 'ws-a',
    })
    expect(view).toEqual({ cwd: '/proj/a', scope: SCOPE })
  })

  it('omits cwd when no workspace was named (user-level skills are cwd-independent)', async () => {
    const view = await resolveSkillView({
      presets: { resolve: async () => PRESET, standingKeyFor: async () => SCOPE },
    })
    expect(view).toEqual({ scope: SCOPE })
  })

  it('omits cwd for an unknown workspace instead of failing', async () => {
    const view = await resolveSkillView({
      workspaces: { get: () => undefined },
      workspaceId: 'ws-missing',
    })
    expect(view).toEqual({})
  })

  it('stays unscoped on a bare host composition without a roster', async () => {
    expect(await resolveSkillView({})).toEqual({})
    expect(await resolveSkillView({ presets: { resolve: async () => PRESET } })).toEqual({})
  })

  it('degrades to unscoped when the roster or the standing mount fails', async () => {
    const rosterBroken = await resolveSkillView({
      presets: {
        resolve: async () => { throw new Error('no roster') },
        standingKeyFor: async () => SCOPE,
      },
    })
    expect(rosterBroken).toEqual({})

    const mountBroken = await resolveSkillView({
      presets: {
        resolve: async () => PRESET,
        standingKeyFor: async () => { throw new Error('preset failed to mount') },
      },
    })
    expect(mountBroken).toEqual({})
  })
})

describe('listSkillsForView (0.6.5)', () => {
  it('reads the catalog with the resolved view', async () => {
    const calls: unknown[] = []
    const skills = await listSkillsForView(
      {
        list: async (options) => {
          calls.push(options)
          return [{ name: 'comet', description: 'Comet 工作流入口' }]
        },
      },
      {
        presets: { resolve: async () => PRESET, standingKeyFor: async () => SCOPE },
        workspaces: { get: () => ({ path: '/proj/a' }) },
        workspaceId: 'ws-a',
      },
    )
    expect(skills.map(s => s.name)).toEqual(['comet'])
    expect(calls).toEqual([{ cwd: '/proj/a', scope: SCOPE }])
  })

  it('falls back to an unscoped read when the scoped read rejects', async () => {
    const calls: unknown[] = []
    const skills = await listSkillsForView(
      {
        list: async (options) => {
          calls.push(options)
          if (options !== undefined) throw new Error('scope chain unavailable')
          return [{ name: 'taskboard' }]
        },
      },
      { presets: { resolve: async () => PRESET, standingKeyFor: async () => SCOPE } },
    )
    expect(skills.map(s => s.name)).toEqual(['taskboard'])
    expect(calls).toEqual([{ scope: SCOPE }, undefined])
  })

  it('returns an empty catalog instead of throwing when both reads fail', async () => {
    const skills = await listSkillsForView({ list: async () => { throw new Error('registry gone') } }, {})
    expect(skills).toEqual([])
  })
})
