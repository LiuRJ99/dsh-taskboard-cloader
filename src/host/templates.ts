/**
 * Host-side task-template store (0.4.0): one JSON side file next to the
 * ledger, seeded with the built-in templates on first load, mutated through
 * the same atomic persist discipline as the ledger.
 *
 * Pure data, no Cordis deps — the routes layer owns it and tests drive it
 * directly against a temp dir.
 *
 * @module dsh-taskboard/host/templates
 */
import { readFile } from 'node:fs/promises'
import type { TaskTemplate } from '../shared/api.ts'
import { BUILTIN_TEMPLATE_CONTENT, BUILTIN_TEMPLATE_IDS, type BuiltinTemplateId } from '../shared/builtin-templates.ts'
import { normalizeTemplateCategory } from '../shared/protocol.ts'

/** The built-in templates seeded when the side file does not exist yet. */
export const BUILTIN_TEMPLATES: ReadonlyArray<{ id: BuiltinTemplateId; name: string; category?: string; task: TaskTemplate['task'] }> =
  BUILTIN_TEMPLATE_IDS.map(id => {
    const content = BUILTIN_TEMPLATE_CONTENT.zh[id]
    return {
      id,
      name: content.name,
      ...(content.category !== undefined ? { category: content.category } : {}),
      task: { ...content.task },
    }
  })

/** Mint a template id. */
function newTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Sanitize a template loaded from disk without rejecting the whole side file. */
function sanitizeLoadedTemplate(template: TaskTemplate): TaskTemplate {
  let category: string | undefined
  try {
    category = normalizeTemplateCategory(template.category)
  } catch {
    category = undefined
  }
  return { ...template, category }
}

/**
 * The template store. NOT thread-synchronized like the ledger (template
 * writes are rare, human-paced GUI operations; last-write-wins is fine).
 */
export class TemplateStore {
  private templates: TaskTemplate[] | undefined
  private loaded = false

  /** @param file - absolute side-file path (next to the ledger). */
  constructor(private readonly file: string) {}

  /** Load once; a missing file seeds the built-ins; a corrupt file resets. */
  private async ensure(): Promise<void> {
    if (this.loaded) return
    let parsed: TaskTemplate[] | undefined
    try {
      const raw = await readFile(this.file, 'utf8')
      const value = JSON.parse(raw) as { templates?: unknown }
      if (Array.isArray(value.templates)) {
        parsed = value.templates.filter((t): t is TaskTemplate =>
          typeof t === 'object' && t !== null && typeof (t as TaskTemplate).id === 'string'
          && typeof (t as TaskTemplate).name === 'string' && typeof (t as TaskTemplate).task === 'object')
          .map(sanitizeLoadedTemplate)
      }
    } catch { /* missing or corrupt → seed */ }
    if (parsed === undefined) {
      const now = Date.now()
      parsed = BUILTIN_TEMPLATES.map((t, i) => ({ ...t, task: { ...t.task }, builtin: true, createdAt: now, updatedAt: now + i }))
      try { await this.persist(parsed) } catch { /* best effort — the seed returns in-memory */ }
    } else {
      // Existing installations may have the pre-option built-ins. Add only
      // newly introduced defaults while preserving any user-edited fields.
      const seeds = new Map<string, typeof BUILTIN_TEMPLATES[number]>(BUILTIN_TEMPLATES.map(template => [template.id, template] as [string, typeof BUILTIN_TEMPLATES[number]]))
      let changed = false
      parsed = parsed.map(template => {
        const seed = template.builtin === true ? seeds.get(template.id) : undefined
        if (seed === undefined) return template
        // Legacy fork stored permission under `permissionMode`; a template
        // carrying it counts as having the field (no default re-seed needed).
        const legacyPermission = (template.task as unknown as { permissionMode?: unknown }).permissionMode
        const missingCategory = template.category === undefined && seed.category !== undefined
        const missingSpeed = template.task.speed === undefined && seed.task.speed !== undefined
        const missingPermission = template.task.permission === undefined
          && seed.task.permission !== undefined && legacyPermission === undefined
        if (!missingCategory && !missingSpeed && !missingPermission) return template
        changed = true
        return {
          ...template,
          ...(missingCategory ? { category: seed.category } : {}),
          task: { ...seed.task, ...template.task },
          updatedAt: Date.now(),
        }
      }).map(template => {
        // Canonicalize any legacy fork `permissionMode` onto `permission`.
        const legacy = (template.task as unknown as { permissionMode?: unknown }).permissionMode
        if (legacy !== undefined && template.task.permission === undefined) {
          const { permissionMode: _dropped, ...rest } = template.task as unknown as { permissionMode?: unknown } & TaskTemplate['task']
          return { ...template, task: { ...rest, permission: legacy as string } }
        }
        return template
      })
      if (changed) {
        try { await this.persist(parsed) } catch { /* best effort — memory still carries the migration */ }
      }
    }
    this.templates = parsed
    this.loaded = true
  }

  /** Atomic persist (temp + fsync + rename — S10, same discipline as the ledger). */
  private async persist(templates: TaskTemplate[]): Promise<void> {
    const { mkdir, open, rename } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    await mkdir(dirname(this.file), { recursive: true })
    const temp = join(dirname(this.file), `.${Math.random().toString(36).slice(2)}.tmp`)
    const fh = await open(temp, 'w')
    try {
      await fh.writeFile(JSON.stringify({ templates }, null, 2), 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(temp, this.file)
  }

  /** All templates (oldest first). */
  async list(): Promise<TaskTemplate[]> {
    await this.ensure()
    return (this.templates ?? []).slice()
  }

  /**
   * Create or replace a template by id (a body without id creates).
   * @returns the stored template.
   */
  async upsert(input: { id?: string; name: string; category?: string; task: TaskTemplate['task'] }): Promise<TaskTemplate> {
    await this.ensure()
    const templates = this.templates ?? []
    const name = input.name.trim()
    if (name.length === 0 || name.length > 60) throw new Error('模板名必须 1..60 字符')
    const category = normalizeTemplateCategory(input.category)
    const now = Date.now()
    const existing = input.id !== undefined ? templates.find(t => t.id === input.id) : undefined
    // T12: built-ins are factory content — editable only by delete + recreate
    // (deleting stays allowed), never silently overwritten in place.
    if (existing?.builtin === true) throw new Error('内置模板不可覆盖；可删除后另建，或以新名称存为新模板')
    const stored: TaskTemplate = existing !== undefined
      ? { ...existing, name, category, task: input.task, updatedAt: now }
      : { id: input.id ?? newTemplateId(), name, ...(category !== undefined ? { category } : {}), task: input.task, createdAt: now, updatedAt: now }
    const index = existing !== undefined ? templates.indexOf(existing) : -1
    if (index >= 0) templates[index] = stored
    else templates.push(stored)
    await this.persist(templates)
    return stored
  }

  /** Delete a template by id; returns whether it existed. */
  async remove(id: string): Promise<boolean> {
    await this.ensure()
    const templates = this.templates ?? []
    const index = templates.findIndex(t => t.id === id)
    if (index < 0) return false
    templates.splice(index, 1)
    await this.persist(templates)
    return true
  }
}
