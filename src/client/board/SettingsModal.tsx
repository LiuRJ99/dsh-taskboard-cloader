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
import { DEFAULT_ISOLATION, defaultPermissionOf, defaultSyncExternalSessionsOf, type IsolationMode, type PermissionMode } from '../../shared/protocol.ts'
import { templateCategoryOptions } from '../template-categories.ts'
import { useT, type Translate } from '../i18n/runtime.ts'

/** The isolation options with one-line hints (mirrors the task form; translated per render). */
const isolationOptions = (t: Translate): ReadonlyArray<{ value: IsolationMode; name: string; hint: string }> => [
  { value: 'none', name: t('form.iso.none'), hint: t('set.iso.noneHint') },
  { value: 'worktree', name: t('form.iso.worktree'), hint: t('set.iso.worktreeHint') },
]

/**
 * The 看板设置 modal: reads the live ledger settings, stages a local draft,
 * and writes back through the controller on save.
 * @param controller - the board controller.
 */
export function SettingsModal({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = controller.getSnapshot()
  const currentIsolation = state.ledger.settings?.defaultIsolation ?? DEFAULT_ISOLATION
  const currentSync = defaultSyncExternalSessionsOf(state.ledger.settings)
  const currentPerm = defaultPermissionOf(state.ledger.settings)
  const currentCategory = state.ledger.settings?.templateMenuCategory ?? ''
  const [draftIsolation, setDraftIsolation] = useState<IsolationMode>(currentIsolation)
  const [draftSync, setDraftSync] = useState<boolean>(currentSync)
  const [draftPerm, setDraftPerm] = useState<PermissionMode>(currentPerm)
  const [draftCategory, setDraftCategory] = useState(currentCategory)
  const categories = templateCategoryOptions(state.templates)
  const categoryOptions = currentCategory !== '' && !categories.some(o => o.value === currentCategory)
    ? [...categories, { value: currentCategory, count: 0 }]
    : categories
  const dirty = draftIsolation !== currentIsolation || draftSync !== currentSync || draftPerm !== currentPerm || draftCategory !== currentCategory

  const save = (): void => {
    void controller.updateSettings({
      // Settings updates are whole-object replacements: keep every existing
      // field instead of accidentally clearing defaultIsolation.
      defaultIsolation: draftIsolation,
      syncExternalSessions: draftSync,
      defaultPermission: draftPerm,
      ...(draftCategory.length > 0 ? { templateMenuCategory: draftCategory } : {}),
    }).then(ok => {
      if (ok) controller.closeSettings()
    })
  }

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeSettings() }}>
      <div className="dsh-atb-modal dsh-atb-set" role="dialog" aria-modal="true" aria-label={t('set.aria')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">🛠</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('set.title')}</h3>
            <p>{t('set.subtitle')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={() => controller.closeSettings()}>✕</button>
        </div>

        <div className="dsh-atb-modal-body">
          <section className="dsh-atb-diag-sec">
            <h4>{t('set.iso.heading')}</h4>
            <div className="dsh-atb-mode-picker">
              {isolationOptions(t).map(o => (
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
              {t('set.iso.current', { current: currentIsolation === 'worktree' ? t('form.iso.worktree') : t('form.iso.none') })}
            </span>
          </section>

          <section className="dsh-atb-diag-sec">
            <h4>{t('set.sync.heading')}</h4>
            <div className="dsh-atb-mode-picker">
              <button
                type="button"
                className="dsh-atb-mode-opt"
                data-on={!draftSync}
                title={t('set.sync.off.title')}
                onClick={() => setDraftSync(false)}
              >
                <span className="dsh-atb-mode-name">{t('set.sync.off.name')}</span>
                <span className="dsh-atb-mode-hint">{t('set.sync.off.hint')}</span>
              </button>
              <button
                type="button"
                className="dsh-atb-mode-opt"
                data-on={draftSync}
                title={t('set.sync.on.title')}
                onClick={() => setDraftSync(true)}
              >
                <span className="dsh-atb-mode-name">{t('set.sync.on.name')}</span>
                <span className="dsh-atb-mode-hint">{t('set.sync.on.hint')}</span>
              </button>
            </div>
            <span className="dsh-atb-isolation-note">
              {currentSync
                ? t('set.sync.stateOn')
                : t('set.sync.stateOff')}
            </span>
          </section>

          <section className="dsh-atb-diag-sec">
            <h4>{t('set.perm.heading')}</h4>
            <div className="dsh-atb-perm-picker">
              <button
                type="button"
                className="dsh-atb-perm-opt"
                data-on={draftPerm === 'workspace-write'}
                onClick={() => setDraftPerm('workspace-write')}
              >
                <span className="dsh-atb-perm-name">{t('set.perm.writeName')}</span>
                <span className="dsh-atb-perm-hint">{t('set.perm.writeHint')}</span>
              </button>
              <button
                type="button"
                className="dsh-atb-perm-opt"
                data-on={draftPerm === 'read-only'}
                onClick={() => setDraftPerm('read-only')}
              >
                <span className="dsh-atb-perm-name">{t('set.perm.readOnlyName')}</span>
                <span className="dsh-atb-perm-hint">{t('set.perm.readOnlyHint')}</span>
              </button>
              <button
                type="button"
                className="dsh-atb-perm-opt"
                data-on={draftPerm === 'danger-full-access'}
                onClick={() => setDraftPerm('danger-full-access')}
              >
                <span className="dsh-atb-perm-name">{t('set.perm.fullName')}</span>
                <span className="dsh-atb-perm-hint">{t('set.perm.fullHint')}</span>
              </button>
            </div>
            <span className="dsh-atb-isolation-note">
              {t('set.perm.current', { current: currentPerm === 'read-only' ? t('set.perm.readOnlyName') : currentPerm === 'danger-full-access' ? t('set.perm.fullName') : t('set.perm.writeName') })}
            </span>
          </section>

          <section className="dsh-atb-diag-sec">
            <h4>{t('set.category.heading')}</h4>
            <select
              className="dsh-atb-template-category-select"
              value={draftCategory}
              onChange={e => setDraftCategory(e.target.value)}
            >
              <option value="">{t('set.category.all', { count: state.templates.length })}</option>
              {categoryOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.value}（{option.count}）{option.count === 0 ? ` · ${t('set.category.empty')}` : ''}
                </option>
              ))}
            </select>
            <span className="dsh-atb-isolation-note">
              {t('set.category.hint')}
            </span>
          </section>
        </div>

        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{dirty ? t('set.foot.dirty') : t('set.foot.clean')}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeSettings()}>{t('shared.cancel')}</button>
            <button type="button" className="dsh-atb-btn" data-primary="true" disabled={!dirty} onClick={save}>{t('set.action.save')}</button>
          </span>
        </div>
      </div>
    </div>
  )
}
