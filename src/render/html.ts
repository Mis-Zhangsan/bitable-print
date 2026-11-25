/**
 * HTML 生成（**纯函数，不碰 DOM**，可在 Node 里单测）。
 *
 * 关键设计：预览与打印**共用同一份 HTML**（PRD F5-01 的"1:1 还原"就是靠这个保证的）。
 * 如果预览走 React 组件、打印走拼字符串，两边迟早会漂移，所以这里只产出一种产物。
 *
 * 三条硬约束（都是踩过坑的）：
 * 1) 所有样式**内联**：打印 iframe 里不保证能加载外部 CSS，`<link>` 在部分沙箱里直接静默失败。
 * 2) 所有数值必须过 `finite()`：无头环境/离屏容器里 getBoundingClientRect 全 0，
 *    一旦把 NaN 写进 style，整页样式会被浏览器整条丢弃（不是只丢那一个属性）。
 * 3) 中文必须指定完整字体栈：只写 `sans-serif` 会让 Windows 打印出宋体，中英混排非常难看。
 */

import { resolveCellEdges, rowChildScale } from '../components/editor/table-actions'
/*
 * ⚠️ 格内子元素的尺寸口径（`w` = 占格宽百分比、`h` = 固定盒高）**不再从
 *    `components/editor/cell-child` 引** —— 那条"渲染层 → 编辑器层"的跨层引用已于
 *    2026-09-23 收口到 `lib/cell-geometry.ts`（见下面那处 import 的说明）。
 *    上面 `resolveCellEdges` 这一处跨层引用**暂时保留**（挪它成本大于收益），
 *    但方向是同一个毛病：渲染引擎不该依赖 UI 层。
 */
import type {
  AnyElement,
  AttachmentPrintConfig,
  BarcodeElement,
  CodeSource,
  InlineNode,
  InlineSysVar,
  PageSetup,
  QrCodeElement,
  TableCell,
  TableElement,
  TextStyle,
} from '../lib/types'
/* 表格 span 摊平（判断"表头行里有没有跨出表头区的合并格"，见 `spanCrossesHead`） */
import { tableGrid } from '../lib/table-grid'
import {
  DEFAULT_PRINT_TIME_FORMAT,
  DEFAULT_TODAY_FORMAT,
  finite,
  mmToPx,
  pageRenderSize,
  ptToMm,
  pxToMm,
  /* ⚠️ 表格/单元格的兜底值 —— 与画布端 `Canvas.tsx` 引用**同一份**（2026-10-02 体检 P1） */
  BOLD_FONT_WEIGHT,
  DEFAULT_CELL_PADDING_MM,
  DEFAULT_TABLE_BORDER_PT,
  DEFAULT_TABLE_LINE,
} from '../lib/types'
import type { RecordItem } from '../lib/data-source'
import {
  fieldMeta,
  formatDateTime,
  isCheckedValue,
  isImageAttachment,
  isVectorImage,
  renderCellValue,
  dateFormatOf,
} from '../lib/field-types'
/*
 * 格内子元素的尺寸口径 —— 与画布（`components/editor/cell-child.ts`）**共用同一份实现**。
 * 下沉到 `lib/` 就是为了让渲染引擎可以引用它，而不必反向 import UI 层。
 */
import {
  childBoxAlign,
  childBoxLeftPct,
  childBoxHeightMm,
  childBoxSpanMm,
  childBoxWidthMm,
  childHeightMm,
  childOffsetXPct,
  childOffsetYMm,
  effectiveChildYMm,
  childWidthPct,
  isChildPositioned,
} from '../lib/cell-geometry'
import type { PageModel, RenderContext, RenderWarning, ResolvedImage } from './context'
import { imageKey } from './context'
import { barcodeSvg, isCode128Encodable, qrCodeSvg, QR_MAX_BYTES, utf8ByteLength } from './code-elements'

// ============================================================
// 常量
// ============================================================

/**
 * 中文优先的字体栈。
 * 不写 Serif 兜底，因为 Windows 下中文 sans-serif 会落到宋体；
 * 明确列出雅黑 / 苹方 / 思源黑体，保证与编辑器画布所见一致。
 */
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', " +
  "'Microsoft YaHei UI', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', " +
  "'WenQuanYi Micro Hei', 'Heiti SC', sans-serif"

const DEFAULT_COLOR = '#1f2329'
const MUTED_COLOR = '#8f959e'
const DEFAULT_FONT_PT = 10.5
const DEFAULT_LINE_HEIGHT = 1.5

/** 单元格文本渲染上限（E-12：超过 10000 字截断） */
const MAX_TEXT_LEN = 10000

/** 页码/总页数占位令牌。用 Unicode 私用区，避免与用户数据里的文本撞车 */
const TOK_PAGE_NO = '\uE000BPPAGE\uE000'
const TOK_PAGE_COUNT = '\uE000BPCOUNT\uE000'
/** 供自测断言使用 */
export const PAGE_TOKENS = { pageNo: TOK_PAGE_NO, pageCount: TOK_PAGE_COUNT } as const

/**
 * 把页码令牌替换成具体数字。**所有**替换都必须走这里（最终产物 + 测量占位），
 * 否则"渲染时写什么"和"测量时按什么量"会各自实现一遍，迟早漂移。
 */
export function replacePageTokens(html: string, pageNo: string, pageCount: string): string {
  return html.split(TOK_PAGE_NO).join(pageNo).split(TOK_PAGE_COUNT).join(pageCount)
}

/**
 * **测量专用**的页码占位（两位数字）。
 *
 * 为什么测量要单独换一次：令牌是 8/9 个私用区字符（`pageNo` 8 个、`pageCount` 9 个），
 * 在窄框里必然折行，而它最终只会被替换成
 * 一两个数字 —— 于是"量到的高度"比"实际渲染的高度"多一整行。用户给的真实模板就是
 * 34mm 窄框 + 「第 X 页 / 共 Y 页」，实测多算了 5.55mm（一个行高），贴近分页边界时会把
 * 内容挤到下一页。所以测量前必须先把令牌换成**与最终数字等宽**的占位。
 *
 * 为什么是**两位**：数字在项目的中文字体栈下等宽，两位覆盖 ≤99 页（打印文档的绝大多数）。
 * 超过 99 页时占位比真实值窄一个数字（≈1.9mm），只有在**恰好卡在折行边界**时才会差一行 ——
 * 这是"测量发生在页数算出来之前"这一事实决定的固有边界，不额外补偿：
 * 为它放大占位反而会把"偶发的少一行"换成"稳定多一行"，把最常见的情况做坏。
 *
 * 注意：占位只进 `measureBlocks` 的入参，**最终产物仍然走令牌 + 逐页替换**（见 buildDocumentHtml），
 * 所以宽框模板（令牌本来就不折行）的产物逐字节不变。
 */
export const MEASURE_PAGE_PLACEHOLDER = '88'

/**
 * 页面安全余量（mm）。
 * 浏览器按 CSS 分页时会有亚像素取整：section 高度**恰好**等于可打印高度时，
 * 有相当概率把 1px 挤到下一页，产出"每隔一页一张白纸"的经典 bug。
 * 因此页面高度统一收 0.2mm —— 视觉上完全不可见，但能稳住分页。
 */
const PAGE_SAFETY_MM = 0.2

// ============================================================
// 基础工具
// ============================================================

/** HTML 文本转义。字段值里出现 `<` `&` 是常态（尤其公式字段），不转义会直接把 DOM 搞坏 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** 属性值转义（比文本多一条：不能含双引号，否则 style 属性会被截断） */
function attr(s: unknown): string {
  return escapeHtml(s)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** mm → CSS px（保留 3 位小数，避免出现 793.7007874015748px 这种噪声） */
function px(mm: number): string {
  return `${round3(finite(mmToPx(finite(mm))))}px`
}

/** pt → CSS px */
function pxPt(pt: number): string {
  return px(ptToMm(finite(pt, DEFAULT_FONT_PT)))
}

// ============================================================
// 文本样式
// ============================================================

/** 文本框通用布局声明：保留换行、允许长词断行 */
const TEXT_FLOW = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere'

/**
 * 文本装饰 → CSS 声明（`textCss` / `inlineCss` / 单元格 `<td>` **三处共用**）。
 *
 * `underlineStyle: 'dashed'` = 下划虚线，用来拼"填空线"（`经办人：_ _ _ _`）。
 * ⚠️ 只有 `underline` 也开着时才生效 —— 线型脱离了下划线本身没有意义。
 * ⚠️ 顺序不能反：`text-decoration` 简写会把 `text-decoration-style` 重置成 solid，
 *    所以线型必须**写在它后面**。
 */
function decoDecl(s: TextStyle): string[] {
  const deco: string[] = []
  if (s.underline) deco.push('underline')
  if (s.strike) deco.push('line-through')
  if (!deco.length) return []
  const out = [`text-decoration:${deco.join(' ')}`]
  if (s.underline && s.underlineStyle === 'dashed') out.push('text-decoration-style:dashed')
  return out
}

function textCss(style: TextStyle | undefined, over: string[] = []): string {
  const s = style ?? {}
  const parts: string[] = []
  const family = s.fontFamily && s.fontFamily !== 'system' ? String(s.fontFamily) : FONT_STACK
  parts.push(`font-family:${family}`)
  parts.push(`font-size:${pxPt(s.fontSizePt ?? DEFAULT_FONT_PT)}`)
  if (s.bold) parts.push(`font-weight:${BOLD_FONT_WEIGHT}`)
  if (s.italic) parts.push('font-style:italic')
  parts.push(...decoDecl(s))
  parts.push(`color:${s.color ?? DEFAULT_COLOR}`)
  if (s.background) parts.push(`background:${s.background}`)
  parts.push(`text-align:${s.align ?? 'left'}`)
  if (typeof s.lineHeightPt === 'number') parts.push(`line-height:${pxPt(s.lineHeightPt)}`)
  else parts.push(`line-height:${finite(s.lineHeight, DEFAULT_LINE_HEIGHT)}`)
  if (typeof s.spaceBeforePt === 'number') parts.push(`margin-top:${pxPt(s.spaceBeforePt)}`)
  if (typeof s.spaceAfterPt === 'number') parts.push(`margin-bottom:${pxPt(s.spaceAfterPt)}`)
  if (typeof s.indentLeftMm === 'number') parts.push(`padding-left:${px(s.indentLeftMm)}`)
  if (typeof s.indentRightMm === 'number') parts.push(`padding-right:${px(s.indentRightMm)}`)
  if (typeof s.indentFirstLineMm === 'number') parts.push(`text-indent:${px(s.indentFirstLineMm)}`)
  return parts.concat(over).join(';')
}

function vAlignCss(v: string | undefined): string {
  return v === 'middle' ? 'vertical-align:middle' : v === 'bottom' ? 'vertical-align:bottom' : 'vertical-align:top'
}

/**
 * 行内节点（`<span>`）专用样式。
 *
 * 刻意**不再重复** font-family / text-align / 行距 / 缩进：
 * 这些属性外层块容器已经声明过，span 会自然继承，而内联元素本来就忽略
 * text-align 与 margin。重复声明会把 HTML 体积放大好几倍
 * （整条中文字体栈约 300 字符，一页几十个 span 很快就上兆）。
 */
function inlineCss(style: TextStyle | undefined): string {
  const s = style ?? {}
  const parts: string[] = []
  if (s.fontFamily && s.fontFamily !== 'system') parts.push(`font-family:${s.fontFamily}`)
  /*
   * ⚠️ **没设字号就一个字节都不输出，让 span 自然继承外层**（2026-10-01 第五批第 1 条）。
   *
   * 原来这里是 `pxPt(s.fontSizePt ?? DEFAULT_FONT_PT)` —— 于是"这个节点没设字号"被当成
   * "这个节点是 10.5pt"，**把外层元素已设好的字号整段吃掉**：
   * 用户在元素上设 6pt，段落里那行字却还是 10.5pt。他截的图里那句
   * 「同样是 6pt，文本段落元素比多维表格的字段大得多」就是这么来的。
   *
   * 上面那段注释写的本来就是"让 span 自然继承"，只有 font-size 这一行没照做 ⇒ 现在照做。
   * 继承链两头都保证有字号：文本元素 = `textCss(el.style)`；表格单元格 = `<td>`（见 buildTableHtml）。
   */
  if (typeof s.fontSizePt === 'number') parts.push(`font-size:${pxPt(s.fontSizePt)}`)
  if (s.bold) parts.push(`font-weight:${BOLD_FONT_WEIGHT}`)
  if (s.italic) parts.push('font-style:italic')
  parts.push(...decoDecl(s))
  if (s.color) parts.push(`color:${s.color}`)
  if (s.background) parts.push(`background:${s.background}`)
  if (typeof s.lineHeightPt === 'number') parts.push(`line-height:${pxPt(s.lineHeightPt)}`)
  else if (typeof s.lineHeight === 'number') parts.push(`line-height:${finite(s.lineHeight, DEFAULT_LINE_HEIGHT)}`)
  return parts.join(';')
}

// ============================================================
// 行内节点
// ============================================================

export interface RenderScope {
  /** 当前记录；模板里循环区外的字段取首行值，因此这里可能传首条记录 */
  record: RecordItem | null
  /** 记录在打印范围内的 0 基下标（系统变量 ${行号} 用） */
  recordIndex: number
  /** 该内容块可用的宽度（mm） */
  widthMm: number
  /** 该内容块可用的高度（mm）；未知时不作为约束（附件"适配单元格"用） */
  heightMm?: number
  /** 用于警告定位 */
  elementId?: string
}

function clippedText(s: string, scope: RenderScope, warnings: RenderWarning[]): string {
  if (s.length <= MAX_TEXT_LEN) return s
  warnings.push({
    kind: 'text-truncated',
    message: `单元格内容超过 ${MAX_TEXT_LEN} 字，已截断显示（E-12）`,
    elementId: scope.elementId,
    recordId: scope.record?.recordId,
  })
  return `${s.slice(0, MAX_TEXT_LEN)}…`
}

/** 求值单个字段占位符。失效/未绑定**必须显式告警**（E-13：禁止静默丢值） */
function resolveField(fieldId: string | null, fieldName: string, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): string {
  if (!fieldId) {
    warnings.push({
      kind: 'field-unbound',
      message: `占位符「${fieldName || '未命名'}」未绑定字段，将渲染为空`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })

    return ''
  }
  const meta = ctx.fieldMap.get(fieldId)
  if (!meta) {
    warnings.push({
      kind: 'field-missing',
      message: `字段「${fieldName || fieldId}」不存在（可能已被删除），将渲染为空`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return ''
  }
  if (!scope.record) return ''
  /*
   * ⚠️ **优先用飞书自己格式化的显示文本**（2026-09-24 第四批第 3 条的**根本解**）。
   *
   * `cellStrings` 由取数阶段对"自己算不准"的字段（公式、查找引用…）预取，
   * 它直接就是界面上那串文本 ⇒ 打印与界面一致，且**以后飞书新增公式类型也不用再改代码**。
   * 这里取不到才回落本地 `renderCellValue` —— 本地那份对常规类型更快，且不依赖 SDK 调用。
   */
  const shown = scope.record.cellStrings?.[fieldId]
  if (typeof shown === 'string' && shown !== '') return clippedText(shown, scope, warnings)
  /*
   * ⚠️ **必须把字段的 `dateFormat` 传下去**（2026-11-25 用户实测：
   *   「报修时间/完成时间在表里有到时分，打印出来只有年月日」）。
   * `renderCellValue` 早就支持 `meta.dateFormat`，但**全项目没有一处传它** ⇒
   * 一律走默认的 `YYYY-MM-DD`，日期列的时间部分被抹掉。
   */
  return clippedText(
    renderCellValue(scope.record.fields[fieldId], meta.type, { dateFormat: dateFormatOf(meta) }),
    scope,
    warnings,
  )
}

/**
 * 时间类系统变量（`today` / `printTime`）的取值。
 *
 * 不指定 `format` 时**直接返回原始串**，而不是"解析回时间戳、再按默认格式重排一遍"：
 * 原始串本来就是用默认格式生成的（`today` = DEFAULT_TODAY_FORMAT，
 * `printTime` = DEFAULT_PRINT_TIME_FORMAT），重排只是白绕一圈，还会引入两类风险
 * （日期串按 UTC 解析在负时区差一天、'YYYY-MM-DD HH:mm' 这种空格分隔写法不是标准 ISO）。
 * 与默认格式比对而不是硬编码，是为了"默认值在哪"与契约里的常量同源。
 *
 * 指定了 `format` 才需要回到时间戳：把空格换成分隔符 `T`（否则部分引擎解析不了），
 * 只有日期没有时间时补 `T00:00` 强制按**本地时间**解析（纯日期串 JS 会按 UTC 解析）。
 * 解析不出来（模板被手改过、传进来一个不是日期的串）就原样返回 —— 绝不抛错、绝不报警告。
 */
function resolveTimeVar(raw: string, format: string | undefined, defaultFormat: string): string {
  const fmt = typeof format === 'string' && format.trim() !== '' ? format.trim() : defaultFormat
  if (fmt === defaultFormat) return raw
  if (!raw) return ''
  const iso = raw.includes(' ') ? raw.replace(' ', 'T') : `${raw}T00:00`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? formatDateTime(ms, fmt) : raw
}

/**
 * 系统变量 → 文本。
 *
 * 契约只在**用得到的**分支上读取 `format` / `hideTotal`：出现在别的变量上时自然被忽略，
 * 不需要额外的校验或警告 —— 模板会被复制粘贴、也会被手改，为此报错只会制造噪音。
 */
function resolveSysVar(node: InlineSysVar, scope: RenderScope, ctx: RenderContext): string {
  switch (node.key) {
    case 'rowNo':
      return String(scope.recordIndex + 1)
    case 'today':
      return resolveTimeVar(ctx.today, node.format, DEFAULT_TODAY_FORMAT)
    // 打印时间在进入渲染时**取一次就固定**（见 pipeline），否则跨分钟翻页时同一篇
    // 文档会出现两个时间，用户会以为打错了。
    case 'printTime':
      return resolveTimeVar(ctx.printTime ?? '', node.format, DEFAULT_PRINT_TIME_FORMAT)
    case 'totalRows':
      return String(ctx.totalRows)
    case 'pageNo':
      return TOK_PAGE_NO
    case 'pageCount':
      return TOK_PAGE_COUNT
    // 合并形态：页码与总页数拼成一句，`hideTotal` 时省略"共 N 页"。
    // 两个数字都用**渲染期已有的令牌**，不在这里自己算页数 —— 页数要到分页结果
    // 出来才知道，令牌由 buildDocumentHtml 逐页替换（见 TOK_PAGE_NO 注释）。
    case 'pageOfTotal':
      return node.hideTotal === true
        ? `第 ${TOK_PAGE_NO} 页`
        : `第 ${TOK_PAGE_NO} 页 / 共 ${TOK_PAGE_COUNT} 页`
    default:
      return ''
  }
}

/**
 * 行内 **inline-block** 需要自己画的装饰（父级的 `text-decoration` 进不去 atomic inline）。
 *
 * 只有"**关掉自动换行**的字段"才是 `inline-block`（`wrap === false`）。父级的下划线
 * 会在它那里**断**，所以自己补一遍 —— 与画布端 `chipDeco` 同一件事、同一口径。
 *
 * 节点自己设过装饰就以它为准（`inlineCss` 已经输出过）；返回一串**以 `;` 结尾**的声明。
 */
function inheritDecoDecl(own: TextStyle | undefined, outer: TextStyle | undefined): string {
  if (own?.underline !== undefined || own?.strike !== undefined) return ''
  if (!outer || (!outer.underline && !outer.strike)) return ''
  const parts = decoDecl(outer)
  return parts.length > 0 ? `${parts.join(';')};` : ''
}

/** 行内节点 → HTML。所有用户可见文本一律 escapeHtml */
export function renderInline(
  nodes: InlineNode[] | undefined,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
  /**
   * 外层的样式（单元格 / 文本元素）。
   *
   * ⚠️ 只用于给 **inline-block** 补画装饰：普通行内 `<span>` 会自然继承父级的
   * `text-decoration`，而 `display:inline-block` 的（关掉自动换行的字段）不会。
   */
  outerStyle?: TextStyle,
): string {
  if (!nodes || nodes.length === 0) return ''
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += `<span style="${attr(inlineCss(n.style))}">${escapeHtml(n.text)}</span>`
        break
      case 'field': {
        /*
         * ⚠️ **复选框在这条路径上也要画方框**（2026-09-24 第四批第 3 条）。
         *
         * 上一轮我只改了 `renderElement` 的 `fieldBlock` 分支 —— 那对应"从左侧面板拖出来的字段块"。
         * 而**放在表格单元格里的字段走的是这条行内路径**（`renderCellContent` → `renderInline`），
         * 于是用户表里的复选框**一直还是文字「是/否」**。
         * 又是"改了一条链、漏了另一条" —— 这个项目里已经栽过好几次：
         * **凡是字段渲染，`fieldBlock` 与 `inline field` 两条路必须一起改。**
         */
        const fMeta = n.fieldId ? ctx.fieldMap.get(n.fieldId) : undefined
        const inner =
          fMeta && fieldMeta(fMeta.type).renderKind === 'checkbox'
            ? checkboxHtml(isCheckedValue(scope.record?.fields?.[n.fieldId ?? '']), n.style)
            : escapeHtml(resolveField(n.fieldId, n.fieldName, scope, ctx, warnings))
        /*
         * ⚠️ **自动换行开关**（2026-10-17 用户要求：开 ⇒ 换行；关 ⇒ 裁切）。
         *
         * 默认（`wrap !== false`）沿用外层 `TEXT_FLOW`（`pre-wrap`）⇒ **与原来一致**；
         * `wrap === false` ⇒ 强制**不换行 + 裁切**（`overflow:hidden` 需要块级容器才生效，
         *   所以外面套一层 `inline-block` —— 行内 `<span>` 的 `overflow` 是无效的）。
         */
        const wrapCss = n.wrap === false
          ? 'display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:clip;vertical-align:bottom;'
          : ''
        /*
         * ⚠️ `wrap === false` ⇒ 上面的 span 变成 `inline-block`，父级的下划线/删除线会在它那里**断**
         * （CSS 装饰进不去 atomic inline）。自己补一遍；普通 span 不补 —— 它会自然继承，补了会变粗。
         */
        const decoCss = n.wrap === false ? inheritDecoDecl(n.style, outerStyle) : ''
        out += `<span style="${attr(wrapCss + decoCss + inlineCss(n.style))}">${inner}</span>`
        break
      }
      case 'sysvar':
        out += `<span style="${attr(inlineCss(n.style))}">${escapeHtml(resolveSysVar(n, scope, ctx))}</span>`
        break
      case 'br':
        out += '<br>'
        break
      default:
        break
    }
  }
  return out
}

// ============================================================
// 附件图片排版（PRD F4.3）
// ============================================================

export interface AttachmentItem {
  token: string
  name: string
  /** 已解析到的可访问地址；缺省表示加载失败 → 渲染占位框（F4-24） */
  url?: string
  mime?: string
  /** 原图像素尺寸，用于等比换算与 DPI 校验 */
  widthPx?: number
  heightPx?: number
}

export interface AttachmentLayoutResult {
  html: string
  /** 内容高度（mm），调用方可直接用于测量校验 */
  heightMm: number
  /**
   * ⚠️ **内容实际宽度（mm）**（2026-10-15）。
   *
   * 为什么需要：之前外面那层容器**写死用元素框宽 ** ⇒ 用户在自由里拉大过尺寸后，
   *   切到原图/适配仍被那层容器撑成那个大小（用户报：不论选什么都按选区大小打印）。
   * ⇒ 现在容器用**真实内容宽**，并把它报给调用方（需要时可按内容度量）。
   */
  widthMm: number
  warnings: RenderWarning[]
}

interface FlowItem {
  /** 占位宽（mm），仅用于分行 */
  wMm: number
  /** 含文件名行高在内的总高（mm） */
  hMm: number
  html: string
}

const NAME_LINE_PT = 7
const NAME_LINE_FACTOR = 1.5

function nameLineHeightMm(): number {
  return ptToMm(NAME_LINE_PT * NAME_LINE_FACTOR)
}

/**
 * 把一组附件排成 HTML。
 *
 * 硬约束（F4-14）：**等比缩放，绝不拉伸**。所有尺寸都从原图宽高比推出，
 * 任何模式下都只允许"整体缩小"这一个操作，从代码结构上杜绝变形。
 */
export function layoutAttachmentGroup(
  items: AttachmentItem[],
  config: AttachmentPrintConfig,
  containerWidthMm: number,
  scope: RenderScope,
  /**
   * ⚠️ **"图片在框内的落点"提示**（2026-10-14 用户要求）。
   *
   * **背景**：用户把附件框摆到格子右侧时，`contain` 的图片**默认居中** ⇒
   *   框贴右了、图没贴 ⇒ 右边留一段空白（画布上看不出来，因为那边画的是"铺满整框"的占位盒）。
   * 原来只能靠用户手动设 `config.align`；**用户要求"按元素框在格子里的位置自动决定"**。
   *
   * ⇒ 调用方（格内子元素那条路，知道元素的 `cellPos`）算出 `'left' | 'center' | 'right'` 传进来；
   *   **拿不到时退回 `config.align`** ⇒ 顶层元素/老路径的行为**逐字不变**。
   */
  boxAlignHint?: 'left' | 'center' | 'right',
  /**
   * ⚠️ **这一格的"内容区"尺寸（mm）**（2026-10-15）。
   *
   * **只有"适配"模式需要它** —— 用户口径：「适配 = **依据单元格大小**进行留白/变形/裁切」，
   *   而"自由 = 按**附件框**"。⚠️ 格内渲染时 `scope` 被换成了**元素自己**的尺寸
   *   （`widthMm: cellWidthMm, heightMm: childBoxHeightMm(child)`）
   *   ⇒ 不额外传"单元格尺寸"，两种模式会**完全一样**（这正是用户报的 bug）。
   * ⚠️ **顶层附件没有单元格** ⇒ 不传 ⇒ 退回元素框（行为不变）。
   */
  cellBoxMm?: { w: number; h: number },
): AttachmentLayoutResult {
  const warnings: RenderWarning[] = []
  const W = Math.max(0, finite(containerWidthMm))
  // ① 用户显式选了"不打印附件" ⇒ 输出空。这是**选择**，不是"没内容"，所以不给占位框。
  if (config.mode === 'none' || W <= 0) {
    return { html: '', heightMm: 0, widthMm: 0, warnings }
  }
  /*
   * ② 字段里**没有附件** ⇒ 给占位框（2026-09-24 第四批第 1 / 5 条）。
   *
   * 原来这里直接返回空 html ⇒ 同一行里码有虚线框、图片有虚线框，附件那一格却什么都没有，
   * 用户读作"这块坏了"。现在与它们共用 `placeholderHtml`。
   * ⚠️ `heightMm` 取 10mm：与 `placeholderHtml` 的 `min-height` 同量级，
   *    否则行的测量高度会与画布上看到的不一致（那会变成"画布≠打印"）。
   */
  if (items.length === 0) {
    return { html: placeholderHtml('附件', '本条记录没有附件'), heightMm: 10, widthMm: W, warnings }
  }

  /**
   * **仅打印附件名称**（2026-09-18 用户要求新增的档位）。
   *
   * 用户原话："对于附件字段，打印策略有点模糊，应该优化下当前的设置，
   * 增加仅打印附件名称的功能。"
   *
   * 实现上**一行一个文件名**（不挤成一行用「、」连起来）：
   * 这样高度就是 `行数 × 行高`，**可预测**；挤一行的话换行位置取决于字体与容器宽度，
   * 高度估不准就会把下面的元素压住（这正是本项目最反复踩的那类坑）。
   *
   * 不下载图片 —— 调用方那边也有一条对应的短路（见 `lib/attachment.ts` 与
   * `useWizardState` 的 allSkip），两处必须同时认这个档位，否则会白下载一堆图。
   */
  if (config.mode === 'nameOnly') {
    const names = items.map((it) => (config.fileNameWithExt === false ? stripExt(it.name) : it.name))
    const lineH = nameLineHeightMm()
    const body = names
      .map(
        (nm) =>
          `<div style="width:100%;font-family:${attr(FONT_STACK)};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};${TEXT_FLOW}">${escapeHtml(
            nm,
          )}</div>`,
      )
      .join('')
    return { html: body, heightMm: Math.max(lineH, names.length * lineH), widthMm: W, warnings }
  }

  const gapX = Math.max(0, finite(config.gapXMm, 2))
  const gapY = Math.max(0, finite(config.gapYMm, 2))
  const showName = !!config.showFileName
  const nameH = showName ? nameLineHeightMm() : 0
  const align = config.align ?? 'left'

  const flow: FlowItem[] = []
  const fileLines: string[] = []

  for (const it of items) {
    const image = isImageAttachment(it.name, it.mime)
    if (!image) {
      // F4-03 / F4-10：非图片附件按文件名文本处理；"仅打印图片"时静默跳过
      if (config.mode === 'all') {
        const nm = config.fileNameWithExt === false ? stripExt(it.name) : it.name
        fileLines.push(nm)
      }
      continue
    }
    // F4-27：不嵌图、只导出文件名的逃生舱
    if (config.textOnlyFallback || !it.url) {
      if (config.textOnlyFallback) {
        const nm = config.fileNameWithExt === false ? stripExt(it.name) : it.name
        fileLines.push(nm)
        continue
      }
      // F4-24：加载失败 → 占位框 + 文件名
      const pw = Math.min(W, 40)
      const ph = pw * 0.72 + nameH
      const box = `<div style="position:absolute;left:0;top:0;width:${px(pw)};height:${px(pw * 0.72)};border:${px(0.3)} dashed #d0d3d9;background:#fafbfc;box-sizing:border-box;color:${MUTED_COLOR};font-family:${attr(
        FONT_STACK,
      )};font-size:${pxPt(7)};display:flex;align-items:center;justify-content:center;padding:${px(1)};">图片加载失败</div>`
      const nmLine = showName
        ? `<div style="position:absolute;left:0;top:${px(pw * 0.72)};width:${px(pw)};font-family:${attr(
            FONT_STACK,
          )};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:center;${TEXT_FLOW}">${escapeHtml(
            it.name,
          )}</div>`
        : ''
      flow.push({ wMm: pw, hMm: ph, html: box + nmLine })
      warnings.push({
        kind: 'image-failed',
        message: `图片「${it.name}」加载失败，已渲染占位框`,
        elementId: scope.elementId,
        recordId: scope.record?.recordId,
      })
      continue
    }

    // ---- 尺寸计算：全部由原图比例推导 ----
    const wPx = finite(it.widthPx, 0)
    const hPx = finite(it.heightPx, 0)
    const ratio = wPx > 0 && hPx > 0 ? hPx / wPx : 0.75
    let wMm: number
    let hMm: number
      /*
       * ⚠️⚠️ **三模式已废弃 —— 现在一律"按选区大小"**（2026-10-15 用户定案）。
       *
       * 用户原话：「**不再需要原图、适配、自由选项，直接按照选区大小去渲染**，
       *   渲染方式还是留白、变形、裁切，**让用户自己去调整选区大小**就行」。
       *
       * ⇒ 语义只剩一句：**框 = 选区（元素框 `w` × `h`）；图按 `fit` 装进这个框**。
       *   这等价于原来"自由（fixedBox）"的行为，但**不再需要用户选模式**。
       *
       * ⚠️ 旧字段 `sizeMode` / `fixedHeightMm` 仍然**能读**（老模板不会崩），
       *   但**不再影响尺寸** —— 尺寸只由"选区"（`W` / `scope.heightMm`）决定。
       *   面板上也已经不再暴露"尺寸模式"。
       */
      wMm = Math.max(1, W)
      hMm = Math.max(1, finite(scope.heightMm, finite(config.fixedHeightMm, 40)))
    // 约束一：绝不能超过容器宽度（F4-14：超出容器时按较小比例缩放）
    let scale = 1
    if (wMm > W) scale = Math.min(scale, W / wMm)
    // 约束二：适配单元格时同时受容器高度约束（F4-20 双向约束，取较小比例）
    const cellH = scope.heightMm
    const wantFitCell = config.fitCell || config.sizeMode === 'fitCell'
    /**
     * 真的被容器压小了没有 —— 压小了要**说出来**（2026-09-18 用户要求）：
     * "自动把尺寸压缩到和单元格一致就行，**同时提醒已经被压缩**。"
     *
     * 为什么要提醒而不是默默压：用户拿到的图上尺寸与他选的原图尺寸对不上，
     * 不吭声就是"两件不一样的事长成一个样子"（判据 30）。提醒里带上压缩后的实际高度，
     * 他就能立刻判断"这个大小我能不能接受"。
     */
    let shrunkToCell = false
    if (wantFitCell && typeof cellH === 'number' && cellH > 0 && hMm * scale > cellH + 0.05) {
      scale = Math.min(scale, cellH / hMm)
      shrunkToCell = true
    }
    wMm = Math.max(1, wMm * scale)
    hMm = Math.max(1, hMm * scale)
    if (shrunkToCell) {
      warnings.push({
        kind: 'element-overflow',
        message: `「${it.name}」原尺寸放不进容器，已自动压缩到 ${Math.round(hMm * 10) / 10}mm 高（等比缩放，不变形）。想要原尺寸请在属性面板关掉「适配单元格」`,
      })
    }

    /*
     * F4-21：有效 DPI 校验（矢量图不参与）。
     *
     * ⚠️⚠️ **必须用"每张实际分到的宽"，不是"框宽"**（2026-10-16 修）。
     *   三模式废弃后"框 = 选区" ⇒ 并排多张时 `wMm` 仍是**选区宽**（如 100mm），
     *   而每张实际只占约 `(100 − gap) / n` ⇒ **DPI 被算小一半** ⇒ 误报"清晰度不足"。
     * ⚠️ 这里**不把校验挪到分行之后**（那要跨作用域搬 30 行，风险收益不成比例）——
     *   改为**就地折算**：
     *     · `wrap`（每张一行）⇒ 就是 `W`；
     *     · `maxPerRow > 0` ⇒ `(W − (n−1)×gapX) / n`；
     *     · 其余（inline 自动换行，列数要等排版完才知道）⇒ **保守按 `W`**
     *       （宁可漏报，也不要**冤枉报** —— 告警可信才有意义）。
     */
    if (!isVectorImage(it.name, it.mime) && wPx > 0) {
      const perRow = config.flow === 'wrap' ? 1 : finite(config.maxPerRow, 0) > 0 ? Math.min(8, Math.floor(finite(config.maxPerRow, 0))) : 0
      const slotWmm =
        perRow === 1 ? W : perRow > 1 ? Math.max(1, (W - (perRow - 1) * Math.max(0, finite(config.gapXMm, 2))) / perRow) : W
      const dpi = wPx / (Math.min(wMm, slotWmm) / 25.4)
      if (dpi < finite(config.minDpi, 150)) {
        warnings.push({
          kind: 'image-low-dpi',
          message: `图片「${it.name}」清晰度可能不足（有效 DPI ≈ ${Math.round(dpi)}），建议减小尺寸或减少每行张数`,
          elementId: scope.elementId,
          recordId: scope.record?.recordId,
        })
      }
    }

    const nmLine = showName
      ? `<div style="position:absolute;left:0;top:${px(hMm)};width:${px(wMm)};font-family:${attr(
          FONT_STACK,
        )};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:center;${TEXT_FLOW}">${escapeHtml(
          config.fileNameWithExt === false ? stripExt(it.name) : it.name,
        )}</div>`
      : ''
    /*
     * ⚠️⚠️ **图片必须单独包一层 `overflow:hidden` 的裁切容器**（2026-10-13 用户诉求：
     *   「保证打印图片的时候，图片**被严格限制在所设置的附件虚线框内**」）。
     *
     * 根因：原来这个 `<img>` 直接 `position:absolute` 挂在"图片格"里，而外层的图片格
     *   （见下面 `flow` 的组装）**没有 `overflow:hidden`** ⇒
     *   `cover` / `fill` 时图片按框尺寸铺满、**超出框的部分会画到框外面** ⇒
     *   相邻的图会互相压、也会盖住表格边框。
     * ⇒ **裁切容器只能包在图片这一层**：包到外层的话，会把框**下面**那行文件名一起裁掉
     *   （文件名故意放在 `top: hMm`，就是"框外"的位置）。
     * ⚠️ `width/height:100%` 让它铺满裁切容器（尺寸仍由外层图片格决定）。
     */
    /*
     * ⚠️⚠️ **`fit`（留白/变形/裁切）在"适配"模式下也必须生效**（2026-10-15 用户报：
     *   「**尺寸模式中的适配，三个填充方式都试了，打印出来都是原图的样式**」）。
     *
     * 根因：这里原来写的是
     *     `config.sizeMode === 'fixedBox' && (fit === 'cover' || fit === 'fill')`
     *   ⇒ **只有"自由（fixedBox）"才认 `fit`，其余一律 `contain`** ❗
     *   而用户口径是「**适配**有三档填充；**自由**也有三档填充」——
     *   ⇒ **两者都该认**。唯一不该认的是 **"原图"**（那时尺寸由图片本身决定，没有"框"可填）。
     */
    /*
     * ⚠️ **三档填充在任何情况下都生效**（2026-10-15 重构后）：
     *   "框 = 选区" ⇒ 永远有框可填，不再有"原图模式没有框"这种例外。
     */
    const fitCss = config.fit === 'cover' || config.fit === 'fill' ? config.fit : 'contain'
    /*
     * ⚠️ **`object-position` 要跟「对齐」走**（2026-10-14 用户报：
     *   「格内附件会对齐上下左三边，但**不会对齐右边**，会距离一段距离，
     *    哪怕在画布中已经紧贴着右边了」）。
     *
     * 根因：图片被 `contain` 装进"元素框"后，**默认居中**（`object-position: center`）——
     *   而用户把元素框摆到了格子右侧，**框贴右了、图没贴**，
     *   于是右边留出一段空白（左边同理，只是他先注意到右边）。
     * ⚠️ 画布上看不出这个问题：那边画的是**占位盒**（铺满整框），本来就贴着框边。
     * ⇒ 让图片在框内的落点**跟着对齐设置**：右对齐 ⇒ 贴框右；左对齐 ⇒ 贴框左。
     * ⚠️ 只在 `contain` 下才有意义（`cover`/`fill` 本来就铺满整框）。
     *   不过统一写上也无害 —— 另两种模式下 `object-position` 不影响结果。
     */
    /*
     * ⚠️⚠️ **优先级：用户设过的对齐 > 自动位置推断**（2026-10-16 用户报：
     *   「附件**铺满**后改对齐，打印确实变了，但**如果没有铺满，那么就只会永远对齐左边，
     *    改了没用**」）。
     *
     * 我第一版修的是"铺满时别推 left"，但那**只解决了一半**：
     *   没铺满且元素靠左（`xPct ≤ 2`）时，自动推断**仍然**给出 `left`，
     *   而它 `?? config.align` 里排在**前面** ⇒ **又把用户设的中/右盖掉**。
     *
     * ⇒ 正确的关系是：**自动推断只是"用户没设过时的默认值"**，
     *   一旦用户在面板上设了 `align`，就该**完全听用户的**（他改了没反应才是 bug）。
     * ⚠️ `config.align === undefined` 才代表"没设过"（面板的 Seg 在没设过时显示 `?? 'left'`，
     *   但**不会写回** ⇒ 字段保持 `undefined`）。
     */
    const effAlign = config.align ?? boxAlignHint
    const objectPos =
      effAlign === 'right' ? 'right center' : effAlign === 'left' ? 'left center' : 'center center'
    const img =
      `<div style="position:absolute;left:0;top:0;width:${px(wMm)};height:${px(hMm)};overflow:hidden;">` +
      `<img src="${attr(it.url)}" style="width:100%;height:100%;display:block;object-fit:${fitCss};object-position:${objectPos}">` +
      `</div>`
    flow.push({ wMm, hMm: hMm + nameH, html: img + nmLine })
  }

  // ---- 非图片附件：逐个换行的文件名文本（F4-10） ----
  for (const nm of fileLines) {
    flow.push({
      wMm: W,
      hMm: nameLineHeightMm(),
      html: `<div style="position:absolute;left:0;top:0;width:${px(W)};font-family:${attr(
        FONT_STACK,
      )};font-size:${pxPt(NAME_LINE_PT + 2)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:${align};${TEXT_FLOW}">${escapeHtml(
        nm,
      )}</div>`,
    })
  }

  if (flow.length === 0) return { html: '', heightMm: 0, widthMm: 0, warnings }

  // ---- 分行：wrap = 每张独占一行；inline = 容器宽度内依次排列，放不下换行 ----
  const maxPerRow = config.flow === 'wrap' ? 1 : config.maxPerRow && config.maxPerRow > 0 ? Math.min(8, Math.floor(config.maxPerRow)) : null
  const rows: FlowItem[][] = []
  let cur: FlowItem[] = []
  let curW = 0
  for (const it of flow) {
    const limit = maxPerRow ?? Number.POSITIVE_INFINITY
    const nextW = cur.length === 0 ? it.wMm : curW + gapX + it.wMm
    if (cur.length > 0 && (cur.length >= limit || nextW > W + 1e-6)) {
      rows.push(cur)
      cur = []
      curW = 0
    }
    const w = cur.length === 0 ? it.wMm : curW + gapX + it.wMm
    cur.push(it)
    curW = w
  }
  if (cur.length > 0) rows.push(cur)

  let y = 0
  let html = ''
  for (const r of rows) {
    const rowH = Math.max(...r.map((i) => i.hMm))
    const usedW = r.reduce((s, i) => s + i.wMm, 0) + gapX * (r.length - 1)
    const x0 = align === 'center' ? Math.max(0, (W - usedW) / 2) : align === 'right' ? Math.max(0, W - usedW) : 0
    let x = x0
    for (const it of r) {
      html += `<div style="position:absolute;left:${px(x)};top:${px(y)};width:${px(it.wMm)};height:${px(
        it.hMm,
      )};">${it.html}</div>`
      x += it.wMm + gapX
    }
    y += rowH + gapY
  }
  const heightMm = Math.max(0, y - gapY)

  /*
   * ⚠️⚠️ **容器的宽度要用"内容的实际宽度"，不是"元素框宽 `W`"**（2026-10-15 用户报：
   *   「**原图模式，打印的时候也是按照附件选区框的大小来渲染的**；用户通过自由模式改动过选区大小后，
   *    后续**不论选择原图还是适配，都是按照这个选区大小**来进行打印」）。
   *
   * 真根因：**图片本身按模式算对了**（`wMm`/`hMm`，见上面的 `switch`），
   *   但**它外面这层容器一直写死 `W`**（= 元素框宽 = 用户在"自由"里拉过的那个宽度）
   *   ⇒ 容器把整个版面撑成那个尺寸 ⇒ 用户看到的就是"不管选什么都按自由模式的尺寸"。
   *
   * ⇒ 改成**内容的最大宽**（单图 = 图片实际宽；多图 = 最宽那一项），
   *   并**用 `W` 封顶**（绝不能超出容器 —— 与上面"约束一"同一口径）。
   */
  /*
   * ⚠️ **容器宽度 = 选区宽 `W`**（2026-10-15 重构后：框就是选区，不再按内容宽收缩）。
   *   （我一度改成"内容宽"，那是为"三模式"服务的；三模式已废弃，这条一并回退。）
   */
  const container = `<div style="position:relative;width:${px(W)};height:${px(heightMm)};">${html}</div>`
  return { html: container, heightMm, widthMm: W, warnings }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

// ============================================================
// 固定图片（ImageElement）
// ============================================================

/**
 * 固定图片 → `<img>`。
 *
 * `fit` 有**三种状态**，必须分开处理，因为它们对老模板的产物影响完全不同：
 *
 * 1) **缺省**（老模板 / `h:'auto'`）：`width:100%;height:auto` —— 按元素宽度等比铺满，
 *    高度由图片自身的宽高比决定。这是历史行为，**一个字节都不能变**：
 *    元素框高在这条路径上不参与约束，否则所有老模板里的图片都会突然缩水。
 * 2) **`contain`**：完整显示。图片盒子 = 元素框（w × h），图片在框**内**等比缩放，
 *    不够的地方留白边，永远不溢出、也永远不把框撑大。
 * 3) **`cover`**：裁剪填满。同一套盒子，超出框的部分裁掉。
 *
 * 两条实现约束（都是这里最容易做错的地方）：
 *
 * · **盒高必须写成显式 px，不能写 `height:100%`。**
 *   外层 `.bp-el` 用的是 `min-height`（见 buildDocumentHtml 的注释：内容比盒子高时
 *   要让它撑开而不是溢出去压住下一个元素）。百分比高度在一个 `height:auto` 的父元素上
 *   会解析成 `auto`，框就约束不住 —— 那正是"图片糊出框外"的成因。
 *   写成 `px(框高)` 之后，约束是**布局期就确定**的，与父元素怎么定高无关。
 *
 * · **宽度始终 100%**：框宽就是元素宽（`.bp-el` 的 width），所以图片盒子与元素框逐边相等，
 *   这与编辑器画布 1:1（画布是 `.bp-el-image{width:100%;height:100%}` + `object-fit`），
 *   保住了 PRD F5-01「预览所见即打印所得」。
 *
 * `contain` 会把小于框的图**放大**到贴近框（object-fit 的固有语义，画布同理），
 * 这是"框内等比缩放"的自然读法：框是权威，图去适配框。
 */
function renderImage(
  el: Extract<AnyElement, { kind: 'image' }>,
  scope: RenderScope,
  /**
   * 渲染上下文（只为拿 `imageUrls`）。
   *
   * ⚠️ **两种存法并存**（2026-10-19）：新模板把固定图片传到飞书附件、元素只存 `fileToken`；
   * 老模板仍是内联的 `dataUrl`。优先级：**token 解析出的临时链接 > dataUrl**
   * （token 是原图，dataUrl 是被压到 50KB 的降级版）。
   */
  ctx?: RenderContext,
): string {
  /*
   * ⚠️ **还没选图时必须给占位框**（2026-09-24 第四批第 1 / 5 条）。
   *
   * 原来这里直接输出 `<img src="">` —— 空 `src` 会塌成一条细线（高度近乎 0），
   * 打印出来那一格什么都没有，用户读作"这儿坏了"；而同一行的二维码却有个虚线框
   * （`codePlaceholderHtml`）⇒ 同一行两种长相。
   * ⇒ 现在与码、附件共用 `placeholderHtml`。
   */
  /* token → 附件名 → 内联 dataUrl（token 可能被飞书重写，见 Canvas 的 imgSrcOf 注释） */
  const byToken = el.fileToken ? ctx?.imageUrls?.get(el.fileToken) : undefined
  const byName = el.fileMeta?.name ? ctx?.imageUrls?.get(el.fileMeta.name) : undefined
  const raw = byToken || byName || el.dataUrl
  if (!raw) return placeholderHtml('图片', el.fileToken ? '图片链接已过期，请重新打开模板' : '还没选择图片')
  const src = attr(raw)
  const boxH = explicitHeightMm(scope)
  // 没有确定的框高（h:'auto'）时"框内"无从谈起 —— 退回缺省形态，不猜一个高度。
  // 非 contain/cover 的取值（含老模板的 undefined）同样走这条路径，保证产物不变。
  /*
   * `natural`（原尺寸）在元素这条路上就是 **`h: 'auto'`** ⇒ `height:auto`（下面第一个分支）。
   * 其余三种（fill/contain/cover）直接进 `object-fit`。
   * ⚠️ 不认识的取值一律退回 `contain`（老模板没有这个字段时的默认行为，不能改）。
   */
  /*
   * ⚠️⚠️ **`object-position` 要跟「对齐」走**（2026-10-16 用户报：
   *   「当我把附件拉到铺满单元格后，打印的图片**一直都是默认对齐左边**……
   *     修复这个 BUG，**同时检查其他类似元素有没有同样的 BUG**」）。
   *
   * ⚠️ 检查结果：**图片 / 二维码 / 条形码也有** —— 它们的 `<img>` 只有 `object-fit`，
   *   而 CSS 默认 `object-position` 是 `center` ⇒ `contain` 时图**永远居中**，
   *   **用户改「对齐」看不出任何变化**。
   *
   * ⇒ 按**元素级 `align`** 输出；没有（老模板）⇒ 退回居中，**行为逐字不变**。
   *   ⚠️ 只在 `contain` 下才有可见效果（`cover`/`fill` 本来就铺满整框），统一写上无害。
   * ⚠️ **必须在分支之前算**（两条 `return` 都要用）。
   */
  const alignOf = (el as { align?: 'left' | 'center' | 'right' }).align
  /*
   * ⚠️ **没设过对齐就不写这个属性**（2026-10-16）——
   *   渲染自测有一条**刻意的护栏**：「fit 缺省时产物与历史完全一致」⇒
   *   无条件写 `center center`（虽然是 CSS 默认值、**视觉等价**）会破坏它。
   *   ⇒ 只有用户真的设了 `align` 才输出 ⇒ **老模板的 HTML 逐字不变**。
   */
  const objectPosStyle = alignOf
    ? `object-position:${alignOf === 'left' ? 'left center' : alignOf === 'right' ? 'right center' : 'center center'};`
    : ''
  if (boxH === null || (el.fit !== 'contain' && el.fit !== 'cover' && el.fit !== 'fill')) {
    const fit = el.fit === 'cover' || el.fit === 'fill' ? el.fit : 'contain'
    return `<img src="${src}" style="width:100%;height:auto;display:block;object-fit:${fit};${objectPosStyle}">`
  }
  return `<img src="${src}" style="width:100%;height:${px(boxH)};display:block;object-fit:${el.fit};${objectPosStyle}">`
}

// ============================================================
// 元素渲染
// ============================================================

export interface RenderElementResult {
  html: string
  warnings: RenderWarning[]
}

/** 表格表头是否每页重复。undefined 视为 true（有表头行就该重复，这是用户默认预期） */
export function tableRepeatHeader(el: TableElement): boolean {
  const hasHeader = el.rows.some((r) => r.isHeader)
  return hasHeader && el.repeatHeader !== false
}

/** 前部连续的表头行数量（表头行必须连续出现在数组开头） */
export function tableHeaderRowCount(el: TableElement): number {
  let n = 0
  while (n < el.rows.length && el.rows[n].isHeader) n++
  return n
}

// ============================================================
// 二维码 / 条形码
// 编码与 SVG 生成都在 code-elements.ts（纯函数，Node 可单测）；
// 这里只负责"取值 → 尺寸 → 告警"，并且**绝不允许静默留白**。
// ============================================================

/** 原文行占用的高度（mm），与码元素留位联动，避免原文压到下一个元素上 */
const CODE_CAPTION_MM = 3
/** 条形码未显式给高度时的默认高（mm） */
const BARCODE_FALLBACK_H_MM = 15
/** 超过这个字符数的条码会密到扫不出来（提示级，仍然渲染） */
const BARCODE_MAX_CHARS = 30

interface CodeValueResult {
  value: string
  /** 取不到值时的原因，写进占位框那句人话里 */
  reason: string
}

/**
 * 解析码的内容来源（字段动态取值 / 用户固定内容）。
 *
 * 与 resolveField 的区别在于**空值必须给说法**：码元素整块就是个图形，
 * 渲染成空白时用户只看到"这里啥都没有"，而真实原因可能是没绑字段、字段被删，
 * 或者只是这一行的字段是空的 —— 三者处理方式完全不同。
 */
function resolveCodeValue(
  source: CodeSource | undefined,
  label: string,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
): CodeValueResult {
  if (!source) return { value: '', reason: '未设置内容来源' }

  if (source.kind === 'static') {
    const v = typeof source.value === 'string' ? source.value : ''
    if (v.trim() === '') {
      warnings.push({
        kind: 'field-unbound',
        message: `${label}没有填写内容，将渲染为占位框`,
        elementId: scope.elementId,
      })
      return { value: '', reason: '未填写内容' }
    }
    return { value: v, reason: '' }
  }

  const name = source.fieldName || source.fieldId || '未命名'
  if (!source.fieldId) {
    warnings.push({
      kind: 'field-unbound',
      message: `${label}未绑定字段，将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { value: '', reason: '未绑定字段' }
  }
  const meta = ctx.fieldMap.get(source.fieldId)
  if (!meta) {
    warnings.push({
      kind: 'field-missing',
      message: `字段「${name}」不存在（可能已被删除），${label}将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { value: '', reason: '字段已失效' }
  }
  // 循环区外的码取首行值；一条记录都没有属于正常状态（不是模板毛病），不刷警告
  if (!scope.record) return { value: '', reason: '暂无数据' }
  const v = renderCellValue(scope.record.fields[source.fieldId], meta.type, { dateFormat: dateFormatOf(meta) })
  if (v.trim() === '') {
    // 字段绑定没问题、模板也没毛病，只是**这一条记录恰好没填** —— 属于数据级问题，
    // 因此用记录级的 code-invalid 而不是模板级的 field-missing：
    // field-missing 会进向导的阻断红条（"字段不存在（可能已被删除）"），
    // 文案与事实不符，用户会去查字段是不是被删了；而且模板级去重会把它压成一条，
    // 多行空值根本定位不到是哪一行。
    warnings.push({
      kind: 'code-invalid',
      message: `字段「${name}」在本条记录中为空，${label}将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record.recordId,
    })
    return { value: '', reason: '字段值为空' }
  }
  return { value: v, reason: '' }
}

/**
 * 元素"还没就绪"时的**通用占位框**（2026-09-24 第四批第 1 / 5 条）。
 *
 * 用户原话：「每个都长的不一样，导致表格变形严重……建议把附件、二维码、条形码、图片
 * 保持画风一致」。画布端已经统一成 `.bp-el-cell__child-phbox`（标题 + 两行说明）；
 * 而**打印端原来只有"码"有占位框** —— 图片在 `dataUrl` 为空时会输出 `<img src="">`
 * （塌成一条细线，什么都看不见），附件又是另一套 ⇒ 三种长相并存。
 *
 * ⇒ 抽成这一份，**四种元素共用同一套结构与样式**：上行"它是什么"、下行"为什么没内容"。
 *
 * ⚠️ 同时输出 `data-ph` 与（码专用的）`data-code-ph`：后者有既有断言在用，不能拆掉。
 */
function placeholderHtml(label: string, reason: string, codeKind = false): string {
  return (
    `<div data-ph="1"${codeKind ? ' data-code-ph="1"' : ''} style="width:100%;height:100%;` +
    `min-height:${px(10)};box-sizing:border-box;border:${px(0.3)} dashed #d0d3d9;background:#fafbfc;` +
    `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${px(0.6)};` +
    `padding:${px(1)};text-align:center;font-family:${attr(FONT_STACK)};font-size:${pxPt(7)};` +
    `color:${MUTED_COLOR};${TEXT_FLOW}">` +
    `<span>${escapeHtml(label)}</span>` +
    (reason ? `<span style="color:#8a8f99;">${escapeHtml(reason)}</span>` : '') +
    `</div>`
  )
}

/** 空内容 / 编码失败时的占位框（码专用入口，转调通用实现） */
function codePlaceholderHtml(label: string, reason: string): string {
  return placeholderHtml(label, reason, true)
}

/** 元素高度（mm）：'auto' 时返回 null，由调用方决定兜底值 */
function explicitHeightMm(scope: RenderScope): number | null {
  return typeof scope.heightMm === 'number' && scope.heightMm > 0 ? scope.heightMm : null
}

function renderQrCode(el: QrCodeElement, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): RenderElementResult {
  const { value, reason } = resolveCodeValue(el.source, '二维码', scope, ctx, warnings)
  if (value === '') return { html: codePlaceholderHtml('二维码', reason), warnings }

  const bytes = utf8ByteLength(value)
  if (bytes > QR_MAX_BYTES) {
    warnings.push({
      kind: 'code-invalid',
      message: `二维码内容 ${bytes} 字节，超出容量上限（${QR_MAX_BYTES} 字节），已改为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('二维码', '内容过长'), warnings }
  }

  const w = Math.max(0, finite(scope.widthMm))
  const h = explicitHeightMm(scope) ?? w
  // 二维码必须是正方形，且要给原文行留出位置，否则原文会溢出元素盒子压到下方元素
  const sizeMm = Math.max(4, Math.min(w, h) - (el.showText ? CODE_CAPTION_MM : 0))
  const svg = qrCodeSvg(value, {
    sizeMm,
    ecLevel: el.ecLevel,
    foreground: el.foreground,
    background: el.background,
  })
  if (svg === '') {
    warnings.push({
      kind: 'code-invalid',
      message: '二维码内容无法编码（可能超出容量上限），已改为占位框',
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('二维码', '编码失败'), warnings }
  }

  const caption = el.showText
    ? `<div style="font-family:${attr(FONT_STACK)};font-size:${pxPt(6)};line-height:1.2;color:${attr(
        el.foreground ?? DEFAULT_COLOR,
      )};${TEXT_FLOW}">${escapeHtml(value)}</div>`
    : ''
  // line-height:0 消掉行内元素自带的基线空隙（否则码下方会莫名多出 3~4px，影响测量）
  return { html: `<div style="width:100%;text-align:center;line-height:0;">${svg}${caption}</div>`, warnings }
}

function renderBarcode(el: BarcodeElement, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): RenderElementResult {
  const { value, reason } = resolveCodeValue(el.source, '条形码', scope, ctx, warnings)
  if (value === '') return { html: codePlaceholderHtml('条形码', reason), warnings }

  // Code 128 编不了非 ASCII。这里必须拦住并告警：出一个扫不出东西的空码，
  // 用户要拿到打印现场才会发现，代价比多一条警告大得多。
  if (!isCode128Encodable(value)) {
    warnings.push({
      kind: 'code-invalid',
      message: '条形码只支持 ASCII 可见字符，当前内容含中文等非 ASCII 字符无法编码（建议改用二维码）',
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('条形码', '内容含非 ASCII 字符'), warnings }
  }
  if (value.length > BARCODE_MAX_CHARS) {
    warnings.push({
      kind: 'code-invalid',
      message: `条形码内容有 ${value.length} 个字符，条宽会密到难以扫描，建议精简内容或改用二维码`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    // 仍然渲染：长编号确实有真实场景，只要用户接受可读性下降
  }

  const w = Math.max(0, finite(scope.widthMm))
  const h = explicitHeightMm(scope) ?? BARCODE_FALLBACK_H_MM
  const svg = barcodeSvg(value, {
    widthMm: w,
    heightMm: h,
    // 与二维码一致：必须显式开才显示原文，避免不同来源的元素默认值打架
    showText: el.showText === true,
    foreground: el.foreground,
    background: el.background,
  })
  if (svg === '') return { html: codePlaceholderHtml('条形码', '编码失败'), warnings }
  return { html: `<div style="width:100%;line-height:0;">${svg}</div>`, warnings }
}

/** 单元格里的附件配置要挂在哪个字段上：优先附件类型字段，其次第一个已绑定字段 */
function resolveCellAttachmentFieldId(cell: TableCell, ctx: RenderContext): string | null {
  let fallback: string | null = null
  for (const n of cell.nodes ?? []) {
    if (n.type !== 'field' || !n.fieldId) continue
    const meta = ctx.fieldMap.get(n.fieldId)
    if (meta && meta.type === 17) return n.fieldId
    if (!fallback) fallback = n.fieldId
  }
  return fallback
}

function attachmentItemsFor(fieldId: string | null, scope: RenderScope, ctx: RenderContext): AttachmentItem[] {
  if (!fieldId || !scope.record) return []
  const resolved = ctx.images.get(imageKey(scope.record.recordId, fieldId))
  if (resolved && resolved.length > 0) {
    /*
     * ⚠️⚠️ **顺序必须以"记录里附件的原始顺序"为准**（2026-10-16 用户报：
     *   「对于有多个图片的附件，**打印的图片不一定是第一张图片**」—— 配合"只打印第一张"，
     *   有时出来的不是用户看到的那张）。
     *
     * 根因：这里是**预取结果**，而预取是**并发下载**的 ⇒ `ctx.images` 里的顺序是
     *   "**任务完成的顺序**"，与用户看到的第一张无关。
     *   （下面那条回退分支用 `record.fields[fieldId]`，顺序是对的 —— 两条分支不一致。）
     * ⇒ 按原始列表的 `token` **重排**；对不上号的（理论上不该有）**追加在后面**，不丢。
     */
    const rawList = scope.record.fields[fieldId]
    const order = Array.isArray(rawList)
      ? rawList.map((v) => (typeof (v as { token?: unknown })?.token === 'string' ? (v as { token: string }).token : ''))
      : []
    const byToken = new Map(resolved.map((r: ResolvedImage) => [r.token, r]))
    const ordered: ResolvedImage[] = []
    for (const t of order) {
      const hit = byToken.get(t)
      if (hit) {
        ordered.push(hit)
        byToken.delete(t)
      }
    }
    /* 预取里多出来的（原始列表对不上）追加在后面 —— 宁可多显示，也不要静默丢图 */
    for (const r of resolved) if (byToken.has(r.token)) ordered.push(r)
    return ordered.map((r: ResolvedImage) => ({
      token: r.token,
      name: r.name,
      url: r.url,
      mime: r.mime,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    }))
  }
  // 没解析到 URL：仍然把附件名列出来，走"加载失败占位框"分支，避免整块消失得莫名其妙
  const raw = scope.record.fields[fieldId]
  if (!Array.isArray(raw)) return []
  return raw.map((v) => {
    const o = (v ?? {}) as { name?: unknown; type?: unknown; token?: unknown }
    return {
      token: typeof o.token === 'string' ? o.token : '',
      name: typeof o.name === 'string' ? o.name : '附件',
      mime: typeof o.type === 'string' ? o.type : undefined,
    }
  })
}

function renderCellContent(
  cell: TableCell,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
  /**
   * 这一格**内容区**的宽度（mm）= 列宽（含 colspan）− 左右内边距。
   *
   * ⚠️ 必须由调用方传进来，**不能**从 `scope.widthMm` 推 —— 那是**表格**的宽度
   * （`pipeline.ts` 的 `scopeOfRecord` 给的就是表宽）。而格内子元素的宽度百分比、
   * 附件/图片的"适配容器"、二维码的边长，全都以**格子**为容器算。
   * 拿表宽当容器就会出现（2026-09-23 真机反馈第 1 / 2 条）：
   *   · 一张附件图横向撑满整张表、竖向按比例长到覆盖整个页面；
   *   · 二维码被画成表宽那么大，溢出格子后被裁掉 ⇒ 用户看到的是"完全不显示"。
   */
  cellWidthMm: number,
  /** 单元格**上内边距**（mm）—— 纵向偏移要减掉它，否则贴不紧上边框（见下方 `abs` 的注释） */
  padMm: number,
  /**
   * ⚠️ 这一行的**行高**（mm）—— **`row.heightMm` 本身就是「内容区高」**（2026-10-15 新增）。
   *
   * 用来给 `yMm` 夹上限（`effectiveChildYMm`）。**不加的话纵向能穿出单元格** ——
   * 用户实测「上/左/右留空隙、**只有底边能贴**」正是它（横向有真上限、纵向的上限是 500 ≈ 不夹）。
   * ⚠️ 自适应行高（`heightMm` 缺席）时传 `undefined` ⇒ **不夹**（没有分母）。
   */
  rowHeightMm: number | undefined,
  /**
   * **行高装不下时格内元素的缩放系数**（`1` = 不缩）。
   *
   * 与画布端 `rowChildScale()` **同一份实现**（`components/editor/table-actions`）。
   * ⚠️ 这是"画布看得见、打印却是空的"那个 bug 的收口（2026-10-19 用户实测）：
   *    `<tr height>` 只是**最小高度**，元素不缩就会把行撑住 —— 画布上永远"装得下"，
   *    而打印按真实行高裁切。两端必须同时缩，所见即所得才成立。
   */
  childScale = 1,
): string {
  /*
   * ⚠️ 单元格里的**块级子元素**（`TableCell.children`，规格 六）必须在这里渲染 ——
   *    2026-09-22 真机反馈时才发现：`children` 只在画布上画了，**打印端整块被忽略**
   *    ⇒ 画布上看得见的图片/二维码，打印/预览里什么都没有。
   *    直接复用 `renderElement`（元素级渲染器），各 kind 的分支只有一份实现。
   *    顺序与画布一致：**先子元素、后 nodes**（图片在上、说明文字在下）。
   */
  /* ⚠️ **2026-10-17 回退**：打印端的子表渲染已移除（用户选 ② 真拆）。 */

  /*
   * ⚠️⚠️ **文字自己裁**（2026-10-19 用户实测：「只要格内有手动输入的文本或普通字段，
   *   单元格在视觉上就不会缩小了，怎么拖都不会小，但实际行高列宽是缩小了的」）。
   *
   * 根因：`<tr height>` 只是**最小高度**，而 `td` 上的 `max-height` / `overflow:hidden`
   * 在 `table-cell` 上**不生效** ⇒ 文字把行撑住。
   * ⇒ 给**文字那一部分**单独套一层定高裁切框；**不能包住 `childHtml`** ——
   *   格内子元素是 `position:absolute`（相对 td 的内容区定位），多一层定位祖先会让落点全偏。
   *
   * 条件与画布端 `Canvas.tsx` 完全一致：有显式行高 + 没开自适应才裁。
   */
  const clipText = (html: string): string => {
    if (cell.autoSize === true) return html
    if (!(typeof rowHeightMm === 'number' && rowHeightMm > 0)) return html
    const h = Math.max(0, rowHeightMm - padMm * 2)
    return `<div style="max-height:${px(h)};overflow:hidden;">${html}</div>`
  }

  const childRaw = (cell.children ?? [])
    .map((child) => {
      /*
       * ⚠️ 每个子元素单独造一个 scope：把 `widthMm` / `heightMm` 换成**它在格子里的实际尺寸**。
       *
       * `renderElement` 的每个分支都是从 scope 推导尺寸的：`renderImage` 取 `widthMm`、
       * `layoutAttachmentGroup` 拿 `widthMm` 当容器宽、`renderQrCode` / `renderBarcode`
       * 用 `widthMm` / `heightMm` 定码的大小。自由层那边由 `pipeline.buildBlocks` 填
       * "元素自己的 w×h"；格内就得填"格内口径的 w×h"—— 两边**语义相同、来源不同**。
       * 少了这一步，格内的东西就会按表的尺寸渲染（就是上面签名注释里那两个症状）。
       */
      const childScope: RenderScope = {
        ...scope,
        widthMm: childBoxWidthMm(child, cellWidthMm),
        /*
         * ⚠️ 盒子高度一律走 `childBoxHeightMm`（2026-09-24 第四批 ④）：
         * 它把 `h: 'auto'` 也当成默认高（18mm）—— 格内"由内容决定"等于"把行撑破"，
         * 于是**老模板**（拖入时存下的 `'auto'`）不必让用户重拖，渲染时就自动变好。
         */
        heightMm: childBoxHeightMm(child) * childScale,
      }
      const r = renderElement(child, childScope, ctx)
      warnings.push(...r.warnings)
      /*
       * 外层盒子承载 `w`（占格宽百分比）与 `h`（固定盒高）—— 与画布**同一套口径**
       * （types.ts 的 TableCell.children 第 ④ 条）。
       *
       * 为什么宽度得由这一层定：`renderElement` 产出的内容一律是 `width:100%`
       * （见 `renderImage`），它撑满的是**这个盒子**，不是单元格 —— 少一层盒子，
       * 用户在面板里把"占格宽"调成 50% 时，打印出来还是 100%。
       */
      /*
       * ⚠️ 这里**直接拼样式串**，不要过 `attr()` —— 它是**转义器**（内部就是 `escapeHtml`），
       *    不是"样式对象序列化器"。传对象进去会得到 `style="[object Object]"`
       *    ⇒ 浏览器整条丢弃 ⇒ 产物里**不报错**，只是"改动看起来没生效"。
       *    （第一版就是这么写的：`w=50` 在画布上生效、打印出来还是 100%，差一点就漏出去。）
       *    数值都来自 `childWidthPct` / `childBoxHeightMm`：它们已经把 NaN / 越界夹掉了。
       */
      /*
       * ⚠️ 盒子**始终给高度 + 裁切**（2026-09-24 第四批 ④）。
       *
       * 这就是"**不把单元格撑变形**"的那一刀：`h: 'auto'` 也走默认高（18mm），
       * 所以一张 800×1200 的竖图进格子只会占 18mm 高，而不是把整行撑到上百毫米。
       * 内容怎么适应这个盒子由元素自己的 `fit` 决定（图片 / 附件默认 `contain` = 等比、不拉伸）。
       */
      /*
       * ⚠️ **水平对齐**（2026-10-13 用户反馈："单元格内的二维码、图片元素，没办法靠右、居中摆放，
       *    默认靠左，**改了属性设置也无效**"）。
       *
       * 根因：这个盒子以前只有 `width` / `height` / `overflow` —— **一个字都没有关于"摆哪边"**。
       * 而用户改的是**单元格**的「水平对齐」（`cell.style.align`），那份设置此前只作用于
       * **文字**（`<td>` 的 `text-align`），**格内的块级子元素完全没读它** ⇒ 永远靠左。
       *
       * ⚠️ 取值口径**不在这里定义** —— 走 `lib/cell-geometry.ts` 的 `childBoxAlign()`，
       *    与画布端（`Canvas.tsx` 的 `.bp-el-cell__child`）**共用同一份**。
       *    这条和 `childWidthPct` / `childBoxHeightMm` 是同一个纪律：
       *    **凡是两端都要算的东西，"家"只有一个**（否则迟早"画布居中、打印靠左"）。
       */
      /*
       * ⚠️ **已手动定位 ⇒ 绝对定位；没定位 ⇒ 维持流式**（2026-10-13）。
       *
       * 这是"老模板零影响"的开关：`cellPos` 缺席就是原来那条路（逐字不变）。
       *
       * ⚠️⚠️ 绝对定位必须**再包一层定位容器**，否则格子会塌 ——
       *    旧设计拒绝绝对定位的理由正是"没人给高度"（见 types.ts）。
       *    容器高 = `childBoxSpanMm` = `y + h` ⇒ 子元素虽然绝对定位，
       *    **容器仍占 `y + h` 的高度** ⇒ 行高照旧被撑住。
       *      ⚠️ 这一层与画布端**必须逐字一致**，否则"画布上好好的、打印出来行高不对"。
       */
      /*
       * ⚠️ **一律绝对定位**（2026-10-13 第 2 次重构，与画布端逐字同口径）。
       *
       * 旧版是"`positioned` 才绝对定位、否则流式 + `margin:auto`" ⇒
       * **每点一次元素就切换一次定位模式** ⇒ 行高来回跳
       * （用户报："拖进格子后单元格被撑大，点击该元素后立刻恢复正常"）。
       * ⇒ 模式必须**与选中状态无关**。
       *
       * 现在：外层容器 = **元素盒子本身**（`left/top/宽/高` 全部按元素给），
       *     子元素铺满它（`100%`）—— 那两件事都由容器承担。
       */
      const geom = 'width:100%;height:100%;overflow:hidden;'
      /*
       * ⚠️ **外层容器 = 元素盒子本身**（2026-10-13 第 2 次重构，与画布端 `.bp-el-cell__holder` 逐字同口径）：
       *    `left/top/width/height` **全部按元素**给 ⇒ 锚点用 `0/100%` 就能贴**元素**四周
       *    （旧版容器是 `width:100%` 整格宽 ⇒ 锚点贴到了**单元格**四周）。
       * ⚠️ 绝对定位 ⇒ **不占文档流高度**（用户要的"不撑行高"）。
       * ⚠️ **不再有"未定位走流式"的分支**：那会让"选中/未选中"切换定位模式 ⇒ 行高来回跳
       *    （用户报："拖进格子后单元格被撑大，点击该元素后立刻恢复正常"）。
       */
      /*
       * ⚠️⚠️ **横向一律用绝对单位（mm），不要用百分比**（2026-10-14 用户指出的不对称）。
       *
       * 用户原话：「**为什么内边距在 1.5 的时候，附件依然可以紧贴着上下左三边呢，
       *   唯独不可以紧贴在右边**？按照这个逻辑来讲，**是不是说明紧贴在上下左边是错误的**」
       *   ⇒ **他的推理是对的 —— 这里就是真 bug，不是"右边差一点"这么简单。**
       *
       * 根因：**两根轴用了不同的单位**
       *   · `top` 用 **mm**（绝对）⇒ 天然与内边距无关 ⇒ 落点精确；
       *   · `left` / `width` 用 **%** ⇒ 绝对定位的百分比是相对**包含块的 padding box 宽**
       *     （= 内容区宽 **＋左右内边距**），而**拖动时算 `xPct` 用的分母是"内容区宽"**
       *     ⇒ **两个分母不一样**。`x = 0` 时恰好不偏（所以"左边看着是好的"），**越靠右偏得越多**。
       *
       * ⇒ 全部换成 mm：`cellWidthMm` 这里就是**内容区宽**（调用方已减过 `padMm * 2`）
       *   ⇒ `xMm = (xPct/100) × 内容区宽`、`wMm = (w/100) × 内容区宽`。
       *   **内边距设多少就留多少空隙**，与纵向行为完全一致（用户要的正是这个）。
       */
      /*
       * ⚠️⚠️ **原点 = 边框内沿**（**回退了"加 pad"的补丁**，2026-10-14）。
       *
       * 我上一轮在这里加了 `padMm`（想法是"把原点从边框内沿挪到内容区"），
       * **结果是引入更严重的问题**：
       *   用户实测「内边距 1.5 时，**右下/左下两组的元素下半部分超出单元格、压线**」——
       *   因为 `yMm` 的上限是按"**内容区高 − 框高**"夹出来的，
       *   **再加一个 `pad` 就直接冒出去了**（而且 `overflow` 只裁"图片在框内"的部分，
       *   裁不到"框本身超出单元格"）。
       *
       * ⇒ **先回退成"不加 pad"**（回到"边框内沿"原点，不会超出）。
       * ⚠️ **正确做法**（下一轮做）：在 `<td>` 里**再包一层"内容区容器"**
       *   （`position:relative`，尺寸等于内容区），让子元素**相对它**定位 ——
       *   那样 `left/top` 天然以"内容区"为原点、**内边距天然生效、也不会冒出单元格**。
       *   直接在坐标上加 pad 是"事后补偿"，会和"钳制上限"打架。
       */
      const contentWmm = Math.max(1, cellWidthMm)
      /*
       * ⚠️ **元素自己的 `align` 优先于"所在单元格的对齐"**（2026-10-14 用户要求：
       *   「附件图片二维码条形码**都遵循同一套规则**，其他几个好像没有类似设置」）。
       *   ⇒ 图片 / 二维码 / 条形码的接口各加了可选 `align`（`types.ts` 的 `CellChildAlign`）。
       *   ⚠️ 都没有 ⇒ 退回单元格的 `style.align` ⇒ **老模板行为逐字不变**。
       */
      const ownAlign = (child as { align?: 'left' | 'center' | 'right' }).align
      const effAlign = ownAlign ?? cell.style?.align
      const xMm = Math.round(((childBoxLeftPct(child, effAlign) / 100) * contentWmm) * 100) / 100
      const wMm = Math.round(((childWidthPct(child) / 100) * contentWmm) * 100) / 100
      /*
       * ⚠️⚠️ **"元素框"的宽高：附件在"非自由"模式下要跟着内容走**（2026-10-15 用户报：
       *   「**原图模式，打印的时候也是按照附件选区框的大小来渲染的**……用户通过自由模式改动过
       *    选区大小后，后续**不论选择原图还是适配，都是按照这个选区大小**打印。
       *    ⇒ **两个模式纯属是一点用没有**」）。
       *
       * 根因链（**外面套了不止一层**，所以前面几次都没改到点上）：
       *   1. 图片本身按模式算 —— `switch (config.sizeMode)` 里 `wMm`/`hMm` ✅ 对
       *   2. 但它外面"附件组容器"写死了 `W`（元素框宽）—— 已修（用内容宽）✅
       *   3. **最外层这个"元素框"仍然写死 `wMm` / `childBoxHeightMm(child)`**（都是"自由"的尺寸）❌
       * ⇒ 现在：**附件且非"自由"** ⇒ 外层**不用固定宽高**（`width/height: auto`），
       *   让**内层内容**（附件组容器：宽=内容宽、高=内容高）自己决定尺寸。
       *
       * ⚠️ 只对 `attach` 这么做：图片 / 二维码 / 条形码的"框"就是用户给的 `w`/`h`
       *   （它们是**单张**，没有"组容器"这一层），改了语义会变。
       * ⚠️ "自由（fixedBox）"模式保持原样 —— 那时 `w`/`h` 就是用户拉出来的尺寸，**必须尊重**。
       */
      /*
       * ⚠️ **元素框 = 选区**（2026-10-15 重构后）—— 回退成固定宽高。
       *   三模式已废弃 ⇒ 不再需要"让内容决定框的大小"。
       */
      const boxSize = `width:${px(wMm)};height:${px(childBoxHeightMm(child) * childScale)};`
      const abs = geom
      return (
        `<div style="position:absolute;left:${px(xMm)};` +
        `top:${px(Math.max(0, effectiveChildYMm(child, rowHeightMm, padMm, childScale)))};` +
        boxSize +
        `">` +
        `<div style="${abs}">${r.html}</div></div>`
      )
    })
    .join('')
  /*
   * ⚠️⚠️ **"内容区容器"**（2026-10-14 定案，一次解决"内边距 + 四边一致 + 不超出"）。
   *
   * **问题**：`<td>` 带 `padding: pad`，而 CSS 绝对定位的 `left/top` 相对的是
   *   **padding box 的**外沿**（= 边框内沿）**；
   *   而格内子元素的 `xMm`/`yMm` 都是**按"内容区"量出来的** ⇒ **差一个 `pad`**。
   *   用户实测「内边距 1.5 时，**左右生效、上下不生效**」正是两根轴原点不同的表现。
   *
   * ⚠️ **不能直接在坐标上加 `pad`** —— 我试过：它会和"拖动钳制（内容区高 − 框高）"打架，
   *   元素**冒出单元格、压线**（用户实测）。
   *
   * ⇒ **正确做法：包一层"内容区容器"**（四边内缩 `pad`），让子元素**相对它**定位 ——
   *   原点天然是"内容区"，内边距天然生效，且**不会冒出容器**。
   *   ⚠️ 画布端（`.bp-el-cell__holder`）必须**逐字同口径**，否则又变成"画布打印不一致"。
   *   ⚠️ 配套：拖动钳制要按"容器高"算（见 `onChildPointerDown` 里的 `maxY`）。
   */
  const childHtml = childRaw
    ? `<div style="position:absolute;left:${px(padMm)};top:${px(padMm)};` +
      `right:${px(padMm)};bottom:${px(padMm)};">${childRaw}</div>`
    : ''
  if (cell.attachment) {
    if (cell.attachment.mode === 'none') {
      // F4-08：选择"不打印附件"时该字段输出空。
      // 但单元格里可能有其它内容（如"照片："这种前缀文字），只摘掉附件字段本身，不动其余节点。
      const fid = resolveCellAttachmentFieldId(cell, ctx)
      const kept = (cell.nodes ?? []).filter((n) => !(n.type === 'field' && n.fieldId === fid))
      return childHtml + clipText(renderInline(kept, scope, ctx, warnings, cell.style))
    }
    const fieldId = resolveCellAttachmentFieldId(cell, ctx)
    const items = attachmentItemsFor(fieldId, scope, ctx)
    /*
     * 附件容器 = **这一格**的宽度（不是表宽）。同时把 `heightMm` 清掉：
     * 格内行高由内容撑，拿"表高"去约束高度会把整格的图压成一条缝。
     * 于是格内附件的口径是"**宽度适配格子、高度等比**" —— 正是用户对
     * 「自适应单元格」的预期（2026-09-23 真机反馈第 1 条）。
     */
    /*
 * ⚠️ **把"单元格内容区"传给适配模式**（2026-10-15）：
 *   宽 = `cellWidthMm`（调用方已经减过左右内边距）；
 *   高 = `行高 − 2×上下内边距`（**`row.heightMm` 是 border box 总高**，实测过）。
 *   行高缺席（自适应）⇒ 不传高 ⇒ 适配退回元素框（没有分母可用）。
 */
const cellContentHmm =
  typeof rowHeightMm === 'number' && rowHeightMm > 0 ? rowHeightMm - 2 * padMm : undefined
const res = layoutAttachmentGroup(
  items,
  cell.attachment,
  cellWidthMm,
  {
      ...scope,
      widthMm: cellWidthMm,
      heightMm: undefined,
    },
    /* 第 5 参 `boxAlignHint`：格内附件这条路径没算"框在格子里的落点提示" ⇒ 不传 */
    undefined,
    /* ⚠️ 第 6 参：**"适配"要用单元格内容区的尺寸**（不是元素框）—— 见 `cellBoxMm` 的注释 */
    cellContentHmm === undefined ? undefined : { w: cellWidthMm, h: cellContentHmm },
  )
    warnings.push(...res.warnings)
    /*
     * ⚠️⚠️ **附件格里"其它节点"也要打印**（2026-10-17 用户报：
     *   「画布中该单元格内有**三个元素**，但实际**打印只有日期**被打印出来」）。
     *
     * 根因：这条分支原来 `return childHtml + res.html` —— **`cell.nodes` 整块被丢掉** ❌
     *   于是"附件格"里除了附件组、别的文字/字段**一个都不印**（画布上却都画着）。
     *   ⚠️ 而"日期"能印，是因为它被当成了附件组的字段（`resolveCellAttachmentFieldId` 的 fallback）。
     *
     * ⇒ 与普通路径**同一个口径**：把附件字段本身摘掉（它已经由附件组画了），
     *   其余节点照常渲染。顺序与画布一致：**子元素（附件）在上、nodes 在下**。
     */
    const keptNodes = (cell.nodes ?? []).filter((n) => !(n.type === 'field' && n.fieldId === fieldId))
    return childHtml + res.html + clipText(renderInline(keptNodes, scope, ctx, warnings, cell.style))
  }
  return childHtml + clipText(renderInline(cell.nodes, scope, ctx, warnings, cell.style))
}

/**
 * 「第 i 行渲染什么」——把**行序**与**行的来源**解耦。
 *
 * 存在两种行序：
 * - 逐记录重复（默认）：行序 = 模板 `rows` 的下标，所有行共用同一个 scope；
 * - 多记录并成一张大表（`rowsFromRecords`）：行序是"虚拟行序"，
 *   同一行可能来自模板的不同行、不同记录（见 `renderLoopTableRows`）。
 *
 * 两种行序必须共用**同一套**列宽压缩 / 边框 / 表头重复逻辑，
 * 否则"第二页没表头"这类问题会在新增的行序里悄悄复活。
 */
interface TableRowRef {
  /** 模板 `el.rows` 里的下标 */
  rowIndex: number
  /** 渲染该行（含单元格内容）时使用的 scope */
  scope: RenderScope
}

/**
 * 列宽和超出元素宽度多少，才算"真的超宽"（mm）。
 *
 * 取值理由（不是拍脑袋定的 0.5）：
 * · **噪声上限**：`colWidthsMm` 由编辑器按 0.01mm / 由 `setColWidthPatch` 按 0.1mm 取整，
 *   `w` 又等于"取整后的和再取整"，所以每一列最多带 0.005mm 误差、`w` 再带 0.05mm。
 *   按列数 C 累计，最坏 ≈ C×0.005 + 0.05：3 列 0.065mm、30 列 0.2mm。
 *   0.5mm 是 30 列最坏噪声的 **2.5 倍**，留足余量。
 * · **可见上限**：0.5mm 在 96dpi 下约 1.9px，肉眼不可见；压缩后每列只窄 0.33%，
 *   排版上等同于没变。也就是说**低于这个阈值的压缩，用户本来就看不出差别**，
 *   却要为此弹一条"超出版心宽度"（带指责意味）的提示 —— 一份正常的模板一打开就自带噪音。
 * · 与同文件的 `BOX_OVERFLOW_WARN_MM` 同量级、同理由（都是"这个尺度以下算取整噪声"）。
 *   刻意不复用那个常量：两者的语义不同，共用一个名字会让以后调其中一个的人误伤另一个。
 *
 * 注意：**压缩本身不受这个阈值影响** —— 只要 `sum > w` 就照旧按比例压缩（那是对的做法，
 * 不压缩就会真的溢出元素框）。这里只决定"要不要打扰用户"。
 */
const TABLE_COMPRESS_WARN_MM = 0.5

/**
 * 表格 HTML 的公共骨架。
 *
 * `startRow/endRow` 用于**按行拆分后的片段**：
 * - startRow === 0 时，片段自带原始表头行；
 * - startRow > 0 且 repeatHeader 时，片段会**克隆一份表头行**（F2-29 硬要求）。
 */
function buildTableHtml(
  el: TableElement,
  /** 列宽 / 边框 / 告警定位用的 scope（行内单元格用各自的行 scope，见 refAt） */
  scope: RenderScope,
  /** 本次行序的总行数（默认 = 模板行数；合并大表 = 表头 + 数据行 × 记录数） */
  total: number,
  headerCount: number,
  repeat: boolean,
  startRow: number,
  endRow: number,
  /** 第 i 行（0 基，虚拟行序）→ 模板行 + scope；返回 null 表示该行不存在 */
  refAt: (i: number) => TableRowRef | null,
  ctx: RenderContext,
): RenderElementResult {
  const warnings: RenderWarning[] = []
  const from = Math.max(0, Math.min(startRow, total))
  const to = Math.max(from, Math.min(endRow, total))

  // ---- 列宽：总和超出元素宽度时按比例压缩（E-45） ----
  const targetW = Math.max(0, finite(scope.widthMm))
  const src = el.colWidthsMm && el.colWidthsMm.length > 0 ? el.colWidthsMm.map((v) => finite(v, 0)) : null
  const colCount = src ? src.length : Math.max(1, ...el.rows.map((r) => r.cells.length), 1)
  const sum = src ? src.reduce((s, v) => s + v, 0) : 0
  let widths: number[]
  if (src && sum > 0) {
    if (sum > targetW + 1e-6) {
      // 压缩：与告警分开判 —— 差 0.04mm 也要压（否则真的溢出元素框），但不值得打扰用户
      const k = targetW / sum
      widths = src.map((v) => v * k)
      if (sum - targetW > TABLE_COMPRESS_WARN_MM) {
        warnings.push({
          kind: 'table-compressed',
          message: `表格列宽总和（${round3(sum)}mm）超出版心宽度，已按比例压缩到 ${round3(targetW)}mm`,
          elementId: el.id,
        })
      }
    } else {
      widths = src
    }
  } else {
    widths = new Array(colCount).fill(colCount > 0 ? targetW / colCount : 0)
  }

  /*
   * ⚠️ 兜底值必须与画布**同一个来源**（2026-10-02 项目体检 P1）。
   *
   * 原来这里写的是 `1`（内边距）和 `0.5`（线宽），而画布那侧是 `1.5` / `0.75`
   * ⇒ 缺省模板**在画布上和打印稿上不一样宽、不一样粗**。
   * 现在两端都引用 `types.ts` 的常量 —— 要调就调一处。
   */
  const paddingMm = Math.max(0, finite(el.cellPaddingMm, DEFAULT_CELL_PADDING_MM))
  const borderW = Math.max(0.05, finite(el.border?.widthPt, DEFAULT_TABLE_BORDER_PT))
  const borderColor = el.border?.color ?? DEFAULT_TABLE_LINE
  const borderPx = `${round3((borderW * 96) / 72)}px`
  const mode = el.border?.mode ?? 'all'

  const tableBorder =
    mode === 'outer'
      ? `border:${borderPx} solid ${borderColor};`
      : mode === 'none'
        ? 'border:none;'
        : 'border:none;'
  const cellBorder =
    mode === 'all'
      ? `border:${borderPx} solid ${borderColor};`
      : mode === 'horizontal'
        ? `border:none;border-bottom:${borderPx} solid ${borderColor};`
        : 'border:none;'

  const colgroup = `<colgroup>${widths.map((w) => `<col style="width:${px(w)};">`).join('')}</colgroup>`
  /* 摊平一次：后面判断"表头行里的格有没有跨出表头区"要用（`spanCrossesHead`） */
  const spanGrid = tableGrid(el.rows, colCount)

  const renderRow = (ri: number): string => {
    const ref = refAt(ri)
    if (!ref) return ''
    const row = el.rows[ref.rowIndex]
    if (!row) return ''
    // ---- F2-35：行内单元格数 ≠ 列数必须显性化，不许静默产出坏表 ----
    //
    // 多出的单元格在 `table-layout:fixed` + 只有 N 个 <col> 的表格里**分不到宽度**，
    // 浏览器会把它们压成 0 宽：空着时肉眼看不出，一旦填了内容就会溢到相邻格上互相压。
    // 这不是能靠渲染层补救的事（"5 格里哪几格该多宽"没有正确答案，替作者补宽等于偷偷改结构），
    // 所以只报出来、并告诉用户去哪儿改。
    //
    // 用 colspan 求和而不是 cells.length：跨列的单元格本身占多列，
    // 3 个 cell（其中一个 colspan=2）实际占 4 列，那才是会溢出的那一种。
    const occupied = row.cells.reduce((s, c) => s + Math.max(1, Math.floor(finite(c.colspan, 1))), 0)
    if (occupied > colCount) {
      warnings.push({
        kind: 'table-column-mismatch',
        message:
          `表格第 ${ref.rowIndex + 1} 行有 ${occupied} 个单元格，但表格只定义了 ${colCount} 列：` +
          `多出的 ${occupied - colCount} 个单元格宽度会被压成 0，填入内容后会与相邻单元格重叠。` +
          `请在编辑器里删掉这一行多余的单元格。`,
        elementId: el.id,
      })
    }
    // 单元格内容用**该行自己的** scope：合并大表里同一张表的每一行可能属于不同记录
    const rowScope = ref.scope
    const rowH = typeof row.heightMm === 'number' && row.heightMm > 0 ? `height:${px(row.heightMm)};` : ''
    /*
     * 单边边框（规格 八）：**只有当这一格自己写过 `borders` 时**才逐边输出 CSS。
     * ⚠️ 老模板（没有 `borders`）继续走 `cellBorder` 这一个字符串 ⇒ **产出的 HTML 逐字不变**，
     *    不会惊动任何现有的渲染断言。
     * ⚠️ `colCursor` 是**按数组顺序累加 colspan** 推出来的列号：跨行合并（rowspan）覆盖的行里，
     *    这一行的第一个格子未必在第 0 列 —— 那种情况下 `outer` 的"是否最左列"判定会偏。
     *    影响面很窄（只有"显式覆盖过 + outer 模式 + 上方有 rowspan"三者同时成立时），
     *    先在这里写明，不假装它能算准。
     */
    let colCursor = 0
    const cells = row.cells
      .map((cell) => {
        const span = cell.colspan > 1 ? ` colspan="${Math.floor(cell.colspan)}"` : ''
        const rspan = cell.rowspan > 1 ? ` rowspan="${Math.floor(cell.rowspan)}"` : ''
        const padMm = Math.max(0, finite(cell.paddingMm, paddingMm))
        /*
         * 该格**内容区**宽度 = 从 `colCursor` 起、跨 `colspan` 列的列宽之和 − 左右内边距。
         *
         * ⚠️ 必须从 `colCursor` 累加，**不要**拿"数组下标"当列号：跨列合并的格子在
         * `row.cells` 里只是一个元素，数组下标 ≠ 网格列号（`table-actions.ts` 的
         * `cellWidthMm` 已经为同一个理由写过一次）。越界时按 0 累加，
         * 退化成"很窄"而不是 NaN —— 那种模板本来就命中 `table-column-mismatch` 告警。
         */
        const cellSpan = Math.max(1, Math.floor(finite(cell.colspan, 1)))
        let cellW = 0
        for (let k = 0; k < cellSpan; k++) cellW += widths[colCursor + k] ?? 0
        const inner = renderCellContent(
          cell, rowScope, ctx, warnings, Math.max(1, cellW - padMm * 2), padMm,
          typeof row.heightMm === 'number' ? row.heightMm : undefined,
          /* 行高装不下时元素等比缩小（与画布同一个函数，见 `rowChildScale`） */
          rowChildScale(el, ref.rowIndex),
        )
        const bg = cell.style?.background ? `background:${cell.style.background};` : ''
        const cw = (cell.borders?.widthPt ?? borderW)
        const cc = cell.borders?.color ?? borderColor
        const cpx = `${round3((Math.max(0.05, cw) * 96) / 72)}px`
        const edges = resolveCellEdges(mode, cell.borders, {
          row: ref.rowIndex,
          rows: el.rows.length,
          col: colCursor,
          cols: colCount,
        })
        const edgeCss = cell.borders
          ? `border-top:${edges.top ? `${cpx} solid ${cc}` : 'none'};` +
            `border-right:${edges.right ? `${cpx} solid ${cc}` : 'none'};` +
            `border-bottom:${edges.bottom ? `${cpx} solid ${cc}` : 'none'};` +
            `border-left:${edges.left ? `${cpx} solid ${cc}` : 'none'};`
          : cellBorder
        colCursor += Math.max(1, Math.floor(finite(cell.colspan, 1)))
        /*
         * ⚠️ **单元格的字形（粗 / 斜 / 下划线 / 删除线）必须在这里输出**（2026-10-02 体检 P0-1）。
         *
         * 原来这段样式串只有 family / size / color / line-height / align —— 而画布端
         * （`Canvas.tsx` 的 `<td>`）用的是 `textCss`，**会**输出 `font-weight` / `font-style` /
         * `text-decoration`。于是：在单元格面板勾「加粗」，**画布上变粗、打印出来还是细的** ——
         * 正是本项目反复出现的那种"设了没用"。
         *
         * 口径与 `textCss` 对齐：`bold ⇒ 700`、`italic`、`underline/strike` 合成 `text-decoration`。
         */
        const cs = cell.style ?? {}
        /* 与 `textCss` / `inlineCss` 共用 `decoDecl`（含下划虚线），三处口径必须一致 */
        const glyphCss =
          (cs.bold ? `;font-weight:${BOLD_FONT_WEIGHT}` : '') +
          (cs.italic ? ';font-style:italic' : '') +
          decoDecl(cs)
            .map((d) => `;${d}`)
            .join('')
        /*
         * ⚠️ **这里不能加 `overflow:hidden`**（2026-10-13 用户第 2 次反馈后删掉）：
         *   元素"向上被切一半、向下被裁一点点"就是它造成的。
         *   纵向的钳制**算得出来**（拖动时量内容区高，见 `Canvas.tsx` 的 `cellGeom.height`）⇒
         *   元素永远待在内容区内 ⇒ **不需要裁切**。与画布端**同一口径**。
         */
        /*
         * ⚠️⚠️ **`position:relative` 不能少**（2026-10-14 用户报的严重 bug）：
         *   「图片的渲染位置和它在画布中所在的单元格**严重不符**……
         *    在同一个单元格内**稍微拖动一点**，预览和实际打印时就会**千差万别**，
         *    会出现在**其他单元格**或者**覆盖在多个单元格之间**」。
         *
         * 根因：格内子元素是 `position:absolute`（定位到"单元格内容区"），
         *   而 `<td>` **没有建立定位上下文** ⇒ 绝对定位会去找**更外层的定位祖先**
         *   （`.bp-page` 之类）⇒ **`left/top` 一算就跑到别的格子去了**。
         *   ⚠️ 在格内拖动一点点就让 `left/top` 变化 ⇒ 落点当然"千差万别"。
         * ⇒ 由 `<td>` 承担定位上下文（两端同一口径：画布端 `<td>` 也要有）。
         */
        return `<td${span}${rspan} style="${attr(
          /*
             * ⚠️⚠️ **`overflow:hidden` + `max-height`**（2026-10-17 用户报：
             *   「关掉自动换行后，打印**没有被裁切**，而是**单元格被拉长**了，导致打印不全」）。
             *
             * 根因：`tr` 的 `height` 是**最小高度**，`nowrap` 的长内容**把行撑起来** ⇒ 表格变高 ✅
             * ⚠️ 不加 `overflow:hidden` 时 `td` 里的内容会"溢出但可见"（打印出来是糊的），
             *   加了之后多出的部分**直接裁掉**（用户要求"直接裁切、不要省略号"）。
             */
            `${edgeCss}${rowH}${bg}padding:${px(padMm)};box-sizing:border-box;position:relative;` +
            /*
             * ⚠️ **`overflow:hidden` 交给 `autoSize` 管**（2026-10-17 用户报：
             *   「开关'自适应宽高' ⇒ 开：**格子依旧按照尺寸裁切**」）。
             *   原来它是**无条件**加的 ⇒ 自适应开着也照样裁 ⇒ 开了跟没开一样。
             *
             * ⚠️⚠️ **注释块后面绝对不能跟 `+`** —— 那是一个**一元加号**，
             *   会把后面的字符串转成数字 `NaN`（本次就是这样炸的：
             *   `/* … *\/ + \`${edgeCss}…\`` ⇒ `NaN` ⇒ 整条 `td` 样式变成 `"NaNoverflow:hidden;…"`，
             *   自测当场红 5 条）。注释要么放在**上一行**、要么放在 `${}` 里。
             */
            `${cell.autoSize === true ? '' : 'overflow:hidden;'}` +
            /* ⚠️ **自适应开 ⇒ 不加 `max-height`**（让行按内容长）；关 ⇒ 死守行高、超出裁掉 */
            `${
              cell.autoSize === true
                ? ''
                : typeof row.heightMm === 'number' && row.heightMm > 0
                  ? `max-height:${px(row.heightMm)};`
                  : ''
            }` +
            `${vAlignCss(cell.style?.vAlign)}` +
            `;font-family:${FONT_STACK};font-size:${pxPt(cell.style?.fontSizePt ?? DEFAULT_FONT_PT)}` +
            /*
             * ⚠️ **固定行距优先**（2026-10-02 项目体检 P1）。
             * 画布的 `textCss` 是 `lineHeightPt` 优先、其次 `lineHeight`；
             * 打印端原来只读 `lineHeight` ⇒ 给单元格设"固定行距 N pt"后
             * **画布按固定行距、打印回落到倍数行距**，两边的行高对不上。
             */
            `;color:${cell.style?.color ?? DEFAULT_COLOR};line-height:${
              typeof cell.style?.lineHeightPt === 'number'
                ? pxPt(cell.style.lineHeightPt)
                : finite(cell.style?.lineHeight, DEFAULT_LINE_HEIGHT)
            }` +
            `;text-align:${cell.style?.align ?? 'left'}${glyphCss};` +
            /*
             * ⚠️⚠️ **换行 / 自适应，读"单元格"上的开关**（2026-10-17 用户要求：
             *   「自动换行的开关……**放在单元格的属性中**，额外再增加一个**单元格自适应宽高**的开关」）。
             *
             * · `wrap === false` ⇒ `nowrap`（并把 `TEXT_FLOW` 里的 `pre-wrap` 换成 `nowrap`）；
             * · 其余 ⇒ 沿用 `TEXT_FLOW`（`pre-wrap`，历史行为）。
             * ⚠️ 顺序：`cell.wrap` 优先，没有就退回"换行"。
             */
            (cell.wrap === false ? 'white-space:nowrap;' : TEXT_FLOW),
        )}">${
          /*
           * ⚠️ **裁切已经下沉到 `renderCellContent` 的 `clipText()`**（2026-10-19）。
           *
           * 原来是在这里给**整格内容**包一层 `max-height + overflow:hidden`，但它
           * **遇到有子元素的格子就不敢包**（那层 div 会成为子元素 `position:absolute`
           * 的新定位祖先）⇒ 图文混排的格子，文字照样把行撑高，行高怎么拖都不缩。
           * ⇒ 现在只包**文字那一部分**（`clipText`），子元素完全不受影响，
           *   而且画布与打印走同一条判断（有显式行高 + 没开自适应）。
           */
          inner
        }</td>`
      })
      .join('')
    const rowStyle = typeof row.heightMm === 'number' && row.heightMm > 0 ? ` style="height:${px(row.heightMm)};"` : ''
    return `<tr${rowStyle}>${cells}</tr>`
  }

  /*
   * ⚠️⚠️ **thead / tbody 的边界会截断 rowspan**（2026-10-17 用户报：
   *   「如果有合并的单元格，打印的时候格内内容会错位，而且表格边框也不会打印」）。
   *
   * HTML 规范：`rowspan` **不能跨行组边界**（thead / tbody / tfoot 各自是独立行组）。
   * 用户的表头行里有一个"跨出表头区"的合并格（先合并、后设表头行 —— 护栏管不到存量模板），
   * 浏览器就把 `rowspan="3"` **截成表头行数** ⇒ 合并凭空消失；而下面那些行，
   * 本该"被覆盖"的那一列在 `row.cells` 数组里**本来就没有 td** ⇒ **整行少一格** ⇒
   * 内容整体左移、右侧边框缺一条 —— 正是用户截图里的样子。
   *
   * ⇒ 检测到这种跨界合并时，**不拆 thead/tbody**，整表输出一个 `<tbody>`（表头行仍在最上面）。
   *   跨页重复不依赖 `table-header-group`：`splitTable` 会在每个续排片段里**手动克隆表头**。
   * ⚠️ 只在第一段（`from === 0`）处理 —— 续排片段从中间开始，表头是克隆的，
   *   它自己的 rowspan 只能在本片段内表达（HTML 没有"跨片段合并"这种东西）。
   */
  const spanCrossesHead = (() => {
    const n = Math.min(headerCount, el.rows.length)
    if (from !== 0 || n <= 0) return false
    for (let i = 0; i < n; i += 1) {
      for (const g of spanGrid[i] ?? []) {
        if (g && g.rowStart === i && g.rowStart + g.rowSpan > n) return true
      }
    }
    return false
  })()

  // 表头行的呈现规则：
  //  - 片段从第 0 行开始 → 自带原始表头行（可能只带一部分）；
  //  - 片段从中间开始 → repeatHeader 时克隆一份完整表头行（F2-29）。
  const headCount = from === 0 ? Math.min(to, headerCount) : repeat ? headerCount : 0
  const headHtml =
    headCount > 0 && !spanCrossesHead
      ? `<thead style="display:table-header-group;">${Array.from({ length: headCount }, (_, i) => renderRow(i)).join('')}</thead>`
      : ''
  /* 表头里有跨界合并 ⇒ 表头行也交给 body（否则它们被 thead 截断，见 `spanCrossesHead`） */
  const bodyFrom = spanCrossesHead ? from : from === 0 ? Math.max(headerCount, from) : from
  const bodyTo = to
  const bodyHtml =
    bodyTo > bodyFrom
      ? `<tbody>${Array.from({ length: bodyTo - bodyFrom }, (_, i) => renderRow(bodyFrom + i)).join('')}</tbody>`
      : ''

  const html =
    /*
     * ⚠️⚠️ **`<table>` 上不能再写 `width: ${el.w}`**（2026-10-14 用户报的严重 bug）：
     *   「画布中表格是满版的，打印出来却只有一条**细长条**」。
     *
     * 根因：**两端的总宽口径不同** ——
     *   · **画布**（`Canvas.tsx:3404`）：逐列输出 `<col style="width:Xmm">`，**`<table>` 不设 width**
     *     ⇒ 总宽 = **Σ列宽**；
     *   · **打印**（这里）：`table-layout:fixed` + `width:${el.w}` ⇒ 总宽被**强行设成 `el.w`**，
     *     列再按比例压 ⇒ 当 `el.w < Σ列宽` 时，**表格被压扁**，而画布仍是满版。
     *
     * ⇒ **去掉 `width`**，让表格按 `<col>` 自己算总宽 ⇒ **与画布逐字同口径** ⇒ 所见即所得。
     * ⚠️ `table-layout:fixed` 保留：列宽仍由 `<colgroup>` 决定（没有它，列宽会被内容撑开）。
     * ⚠️ `targetW` 仍然算着（下游用它做别的事），只是**不再写进表格的 width**。
     */
    /*
     * ⚠️⚠️ **必须给 `<table>` 一个显式 `width`**（2026-10-17 用户报：
     *   「字段值多长，宽就多大」—— **单元格被内容撑宽**）。
     *
     * 根因：`table-layout: fixed` **只在"表格宽度确定"时**才按 `<col>` 分配列宽。
     *   一旦 `<table>` 没有 `width`（历史上一度去掉过，见下面那段的注释），
     *   浏览器会退回 `auto` 宽度 ⇒ **按内容的 `min-content` 撑开** ⇒
     *   `nowrap` 的长字段值**把整张表撑宽** ✅
     *
     * ⇒ 用 `<col>` 之和当总宽。这与"逐列 `<col width>` 才是唯一真相"的既定口径**不冲突**：
     *   总宽不是新来源，而是**同一组数字的和**（同一份 `widths`）。
     * ⚠️ 画布端（`Canvas.tsx`）同样"不设 width、按 col 算"—— 那边是 `div` 布局，
     *   没有 `table-layout:fixed` 的这层陷阱，所以不需要跟。
     */
    `<table style="border-collapse:collapse;table-layout:fixed;` +
    /* ⚠️ **过滤 NaN**（见上方注释）：非有限值按 0 计；全空则不输出 `width`（退回"按 col 算"） */
    (() => {
      const sum = widths.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
      return sum > 0 ? `width:${px(sum)};` : ''
    })() +
    `${tableBorder}">` +
    colgroup +
    headHtml +
    bodyHtml +
    '</table>'
  return { html, warnings }
}

/**
 * 单张表格 → HTML（逐记录重复时用）。
 * 行序 = 模板 `rows` 的下标；`startRow/endRow` 是**按行拆分后的片段**区间。
 */
export function renderTableRows(
  el: TableElement,
  startRow: number,
  endRow: number,
  scope: RenderScope,
  ctx: RenderContext,
): RenderElementResult {
  return buildTableHtml(
    el,
    scope,
    el.rows.length,
    tableHeaderRowCount(el),
    tableRepeatHeader(el),
    startRow,
    endRow,
    // 行序 = 模板行下标；所有行共用同一个 scope（逐记录重复的语义）
    (i) => (el.rows[i] ? { rowIndex: i, scope } : null),
    ctx,
  )
}

// ============================================================
// 多记录并成一张大表（TableElement.rowsFromRecords）
// ============================================================

/**
 * 合并大表的行展开计划：一份表头 + 每条记录各一遍数据行。
 *
 * 为什么要有"计划"这一层：分页（`splitTable`）按**行号区间**切片段，
 * 而测量要按行读高度，两者都必须知道"虚拟第 i 行是哪条记录的第几行"。
 * 把换算集中在这里，分页与测量才不会各算一套。
 */
export interface LoopTablePlan {
  /** 表头行数（模板前部的 isHeader 行，只出现一次） */
  headerCount: number
  /** 模板数据行数（非表头行，每条记录各渲染一遍） */
  bodyCount: number
  /** 记录数 */
  recordCount: number
  /** 虚拟总行数 = 表头行数 + 模板数据行数 × 记录数 */
  totalRows: number
}

export function planLoopTable(el: TableElement, recordCount: number): LoopTablePlan {
  const headerCount = tableHeaderRowCount(el)
  const bodyCount = Math.max(0, el.rows.length - headerCount)
  const n = Math.max(0, Math.floor(recordCount))
  return { headerCount, bodyCount, recordCount: n, totalRows: headerCount + bodyCount * n }
}

/**
 * 多记录合并表 → HTML。
 *
 * 行序（虚拟行序，与测量出的 `rowHeightsMm` 一一对应）：
 *   [0, headerCount)                    → 模板表头行，**只渲染一次**
 *   headerCount + d (d = 0..bodyCount*N) → 模板第 headerCount + d%bodyCount 行，用第 floor(d/bodyCount) 条记录的 scope
 *
 * 表头行用**首条记录**的 scope（与"循环区外的占位符取首行值"同一条约定，F2-16）。
 * 分页复用 `buildTableHtml` 的既有规则：片段从中间开始时按 `repeatHeader` 克隆表头（F2-29）。
 */
export function renderLoopTableRows(
  el: TableElement,
  plan: LoopTablePlan,
  startRow: number,
  endRow: number,
  /** 第 recordIndex 条记录渲染时用的 scope；调用方保证 0 ≤ recordIndex < plan.recordCount */
  scopeOfRecord: (recordIndex: number) => RenderScope,
  ctx: RenderContext,
): RenderElementResult {
  const headerScope = scopeOfRecord(0)
  return buildTableHtml(
    el,
    headerScope,
    plan.totalRows,
    plan.headerCount,
    tableRepeatHeader(el),
    startRow,
    endRow,
    (i) => {
      if (i < plan.headerCount) return { rowIndex: i, scope: headerScope }
      if (plan.bodyCount <= 0) return null
      const d = i - plan.headerCount
      const rec = Math.floor(d / plan.bodyCount)
      if (rec < 0 || rec >= plan.recordCount) return null
      return { rowIndex: plan.headerCount + (d % plan.bodyCount), scope: scopeOfRecord(rec) }
    },
    ctx,
  )
}

/**
 * 打印用的复选框：一个方框 + 勾选时的对勾。
 *
 * 用 CSS 边框 + `✓` 字符，而不是 SVG：在任何打印引擎里表现一致，
 * 而且尺寸从**字号**换算（`ptToMm(fontSizePt) * 1.15`）⇒ 用户改了字号它跟着变，不会错位。
 *
 * ⚠️ 画布上**不画这个框**：编辑期字段显示的是 chip（字段名占位，见 `Canvas.tsx` 的 `renderInline`），
 * 只有打印/预览才取真值。所以这里不存在"画布 / 打印两份实现"的分叉风险 ——
 * 但**别**顺手给画布也加上，那会让用户在编辑期误以为那就是最终效果（字段名与值不是一回事）。
 */
function checkboxHtml(checked: boolean, style?: TextStyle): string {
  const fsPt = finite(style?.fontSizePt, DEFAULT_FONT_PT)
  const sizeMm = Math.max(1.6, ptToMm(fsPt) * 1.15)
  const color = style?.color ?? DEFAULT_COLOR
  const line = checked ? color : MUTED_COLOR
  return (
    `<span style="display:inline-block;width:${px(sizeMm)};height:${px(sizeMm)};box-sizing:border-box;` +
    `border:${px(0.25)} solid ${line};border-radius:${px(0.4)};vertical-align:-0.16em;` +
    `margin:0 ${px(0.35)};line-height:${px(sizeMm * 0.82)};text-align:center;` +
    `font-size:${px(sizeMm * 0.8)};color:#ffffff;background:${checked ? color : 'transparent'};">` +
    (checked ? '✓' : '') +
    `</span>`
  )
}

/** 单个元素 → HTML（不含定位信息，定位由 buildDocumentHtml 统一包裹） */
export function renderElement(el: AnyElement, scope: RenderScope, ctx: RenderContext): RenderElementResult {
  const warnings: RenderWarning[] = []
  const sc: RenderScope = { ...scope, elementId: el.id }
  switch (el.kind) {
    case 'text': {
      const flow = `<div style="${attr(textCss(el.style, [TEXT_FLOW]))}">${renderInline(el.nodes, sc, ctx, warnings, el.style)}</div>`
      return { html: flow, warnings }
    }
    case 'fieldBlock': {
      const val = resolveField(el.fieldId, el.fieldName, sc, ctx, warnings)
      const fMeta = el.fieldId ? ctx.fieldMap.get(el.fieldId) : undefined
      /*
       * ⚠️ **复选框要画真实的方框**（2026-09-24 第四批第 3 条）。
       *
       * 用户截图：多维表格里是一个绿色勾选框，打印出来却是文字「否」。
       * 根因：`renderCellValue` 的契约是"值 → **字符串**"，画不出框。
       * 所以这里单开一条路：直接读**原始值**（`record.fields[fieldId] === true`）来定勾选态，
       * 再交给 `checkboxHtml` 画一个方框 + 对勾。
       */
      if (fMeta && fieldMeta(fMeta.type).renderKind === 'checkbox') {
        const raw = el.fieldId ? sc.record?.fields?.[el.fieldId] : undefined
        /* ⚠️ 用 `isCheckedValue` 而不是 `=== true`：值可能是 1 / 'true' / '是'（见它的注释） */
        const box = checkboxHtml(isCheckedValue(raw), el.style)
        return {
          html: `<div style="${attr(textCss(el.style, [TEXT_FLOW]))}">${escapeHtml(el.prefix ?? '')}${box}${escapeHtml(
            el.suffix ?? '',
          )}</div>`,
          warnings,
        }
      }
      const flow = `<div style="${attr(textCss(el.style, [TEXT_FLOW]))}">${escapeHtml(el.prefix ?? '')}${escapeHtml(
        val,
      )}${escapeHtml(el.suffix ?? '')}</div>`
      return { html: flow, warnings }
    }
    case 'table': {
      const res = renderTableRows(el, 0, el.rows.length, sc, ctx)
      return { html: res.html, warnings: res.warnings }
    }
    case 'image':
      return { html: renderImage(el, sc, ctx), warnings }
    case 'hline': {
      const w = Math.max(0.05, finite(el.thicknessPt, 0.75))
      const html = `<div style="height:0;border-top:${round3((w * 96) / 72)}px solid ${el.color ?? '#1f2329'};"></div>`
      return { html, warnings }
    }
    case 'pagebreak':
      // 分页符本身不产出可见内容，只影响分页（由 layout 处理）
      return { html: '', warnings }
    case 'attach': {
      const all = attachmentItemsFor(el.fieldId, sc, ctx)
      /*
       * ⚠️ **只打印第一张 —— 现在是「默认开」**（2026-10-15 用户要求：
       *   「把**"只打印第一张"设置为默认勾选**」）。
       *
       * 原来缺省为假 ⇒ 用户不改就是"全部打印"；而实际业务里绝大多数单据位
       *   只放得下一张（用户反复报过"打印的图片似乎是随机的"）⇒ **默认开更贴合直觉**。
       *
       * ⚠️ 判定写成 **`!== false`** 而不是 `=== true`：这样
       *   · `undefined`（老模板 / 从没设过）⇒ **默认开** ✅
       *   · 显式 `false`（用户手动关掉）⇒ **尊重用户**：打印全部 ✅
       * ⚠️ 这样**老模板的行为会变**（原来打全部、现在只打第一张）——
       *   这是用户明确要求的默认值变更，且**在面板上可一键关掉**。
       */
      const items = el.config.onlyFirst !== false ? all.slice(0, 1) : all
      /*
       * ⚠️ **按"元素框在格子里的位置"自动决定图片贴哪边**（2026-10-14 用户要求）。
       *
       *   · 只在**格内子元素**上有意义 —— 那时 `cellPos` 才有值；
       *   · **顶层元素**没有 `cellPos` ⇒ 传 `undefined` ⇒ 退回 `config.align`（**老路径行为逐字不变**）。
       * ⚠️ 阈值：`xPct ≤ 2%` 视为贴左、`xPct + w ≥ 98%` 视为贴右、其余居中。
       *   用百分比而不是 mm，是因为这里只知道 `sc.widthMm`（容器宽），
       *   而 `2%` 在任何宽度的容器里都对应"视觉上贴边"。
       */
      const pos = (el as { cellPos?: { xPct?: number } }).cellPos
      const wPctEl = childWidthPct(el as { w?: number | string })
      /*
       * ⚠️⚠️ **"铺满"时不再自动推"左"**（2026-10-16 用户报：
       *   「当我把附件**拉到铺满单元格**后，打印的图片**一直都是默认对齐左边**，
       *     即使把附件属性中的对齐改成中、右，依旧对齐左边；
       *     我也尝试改了**单元格的对齐方式**，改成中、右，依旧对齐左边」）。
       *
       * 根因：`xPct <= 2 ⇒ 'left'` 这条判据在"铺满"时**必然成立**
       *   （铺满 ⇒ `x = 0`、`w = 100`）⇒ `boxAlignHint` 恒为 `'left'`
       *   ⇒ 而它**优先于** `config.align`（见同文件 `effAlign = boxAlignHint ?? config.align`）
       *   ⇒ **用户在面板上改对齐怎么都不生效**。
       *
       * ⚠️ 而且这个 hint 在"铺满"时**本来就没有意义** ——
       *   它的用途是"框明显贴左/贴右时，让**图在框内**也贴同一边"；
       *   框已经占满整格时，图贴哪边应该**听用户的**。
       * ⇒ 加两个前提：**`w < 98`（真的没铺满）**，且**只在真贴边时**给 hint；
       *   **居中的情况不给**（退回 `config.align`，用户设置才生效）。
       */
      const boxAlignHint =
        pos && typeof pos.xPct === 'number' && wPctEl < 98
          ? pos.xPct <= 2
            ? ('left' as const)
            : pos.xPct + wPctEl >= 98
              ? ('right' as const)
              : undefined
          : undefined
      const res = layoutAttachmentGroup(items, el.config, sc.widthMm, sc, boxAlignHint)
      return { html: res.html, warnings: res.warnings }
    }
    case 'qrcode':
      return renderQrCode(el, sc, ctx, warnings)
    case 'barcode':
      return renderBarcode(el, sc, ctx, warnings)
    default:
      return { html: '', warnings }
  }
}

// ============================================================
// 文档拼装
// ============================================================

export interface HtmlOptions {
  title?: string
  /**
   * 预览模式：屏幕上看的时候给每页加纸张阴影与灰底。
   * 打印（@media print）时会自动关掉，因此**预览与打印共用同一份 HTML**。
   */
  forPreview?: boolean
  /** 额外注入的 CSS（预览缩放等），仅用于展示，不影响打印几何 */
  extraCss?: string
}

/**
 * `@page` 规则。
 *
 * ⚠️ **边距必须为 0**（2026-09-18 飞书真机反馈后修正）。
 *
 * 原来的写法把用户的页边距（默认 20mm）也写进了 `@page`。后果不是"更准确"，
 * 而是**给浏览器腾出了画页眉页脚的地方**：浏览器把默认页眉（文档标题 + 日期 + 页码）
 * 与页脚（页面 URL）**画在页边距区里**，于是打印出来凭空多出：
 *   顶部 `2026/9/18 19:44、空白（视图模板）1·打印预览`
 *   底部 `https://xxx.feishu.cn/base/...`
 * 用户原话："我的模板中并没有这些内容，预览界面也没有这些内容，打印的时候凭空多出来了。"
 *
 * 更糟的是它还**双算了边距**：`<section>` 被放进"纸张原点内缩 20mm"的页面区里，
 * 而块坐标里又加了一遍 `m.left / m.top`（见下面 `left/top` 的算法）⇒
 * 打印会比预览整体右下各偏 20mm、右/下页边距被吃掉（预览走屏幕媒体、`@page` 不生效，所以只有打印偏）。
 *
 * ⇒ 归零之后：浏览器没有边距区可画 ⇒ 页眉页脚消失；坐标体系只剩一套（块自己带 `m.left/top`）
 * ⇒ **预览什么样，打印就什么样**。页边距由我们自己在块坐标里补，不再依赖 `@page`。
 * ⇒ 配套：`<section>` 的高度必须改成**整纸高**（`renderH` 那一行），否则页面下部分会被裁掉。
 */
function pageCss(pageSetup: PageSetup): string {
  const size = pageRenderSize(pageSetup)
  return `@page { size: ${round3(size.w)}mm ${round3(size.h)}mm; margin: 0; }`
}

/**
 * PageModel[] + PageSetup + RenderContext → 完整 HTML 文档字符串。
 *
 * 页码在分页完成后才确定，而重复区（表头）的 HTML 是跨页克隆的同一份，
 * 因此页码用私用区令牌写入，最后**逐页替换**（见 TOK_PAGE_NO）。
 */
export function buildDocumentHtml(
  pages: PageModel[],
  pageSetup: PageSetup,
  ctx: RenderContext,
  opts: HtmlOptions = {},
): string {
  const size = pageRenderSize(pageSetup)
  const m = pageSetup.margin
  const contentW = Math.max(0, size.w - finite(m?.left) - finite(m?.right))
  const contentH = Math.max(0, size.h - finite(m?.top) - finite(m?.bottom))
  /**
   * ⚠️ `@page` 边距归零之后，这一页必须撑到**整张纸**（见 pageCss 的注释）。
   *
   * 块坐标是"纸张原点 + 页边距 + 作者 y"（下面 `left/top` 那一行），所以最低的块可以到
   * `m.top + contentH = 纸高 − m.bottom` —— 这个值**大于** `contentH`。
   * 若页面盒仍按 `contentH` 收高，`.`bp-page` 的 `overflow:hidden` 会把底部内容裁掉。
   */
  const renderH = Math.max(0, size.h - PAGE_SAFETY_MM)
  const totalPages = pages.length

  const sections = pages
    .map((pg, i) => {
      const blocks = pg.blocks
        .map((b) => {
          const left = finite(m?.left) + finite(b.xMm)
          const top = finite(m?.top) + finite(b.yMm)
          // 表格片段用 auto 高度：片段高度是按实测量出来的，写死高度反而可能裁掉最后一行
          //
          // 其它元素用 **min-height** 而不是 height：hMm 是"这个块实际占用的高度"
          // （= max(作者设定的盒子高, 实测内容高)，见 pipeline 的 boxHMm）。
          // 写成 min-height，内容万一还是比它高，浏览器会把盒子撑开而不是让文字溢出去压住
          // 下面那个元素 —— 打印时"叠字"正是这么来的。内容装得下时 min-height 与 height 等价，
          // 因此正常模板的产物逐字节不变。
          /**
           * ⚠️ **但"图片类"元素要写死高度**（2026-09-20 用户反馈后改）。
           *
           * 用户原话："附件类字段、二维码元素都无法通过鼠标拖动调整大小，特别是高度…
           * 即使是修改元素的属性高度，高度降低，**但其在画布中的大小还是不变**。"
           *
           * 根因：整个模型里 `h: number` 的语义是**下限**（`pipeline.boxHMm` 的注释写着
           * "盒子高只作下限"，量出来比盒子高就撑大 `hMm`）—— 画布与打印**都**这么干，
           * 所以两边一致地忽略"固定高度"。对**文字块**这是对的（换行撑高，写死会叠字）；
           * 但**有固有尺寸的内容**（图片/附件/二维码/条码）是另一回事：
           * 它们本来就该"缩放到框里"，高度必须由框说了算。
           *
           * ⇒ 只对图片类、且**作者显式设过高度**（`boxHMm > 0`）的块写 `height` + 裁掉溢出。
           *   这样实测高度自然等于盒子高，`pipeline` 的 `max()` 取到同一个数 ⇒
           *   **分页逻辑一行都不用动**（这是本次刻意挑的改法：不动管道就没有分页风险）。
           *   文字块、表格、`h:'auto'` 的元素一律走原路径，产物不变。
           */
          const picLike =
            b.kind === 'attach' || b.kind === 'qrcode' || b.kind === 'barcode' || b.kind === 'image'
          const heightCss =
            b.kind === 'table'
              ? ''
              : picLike && b.boxHMm > 0
                ? `height:${px(b.boxHMm)};overflow:hidden;`
                : b.hMm > 0
                  ? `min-height:${px(b.hMm)};`
                  : ''
          return (
            `<div class="bp-el bp-el-${attr(b.kind)}" data-el="${attr(b.elementId)}" ` +
            `style="position:absolute;left:${px(left)};top:${px(top)};width:${px(b.wMm)};${heightCss}">` +
            `${b.html}</div>`
          )
        })
        .join('')
      const section = `<section class="bp-page" data-page="${i + 1}" style="width:${px(size.w)};height:${px(renderH)};">${blocks}</section>`
      // 逐页替换页码令牌
      return replacePageTokens(section, String(i + 1), String(totalPages))
    })
    .join('')

  const title = escapeHtml(opts.title ?? '打印预览')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${pageCss(pageSetup)}
html,body{margin:0;padding:0;background:#fff;}
body{font-family:${FONT_STACK};color:${DEFAULT_COLOR};-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.bp-page{position:relative;overflow:hidden;background:#fff;box-sizing:border-box;}
.bp-page + .bp-page{break-before:page;page-break-before:always;}
.bp-el{box-sizing:border-box;}
.bp-el table{border-collapse:collapse;}
.bp-el img{display:block;}
${opts.forPreview ? `.bp-page{box-shadow:0 2px 10px rgba(31,35,41,.18);margin:0 auto 16px;}` : ''}
${opts.extraCss ?? ''}
@media print{
  html,body{background:#fff;}
  .bp-page{box-shadow:none;margin:0;}
}
</style>
</head>
<body>${sections}</body>
</html>`
}

/** 供需要复用上下文宽度的调用方（pipeline）使用 */
export function contentBoxOf(pageSetup: PageSetup): { w: number; h: number } {
  const size = pageRenderSize(pageSetup)
  return {
    w: Math.max(0, size.w - finite(pageSetup.margin?.left) - finite(pageSetup.margin?.right)),
    h: Math.max(0, size.h - finite(pageSetup.margin?.top) - finite(pageSetup.margin?.bottom)),
  }
}
