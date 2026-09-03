/**
 * User-only authorization skill for the taskboard capability.
 *
 * The skill owns the association between the taskboard authorization gesture,
 * the taskboard_* tool family, and the taskboard protocol prompt section. The
 * lazy-gate plugin consumes this metadata; it does not need to depend on the
 * taskboard package.
 */

/** Structural slice of the optional DSH skill registry. */
export interface SkillsSurface {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    content: string
    source: string
    invocation?: {
      modelInvocable: boolean
      userInvocable: boolean
    }
    metadata?: Readonly<Record<string, unknown>>
  }): () => void
}

/**
 * The user-facing `/taskboard` authorization skill.
 *
 * `modelInvocable: false` is important: the model must not be able to load the
 * authorization skill itself and then appear to have user authorization.
 */
export const TASKBOARD_SKILL = {
  name: 'taskboard',
  description: 'Unlock the taskboard_* tools for this session after you explicitly invoke /taskboard.',
  whenToUse: 'Use when the task requires reading or managing tasks on the DSH task board.',
  content: [
    '# Taskboard',
    '',
    'Taskboard access is now unlocked for this session.',
    'Use the taskboard_* tools according to the task-board workflow protocol.',
  ].join('\n'),
  source: 'dsh-taskboard',
  invocation: {
    modelInvocable: false,
    userInvocable: true,
  },
  metadata: {
    'dsh:gate': {
      toolPrefixes: ['taskboard_'],
      promptSections: ['plugin:dsh-taskboard'],
    },
  },
} as const
