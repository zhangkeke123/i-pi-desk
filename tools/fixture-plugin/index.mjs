/**
 * 测试夹具插件。
 *
 * 它的价值不在功能，而在于**能被断言**：
 *  - `fixture_echo` 回显文本 → 证明工具真的在插件进程里执行了；
 *  - 同时报告几个环境变量是否存在 → 证明宿主没有把完整 `process.env` 传进来
 *    （这是插件隔离里唯一实质性的运行时保护）；
 *  - 目录里带一个 `skills/` → 证明插件能贡献技能，且会被内核的渐进式披露接住。
 *
 * 它会被 `verify-plugin-host.mjs`（直接驱动插件宿主）与
 * `verify-renderer.mjs`（通过真实应用注册工具）两处使用。
 */

export async function activate(ctx) {
  // 走 ctx.log 而不是 console.log —— 两者都会被转成协议通知，
  // 但用 ctx 更能表达「这是宿主提供的日志出口」。
  ctx.log(`fixture 已激活，声明权限：${JSON.stringify(ctx.permissions)}`)
}

export const tools = {
  async fixture_echo(args) {
    return JSON.stringify({
      echo: args?.text ?? null,
      // 宿主刻意不传完整 env。这几个字段就是用来证明这一点的。
      leakedSecret: process.env.IPI_FIXTURE_SECRET ?? null,
      hasPath: Boolean(process.env.PATH || process.env.Path),
      hasElectronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1'
    })
  }
}
