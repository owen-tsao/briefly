// DEV ONLY. CPU-profiles briefly's main process for N seconds and prints the hottest functions.
// Launch the app with --inspect=9229 first (see README "Scripts"). Usage: node scripts/profile-main.mjs 25
const seconds = Number(process.argv[2] ?? 20)
const list = await (await fetch('http://127.0.0.1:9229/json')).json()
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
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
await call('Profiler.enable')
await call('Profiler.setSamplingInterval', { interval: 1000 })
await call('Profiler.start')
await new Promise((r) => setTimeout(r, seconds * 1000))
const { profile } = await call('Profiler.stop')
ws.close()

// Self time per function, then roll up by file so the picture is readable.
const byNode = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = profile.timeDeltas
for (let i = 0; i < profile.samples.length; i++) {
  const n = byNode.get(profile.samples[i])
  const key = `${n.callFrame.functionName || '(anon)'} @ ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0))
}
const total = [...self.values()].reduce((a, b) => a + b, 0) / 1000
const busy = [...self.entries()].filter(([k]) => !/\(idle\)|\(program\)|\(garbage collector\)/.test(k)).reduce((a, [, v]) => a + v, 0) / 1000
console.log(`sampled ${total.toFixed(0)} ms, busy ${busy.toFixed(0)} ms (${((busy / total) * 100).toFixed(0)}%)`)
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`)
