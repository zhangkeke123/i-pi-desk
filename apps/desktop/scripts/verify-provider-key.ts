/**
 * provider key 解析规则自测。
 *
 * 这个函数只有四条分支，但每条都对应一个用户能感知的后果：
 * 配错时是收到一句能动手的错误，还是一条莫名其妙的空回答。
 *
 * 尤其要盯住「本地端点」这条 —— 它是**内网私有化这条主线能不能用**的关键：
 * pi 的 OpenAI 适配层要求 Authorization 头必须存在，不注入占位 key 的话
 * 「把应用指向本机 Ollama」会直接跑不起来。
 */

import { LOCAL_NO_AUTH_API_KEY, isLoopbackOrPrivateHost, resolveRunApiKey } from '../electron/main/store/provider-key.ts'
import type { ProviderConfig } from '@i-pi-desk/shared'

let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    id: 'p1',
    label: '测试 provider',
    apiStyle: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'm1' }],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as ProviderConfig

console.log('[1] 配了 key 且能取到 → 用真 key')
const withKey = resolveRunApiKey(provider({ apiKeyRef: 'secret-1' }), 'sk-real')
check('用真 key', withKey.apiKey === 'sk-real', JSON.stringify(withKey))
check('不标记为占位', withKey.placeholder === false)
check('无错误', withKey.errorCode === undefined)

console.log('\n[2] 配了 key 但取不到 → 报错（这是可行动的错误）')
const lostKey = resolveRunApiKey(provider({ apiKeyRef: 'secret-1' }), undefined)
check('报 PROVIDER_KEY_MISSING', lostKey.errorCode === 'PROVIDER_KEY_MISSING', JSON.stringify(lostKey))
check('给出明文 key 让内核报错', lostKey.apiKey === undefined)
check('错误信息提到「重新填写」', Boolean(lostKey.errorMessage?.includes('重新填写')), String(lostKey.errorMessage))

console.log('\n[3] 没配 key 且端点是本机/内网 → 占位 key（本地 Ollama 场景）')
for (const [label, baseUrl] of [
  ['回环 IPv4', 'http://127.0.0.1:11434/v1'],
  ['localhost', 'http://localhost:11434/v1'],
  ['10.x 内网', 'http://10.0.0.10:8000/v1'],
  ['192.168 内网', 'http://192.168.1.20:8000/v1'],
  ['172.16 内网', 'http://172.16.5.5:8000/v1'],
  ['.internal 域', 'http://llm.internal:8000/v1'],
  ['不带点的主机名', 'http://gpu-node-01:8000/v1']
] as const) {
  const resolved = resolveRunApiKey(provider({ baseUrl }), undefined)
  check(
    `${label} → 注入占位 key`,
    resolved.apiKey === LOCAL_NO_AUTH_API_KEY && resolved.placeholder === true && resolved.errorCode === undefined,
    JSON.stringify(resolved)
  )
}

console.log('\n[4] 没配 key 且端点是公网 → 报错（多半是忘了配）')
for (const baseUrl of ['https://api.openai.com/v1', 'https://api.deepseek.com/v1', 'http://8.8.8.8:8000/v1']) {
  const resolved = resolveRunApiKey(provider({ baseUrl }), undefined)
  check(
    `${baseUrl} → 报缺 key`,
    resolved.errorCode === 'PROVIDER_KEY_MISSING' && resolved.apiKey === undefined,
    JSON.stringify(resolved)
  )
}

console.log('\n[5] 边界：baseUrl 缺失或不是合法 URL')
const noUrl = resolveRunApiKey(provider({ baseUrl: undefined }), undefined)
check('没有 baseUrl → 报缺 key 而不是给占位 key', noUrl.errorCode === 'PROVIDER_KEY_MISSING', JSON.stringify(noUrl))
const badUrl = resolveRunApiKey(provider({ baseUrl: 'not a url' }), undefined)
check('baseUrl 不合法 → 报缺 key（不猜）', badUrl.errorCode === 'PROVIDER_KEY_MISSING', JSON.stringify(badUrl))

console.log('\n[6] 占位 key 不该长得像真 key')
check(
  '占位 key 没有 sk- 之类的真实前缀',
  !/^(sk|pk|api|key)[-_]/i.test(LOCAL_NO_AUTH_API_KEY),
  LOCAL_NO_AUTH_API_KEY
)

console.log('\n[7] 内网判定复用性（控制面的明文告警也用它）')
check('回环算内网', isLoopbackOrPrivateHost('127.0.0.1'))
check('公网域不算内网', !isLoopbackOrPrivateHost('api.openai.com'))
check('空串不算内网', !isLoopbackOrPrivateHost(''))

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
