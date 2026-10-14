/**
 * 「现在能不能发出去」以及**为什么不能**。
 *
 * 参考材料点名的一条反模式是「禁用发送却不解释缺什么」。这个模块把那条规则变成
 * 一个可单测的判定：要么没问题，要么给出「一句话 + 一个入口」。
 *
 * 为什么抽出来：这类判断最容易写成散落在 JSX 里的三元表达式，于是
 * 「没选目录」「没配模型」两种情况各写一半、入口指向也各不一样，
 * 而它们恰恰是新用户最可能撞上的两条路。
 */

export interface ComposerBlocker {
  /** 说清缺什么（不指责用户，也不说废话）。 */
  text: string
  /** 一个能点的入口的文案。 */
  actionLabel: string
  /** 点它做什么。 */
  action: 'pick-workspace' | 'open-settings'
}

export interface ComposerReadiness {
  hasWorkspace: boolean
  /** 已启用的 provider 数量。 */
  enabledProviders: number
  /**
   * 启用的 provider 是否全是截图/E2E 假端点（mock、8131 等）。
   * 真有可用端点时为 false。
   */
  onlyStubProviders?: boolean
}

/**
 * 判定顺序有意为之：**先看工作目录**。
 *
 * 没有目录时，agent 连在哪干活都不知道 —— 那是比「没有模型」更前置的问题；
 * 两个都没配时提示目录，用户按顺序解决，不会一次收到两条抱怨。
 */
export function composerBlocker(readiness: ComposerReadiness): ComposerBlocker | null {
  if (!readiness.hasWorkspace) {
    return {
      text: '还没有工作目录，agent 不知道在哪干活。',
      actionLabel: '选择一个目录 →',
      action: 'pick-workspace'
    }
  }
  if (readiness.enabledProviders === 0 || readiness.onlyStubProviders) {
    return {
      text: readiness.onlyStubProviders
        ? '当前只有测试用假模型，连不上会 Connection error。请配置真实端点。'
        : '还没有可用的模型端点，发出去只会报错。',
      actionLabel: '去配置 →',
      action: 'open-settings'
    }
  }
  return null
}

/** 截图夹具 / E2E mock：启用了也会 Connection error，不能算「可用」。 */
export function isStubProvider(provider: {
  id?: string
  label?: string
  baseUrl?: string
  models?: Array<{ id?: string }>
}): boolean {
  const blob = [
    provider.id,
    provider.label,
    provider.baseUrl,
    ...(provider.models ?? []).map((m) => m.id)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (!blob) return false
  if (blob.includes('mock')) return true
  if (blob.includes('假模型') || blob.includes('截图')) return true
  if (/127\.0\.0\.1:813\d/.test(blob) || /localhost:813\d/.test(blob)) return true
  return false
}
