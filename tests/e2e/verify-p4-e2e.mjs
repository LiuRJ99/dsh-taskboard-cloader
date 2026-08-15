// P4 two-way E2E: the REAL agent loop claims the task, comments, and moves
// it to in_review through the taskboard_* tools — the full collaboration
// protocol exercised by a real model turn.
const base = 'http://127.0.0.1:3177'
for (let i = 0; i < 30; i++) {
  try { const r = await fetch(`${base}/`); if (r.ok) break } catch { await new Promise(r => setTimeout(r, 1000)) }
}
const post = async (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())

const ws = (await (await fetch(`${base}/taskboard/workspaces`)).json()).value
const target = ws.find(w => (w.title ?? '').includes('deepseekharness')) ?? ws[0]

// Clean historical verification tasks (trash + purge).
const stale = (await (await fetch(`${base}/taskboard/state`)).json()).value.tasks
  .filter(t => /P3 执行链路验证|P4 双向协作验证|prepare 排查|Dev-server verification/.test(t.title))
for (const t of stale) {
  if (t.trashedAt === undefined) await post(`/taskboard/tasks/${t.id}/delete`, {})
  await post(`/taskboard/tasks/${t.id}/delete`, { purge: true })
}
console.log('cleaned stale tasks:', stale.length)

const created = await post('/taskboard/tasks', {
  title: 'P4 双向协作验证',
  workspaceId: target.id,
  urgency: 'urgent',
  description: '验证 agent 按协议对已执行任务留评论并移交待验收。',
  prompt: [
    '这是一次任务看板协议验证（你的会话由任务执行服务启动，任务已在 in_progress）。',
    '请严格按顺序完成：',
    '1. 用 taskboard_get 读取消息头给出的任务 ID，确认标题与 version。',
    '2. 用 taskboard_comment_add 给该任务留评论，内容：「协议验证完成：评论与移交已执行」。',
    '3. 用 taskboard_move 把该任务移到 in_review（带最新 ifVersion）。',
    '4. 最后回复「协议验证通过」。',
  ].join('\n'),
})
const id = created.value.id
console.log('task:', id, '-> run')

const run = await post(`/taskboard/tasks/${id}/run`, {})
if (!run.value?.ok) { console.log('run failed', run); process.exit(1) }
console.log('execution session:', run.value.sessionId)

let task
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 3000))
  const state = (await (await fetch(`${base}/taskboard/state`)).json()).value
  task = state.tasks.find(t => t.id === id)
  const exec = task.executions[0]
  if (exec.outcome !== 'running') break
}
console.log('execution:', task.executions[0].outcome, task.executions[0].error ?? '')
console.log('final status:', task.status)
console.log('comments:', task.comments.length, task.comments.map(c => c.body.slice(0, 50)))
console.log('updatedBy:', JSON.stringify(task.updatedBy))
const pass = task.executions[0].outcome === 'succeeded'
  && task.status === 'in_review'
  && task.comments.length > 0
  && task.updatedBy.kind === 'agent'
console.log(pass ? 'P4 PROTOCOL E2E PASS ✓' : 'P4 INCOMPLETE — see state above')
