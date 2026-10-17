/**
 * 上一次**真实渲染**的耗时（给「检查」页读）。
 *
 * ## 为什么需要它
 *
 * 检查页的「预计渲染」只能按**系数粗估**（`InspectPanel` 里 `total * 2 + records * (…)`）——
 * 它没有真实记录值，长文本换行、图片解码的代价估不出来，只能看量级。
 *
 * 而真实渲染（`renderDocument`，含 DOM 测量 + 分页）本来就要在用户点预览时跑一遍，
 * 顺手记下耗时是**零额外成本**；检查页把它与粗估并列显示，用户自己判断该信哪个。
 *
 * ## 为什么不做"面板里点一下实时测"
 *
 * 真渲染要拉数据 + 建测量宿主，几秒且会阻塞 UI；而检查页**在预览之前**就要给出数字。
 * 记"最近一次实测"比"为了一个数字专门跑一遍"克制得多。
 *
 * ## 为什么单独一个文件
 *
 * `preview.ts` 会把数据源 / 渲染管线整个拉进来。检查页只需要读一个数字，
 * 不该因此依赖整条预览链路（也避免循环 import）。这里是零依赖的模块级 store。
 */

export interface RenderStats {
  /** `renderDocument` 那一段的墙钟耗时（毫秒，含 DOM 测量与分页） */
  ms: number
  /** 这次渲染覆盖了多少条记录 */
  records: number
  pages: number
}

let lastStats: RenderStats | null = null
const listeners = new Set<() => void>()

export function getLastRenderStats(): RenderStats | null {
  return lastStats
}

/** 给 `useSyncExternalStore` 用；返回退订函数 */
export function subscribeRenderStats(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function publishRenderStats(next: RenderStats): void {
  lastStats = next
  for (const fn of listeners) fn()
}
