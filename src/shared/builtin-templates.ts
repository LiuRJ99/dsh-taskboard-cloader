/**
 * Built-in task-template content: the factory templates seeded into the
 * template side file in both shipped locales. The host seeds the zh copy as
 * the persisted fallback (the side file is plain data); the client resolves
 * the active locale's copy at render / prefill time.
 *
 * The zh entries intentionally preserve the fork's existing template data,
 * including its execution defaults and category labels. The English entries
 * are the locale-aware presentation copy; persisted user-edited templates are
 * never rewritten by this module.
 *
 * @module dsh-taskboard/shared/builtin-templates
 */
import type { TaskTemplateSpec } from './api.ts'

/** Shipped built-in template locales (mirrors the client i18n LocaleId). */
export type BuiltinTemplateLocale = 'zh' | 'en'

/** One built-in template's localized name + category + task spec. */
export interface BuiltinTemplateContent {
  name: string
  category?: string
  task: TaskTemplateSpec
}

/** Stable ids of the factory templates (persisted in the side file). */
export const BUILTIN_TEMPLATE_IDS = ['tpl-feature', 'tpl-bugfix', 'tpl-release', 'tpl-patrol'] as const

export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATE_IDS)[number]

/** Built-in template content per locale (name + prefilled task spec). */
export const BUILTIN_TEMPLATE_CONTENT: Readonly<Record<BuiltinTemplateLocale, Readonly<Record<BuiltinTemplateId, BuiltinTemplateContent>>>> = {
  zh: {
    'tpl-feature': {
      name: '新增功能',
      task: {
        title: '新增：',
        prompt: [
          '实现以上新功能并按序交接：',
          '1. 明确需求边界与验收标准，列出实现要点',
          '2. 实现功能（含类型定义与错误处理）',
          '3. 补充测试（单测/回归）',
          '4. 运行相关测试套件确认通过',
        ].join('\n'),
        urgency: 'normal',
        checklist: ['实现要点已明确（需求边界与验收标准）', '功能已实现并补充测试', '相关测试套件通过'],
      },
    },
    'tpl-bugfix': {
      name: 'Bug 修复',
      category: '开发',
      task: {
        title: '修复：',
        prompt: [
          '修复以上问题并按序交接：',
          '1. 复现问题（写最小复现步骤或测试）',
          '2. 定位根因，说明为什么会发生',
          '3. 修复并补回归测试',
          '4. 运行相关测试套件确认无回归',
        ].join('\n'),
        urgency: 'urgent',
        speed: 'standard',
        permission: 'workspace-write',
        checklist: ['已复现并定位根因', '修复已提交到任务分支', '回归测试通过'],
      },
    },
    'tpl-release': {
      name: '发布检查',
      category: '开发',
      task: {
        title: '发布：',
        prompt: '执行发布流程：版本号更新、构建、测试、变更记录，完成后按序交接（不要实际推送/发布，等用户确认）。',
        urgency: 'normal',
        speed: 'standard',
        permission: 'workspace-write',
        checklist: ['版本号已更新（package.json 与版本常量同步）', '构建通过', '全部测试通过', '变更记录已写'],
      },
    },
    'tpl-patrol': {
      name: '例行巡检',
      category: '运营',
      task: {
        title: '巡检：',
        prompt: [
          '例行巡检：检查依赖更新、失败测试、明显代码问题与未处理的告警。',
          '发现的问题逐条列出（严重度/位置/建议），小问题直接修复，大问题只报告不动手。',
          '输出巡检摘要（用 {{lastComments}} 可回看上次巡检结论）。',
        ].join('\n'),
        urgency: 'relaxed',
        speed: 'standard',
        permission: 'read-only',
        execution: { mode: 'scheduled', cron: '0 9 * * 1' },
      },
    },
  },
  en: {
    'tpl-feature': {
      name: 'New feature',
      task: {
        title: 'New feature:',
        prompt: [
          'Implement the new feature above and hand off in order:',
          '1. Clarify the requirement boundaries and acceptance criteria; list the implementation points',
          '2. Implement the feature (including type definitions and error handling)',
          '3. Add tests (unit / regression)',
          '4. Run the relevant test suites and confirm they pass',
        ].join('\n'),
        urgency: 'normal',
        checklist: ['Implementation points clarified (requirement boundaries and acceptance criteria)', 'Feature implemented with tests added', 'Relevant test suites pass'],
      },
    },
    'tpl-bugfix': {
      name: 'Bug fix',
      category: 'Development',
      task: {
        title: 'Fix:',
        prompt: [
          'Fix the issue above and hand off in order:',
          '1. Reproduce the issue (write minimal reproduction steps or a test)',
          '2. Locate the root cause and explain why it happens',
          '3. Fix it and add regression tests',
          '4. Run the relevant test suites and confirm there are no regressions',
        ].join('\n'),
        urgency: 'urgent',
        speed: 'standard',
        permission: 'workspace-write',
        checklist: ['Issue reproduced and root cause located', 'Fix committed to the task branch', 'Regression tests pass'],
      },
    },
    'tpl-release': {
      name: 'Release check',
      category: 'Development',
      task: {
        title: 'Release:',
        prompt: 'Run the release process: bump the version, build, test, and update the changelog, then hand off in order (do not actually push / publish — wait for user confirmation).',
        urgency: 'normal',
        speed: 'standard',
        permission: 'workspace-write',
        checklist: ['Version bumped (package.json and version constants in sync)', 'Build passes', 'All tests pass', 'Changelog written'],
      },
    },
    'tpl-patrol': {
      name: 'Routine patrol',
      category: 'Operations',
      task: {
        title: 'Patrol:',
        prompt: [
          'Routine patrol: check dependency updates, failing tests, obvious code issues, and unhandled alerts.',
          'List each finding (severity / location / suggestion); fix small issues directly, and only report (do not touch) large ones.',
          'Output a patrol summary (use {{lastComments}} to review the last patrol’s conclusions).',
        ].join('\n'),
        urgency: 'relaxed',
        speed: 'standard',
        permission: 'read-only',
        execution: { mode: 'scheduled', cron: '0 9 * * 1' },
      },
    },
  },
}

/**
 * Resolve one built-in template's localized content.
 * @param id - the template id.
 * @param locale - the requested locale.
 * @returns the content, or undefined when `id` is not a built-in template id.
 */
export function builtinTemplateContent(id: string, locale: BuiltinTemplateLocale): BuiltinTemplateContent | undefined {
  if (!(BUILTIN_TEMPLATE_IDS as readonly string[]).includes(id)) return undefined
  return BUILTIN_TEMPLATE_CONTENT[locale][id as BuiltinTemplateId]
}
