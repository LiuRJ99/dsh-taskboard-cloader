// P3 real E2E: create a task, trigger a manual run, and poll until the
// execution settles. This REALLY creates an agent session and consumes one
// API round — prompt is deliberately minimal.
const base = 'http://127.0.0.1:3177'
for (let i = 0; i < 30; i++) {
  try { const r = await fetch(`${base}/`); if (r.ok) break } catch { await new Promise(r => setTimeout(r, 1000)) }
}

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// 1. pick the deepseekharness workspace (this repo)
const ws = (await (await fetch(`${base}/agent-taskboard/workspaces`)).json()).value
const target = ws.find(w => (w.title ?? '').includes('deepseekharness')) ?? ws[0]
console.log('project:', target.title)

// 2. create a minimal task (default model — no pin, to test the plain path)
const created = await post('/agent-taskboard/tasks', {
  title: 'P3 执行链路验证',
  workspaceId: target.id,
  urgency: 'normal',
  prompt: '请只回复两个字：通过',
})
if (created.status !== 201) { console.log('create failed:', created); process.exit(1) }
const id = created.json.value.id
console.log('task created:', id)

// 3. trigger the run
const run = await post(`/agent-taskboard/tasks/${id}/run`, {})
console.log('run ->', run.status, JSON.stringify(run.json.value ?? run.json.error))
if (run.status !== 202) process.exit(1)
const sessionId = run.json.value.sessionId

// 4. poll the ledger until the execution settles (max ~120s)
let settled = null
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const state = (await (await fetch(`${base}/agent-taskboard/state`)).json()).value
  const task = state.tasks.find(t => t.id === id)
  const exec = task?.executions?.[0]
  if (exec && exec.outcome !== 'running') { settled = { task, exec }; break }
}
if (settled === null) {
  console.log('execution still running after 120s (session will settle in background)')
  process.exit(0)
}
console.log('settled:', settled.exec.outcome, settled.exec.error ?? '')
console.log('task status:', settled.task.status)
console.log('execution session:', settled.exec.sessionId)
console.log('E2E', settled.exec.outcome === 'succeeded' ? 'PASS ✓' : 'DONE (failed)')
