/**
 * 模板图片（飞书附件）的**临时链接表** —— 模块级 store。
 *
 * ## 为什么需要
 *
 * 2026-10-19 起，模板里的固定图片可以只存 `fileToken`（图片本体在飞书附件字段里），
 * 这样模板 JSON 不会因为 base64 撑爆飞书的 10 万字单元格上限。
 *
 * 代价是：**渲染前必须先把 token 换成 URL**（一次异步请求），而画布/打印的渲染都是同步的。
 * 这个 store 就是那个"异步结果 → 同步读取"的桥：
 *   · 打开模板时 `loadTemplateImageUrls()` 解析一次，写进这里；
 *   · 画布（`Canvas.tsx`）用 `useSyncExternalStore` 读；
 *   · 打印在渲染前读一次，塞进 `RenderContext.imageUrls`。
 *
 * ## 三条约束
 *
 *   1. **链接约 10 分钟失效** ⇒ 每次打开模板 / 预览都要重新解析，不能持久化。
 *   2. **空表也要能区分"还没解析"和"解析完但没图"** ⇒ 用 `loaded` 标记（画布据此显示占位框）。
 *   3. **解析失败不能抛** ⇒ 失败就是空表，渲染退回元素自己的 `dataUrl`（老模板那条路）。
 */

let urls: Map<string, string> = new Map()
let loaded = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 画布用 `useSyncExternalStore` 订阅（返回退订函数） */
export function subscribeTemplateImageUrls(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 同步读取（`useSyncExternalStore` 的 getSnapshot）—— 返回同一个引用，除非真的变了 */
export function getTemplateImageUrls(): Map<string, string> {
  return urls
}

/** 是否已经解析过一次（画布用它决定"占位框"还是"加载中"） */
export function templateImageUrlsLoaded(): boolean {
  return loaded
}

/** 直接设置（测试 / 打印链路用） */
export function setTemplateImageUrls(next: Map<string, string>): void {
  urls = next
  loaded = true
  emit()
}

/** 清空（切换模板 / 关闭编辑器时调用，避免把上一条模板的链接带过去） */
export function resetTemplateImageUrls(): void {
  urls = new Map()
  loaded = false
  emit()
}

/**
 * 解析一组 token 的链接并写进 store。
 *
 * @param fetchUrls 由调用方注入（通常是 `store.imageUrlMap(recordId, tokens)`），
 *                  这样本模块不必知道 `DataSource`/`TemplateStore` 的存在。
 */
export async function loadTemplateImageUrls(
  tokens: string[],
  fetchUrls: (tokens: string[]) => Promise<Map<string, string>>,
): Promise<void> {
  if (tokens.length === 0) {
    setTemplateImageUrls(new Map())
    return
  }
  try {
    setTemplateImageUrls(await fetchUrls(tokens))
  } catch {
    /* 解析失败 ⇒ 空表 + 标记已加载，渲染退回 dataUrl / 占位框 */
    setTemplateImageUrls(new Map())
  }
}

// ============================================================
// 解析器注册（预览/打印用）
// ============================================================

/**
 * "重新解析一次模板图片链接"的能力，由 `useWizardState` 注册。
 *
 * 为什么需要重新解析：附件临时链接**约 10 分钟失效**，而编辑器可能开着很久；
 * 画布上即使显示的是旧的（已过期）URL 也还能看（浏览器已解码），
 * 但**打印是从头生成 HTML**，拿到过期链接就是空白/糊图。
 * ⇒ 每次打印前调一次这个解析器，拿新鲜链接。
 */
let resolver: (() => Promise<Map<string, string>>) | null = null

export function registerTemplateImageResolver(fn: (() => Promise<Map<string, string>>) | null): void {
  resolver = fn
}

/** 重新解析（拿不到就退回 store 里的旧值，不抛） */
export async function resolveTemplateImageUrls(): Promise<Map<string, string>> {
  if (!resolver) return getTemplateImageUrls()
  try {
    return await resolver()
  } catch {
    return getTemplateImageUrls()
  }
}
