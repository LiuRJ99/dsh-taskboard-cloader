/**
 * The task form modal — create and edit in one polished dialog: header with
 * icon / subtitle / close, a sectioned field grid (title, project, model,
 * urgency tri-picker with hints, description, prompt, execution-mode
 * segmented picker, cron with presets and a live next-run preview), and a
 * footer bar carrying the validation hint and the actions. Esc closes;
 * the title input is focused on open.
 *
 * @module dsh-taskboard/client/board/TaskFormModal
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BoardController, GateCapabilityOption } from '../controller.ts'
import type { TaskTemplateSpec } from '../../shared/api.ts'
import type { ChecklistItem, IsolationMode, PermissionMode, TaskRecord, Urgency } from '../../shared/protocol.ts'
import { MAX_CHECKLIST_ITEMS, asPermission, defaultIsolationOf, defaultPermissionOf, nextCronTime, parseCron } from '../../shared/protocol.ts'
import { fmtTime } from './format.ts'
import { useT, type Translate } from '../i18n/runtime.ts'
import { SlashPromptInput } from './SlashPromptInput.tsx'

/** One row of the configured model catalog (from llm.models). */
export interface CatalogModel {
  provider: string
  model: string
  name?: string
  description?: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
  serviceTiers?: readonly { id: string; name?: string; description?: string }[]
}

/** A reasoning selector is useful only when the model exposes actual choices. */
export function hasReasoningOptions(reasoning: CatalogModel['reasoning'] | undefined): boolean {
  return reasoning !== undefined && reasoning.efforts.length > 0
}

/** Fast is usable only when the selected catalog row advertises priority. */
export function speedForModel(model: CatalogModel | undefined, speed: TaskSpeed): TaskSpeed {
  return supportsTaskFastSpeed(model) ? speed : 'standard'
}

/** Local storage key for remembering the last selected model in create mode. */
export const LAST_MODEL_KEY = 'dsh-taskboard-last-model-v1'

/** Read the remembered model from localStorage. */
export function loadLastModel(): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const raw = localStorage.getItem(LAST_MODEL_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const { provider, model, reasoningEffort } = parsed as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      if (typeof provider === 'string' && typeof model === 'string' && provider.trim().length > 0 && model.trim().length > 0) {
        return {
          provider: provider.trim(),
          model: model.trim(),
          ...(typeof reasoningEffort === 'string' && reasoningEffort.trim().length > 0 ? { reasoningEffort: reasoningEffort.trim() } : {}),
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Save the remembered model to localStorage. */
export function saveLastModel(model?: { provider: string; model: string; reasoningEffort?: string }): void {
  try {
    if (model === undefined) {
      localStorage.removeItem(LAST_MODEL_KEY)
    } else {
      localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(model))
    }
  } catch { /* storage unavailable */ }
}

/** Urgency segmented options with a one-line hint each (translated per render). */
const urgencyOptions = (t: Translate): ReadonlyArray<{ value: Urgency; label: string; hint: string }> => [
  { value: 'urgent', label: t('form.urgency.urgent'), hint: t('form.urgency.urgentHint') },
  { value: 'normal', label: t('form.urgency.normal'), hint: t('form.urgency.normalHint') },
  { value: 'relaxed', label: t('form.urgency.relaxed'), hint: t('form.urgency.relaxedHint') },
]

/** Cron presets offered in the scheduled mode (translated per render). */
const cronPresets = (t: Translate): ReadonlyArray<{ label: string; cron: string }> => [
  { label: t('form.cron.daily'), cron: '0 9 * * *' },
  { label: t('form.cron.hourly'), cron: '0 * * * *' },
  { label: t('form.cron.every10min'), cron: '*/10 * * * *' },
  { label: t('form.cron.weekly'), cron: '0 9 * * 1' },
]

/** Permission presets aligned with DSH (translated per render). */
const permissionOptions = (t: Translate): ReadonlyArray<{ value: PermissionMode; label: string; hint: string; icon: string }> => [
  { value: 'workspace-write', label: t('form.perm.write'), hint: t('form.perm.writeHint'), icon: '📁' },
  { value: 'read-only', label: t('form.perm.readOnly'), hint: t('form.perm.readOnlyHint'), icon: '🔒' },
  { value: 'danger-full-access', label: t('form.perm.fullAccess'), hint: t('form.perm.fullAccessHint'), icon: '⚡' },
]

/** Field shell: label + control, optionally spanning the full grid row. */
function Field({ label, required = false, full = false, children }: {
  label: string
  required?: boolean
  full?: boolean
  children: ReactNode
}) {
  return (
    <label className="dsh-atb-field" data-span={full ? 'full' : undefined}>
      <span className="dsh-atb-field-label">
        {label}
        {required && <em className="dsh-atb-req">*</em>}
      </span>
      {children}
    </label>
  )
}

/** One editable checklist row (create: fresh unchecked; edit: preserved ids/flags). */
interface CheckRow {
  id?: string
  text: string
  checked: boolean
  checkedBy?: string
  checkedAt?: number
  note?: string
}

/**
 * The checklist (DoD) editor: toggle + text + remove per row, add button,
 * cap-enforced. Edit mode preserves checked state and notes (the GUI
 * replaces the whole list on save).
 */
function ChecklistEditor({ rows, onChange, editing }: { rows: CheckRow[]; onChange: (rows: CheckRow[]) => void; editing: boolean }) {
  const t = useT()
  const setRow = (index: number, patch: Partial<CheckRow>): void => {
    const next = rows.map((row, i) => i === index ? { ...row, ...patch } : row)
    onChange(next)
  }
  const checked = rows.filter(r => r.checked).length
  return (
    <div className="dsh-atb-cke">
      {rows.map((row, index) => (
        <div
          key={row.id ?? `new-${index}`}
          className="dsh-atb-cke-row"
          data-editing={editing ? 'true' : undefined}
        >
          {editing && (
            <input
              type="checkbox"
              className="dsh-atb-cke-box"
              checked={row.checked}
              title={t('form.check.checkedTitle', { who: row.checkedBy ?? t('form.check.notCheckedYet') })}
              onChange={e => setRow(index, { checked: e.target.checked })}
            />
          )}
          <input
            className="dsh-atb-cke-text"
            value={row.text}
            maxLength={200}
            placeholder={t('form.check.itemPlaceholder', { n: index + 1 })}
            spellCheck={false}
            onChange={e => setRow(index, { text: e.target.value })}
          />
          <button type="button" className="dsh-atb-cke-del" title={t('form.check.removeTitle')} onClick={() => onChange(rows.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}
      {rows.length < MAX_CHECKLIST_ITEMS && (
        <button type="button" className="dsh-atb-cke-add" onClick={() => onChange([...rows, { text: '', checked: false }])}>{t('form.check.add')}</button>
      )}
      {rows.length > 0 && (
        <span className="dsh-atb-cke-hint">{editing ? t('form.check.hintEdit', { checked, total: rows.length }) : t('form.check.hintCreate', { n: rows.length })}</span>
      )}
    </div>
  )
}

/**
 * The form modal. Without `task` it composes a new task (optionally
 * prefilled from a chosen template); with `task` it edits that record
 * (project, urgency, execution, model included — the GUI is the owner
 * surface).
 * @param controller - the controller.
 * @param task - the task being edited (create mode when absent).
 */
export function TaskFormModal({ controller, task }: { controller: BoardController; task?: TaskRecord }) {
  const t = useT()
  const state = controller.getSnapshot()
  const prefill: TaskTemplateSpec | undefined = state.templatePrefill
  const editing = task !== undefined
  const [title, setTitle] = useState(task?.title ?? prefill?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? prefill?.description ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? prefill?.prompt ?? '')
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? '')
  const [urgency, setUrgency] = useState<Urgency>(task?.urgency ?? (prefill?.urgency === 'urgent' || prefill?.urgency === 'relaxed' ? prefill.urgency : 'normal'))
  const [mode, setMode] = useState<'claim' | 'scheduled'>(task?.execution.mode === 'scheduled' || prefill?.execution?.mode === 'scheduled' ? 'scheduled' : 'claim')
  const [cron, setCron] = useState(task?.execution.cron ?? prefill?.execution?.cron ?? '0 9 * * *')
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  // In create mode (when not pinned by template), prefill from the remembered last choice.
  const initialModel = task?.model ?? prefill?.model ?? (!editing ? loadLastModel() : undefined)
  const [model, setModel] = useState(initialModel === undefined ? '' : JSON.stringify(initialModel))
  const [speed, setSpeed] = useState<TaskSpeed>(
    task?.speed === 'fast' || prefill?.speed === 'fast' ? 'fast' : 'standard',
  )
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    task?.permissionMode ?? (prefill?.permissionMode === 'read-only' || prefill?.permissionMode === 'danger-full-access' ? prefill.permissionMode : 'workspace-write'),
  )
  const [requiredCapabilities, setRequiredCapabilities] = useState<TaskCapability[]>(() => extraCapabilitiesOf(task?.requiredCapabilities ?? prefill?.requiredCapabilities))
  const [gateOptions, setGateOptions] = useState<GateCapabilityOption[]>([])
  const [gateDiscoveryReady, setGateDiscoveryReady] = useState(false)
  // Preset roster (0.3.3): create mode PRE-SELECTS the deployment default
  // (标准模式 in this deployment); '' = 跟随部署默认 (submit omits the field).
  const initialPreset = task?.presetId ?? prefill?.presetId ?? ''
  const [presetId, setPresetId] = useState(initialPreset)
  const [presets, setPresets] = useState<Array<{ id: string; name?: string }>>([])
  const [presetDefault, setPresetDefault] = useState<string | undefined>(undefined)
  // Permission preset (0.5.5): 'workspace-write' (default) | 'read-only' | 'danger-full-access'
  const [permission, setPermission] = useState<PermissionMode>(
    task?.permission ?? (prefill?.permission ? asPermission(prefill.permission) : defaultPermissionOf(state.ledger.settings)),
  )
  // Isolation toggle: create mode starts from the board setting (0.5.0
  // 看板设置 → 默认执行隔离) or the template's choice; edit mode starts from
  // the task and locks once execution began.
  const [isolation, setIsolation] = useState<IsolationMode>(task?.isolation ?? (prefill?.isolation === 'none' ? 'none' : prefill?.isolation === 'worktree' ? 'worktree' : defaultIsolationOf(state.ledger.settings)))
  // Checklist (0.4.0): create = template texts / blank rows; edit = live items.
  const [checkRows, setCheckRows] = useState<CheckRow[]>(
    task?.checklist !== undefined && task.checklist.length > 0
      ? task.checklist.map(i => ({ ...i }))
      : (prefill?.checklist ?? []).map(text => ({ text, checked: false })),
  )
  const titleRef = useRef<HTMLInputElement>(null)
  // One in-flight write at a time: the foot buttons disable while a
  // create/update/run round-trip is pending — a double click used to fire
  // duplicate creates (and runs) before the first one returned (review P0).
  const [busy, setBusy] = useState(false)

  // Focus the title and close on Esc while the dialog is open.
  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') controller.closeForm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [controller])

  // Model catalog: query runtime or fallback to host API
  useEffect(() => {
    void controller.fetchModelCatalog().then(setCatalog).catch(() => setCatalog([]))
  }, [controller])

  // Preset roster: query runtime or fallback to host API; pre-select the deployment default in
  // create mode (unless a template pinned one) so executions run with a
  // real tool set out of the box.
  useEffect(() => {
    void controller.fetchPresetCatalog().then(roster => {
      setPresets(roster.presets)
      setPresetDefault(roster.defaultId)
      // CREATE mode only (review P1): pre-selecting in edit mode would
      // silently pin the deployment default onto tasks that deliberately
      // follow it. In create mode `task` is undefined, so checking
      // `initialPreset` (template pin) alone is sufficient.
      if (!editing && initialPreset === '' && roster.defaultId !== undefined) setPresetId(roster.defaultId)
    }).catch(() => setPresets([]))
  }, [controller, editing, task?.presetId, initialPreset])

  // Live cron validation + next-run preview (same math as the host).
  const cronMatch = mode === 'scheduled' ? parseCron(cron.trim()) : null
  const nextRun = cronMatch !== null ? nextCronTime(cronMatch, Date.now()) : null
  const cronBad = mode === 'scheduled' && (cronMatch === null || nextRun === null)
  const valid = title.trim().length > 0 && workspaceId !== '' && !cronBad

  // A task already in progress cannot be run again (host rejects it).
  const runBlocked = editing && task.status === 'in_progress'

  // Isolation editability: locked once the task has execution history (the
  // branch and its baseline depend on the choice — plan §3.1).
  const isolationLocked = editing && ((task.executions?.length ?? 0) > 0 || task.status === 'in_progress')
  const gitOk = controller.gitAvailable(workspaceId)
  // 0.6.3: how many repos a task mirror of this workspace would cover — >1
  // shows the auto-mirror note under the picker (multi-repo is automatic,
  // there is deliberately no per-task repo selection this release).
  const repoCount = controller.repoCount(workspaceId)
  // Non-git project: the worktree option is disabled; submitting keeps the
  // default (runtime auto-degrades with a note) instead of persisting 'none'.
  const isolationDisabled = isolationLocked || !gitOk

  /**
   * Isolation payload for submit: undefined lets the HOST materialize the
   * current board default at creation (non-git projects degrade naturally).
   */
  const isolationPayload = (): string | undefined => {
    if (!gitOk) return undefined
    return isolation
  }

  /** Preset payload: '' = follow the deployment default (submit omits). */
  const presetPayload = (): string | undefined => (presetId.trim().length > 0 ? presetId.trim() : undefined)

  /** The currently selected model, if the form state is still valid JSON. */
  const selectedModel = (() => {
    if (model === '') return undefined
    try {
      const value = JSON.parse(model) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      return typeof value.provider === 'string' && typeof value.model === 'string'
        ? {
            provider: value.provider,
            model: value.model,
            ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0 ? { reasoningEffort: value.reasoningEffort } : {}),
          }
        : undefined
    } catch {
      return undefined
    }
  })()
  const selectedCatalog = selectedModel === undefined
    ? undefined
    : catalog.find(entry => entry.provider === selectedModel.provider && entry.model === selectedModel.model)
  const reasoning = hasReasoningOptions(selectedCatalog?.reasoning) ? selectedCatalog?.reasoning : undefined
  const effectiveEffort = selectedModel?.reasoningEffort ?? reasoning?.defaultEffort
  const speedAvailable = supportsTaskFastSpeed(selectedCatalog)
  const effectiveSpeed = speedForModel(selectedCatalog, speed)

  /** Pick a model and seed its adapter-configured default reasoning level. */
  const chooseModel = (value: string): void => {
    if (value === '') {
      setModel('')
      setSpeed('standard')
      return
    }
    const picked = JSON.parse(value) as { provider: string; model: string }
    const metadata = catalog.find(entry => entry.provider === picked.provider && entry.model === picked.model)
    const next = {
      ...picked,
      ...(metadata?.reasoning?.defaultEffort !== undefined ? { reasoningEffort: metadata.reasoning.defaultEffort } : {}),
    }
    setSpeed(current => supportsTaskFastSpeed(metadata) ? current : 'standard')
    setModel(JSON.stringify(next))
  }

  /** Set the exact adapter-owned effort or remove it for provider default. */
  const chooseEffort = (value: string): void => {
    if (selectedModel === undefined) return
    const next = {
      provider: selectedModel.provider,
      model: selectedModel.model,
      ...(value.length > 0 ? { reasoningEffort: value } : {}),
    }
    setModel(JSON.stringify(next))
  }

  /** Checklist rows with non-empty text (blank rows are dropped on submit). */
  const filledRows = (): CheckRow[] => checkRows.map(r => ({ ...r, text: r.text.trim() })).filter(r => r.text.length > 0)

  const submit = (): void => {
    if (!valid || busy) return
    const picked = selectedModel
    if (!editing) saveLastModel(picked)
    const isolationOut = isolationPayload()
    const presetOut = presetPayload()
    const rows = filledRows()
    setBusy(true)
    const action = editing
      ? controller.update(task.id, task.version, {
        title,
        description,
        prompt,
        urgency,
        workspaceId,
        execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
        // '' in edit mode clears the pinned model back to the default.
        model: picked ?? null,
        speed: effectiveSpeed,
        permissionMode,
        requiredCapabilities: normalizeRequiredCapabilities([TASKBOARD_CAPABILITY, ...requiredCapabilities]),
        ...(isolationOut !== undefined && !isolationLocked ? { isolation: isolationOut } : {}),
        presetId: presetOut ?? null,
        permission,
        // [] clears the checklist (host deletes the field on empty).
        checklist: rows.length > 0 ? rows : null,
      })
      : controller.createFromPanel({
        title,
        workspaceId,
        urgency,
        description: description.length > 0 ? description : undefined,
        prompt: prompt.length > 0 ? prompt : undefined,
        execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
        model: picked,
        speed: effectiveSpeed,
        permissionMode,
        requiredCapabilities: normalizeRequiredCapabilities([TASKBOARD_CAPABILITY, ...requiredCapabilities]),
        ...(isolationOut !== undefined ? { isolation: isolationOut } : {}),
        ...(presetOut !== undefined ? { presetId: presetOut } : {}),
        permission,
        ...(rows.length > 0 ? { checklist: rows.map(r => r.text) } : {}),
      }, sessionId)
    void action.catch(() => undefined).finally(() => setBusy(false))
  }

  /** Save the form, then immediately trigger a manual run of the task. */
  const submitAndRun = (): void => {
    if (!valid || runBlocked || busy) return
    const picked = selectedModel
    if (!editing) saveLastModel(picked)
    const isolationOut = isolationPayload()
    const presetOut = presetPayload()
    const rows = filledRows()
    setBusy(true)
    void (async () => {
      if (editing) {
        const saved = await controller.update(task.id, task.version, {
          title,
          description,
          prompt,
          urgency,
          workspaceId,
          execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
          model: picked ?? null,
          speed: effectiveSpeed,
          permissionMode,
          requiredCapabilities: normalizeRequiredCapabilities([TASKBOARD_CAPABILITY, ...requiredCapabilities]),
          ...(isolationOut !== undefined && !isolationLocked ? { isolation: isolationOut } : {}),
          presetId: presetOut ?? null,
          permission,
          checklist: rows.length > 0 ? rows : null,
        })
        if (saved) await controller.run(task.id)
      } else {
        const id = await controller.createFromPanel({
          title,
          workspaceId,
          urgency,
          description: description.length > 0 ? description : undefined,
          prompt: prompt.length > 0 ? prompt : undefined,
          execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
          model: picked,
          speed: effectiveSpeed,
          permissionMode,
          requiredCapabilities: normalizeRequiredCapabilities([TASKBOARD_CAPABILITY, ...requiredCapabilities]),
          ...(isolationOut !== undefined ? { isolation: isolationOut } : {}),
          ...(presetOut !== undefined ? { presetId: presetOut } : {}),
          permission,
          ...(rows.length > 0 ? { checklist: rows.map(r => r.text) } : {}),
        }, sessionId)
        if (id !== undefined) await controller.run(id)
      }
    })().catch(() => undefined).finally(() => setBusy(false))
  }

  const hint = !valid
    ? (title.trim().length === 0 ? t('form.hint.needTitle') : workspaceId === '' ? t('form.hint.needProject') : t('form.hint.cronBad'))
    : mode === 'scheduled' && nextRun !== null
      ? t('form.hint.nextRun', { time: fmtTime(nextRun) })
      : editing
        ? t('form.hint.saveVersion', { v: task.version, next: task.version + 1 })
        : t('form.hint.createClaim')

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeForm() }}>
      <div className="dsh-atb-modal dsh-atb-taskform-modal" data-mode={editing ? 'edit' : 'create'} role="dialog" aria-modal="true" aria-label={editing ? t('form.title.edit') : t('form.title.create')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">{editing ? '✎' : '✚'}</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{editing ? t('form.title.edit') : t('form.title.create')}</h3>
            <p>{editing ? t('form.subtitle.edit') : t('form.subtitle.create')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={() => controller.closeForm()}>✕</button>
        </div>

        <div className="dsh-atb-modal-body dsh-atb-taskform-body">
          {/* Left Column: Core Fields & Execution Configurations */}
          <div className="dsh-atb-form-col dsh-atb-form-left">
            <Field label={t('form.field.title')} required full>
              <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('form.field.titlePlaceholder')} maxLength={200} />
            </Field>

            <div className="dsh-atb-form-subgrid">
              <Field label={t('form.field.project')} required>
                <select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>
                  {state.workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title || ws.path}</option>)}
                </select>
              </Field>

              <Field label={t('form.field.model')}>
                <select
                  value={model}
                  onChange={e => {
                    const val = e.target.value
                    setModel(val)
                    if (val === '') {
                      setReasoningEffort('')
                    } else {
                      const pm = JSON.parse(val) as { provider: string; model: string }
                      const cm = catalog.find(m => m.provider === pm.provider && m.model === pm.model)
                      if (cm?.reasoning?.defaultEffort !== undefined) {
                        setReasoningEffort(cm.reasoning.defaultEffort)
                      } else {
                        setReasoningEffort('')
                      }
                    }
                  }}
                >
                  <option value="">{t('form.field.modelDefault')}</option>
                  {catalog.map(m => (
                    <option key={`${m.provider}/${m.model}`} value={JSON.stringify({ provider: m.provider, model: m.model })}>
                      {t('form.model.option', { name: m.name ?? m.model, provider: m.provider })}
                    </option>
                  ))}
                </select>
              </Field>

              {parsedModel !== undefined && (
                <Field label={t('form.field.effort')}>
                  <select
                    value={reasoningEffort}
                    onChange={e => setReasoningEffort(e.target.value)}
                    title={t('form.field.effortTitle')}
                  >
                    <option value="">{t('form.effort.follow')}{modelReasoning?.defaultEffort !== undefined ? t('shared.current', { name: modelReasoning.efforts.find(ef => ef.id === modelReasoning.defaultEffort)?.name ?? modelReasoning.defaultEffort }) : ''}</option>
                    {modelReasoning !== undefined && modelReasoning.efforts.length > 0 ? (
                      modelReasoning.efforts.map(eff => (
                        <option key={eff.id} value={eff.id}>
                          {eff.name}{eff.description ? ` (${eff.description})` : ''}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="low">{t('form.effort.low')}</option>
                        <option value="medium">{t('form.effort.medium')}</option>
                        <option value="high">{t('form.effort.high')}</option>
                        <option value="none">{t('form.effort.none')}</option>
                      </>
                    )}
                  </select>
                </Field>
              )}

              {presets.length > 0 && (
                <Field label={t('form.field.preset')}>
                  <select value={presetId} onChange={e => setPresetId(e.target.value)} title={t('form.field.presetTitle')}>
                    <option value="">{t('form.preset.follow')}{presetDefault !== undefined ? t('shared.current', { name: presets.find(p => p.id === presetDefault)?.name ?? presetDefault }) : ''}</option>
                    {presets.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name ?? p.id}{p.id === presetDefault ? t('form.preset.defaultTag') : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>

            <Field label={t('form.field.urgency')} full>
              <div className="dsh-atb-urgency-picker">
                {urgencyOptions(t).map(o => (
                  <button
                    key={o.value}
                    type="button"
                    className="dsh-atb-urgency-opt"
                    data-urgency={o.value}
                    data-on={urgency === o.value}
                    onClick={() => setUrgency(o.value)}
                  >
                    <span className="dsh-atb-urgency-name"><span className="dsh-atb-dot" data-urgency={o.value} />{o.label}</span>
                    <span className="dsh-atb-urgency-hint">{o.hint}</span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t('form.field.permission')} full>
              <div className="dsh-atb-perm-picker">
                {permissionOptions(t).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className="dsh-atb-perm-opt"
                    data-on={permission === opt.value}
                    onClick={() => setPermission(opt.value)}
                  >
                    <span className="dsh-atb-perm-name">{opt.icon} {opt.label}{opt.value === 'workspace-write' ? t('form.perm.defaultTag') : ''}</span>
                    <span className="dsh-atb-perm-hint">{opt.hint}</span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t('form.field.mode')} full>
              <div className="dsh-atb-mode-picker">
                <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'claim'} onClick={() => setMode('claim')}>
                  <span className="dsh-atb-mode-name">{t('form.mode.claim')}</span>
                  <span className="dsh-atb-mode-hint">{t('form.mode.claimHint')}</span>
                </button>
                <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'scheduled'} onClick={() => setMode('scheduled')}>
                  <span className="dsh-atb-mode-name">{t('form.mode.scheduled')}</span>
                  <span className="dsh-atb-mode-hint">{t('form.mode.scheduledHint')}</span>
                </button>
              </div>
            </Field>

            {mode === 'scheduled' && (
              <Field label={t('form.field.cron')} required full>
                <input
                  className={cronBad ? 'dsh-atb-input-bad' : undefined}
                  value={cron}
                  onChange={e => setCron(e.target.value)}
                  placeholder={t('form.cron.placeholder')}
                  spellCheck={false}
                />
                <span className="dsh-atb-cron-presets">
                  {cronPresets(t).map(p => (
                    <button
                      key={p.cron}
                      type="button"
                      className="dsh-atb-cron-preset"
                      data-on={cron.trim() === p.cron}
                      onClick={() => setCron(p.cron)}
                    >
                      {p.label}
                    </button>
                  ))}
                  {!cronBad && nextRun !== null && <span className="dsh-atb-cron-next">{t('form.cron.next', { time: fmtTime(nextRun) })}</span>}
                </span>
              </Field>
            )}

            <Field label={t('form.field.isolation')} full>
              <div className="dsh-atb-mode-picker" data-disabled={isolationDisabled ? 'true' : undefined}>
                <button
                  type="button"
                  className="dsh-atb-mode-opt"
                  data-on={isolation === 'worktree'}
                  disabled={isolationDisabled}
                  title={isolationLocked ? t('form.iso.locked') : !gitOk ? t('form.iso.nonGit') : t('form.iso.worktreeTitle')}
                  onClick={() => setIsolation('worktree')}
                >
                  <span className="dsh-atb-mode-name">{t('form.iso.worktree')}</span>
                  <span className="dsh-atb-mode-hint">
                    {isolationLocked ? t('form.iso.lockedShort') : !gitOk ? t('form.iso.nonGit') : t('form.iso.worktreeHint')}
                  </span>
                </button>
                <button
                  type="button"
                  className="dsh-atb-mode-opt"
                  data-on={isolation === 'none'}
                  disabled={isolationDisabled}
                  title={isolationLocked ? t('form.iso.locked') : t('form.iso.noneTitle')}
                  onClick={() => setIsolation('none')}
                >
                  <span className="dsh-atb-mode-name">{t('form.iso.none')}</span>
                  <span className="dsh-atb-mode-hint">{isolationLocked ? t('form.iso.lockedShort') : !gitOk ? t('form.iso.noneHintNonGit') : t('form.iso.noneHint')}</span>
                </button>
              </div>
              {!gitOk && !isolationLocked && (
                <span className="dsh-atb-isolation-note">{t('form.iso.nonGitNote')}</span>
              )}
              {gitOk && !isolationLocked && repoCount > 1 && (
                <span className="dsh-atb-isolation-note" data-mirror="true">{t('form.iso.mirrorNote', { n: repoCount })}</span>
              )}
            </Field>

            <Field label={editing ? t('form.field.checklist') : t('form.field.checklistOptional')} full>
              <ChecklistEditor rows={checkRows} onChange={setCheckRows} editing={editing} />
            </Field>
          </div>

          {/* Right Column: Description & Execution Prompt */}
          <div className="dsh-atb-form-col dsh-atb-form-right">
            <Field label={editing ? t('form.field.description') : t('form.field.descriptionOptional')} full>
              <SlashPromptInput
                value={description}
                onChange={setDescription}
                controller={controller}
                rows={7}
                placeholder={t('form.desc.placeholder')}
              />
            </Field>

            <Field label={editing ? t('form.field.prompt') : t('form.field.promptOptional')} full>
              <SlashPromptInput
                value={prompt}
                onChange={setPrompt}
                controller={controller}
                rows={7}
                placeholder={t('form.prompt.placeholder')}
              />
            </Field>
          </div>
        </div>

        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint" data-tone={valid ? undefined : 'bad'}>{hint}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeForm()}>{t('shared.cancel')}</button>
            <button
              type="button"
              className="dsh-atb-btn"
              disabled={!valid || runBlocked || busy}
              title={runBlocked ? t('form.action.runBlockedTitle') : busy ? t('form.action.runBusyTitle') : t('form.action.runTitle')}
              onClick={submitAndRun}
            >
              {t('form.action.run')}
            </button>
            <button type="button" className="dsh-atb-btn" data-primary="true" disabled={!valid || busy} onClick={submit}>
              {editing ? t('form.action.save') : t('form.action.create')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/** The record shape this form edits (narrow structural type to avoid a value import). */
interface TaskRecordLike {
  id: string
  version: number
  status?: string
  title: string
  description: string
  prompt: string
  workspaceId: string
  urgency: Urgency
  execution: { mode: 'claim' | 'scheduled'; cron?: string }
  model?: { provider: string; model: string; reasoningEffort?: string }
  requiredCapabilities?: TaskCapability[]
  speed?: TaskSpeed
  permissionMode?: PermissionMode
  isolation?: IsolationMode
  presetId?: string
  checklist?: ChecklistItem[]
  executions?: unknown[]
}
