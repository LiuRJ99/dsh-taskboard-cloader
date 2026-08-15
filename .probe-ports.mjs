// Probe common ports and the exact URL the server prints.
const candidates = [3177, 3080, 3000, 8080, 5173, 4173, 8787]
for (const port of candidates) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    const server = res.headers.get('server') ?? ''
    console.log(`port ${port}: ${res.status} server=${server}`)
  } catch (err) {
    console.log(`port ${port}: no (${err.cause?.code ?? err.message.split('\n')[0]})`)
  }
}
// check listening sockets via netstat alternative: try the dsh webserver default
