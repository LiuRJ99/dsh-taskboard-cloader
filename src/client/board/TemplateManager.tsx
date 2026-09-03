/**
 * The template-manager modal (0.4.0): rename / categorize / delete / use the
 * stored task templates. Templates live host-side (side file next to the
 * ledger) and prefill the create form from the + 新建任务 ▼ dropdown.
 *
 * @module dsh-taskboard/client/board/TemplateManager
 */
import { useState } from 'react'
import type { BoardController } from '../controller.ts'
import { useAlert } from './AlertModal.tsx'
import { matchesTemplateCategory, templateCategoryOf, templateCategoryOptions } from '../template-categories.ts'
import { useT } from '../i18n/runtime.ts'

/**
 * The template manager modal.
 * @param controller - the controller.
 */
export function TemplateManager({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = controller.getSnapshot()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [categoryEdits, setCategoryEdits] = useState<Record<string, string>>({})
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const { alert: showAlert, el: alertEl } = useAlert()

  const close = (): void => controller.closeTemplateManager()
  const categories = templateCategoryOptions(state.templates)
  const selectedCategory = state.ledger.settings?.templateMenuCategory
  const visibleTemplates = state.templates.filter(template => matchesTemplateCategory(template, selectedCategory))

  const nameOf = (id: string, fallback: string): string => edits[id] ?? fallback
  const categoryOf = (id: string, fallback: string | undefined): string => categoryEdits[id] ?? templateCategoryOf({ category: fallback })

  /** Save one template's rename and/or category. */
  const save = (id: string, name: string, category: string): void => {
    const template = state.templates.find(t => t.id === id)
    if (template === undefined) return
    const normalizedCategory = category.trim().length > 0 ? category.trim() : '其他'
    if (name === template.name && normalizedCategory === templateCategoryOf(template)) return
    void controller.upsertTemplate({ id, name, category: normalizedCategory, task: template.task }).then(ok => {
      if (ok) {
        setEdits(prev => { const next = { ...prev }; delete next[id]; return next })
        setCategoryEdits(prev => { const next = { ...prev }; delete next[id]; return next })
        showAlert(t('tpl.updated'))
      }
    })
  }

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div className="dsh-atb-modal dsh-atb-tplm" role="dialog" aria-modal="true" aria-label={t('tpl.aria')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">⌗</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('tpl.title')}</h3>
            <p>{t('tpl.subtitle')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={close}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          {state.templates.length === 0
            ? <div className="dsh-atb-empty2">{t('tpl.empty')}</div>
            : visibleTemplates.length === 0
              ? <div className="dsh-atb-empty2">{t('tpl.categoryEmpty')}</div>
              : (
                <>
                  <datalist id="dsh-atb-template-categories">
                    {categories.map(option => <option key={option.value} value={option.value} />)}
                  </datalist>
                  <div className="dsh-atb-tplm-list">
                    {visibleTemplates.map(tpl => {
                      const name = nameOf(tpl.id, tpl.name)
                      const category = categoryOf(tpl.id, tpl.category)
                      const unchanged = name === tpl.name && category === templateCategoryOf(tpl)
                      return (
                        <div key={tpl.id} className="dsh-atb-tplm-row">
                          <input
                            className="dsh-atb-tplm-name"
                            value={name}
                            maxLength={60}
                            spellCheck={false}
                            aria-label={t('tpl.name.aria', { name: tpl.name })}
                            onChange={e => setEdits(prev => ({ ...prev, [tpl.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') save(tpl.id, name, category)
                            }}
                          />
                          <input
                            className="dsh-atb-tplm-category"
                            value={category}
                            maxLength={30}
                            list="dsh-atb-template-categories"
                            spellCheck={false}
                            placeholder={t('tpl.category.placeholder')}
                            aria-label={t('tpl.category.aria', { name: tpl.name })}
                            onChange={e => setCategoryEdits(prev => ({ ...prev, [tpl.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') save(tpl.id, name, category)
                            }}
                          />
                          <span className="dsh-atb-tplm-meta">
                            {tpl.builtin === true ? t('tpl.builtin') : t('tpl.custom')}
                            {tpl.task.checklist !== undefined && tpl.task.checklist.length > 0 ? t('tpl.meta.checklist', { n: tpl.task.checklist.length }) : ''}
                            {tpl.task.urgency !== undefined ? ` · ${tpl.task.urgency}` : ''}
                            {tpl.task.speed === 'fast' ? ` · ${t('tpl.speedFast')}` : ''}
                            {tpl.task.permission !== undefined && tpl.task.permission !== 'workspace-write'
                              ? ` · ${tpl.task.permission === 'read-only' ? t('tpl.meta.permReadOnly') : t('tpl.meta.permFull')}`
                              : ''}
                          </span>
                          <span className="dsh-atb-tplm-btns">
                            <button
                              type="button"
                              className="dsh-atb-btn"
                              disabled={unchanged || name.trim().length === 0}
                              title={t('tpl.rename.title')}
                              onClick={() => save(tpl.id, name, category)}
                            >
                              {t('tpl.rename.button')}
                            </button>
                            <button
                              type="button"
                              className="dsh-atb-btn"
                              title={t('tpl.use.title')}
                              onClick={() => {
                                close()
                                controller.newFromTemplate(tpl.task)
                              }}
                            >
                              {t('tpl.use.button')}
                            </button>
                            {confirmId === tpl.id
                              ? (
                                <>
                                  <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.deleteTemplate(tpl.id); setConfirmId(undefined) }}>{t('shared.confirmDelete')}</button>
                                  <button type="button" className="dsh-atb-btn" onClick={() => setConfirmId(undefined)}>{t('shared.cancel')}</button>
                                </>
                              )
                              : (
                                <button type="button" className="dsh-atb-btn" data-danger="true" title={t('tpl.delete.title')} onClick={() => setConfirmId(tpl.id)}>
                                  🗑
                                </button>
                              )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
        </div>
        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{t('tpl.foot.hint')}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={close}>{t('shared.close')}</button>
          </span>
        </div>
      </div>
      {alertEl}
    </div>
  )
}
