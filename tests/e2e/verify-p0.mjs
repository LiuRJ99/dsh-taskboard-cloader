// Verify the P0 mount: fetch the served plugin client bundle + the shell page.
const base = 'http://127.0.0.1:3177'

for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      console.log(`shell page: ${res.status}`)
      break
    }
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 1000))
}

for (const path of ['/plugins/dsh-taskbord/client.js']) {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) })
    const text = res.ok ? await res.text() : ''
    console.log(`${path} -> ${res.status} (${text.length} bytes)`)
    if (text.includes('__ModuleLoader__.load')) console.log('  registration wrapper present ✓')
  } catch (err) {
    console.log(`${path} -> ERROR ${err.message}`)
  }
}
