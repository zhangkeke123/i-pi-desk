import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 极简 JSON 持久化。
 *
 * 为什么第一版不用 SQLite：better-sqlite3 是原生模块，要走 electron-rebuild，
 * 一旦 ABI 不匹配就是「装不上 / 打包后崩」两类难查故障。而会话与设置的数据量
 * 在单机场景下远达不到需要数据库的规模。
 *
 * 换 SQLite 的时机：M3 之后如果出现「单会话消息 > 1 万条」或「需要全文检索」，
 * 那时只替换本文件的实现，上层接口不变。
 */

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    // 文件不存在、是空文件、或被写坏：一律回退到默认值。
    // 这里刻意不抛：设置文件损坏不该让应用起不来。
    return fallback
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 * 直接 writeFileSync 覆盖时若进程在写到一半被杀，会留下半个 JSON —— 下次启动就解析失败。
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function userFile(userDataPath: string, ...segments: string[]): string {
  return join(userDataPath, ...segments)
}
