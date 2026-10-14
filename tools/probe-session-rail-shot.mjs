import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../apps/desktop/package.json'))
const WebSocket = require('ws')
const port = Number(process.argv[2] || 9333)

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})

let id = 1
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = id++
    const timer = setTimeout(() => reject(new Error(method)), 15000)
    ws.on('message', function handler(raw) {
      const msg = JSON.parse(String(raw))
      if (msg.id !== my) return
      clearTimeout(timer)
      ws.off('message', handler)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    })
    ws.send(JSON.stringify({ id: my, method, params }))
  })

await call('Runtime.enable')
await call('Page.enable')
const layout = await call('Runtime.evaluate', {
  expression: `(() => {
    const ticks = [...document.querySelectorAll('[data-testid="session-rail-tick"]')];
    const t = ticks[Math.min(1, ticks.length - 1)].getBoundingClientRect();
    return { x: t.left + t.width / 2, y: t.top + t.height / 2 };
  })()`,
  returnByValue: true
})
const { x, y } = layout.result.value
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
await new Promise((r) => setTimeout(r, 150))
const shot = await call('Page.captureScreenshot', { format: 'png' })
const out = join(here, 'session-rail-tip-probe.png')
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('SHOT', out, 'hover', Math.round(x), Math.round(y))
ws.close()
