// Real-environment verification of the /taskboard routes on the dev server.
const base = 'http://127.0.0.1:3177'

// wait for server
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) break
  } catch { /* retry */ }
  await new Promise(r => setTimeout(r, 1000))
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// 1. state baseline
let res = await fetch(`${base}/taskboard/state`)
console.log('GET state:', res.status, JSON.stringify(await res.json()).slice(0, 100))

// 2. workspaces (real DSH registry)
res = await fetch(`${base}/taskboard/workspaces`)
const ws = await res.json()
console.log('GET workspaces:', res.status, JSON.stringify(ws.value?.map(w => `${w.id}|${w.title}`)))

// 3. create a real task in the first real workspace
const first = ws.value?.[0]
if (first) {
  const created = await post('/taskboard/tasks', {
    title: 'Dev-server verification task',
    workspaceId: first.id,
    urgency: 'urgent',
    description: 'created by the P2 route verification script',
  })
  console.log('POST tasks:', created.status, JSON.stringify(created.json.value ?? created.json.error))
  const id = created.json.value?.id

  // 4. lifecycle: claim → review → done (user path)
  if (id) {
    const mv = async (ifVersion, status) => post(`/taskboard/tasks/${id}/move`, { ifVersion, status })
    console.log('move in_progress:', (await mv(1, 'in_progress')).status)
    console.log('move in_review:', (await mv(2, 'in_review')).status)
    console.log('move done (user):', (await mv(3, 'done')).status)
    const stale = await mv(1, 'todo')
    console.log('stale move ->', stale.status, stale.json?.error?.code)
  }
} else {
  console.log('no workspaces registered; create skipped')
}

// 5. ledger file on disk
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
try {
  const ledger = JSON.parse(readFileSync(`${homedir()}/.dsh/taskboard.json`, 'utf8'))
  console.log('ledger on disk: revision', ledger.revision, 'tasks', ledger.tasks.map(t => `${t.title}[${t.status}]`))
} catch (error) {
  console.log('ledger read failed:', error.message)
}
