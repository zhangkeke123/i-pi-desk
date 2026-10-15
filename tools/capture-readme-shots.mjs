/**
 * 为 README 抓几张真实窗口截图（CDP）。
 * 用法：临时 userData + --remote-debugging-port=9333 启动后：
 *   node tools/capture-readme-shots.mjs [cdpPort=9333]
 */
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '../docs/screenshots')
mkdirSync(outDir, { recursive: true })

const require = createRequire(join(here, '../apps/desktop/package.json'))
const WebSocket = require('ws')
const port = Number(process.argv[2] || 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (!page) throw new Error('no page target on CDP')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 1
  const call = (method, params) => rpc(ws, nextId++, method, params)
  await call('Runtime.enable')
  await call('Page.enable')
  await sleep(600)

  // 遮住本机绝对路径
  await call('Runtime.evaluate', {
    expression: `(() => {
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent || '';
          if (/[A-Za-z]:\\\\/.test(t) || /Users[\\\\\\/]/.test(t)) {
            node.textContent = t.replace(/[A-Za-z]:\\\\[^\\n]*/g, '%APPDATA%\\\\i-pi-desk');
          }
        } else if (node.childNodes) node.childNodes.forEach(walk);
      };
      walk(document.body);
      return true;
    })()`,
    returnByValue: true,
  })

  async function shot(name) {
    // 每次截图前再遮一次路径（切页后可能重新渲染）
    await call('Runtime.evaluate', {
      expression: `(() => {
        const walk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent || '';
            if (/[A-Za-z]:\\\\/.test(t)) node.textContent = t.replace(/[A-Za-z]:\\\\[^\\n]*/g, '%APPDATA%\\\\i-pi-desk');
          } else if (node.childNodes) node.childNodes.forEach(walk);
        };
        walk(document.body);
        return true;
      })()`,
      returnByValue: true,
    })
    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('SHOT', file)
  }

  async function clickSelector(selector) {
    const result = await call('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.click();
        return el.getAttribute('title') || el.getAttribute('data-testid') || el.textContent?.trim()?.slice(0, 40);
      })()`,
      returnByValue: true,
    })
    console.log('click', selector, '→', result.result.value)
    await sleep(900)
    return Boolean(result.result.value)
  }

  async function clickNavItem(label) {
    const result = await call('Runtime.evaluate', {
      expression: `(() => {
        const items = [...document.querySelectorAll('[data-testid="settings-nav"] button, .settings-nav-item')];
        const el = items.find((n) => (n.textContent || '').includes(${JSON.stringify(label)}));
        if (!el) return null;
        el.click();
        return (el.textContent || '').trim().slice(0, 40);
      })()`,
      returnByValue: true,
    })
    console.log('nav', label, '→', result.result.value)
    await sleep(900)
    return Boolean(result.result.value)
  }

  // 清掉旧的无关截图
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.png')) unlinkSync(join(outDir, f))
  }

  // 若在设置页，先返回
  await clickSelector('[data-testid="settings-back-to-app"]')
  await sleep(400)

  await clickSelector('button[title="工作台"]')
  await shot('01-workbench')

  await clickSelector('button[title="定时任务"]')
  await shot('03-scheduled')

  await clickSelector('button[title="项目"]')
  await shot('04-projects')

  await clickSelector('button[title="工作台"]')
  await sleep(400)
  await shot('05-overview')

  await clickSelector('button[title="设置"]')
  await sleep(500)
  await clickNavItem('模型 provider')
  await shot('02-provider')

  await clickNavItem('外观')
  await shot('06-appearance')

  await clickNavItem('技能')
  await shot('07-skills')

  await clickSelector('[data-testid="settings-back-to-app"]')
  await sleep(500)

  ws.close()
  console.log('DONE', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
