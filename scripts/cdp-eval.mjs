// DEV ONLY. Drives the running briefly renderer over CDP to test UI behaviour without clicking.
// Requires launching the app with --remote-debugging-port=9333, which lets ANY local process drive
// the renderer (clipboard, CSV export, Aside launcher). Never run the app that way day to day.
// Usage: node scripts/cdp-eval.mjs "<js expression>"   (uses Node's built-in WebSocket)

const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const me = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === me) {
        ws.removeEventListener('message', onMsg)
        resolve(m.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: me, method, params }))
  })
// An argument starting with @ is a file whose contents are the expression (for long payloads).
const expr = process.argv[2]?.startsWith('@') ? (await import('node:fs')).readFileSync(process.argv[2].slice(1), 'utf8') : process.argv[2]
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(r?.result?.value ?? r, null, 1))
// Optional: node scripts/cdp-eval.mjs "<expr>" --shot /tmp/x.png  → PNG of the popover after the expression ran.
const shotIdx = process.argv.indexOf('--shot')
if (shotIdx !== -1) {
  await new Promise((res) => setTimeout(res, 400))
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.argv[shotIdx + 1], Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', process.argv[shotIdx + 1])
}
ws.close()
