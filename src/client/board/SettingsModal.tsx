/**
 * Board-settings modal (0.5.0): user-owned defaults applied when a NEW task
 * is created without an explicit choice, plus the global template-menu
 * category preference. Saving goes through the host route (whole-object
 * replace) and the SSE change stream refreshes every open view.
 *
 * @module dsh-taskboard/client/board/SettingsModal
 */
import { useState } from 'react'
import type { BoardController } from '../controller.ts'
import { DEFAULT_ISOLATION, type IsolationMode } from '../../shared/protocol.ts'
import { templateCategoryOptions } from '../template-categories.ts'

/** The isolation options with one-line hints (mirrors the task form). */
const ISOLATION_OPTIONS: ReadonlyArray<{ value: IsolationMode; name: string; hint: string }> = [
  { value: 'none', name: '📁 原目录执行', hint: '不使用 git，直接在项目目录工作（出厂默认）' },
  { value: 'worktree', name: '🌿 Worktree 隔离', hint: '每次执行在独立 worktree 分支上进行（task/标题+ID），互不污染' },
]

/**
 * The 看板设置 modal: reads the live ledger settings, stages a local draft,
 * and writes back through the controller on save.
 * @param controller - the board controller.
 */
export function SettingsModal({ controller }: { controller: BoardController }) {
  const state = controller.getSnapshot()
  const currentIsolation = state.ledger.settings?.defaultIsolation ?? DEFAULT_ISOLATION
  const currentCategory = state.ledger.settings?.templateMenuCategory ?? ''
  const [draftIsolation, setDraftIsolation] = useState<IsolationMode>(currentIsolation)
  const [draftCategory, setDraftCategory] = useState(currentCategory)
  const categories = templateCategoryOptions(state.templates)
  const categoryOptions = currentCategory !== '' && !categories.some(o => o.value === currentCategory)
    ? [...categories, { value: currentCategory, count: 0 }]
    : categories
  const dirty = draftIsolation !== currentIsolation || draftCategory !== currentCategory

  const save = (): void => {
    void controller.updateSettings({
      // Settings updates are whole-object replacements: keep every existing
      // field instead of accidentally clearing defaultIsolation.
      defaultIsolation: draftIsolation,
      ...(draftCategory.length > 0 ? { templateMenuCategory: draftCategory } : {}),
    }).then(ok => {
      if (ok) controller.closeSettings()
    })
  }

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeSettings() }}>
      <div className="dsh-atb-modal dsh-atb-set" role="dialog" aria-modal="true" aria-label="看板设置">
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">🛠</span>
          <div className="dsh-atb-modal-headtext">
            <h3>看板设置</h3>
            <p>新建任务时应用的默认值（不影响已有任务）</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label="关闭" onClick={() => controller.closeSettings()}>✕</button>
        </div>

        <div className="dsh-atb-modal-body">
          <section className="dsh-atb-diag-sec">
            <h4>默认执行隔离</h4>
            <div className="dsh-atb-mode-picker">
              {ISOLATION_OPTIONS.map(o => (
                <button
                  key={o.value}
                  type="button"
                  className="dsh-atb-mode-opt"
                  data-on={draftIsolation === o.value}
                  title={o.hint}
                  onClick={() => setDraftIsolation(o.value)}
                >
                  <span className="dsh-atb-mode-name">{o.name}</span>
                  <span className="dsh-atb-mode-hint">{o.hint}</span>
                </button>
              ))}
            </div>
            <span className="dsh-atb-isolation-note">
              当前保存的默认：{currentIsolation === 'worktree' ? '🌿 Worktree 隔离' : '📁 原目录执行'}。
              仅影响之后新建的任务；已有任务保持创建时的选择，非 git 项目运行时仍自动降级原目录。
            </span>
          </section>

          <section className="dsh-atb-diag-sec">
            <h4>新建任务菜单的模板分类</h4>
            <select
              className="dsh-atb-template-category-select"
              value={draftCategory}
              onChange={e => setDraftCategory(e.target.value)}
            >
              <option value="">全部分类（{state.templates.length}）</option>
              {categoryOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.value}（{option.count}）{option.count === 0 ? ' · 当前无模板' : ''}
                </option>
              ))}
            </select>
            <span className="dsh-atb-isolation-note">
              只影响“+ 新建任务”菜单的模板展示，不会影响模板内容和已有任务；模板类别可在“管理模板”中调整。
            </span>
          </section>
        </div>

        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{dirty ? '有未保存的修改' : '与看板当前设置一致'}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeSettings()}>取消</button>
            <button type="button" className="dsh-atb-btn" data-primary="true" disabled={!dirty} onClick={save}>保存设置</button>
          </span>
        </div>
      </div>
    </div>
  )
}
