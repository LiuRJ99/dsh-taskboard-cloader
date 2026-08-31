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

/**
 * The template manager modal.
 * @param controller - the controller.
 */
export function TemplateManager({ controller }: { controller: BoardController }) {
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
        showAlert('模板已更新')
      }
    })
  }

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div className="dsh-atb-modal dsh-atb-tplm" role="dialog" aria-modal="true" aria-label="管理模板">
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">⌗</span>
          <div className="dsh-atb-modal-headtext">
            <h3>任务模板</h3>
            <p>新建任务 ▼ 下拉的模板：改名 / 分类 / 删除 / 直接使用；任务详情页「存为模板」可新增</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label="关闭" onClick={close}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          {state.templates.length === 0
            ? <div className="dsh-atb-empty2">暂无模板 — 在任务详情页点「存为模板」把常用配置沉淀下来</div>
            : visibleTemplates.length === 0
              ? <div className="dsh-atb-empty2">当前看板设置的类别暂无模板，请在看板设置中调整模板分类</div>
              : (
                <>
                  <datalist id="dsh-atb-template-categories">
                    {categories.map(option => <option key={option.value} value={option.value} />)}
                  </datalist>
                  <div className="dsh-atb-tplm-list">
                    {visibleTemplates.map(t => {
                      const name = nameOf(t.id, t.name)
                      const category = categoryOf(t.id, t.category)
                      const unchanged = name === t.name && category === templateCategoryOf(t)
                      return (
                        <div key={t.id} className="dsh-atb-tplm-row">
                          <input
                            className="dsh-atb-tplm-name"
                            value={name}
                            maxLength={60}
                            spellCheck={false}
                            aria-label={`模板名 ${t.name}`}
                            onChange={e => setEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') save(t.id, name, category)
                            }}
                          />
                          <input
                            className="dsh-atb-tplm-category"
                            value={category}
                            maxLength={30}
                            list="dsh-atb-template-categories"
                            spellCheck={false}
                            aria-label={`模板类别 ${t.name}`}
                            onChange={e => setCategoryEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') save(t.id, name, category)
                            }}
                          />
                          <span className="dsh-atb-tplm-meta">
                            {t.builtin === true ? '内置' : '自建'}
                            {t.task.checklist !== undefined && t.task.checklist.length > 0 ? ` · 清单 ${t.task.checklist.length} 项` : ''}
                            {t.task.urgency !== undefined ? ` · ${t.task.urgency}` : ''}
                            {t.task.speed === 'fast' ? ' · 快速' : ''}
                            {t.task.permissionMode !== undefined ? ` · ${t.task.permissionMode}` : ''}
                          </span>
                          <span className="dsh-atb-tplm-btns">
                            <button
                              type="button"
                              className="dsh-atb-btn"
                              disabled={unchanged || name.trim().length === 0}
                              title="保存模板名和类别"
                              onClick={() => save(t.id, name, category)}
                            >
                              改名
                            </button>
                            <button
                              type="button"
                              className="dsh-atb-btn"
                              title="用此模板打开新建表单"
                              onClick={() => {
                                close()
                                controller.newFromTemplate(t.task)
                              }}
                            >
                              用此新建
                            </button>
                            {confirmId === t.id
                              ? (
                                <>
                                  <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.deleteTemplate(t.id); setConfirmId(undefined) }}>确认删除</button>
                                  <button type="button" className="dsh-atb-btn" onClick={() => setConfirmId(undefined)}>取消</button>
                                </>
                              )
                              : (
                                <button type="button" className="dsh-atb-btn" data-danger="true" title="删除该模板" onClick={() => setConfirmId(t.id)}>
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
          <span className="dsh-atb-modal-hint">模板随台账一同保存在 DSH 主目录，升级不丢</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={close}>关闭</button>
          </span>
        </div>
      </div>
      {alertEl}
    </div>
  )
}
