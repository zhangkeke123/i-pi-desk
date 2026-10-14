/**
 * 会话列表分页。
 *
 * ## 为什么抽成纯函数
 *
 * 它是**一条可以被验证的约定**（默认显示多少、剩下的怎么算、上限非法时怎么办），
 * 而不是散在组件里的 `visible.slice(0, 30)`。抽出来之后这些边界都能单测钉住，
 * 组件里只负责点与不点。
 *
 * ## 为什么默认 30
 *
 * 端到端跑完一轮会在夹具目录里留下近 20 个会话 —— 取 30 能保证测试里所有会话都可见，
 * 于是那些「按标题找某一行」的断言不会因为分页而失效。这不是为了让测试好过：
 * 一次能看三十个会话，正好是「滚一屏还找得到」的量级。
 */
export const SESSION_PAGE_SIZE = 30

export interface SessionPage<T> {
  /**
   * 返回**可变**数组而不是 readonly：下游 groupSessionsByTime 收的是 Session[]。
   * 这里是一处拷贝（几十个元素，代价可忽略），换来调用方不必为类型再拷一次。
   *
   * 这个错漏过了一轮：端到端用 esbuild **不做类型检查**，所以它一路绿，
   * 是一次顺手跑的 typecheck 才发现的（见 §15.25）。
   */
  shown: T[]
  hiddenCount: number
}

export function pageSessions<T>(sessions: readonly T[], limit = SESSION_PAGE_SIZE, expanded = false): SessionPage<T> {
  // 上限非法（0 / 负数 / NaN）时宁可全显示：分页是优化，不该把内容藏没。
  if (expanded || !Number.isFinite(limit) || limit <= 0 || sessions.length <= limit) {
    return { shown: [...sessions], hiddenCount: 0 }
  }
  return { shown: sessions.slice(0, limit), hiddenCount: sessions.length - limit }
}
