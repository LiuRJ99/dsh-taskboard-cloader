// P2 final verification: server up, client bundle served (new size),
// routes live, ledger persisted from the earlier real run.
const base = 'http://127.0.0.1:3177'
for (let i = 0; i < 30; i++) {
  try { const r = await fetch(`${base}/`); if (r.ok) break } catch { await new Promise(r => setTimeout(r, 1000)) }
}
const client = await fetch(`${base}/plugins/dsh-taskboard/client.js`)
const clientText = client.ok ? await client.text() : ''
console.log('client.js:', client.status, `${clientText.length} bytes`, clientText.includes('__ModuleLoader__') ? '✓ wrapper' : '✗')
console.log('  board view code:', clientText.includes('dsh-atb-board') ? '✓' : '✗')
console.log('  urgency chips:', clientText.includes('dsh-atb-chip') ? '✓' : '✗')
console.log('  composer:', clientText.includes('新建任务') ? '✓' : '✗')
console.log('  detail:', clientText.includes('执行记录') ? '✓' : '✗')
const state = await fetch(`${base}/dsh-taskbord/state`)
const body = await state.json()
console.log('state:', state.status, `rev ${body.value.revision}, ${body.value.tasks.length} task(s):`, body.value.tasks.map(t => `${t.title}[${t.status}]`))
const ws = await (await fetch(`${base}/dsh-taskbord/workspaces`)).json()
console.log('workspaces:', ws.value.map(w => `${w.id.slice(0, 8)}(${w.title ?? w.path})`).join(', '))
