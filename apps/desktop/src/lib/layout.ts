/**
 * 窗口宽度 → 版面。
 *
 * ## 为什么是纯函数
 *
 * 「多窄算窄」是一个**可以被验证的约定**，而不是散在组件里的 `window.innerWidth < 1100`：
 * 抽出来之后，阈值边界、以及「宽窗口绝不进入紧凑模式」都能单测钉住
 * （见 scripts/verify-ui-logic.ts）。
 *
 * ## 为什么是侧栏折叠，而不是让面板变成浮层
 *
 * 设计稿 §10 那条问的是「900px 是硬下限，要不要再往下探」——真正的拥挤来源是
 * **侧栏 264px + 聊天区 + 文件面板 288px** 一起挤。文件树变浮层会遮住正在读的内容，
 * 而侧栏是一块「进去一次、出来」的区域：折叠成图标条损失最小，也最接近
 * 大家在编辑器里习惯的行为（窄的时候左栏收成图标）。
 *
 * AEI / 设计稿 A：会话侧栏（临时→置顶→按项目）是主入口，不能轻易收成图标条。
 * 默认窗 1280、右栏产物常开时，旧阈值 1080 会把侧栏打成「三颗图标」，与稿面差很远。
 * 新阈值贴窗口下限：只在极端窄（< 960）才折叠；空间紧张时优先关右栏（见 App）。
 */
export const COMPACT_SIDEBAR_BELOW = 960

/** 窄于此时优先收起右栏产物，保住会话列表宽度。 */
export const PREFER_INSPECTOR_COLLAPSE_BELOW = 1180

export interface Layout {
  /** 侧栏是否折叠成图标条。 */
  compactSidebar: boolean
  /** 侧栏宽度（px）—— 给界面直接用，避免两处各写一个数字。 */
  sidebarWidth: number
  /** 建议是否收起右栏以保住会话侧栏。 */
  preferInspectorCollapsed: boolean
}

export const SIDEBAR_WIDTH = 264
export const SIDEBAR_RAIL_WIDTH = 52

export function layoutFor(width: number): Layout {
  // 非法宽度（NaN / 0）按「不折叠」处理：宁可挤一点，也不要让界面莫名其妙变窄。
  const compact = Number.isFinite(width) && width > 0 && width < COMPACT_SIDEBAR_BELOW
  const preferInspectorCollapsed =
    Number.isFinite(width) && width > 0 && width < PREFER_INSPECTOR_COLLAPSE_BELOW
  return {
    compactSidebar: compact,
    sidebarWidth: compact ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH,
    preferInspectorCollapsed
  }
}
