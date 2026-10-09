import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mmToPx } from '../../lib/types'

/**
 * 打印预览容器。
 *
 * 为什么用 iframe 而不是把页面渲染进 React 树：
 * 渲染引擎产出的是一份**完整自包含 HTML**（含内联样式与 `@page` 规则），打印时原样送进打印 iframe。
 * 预览如果另起一套 DOM 结构，就必然出现"预览和打印不一样"——这正是 PRD F5-01 明令禁止的。
 * 直接把同一份 HTML 塞进 iframe，保真度天然 1:1，还能天然隔离样式（插件的 CSS 不会污染纸张）。
 *
 * 顺带说明：iframe 用 srcdoc 加载，属同源，所以能读 contentDocument 拿真实内容高度 ——
 * 不做这件事就只能靠"页数 × 页高"估算，带阴影/间隙的预览会算出偏差。
 */

interface Props {
  /** 渲染引擎产出的完整 HTML */
  html: string
  pageWidthMm: number
  pageHeightMm: number
  /** 'fit' = 适应容器宽度；数字 = 固定缩放比 */
  zoom: 'fit' | number
  /** 页数，仅用于内容高度还没测出来时的兜底估算 */
  pageCount: number
}

export function PreviewFrame({ html, pageWidthMm, pageHeightMm, zoom, pageCount }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [availW, setAvailW] = useState(340)
  /**
   * **可用高度**（2026-10-09 用户要求"任何尺寸的纸张都要完整显示在一屏内"）。
   *
   * ⚠️ 为什么不能只按宽度缩放：A4 纵向的宽高比是 1:1.414，按宽度 fit 之后
   * **高度必然溢出屏幕** ⇒ 用户要滚很久才能看到纸的下半截，"预览"的意义就没了。
   * 所以取 `min(宽度比, 高度比)` —— 两个方向都装得下才叫"完整显示"。
   *
   * ⚠️ 这个 `CHROME_H`（视口里除纸张之外的 UI 高度）是**估算**：
   *    向导头部 + 步骤条 + 底栏 + 底部那句说明 ≈ 240px。
   *    宁可估大一点（纸张略小），也不要估小 —— 估小就又溢出了，
   *    而用户对"要滚动"的容忍度远低于"纸小一点"。
   */
  const CHROME_H = 240
  const [availH, setAvailH] = useState(600)
  const [contentH, setContentH] = useState(0)

  /** 逻辑宽度：纸张的真实像素宽（缩放前） */
  const logicalW = Math.max(1, mmToPx(pageWidthMm))
  const fallbackH = Math.max(1, mmToPx(pageHeightMm)) * Math.max(1, pageCount)

  // 容器宽度变化 → "适应宽度"要跟着变
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      /*
       * ⚠️ 减去边框 2 + 左右内边距 16（`.wiz-prev-inner` 的 `padding: 8px`）——
       * **这两处是配对的**，改一边就要改另一边，否则"适应宽度"会算宽、纸张横向溢出。
       * （2026-10-09 把 padding 从 16 收到 8，这个常数跟着从 34 改成 18。）
       */
      const w = el.clientWidth - 18
      setAvailW(Number.isFinite(w) && w > 0 ? w : 340)
      const vh = typeof window !== 'undefined' ? window.innerHeight : 0
      setAvailH(vh > 0 ? Math.max(200, vh - CHROME_H) : 600)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      /* ⚠️ 视口高度变化（旋转屏幕 / 浏览器窗口拉伸）也要重算，光观察容器不够 */
      window.addEventListener('resize', measure)
      return () => {
        ro.disconnect()
        window.removeEventListener('resize', measure)
      }
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  /**
   * ⚠️ **宽、高两个方向都要装得下**（2026-10-09 用户要求"任何尺寸的纸张都完整显示在一屏内"）。
   *
   * 原来只按宽度算（`availW / logicalW`）⇒ 高纸张（A4 纵向、label100×180）
   * **纵向必然溢出**，用户得滚很久才看得到下半截，"预览"就没意义了。
   * 现在取两个比值的最小值 ⇒ 整张纸一屏可见。
   *
   * ⚠️ 高度基准是**单页高**（`pageH`）而不是"总内容高"：
   *    要装进一屏的是**一张纸**，不是所有页。多页时按总高缩放会把纸缩成邮票，
   *    反而谁也看不清 —— 多页应该靠滚动看下一页，不是硬塞进一屏。
   * ⚠️ 上限 2 保留：小标签（70×50）按高度算会放大很多，字会糊，
   *    放大超过 2 倍也看不出真实的版面比例了。
   * ⚠️ 下限 0.1 保留：极端比例下不能缩到不可见。
   */
  const pageH = Math.max(1, mmToPx(pageHeightMm))
  const scale =
    zoom === 'fit' ? Math.max(0.1, Math.min(availW / logicalW, availH / pageH, 2)) : zoom

  /** 读 iframe 里的真实内容高度。srcdoc 同源，可以直接读 */
  const measureHeight = useCallback(() => {
    const f = frameRef.current
    if (!f) return
    try {
      const d = f.contentDocument
      if (!d) return
      const root = d.documentElement
      const body = d.body
      const h = Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0)
      if (Number.isFinite(h) && h > 0) setContentH(h)
    } catch {
      // 极端情况下读不到（被沙箱限制），保持兜底估算值即可，不要抛错
    }
  }, [])

  useEffect(() => {
    // html 变了要重新量：srcDoc 会重建文档
    setContentH(0)
  }, [html])

  const naturalH = contentH > 0 ? contentH : fallbackH
  const shownH = naturalH * scale

  return (
    <div className="wiz-prev" ref={wrapRef}>
      {/*
        ⚠️ **两层盒子**（2026-10-09 修"纸张不居中、贴在左边"）。
        ⚠️ 这是个 CSS 经典陷阱：`transform: scale()` **不改变布局占位**。
        原来只有一层，宽度给的是**缩放后**的尺寸（`logicalW * scale`），
        而 iframe 自己的**布局宽**仍是未缩放的 `logicalW` ⇒ iframe 比容器宽 ⇒ 溢出
        ⇒ 外层 `.wiz-prev-inner` 的 `justify-content: center` **对着一个超宽子元素居中不了**。
        ⇒ 里面再包一层"缩放后尺寸"的盒子：**它才是 flex 的居中对象**；
          iframe 用绝对定位卧在它里面（`transformOrigin: top left` 保证左上角对齐）。
      */}
      <div className="wiz-prev-inner">
        <div
          className="wiz-prev-scaler"
          style={{ width: `${Math.round(logicalW * scale)}px`, height: `${Math.round(shownH)}px` }}
        >
          <iframe
            ref={frameRef}
            className="wiz-prev-frame"
            title="打印预览"
            srcDoc={html}
            sandbox="allow-same-origin"
          /*
           * ⚠️ **禁止 iframe 内部滚动**（2026-10-09 用户报"为什么会有两个拖动条"）。
           *
           * 纸张内部那条滚动条来自**iframe 里的文档自己**：渲染出的 HTML 带 `@page`
           * 与整纸高度的容器，浏览器会给它一个可滚动视口 —— 而我们已经用 `naturalH`
           * 把 iframe 撑到"内容总高"，**根本不需要它自己滚**。
           * 两个滚动条叠在一起（内层滚纸、外层滚页面）是用户看到的那副样子。
           *
           * ⚠️ `scrolling="no"` 虽在 HTML 规范里被标为废弃，但**所有主流浏览器仍支持**，
           *    且它是唯一能从**外部**关掉 iframe 内部滚动的开关（`overflow` 写在父元素上管不到里面）。
           */
          scrolling="no"
          onLoad={() => {
            measureHeight()
            // 图片是 blob 链接，加载完成会改变高度，补量两次
            setTimeout(measureHeight, 120)
            setTimeout(measureHeight, 600)
          }}
          style={{
            width: `${Math.round(logicalW)}px`,
            height: `${Math.round(naturalH)}px`,
            transform: `scale(${Number.isFinite(scale) ? scale : 1})`,
            transformOrigin: 'top left',
            /*
             * ⚠️ 绝对定位卧在 `.wiz-prev-scaler`（缩放后尺寸的盒子）里 ——
             * 因为 iframe 的布局宽是**未缩放**的 `logicalW`，会把这个盒子撑开，
             * 那就又变回"纸贴左边"了。绝对定位让它的布局尺寸不参与父盒子计算。
             */
            position: 'absolute',
            top: 0,
            left: 0,
          }}
          />
        </div>
      </div>
      <p className="wiz-prev-note">
        预览与打印用的是同一份渲染结果，所见即所得。纸张 {Math.round(pageWidthMm)}×{Math.round(pageHeightMm)}mm，
        缩放 {Math.round(scale * 100)}%
      </p>
    </div>
  )
}
