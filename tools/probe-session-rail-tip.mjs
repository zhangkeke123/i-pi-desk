/**
 * 探针：用 CDP 真实鼠标悬停 SessionPreviewRail 刻度，断言 tip 垂直对齐该刻度。
 * 用法：node tools/probe-session-rail-tip.mjs [cdpPort=9333]
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../apps/desktop/package.json'))
const WebSocket = require('ws')

const port = Number(process.argv[2] || 9333)

async function cdpHttp(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) throw new Error(`CDP ${path} → ${res.status}`)
  return res.json()
}

function rpc(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout ${method}`)), 20000)
    const onMsg = (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  const targets = await cdpHttp('/json/list')
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 1
  const call = (method, params) => rpc(ws, nextId++, method, params)

  await call('Runtime.enable')
  await call('DOM.enable')
  await call('Input.setIgnoreInputEvents', { ignore: false })

  const wait = await call('Runtime.evaluate', {
    expression: `(() => {
      const started = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          const rail = document.querySelector('[data-testid="session-preview-rail"]');
          const ticks = rail ? rail.querySelectorAll('[data-testid="session-rail-tick"]') : [];
          if (ticks.length >= 2) return resolve({ ok: true, ticks: ticks.length });
          if (Date.now() - started > 12000) return resolve({ ok: false, ticks: ticks.length });
          setTimeout(tick, 200);
        };
        tick();
      });
    })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (!wait.result?.value?.ok) {
    console.error('PROBE_FAIL', wait.result?.value)
    process.exit(2)
  }

  const layout = await call('Runtime.evaluate', {
    expression: `(() => {
      const rail = document.querySelector('[data-testid="session-preview-rail"]');
      const ticks = [...rail.querySelectorAll('[data-testid="session-rail-tick"]')];
      const indices = [...new Set([0, Math.min(1, ticks.length - 1), ticks.length - 1])];
      return {
        rail: (() => { const r = rail.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height }; })(),
        ticks: indices.map((idx) => {
          const t = ticks[idx].getBoundingClientRect();
          return { idx, x: t.left + t.width / 2, y: t.top + t.height / 2, top: t.top, height: t.height };
        })
      };
    })()`,
    returnByValue: true
  })
  const info = layout.result.value
  const results = []

  for (const tick of info.ticks) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: tick.x,
      y: tick.y,
      button: 'none'
    })
    // 等 React commit tip
    await new Promise((r) => setTimeout(r, 80))
    const measured = await call('Runtime.evaluate', {
      expression: `(() => {
        const rail = document.querySelector('[data-testid="session-preview-rail"]');
        const preview = document.querySelector('[data-testid="session-rail-preview"]');
        if (!preview) return { error: 'no-preview' };
        const t = ${JSON.stringify(tick)};
        const p = preview.getBoundingClientRect();
        const r = rail.getBoundingClientRect();
        const tipCenter = p.top + p.height / 2;
        return {
          tickCenter: Math.round(t.y),
          tipCenter: Math.round(tipCenter),
          tipTop: Math.round(p.top),
          tipLeft: Math.round(p.left),
          railTop: Math.round(r.top),
          railRight: Math.round(r.right),
          delta: Math.round(Math.abs(tipCenter - t.y)),
          tipRightOfRail: p.left >= r.right - 4,
          styleTop: preview.style.top
        };
      })()`,
      returnByValue: true
    })
    results.push({ idx: tick.idx, ...measured.result.value })
  }

  const mid = results.find((x) => x.idx === 1) || results[results.length - 1]
  const allAligned = results.every((x) => !x.error && x.delta <= 14 && x.tipRightOfRail)
  // 旧 bug：所有 tip 贴在轨顶附近（固定 top:1.5rem ≈ 24px）
  const midNotStuckTop = mid && !mid.error && mid.tipTop > mid.railTop + 28
  const topsDiffer =
    results.length >= 2 &&
    new Set(results.filter((x) => !x.error).map((x) => x.styleTop)).size >= 2

  const out = { results, allAligned, midNotStuckTop, topsDiffer, rail: info.rail }
  console.log(JSON.stringify(out, null, 2))
  if (!allAligned || !midNotStuckTop || !topsDiffer) {
    console.error('PROBE_FAIL tip not anchored to ticks')
    process.exit(1)
  }
  console.log('PROBE_PASS session-rail tip follows ticks')
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
