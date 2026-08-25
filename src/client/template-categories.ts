/**
 * Shared client-side helpers for template category labels and filters.
 *
 * The category is library metadata, not part of the task prefill payload. Older
 * templates have no category; they are presented under the compatibility
 * category “其他” until the user assigns another label.
 *
 * @module dsh-taskboard/client/template-categories
 */
import type { TaskTemplate } from '../shared/api.ts'

/** Compatibility label for templates created before categories existed. */
export const DEFAULT_TEMPLATE_CATEGORY = '其他'

/** Resolve the display/filter category for one template. */
export function templateCategoryOf(template: Pick<TaskTemplate, 'category'>): string {
  const category = template.category?.trim()
  return category === undefined || category.length === 0 ? DEFAULT_TEMPLATE_CATEGORY : category
}

/** One category option with the number of templates currently assigned to it. */
export type TemplateCategoryOption = { value: string; count: number }

/** Derive stable, first-seen category options from the loaded template list. */
export function templateCategoryOptions(templates: readonly TaskTemplate[]): TemplateCategoryOption[] {
  const counts = new Map<string, number>()
  for (const template of templates) {
    const category = templateCategoryOf(template)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count }))
}

/** Whether a template belongs to the selected category; undefined means all. */
export function matchesTemplateCategory(template: Pick<TaskTemplate, 'category'>, selected?: string): boolean {
  return selected === undefined || templateCategoryOf(template) === selected
}
