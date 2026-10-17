/**
 * 单元格子元素的**定位与写入**（2026-09-22，真机反馈第 3 条）。
 *
 * 用户原话：「单元格内的元素……完全无法对单元格内的图片、二维码和条形码进行编辑，
 * 点击该单元格后，右侧的属性面板显示 @image#1:Clipboard_Screenshot.png 未绑定字段」
 * —— 点格子显示的是**格子的字段占位**，而格子里那个真元素根本没有被选中的机会。
 *
 * ── 为什么需要这个模块（而不是往 findElement 里加递归）──────────────────
 * `findElement(doc, id)` 只在**版式区**里找元素，找到的结果是 `{el, band}` ——
 * 调用方（`mergeElement` / `removeElement`）靠 `band` 写回。而格内子元素**不属于任何版式区**，
 * 它的写回路径是"改它所在的那张表的某一格"。两者结构不同，硬塞进同一个返回值里
 * 只会让每个调用方都去判"这次是不是子元素"。
 *
 * ── 三个设计决定（动它之前先读这三条）──────────────────────────────────
 *
 * ① **下钻只有一层**：一格最多一个块级子元素（`MAX_CELL_CHILDREN = 1`），
 *    而且 `CELL_BLOCK_KINDS` 里**没有 `table`** ⇒ 结构上不可能嵌套。所以不需要递归搜索。
 *
 * ② **用复合 id 表达"某个格子里的那个元素"**：`child:<tableId>:<cellId>`。
 *    这样它就是一个**普通字符串**，能直接流进现有的 `select(id)` / `mergeElement(id, patch)` /
 *    撤销栈的 `mergeKey`，改动面最小；而 `findCellChild` 负责把它解回三元组。
 *    ⚠️ 走这条路的代价：`selectedId` 里会出现这种合成 id，**任何按 id 找元素的地方都要能容忍它** ——
 *    所以 `mergeElement` / `removeElement` / `selected` / `setElementBand` 四处都加了分支（见 useEditorState）。
 *
 * ③ **写回 = 重建那张表的 rows**（不是就地改）：克隆 rows → 换掉那一格里的子元素 → 用 `withBand` 落回原版式区。
 *    与其它动作层一样走"整份快照"路线，撤销栈因此天然正确。
 */

import type { AnyElement, TableElement, TemplateDoc } from '../../lib/types'
// ⚠️ 只从 `./doc-bands` 取 —— 不要从 `./useEditorState` 取。那个模块是 React hooks 模块，
// 而本文件必须能被 Node 直接加载（单测要跑），并且反向引用会和 useEditorState 形成循环依赖。
// `BandKey` 就是从 doc-bands 转出去的，类型上是同一个。
import { findElement, readBand, withBand, type BandKey } from './doc-bands'
/*
 * `round1` 的**规范实现**（`round.ts`）。
 * ⚠️ 不要在本文件里再写一份 —— 本项目有一条守卫钉着"全项目恰好一处定义"
 * （`src/components/editor/__selftest.mts` 的「已收口」断言），我第一次就是这么被拦下来的。
 * `round.ts` 只依赖 `lib/types`，因此不影响"本文件要能被 Node 直接加载"这条约束。
 */
import { round1 } from './round'
// 尺寸口径的规范实现在 lib/（见下方 re-export 处的说明）—— 这里要**本地**用到 `childWidthPct`
import { childWidthPct, CELL_CHILD_DEFAULT_H_MM, MIN_CELL_CHILD_PCT } from '../../lib/cell-geometry'

const PREFIX = 'child:'

/**
 * 复合 id：`child:<tableId>:<cellId>[:<childId>]`。
 *
 * ⚠️ **第三段是可选的**（2026-10-16 放宽 `MAX_CELL_CHILDREN` 后新增）：
 *   · 不传 ⇒ `child:<tableId>:<cellId>` —— **与旧代码逐字相同**，表示"这一格"；
 *   · 传了 ⇒ `child:<tableId>:<cellId>:<childId>` —— 指向**具体某一个**子元素。
 * ⚠️ 老形式仍然合法（"这一格"的语义没变）⇒ 老模板/老调用点不受影响。
 */
export function cellChildId(tableId: string, cellId: string, childId?: string): string {
  return childId ? `${PREFIX}${tableId}:${cellId}:${childId}` : `${PREFIX}${tableId}:${cellId}`
}

/**
 * 解回 `{tableId, cellId, childId?}`；不是子元素 id 就返回 null。
 *
 * ⚠️ **2026-10-16 改成"按段切"**：原来用 `lastIndexOf(':')` 从右边切一刀 ——
 *   那是为**两段**设计的；加了可选的第三段之后，那个切法会把 `cellId` 切错位。
 *   · 2 段 ⇒ `{tableId, cellId}`（老形式，**行为逐字不变**）
 *   · ≥3 段 ⇒ `{tableId, cellId, childId}`（`childId` 取剩下的全部，含冒号也不怕）
 * ⚠️ `tableId` / `cellId` 都是 `newId()` 生成的（不含冒号）⇒ 按段切是安全的。
 */
export function parseCellChildId(
  id: string | null | undefined,
): { tableId: string; cellId: string; childId?: string } | null {
  if (!id || !id.startsWith(PREFIX)) return null
  const rest = id.slice(PREFIX.length)
  const parts = rest.split(':')
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  if (parts.length === 2) return { tableId: parts[0], cellId: parts[1] }
  return { tableId: parts[0], cellId: parts[1], childId: parts.slice(2).join(':') }
}

/**
 * ⚠️ **格内子元素里"可自由缩放"的种类**（2026-10-16 用户要求 —— 
 *   "所有的字段、元素都可自由拖动，但**不像附件/图片/码那样可自由缩放**"）。
 *
 * 列的这 4 种都有"框"的概念（宽 × 高都能调）；
 * 没列的两种（`hline` 水平线 / `text` 文本块）**只能拖位置**，不该出现缩放手柄 ——
 * 它们"拉高"没有意义（文本高度由字号/行数决定，水平线只有长度）。
 *
 * ⚠️ **单一来源**：锚点的显示条件、以及以后的任何"是否可缩放"判断，都从这里取。
 */
export const SCALABLE_CELL_KINDS: ReadonlyArray<AnyElement['kind']> = [
  'image',
  'qrcode',
  'barcode',
  'attach',
]

export interface FoundCellChild {
  tableId: string
  cellId: string
  /** 那张表在哪个版式区（写回要用） */
  band: BandKey
  /** 那张表（未修改的快照） */
  table: TableElement
  /** 格子里的那个子元素 */
  child: AnyElement
}

/** 按复合 id 找到"格内子元素" —— 找不到（表/格/子元素任一缺失）返回 null */
export function findCellChild(doc: TemplateDoc, id: string | null | undefined): FoundCellChild | null {
  const parsed = parseCellChildId(id)
  if (!parsed) return null
  const found = findElement(doc, parsed.tableId)
  if (!found || found.el.kind !== 'table') return null
  const row = found.el.rows.find((r) => r.cells.some((c) => c.id === parsed.cellId))
  const cell = row?.cells.find((c) => c.id === parsed.cellId)
  /*
   * ⚠️⚠️ **按 `childId` 找，而不是永远 `[0]`**（2026-10-16 用户报：
   *   「点击**格内任意元素**，右侧面板**显示第一个增加的元素**」）。
   *
   * 原来写死 `cell?.children?.[0]` —— 一格一个时没问题；
   *   放宽 `MAX_CELL_CHILDREN` 之后，**点哪个都解析成第一个** ✅
   * ⇒ 有 `childId` 就按 id 找；没有（老形式 2 段 id）才退回第 0 个（**行为逐字不变**）。
   */
  const child = parsed.childId
    ? cell?.children?.find((c) => c.id === parsed.childId)
    : cell?.children?.[0]
  if (!cell || !child) return null
  return { tableId: parsed.tableId, cellId: parsed.cellId, band: found.band, table: found.el, child }
}

/** 把某张表的 rows 换掉（其余字段原样），并用 `withBand` 落回原版式区 */
function replaceTableRows(doc: TemplateDoc, band: BandKey, tableId: string, rows: TableElement['rows']): TemplateDoc {
  return withBand(
    doc,
    band,
    readBand(doc, band).map((e) => (e.id === tableId && e.kind === 'table' ? { ...e, rows } : e)),
  )
}

/** 改格内子元素（patch 合并进去）—— 与 `mergeElement` 同语义，只是写回路径不同 */
export function patchCellChild(
  doc: TemplateDoc,
  id: string,
  patch: Partial<AnyElement>,
): TemplateDoc | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const rows = hit.table.rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) =>
      c.id !== hit.cellId
        ? c
        : { ...c, children: (c.children ?? []).map((ch) => (ch.id === hit.child.id ? ({ ...ch, ...patch } as AnyElement) : ch)) },
    ),
  }))
  return replaceTableRows(doc, hit.band, hit.tableId, rows)
}

/** 把格内子元素**从格子里摘掉**（元素本身的属性面板用不到，但 `removeElement` 要走这条） */
export function dropCellChild(doc: TemplateDoc, id: string): TemplateDoc | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const rows = hit.table.rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) => (c.id !== hit.cellId ? c : { ...c, children: (c.children ?? []).filter((ch) => ch.id !== hit.child.id) })),
  }))
  return replaceTableRows(doc, hit.band, hit.tableId, rows)
}

/**
 * 把格内子元素**搬到一个版式区**（"取出到画布"用）。
 * 返回新文档；调用方随后自己 `addElement`。
 */
export function takeOutCellChild(doc: TemplateDoc, id: string): { doc: TemplateDoc; child: AnyElement } | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const next = dropCellChild(doc, id)
  if (!next) return null
  return { doc: next, child: hit.child }
}

/** 这个 id 是不是"格内子元素"（给那些只认版式区元素的地方一个显式的判据，而不是靠 `findElement` 返回 null 去猜） */
export function isCellChildId(id: string | null | undefined): boolean {
  return parseCellChildId(id) !== null
}

// ============================================================
// 尺寸口径（`w` 在格内是百分比、`h` 是固定高度；见 types.ts 的 TableCell.children 第 ④ 条）
// ============================================================

/** 占单元格宽度的百分比的**下限**：再窄就看不见了，那种"拖了半天什么都没了"必须堵掉 */
/*
 * ⚠️ `MIN_CELL_CHILD_PCT` / `childWidthPct` / `childHeightMm` 的**规范实现**已下沉到
 * `lib/cell-geometry.ts`。理由与 `round1` 那条一样，只是方向相反：
 * **渲染引擎**（`render/html.ts`）也要用同一套口径，而 `render/` 绝不能反向 import
 * `components/editor/`（会形成循环依赖，且渲染引擎必须能被 Node 直接加载）。
 * 这里只做 re-export，保住全部既有引用（含 `cell-child.selftest.mts` 与 Canvas）。
 */
export {
  MIN_CELL_CHILD_PCT,
  CELL_CHILD_DEFAULT_H_MM,
  childBoxHeightMm,
  childHeightMm,
  childWidthPct,
} from '../../lib/cell-geometry'

/**
 * **进格子**：把一个自由层元素归一化成格内子元素。
 *
 * 口径：撑满格子宽度 + 高度由内容决定（= 它被扔进格子之前画布上的样子）。
 * 不这么做的话，自由层的 `w: 40`（mm）会被读成 40%，图片比用户预期小一半 —— 而且
 * 用户没做任何操作，只是把东西放进了格子，尺寸不该"自己变一下"。
 *
 * ⚠️ **码是例外**（真机反馈 2026-09-23 第 8 条：「单元格内的二维码、条形码……会超出单元格的限制」）：
 * 二维码/条形码是**正方形/长条**，若让它的高度"由内容决定"，它就会跟着**格宽**长
 * （width:100% ⇒ 高 = 宽），一个 40mm 宽的格子会得到一个 40mm 高的码，把整行撑高。
 * 所以码给一个**默认高度**（18mm ≈ 常见的打印码尺寸），配合"等比缩放到框内"就不会溢出，
 * 用户想要更大/更小再去面板里改「高」。
 */
export const CELL_CHILD_CODE_H_MM = 18

/**
 * ⚠️ 2026-09-24 第四批第 3 / 5 条修正：码的 `w` **不再写死 100**。
 *
 * 原来不管格子多宽都给 `w: 100`（占满格宽），而码本体只有 18mm 宽 ⇒ 外层盒子的绿框
 * （`.bp-el-cell__child` 的 `outline`）比码大一大圈。用户原话是
 * 「条形码和二维码会多一圈绿色的框，没有完全贴合自身」，
 * 而视觉上它也像「二维码显示不全」—— 框铺满整格、码缩在左边一小块。
 *
 * 现在按 `18 / 格宽` 反算百分比：**框贴着码走**。
 * 没传 `cellWidthMm` 时仍退回 100（老调用与单测不受影响）。
 */
export function normalizeChildInCell<T extends AnyElement>(
  child: T,
  cellWidthMm?: number,
  /**
   * 这一格的**行高**（mm，可选）。
   *
   * ⚠️ 2026-10-13 用户口径：「**两者取小**（既不超过格宽、也不超过行高）」——
   *   从画布拖进格子的元素要按这个规则自动缩放。
   * ⚠️ **为什么是可选的**：行高可能是**自适应**的（`TableRow.heightMm` 缺席 ⇒ 由内容撑开）
   *   ⇒ 那种格子**没有分母**，只能退回"按格宽"那一档。这不是偷懒，
   *   而是"自适应行高"与"元素不超出格子"在语义上**循环依赖**（元素多高 → 行多高 → 元素该多高）。
   * ⚠️ 留 `2mm` 余量给单元格的上下内边距（`y` 会往里推）——
   *   否则元素顶着行高算出来的尺寸，加上内边距就又溢出了。
   */
  cellHeightMm?: number,
): T {
  /*
   * ⚠️ **四种元素一视同仁**（2026-09-24 第四批 ④）。
   *
   * 用户口径：「二维码、条形码、图片、附件，放入单元格后，**默认按照单元格的尺寸等比适应，
   * 不把单元格撑变形**」。原来只有码拿到默认高，图片 / 附件是 `h: 'auto'` ——
   * 而在格内"由内容决定"等于**把行撑到原图那么高**，正是"表格被撑变形"的来源。
   *
   * ⇒ 统一成：
   *   · `h` = `CELL_CHILD_DEFAULT_H_MM`（18mm，四种一致 ⇒ 行高一致）
   *   · `w` = 按 `默认高 / 格宽` 反算的百分比（方形元素框贴着内容；非方形由 `contain` 兜）
   *   · `fit` 保持元素自己的取值（默认 `contain` = 等比、不拉伸）
   */
  /*
   * ⚠️ **两者取小**（用户口径）：高度上限 = `min(默认 18mm, 单元格内容区高)`；
   * 宽度则由"这个高度 / 格宽"反算成百分比。内容区高不可知（自适应行）时只有默认值这一档。
   *
   * ⚠️ **这里收的是"内容区高"，不是行高**（2026-10-17 修正）：
   *   `row.heightMm` 是 **border box 总高**（含上下内边距），而格内元素画在**内容区**里。
   *   原来传行高再 `− 2mm` 当余量，只是"差不多"；内边距一改（1.5 / 3 / 0）就不准，
   *   元素会**压在单元格边框上**（用户原话："不会根据单元格当前的高度自动压缩嵌入，
   *   反而是压在单元格之上"）。现在由调用方用 `cellContentHeightMm()` 算好再传。
   */
  const boxH =
    typeof cellHeightMm === 'number' && cellHeightMm > 0
      ? Math.max(4, Math.min(CELL_CHILD_DEFAULT_H_MM, cellHeightMm))
      : CELL_CHILD_DEFAULT_H_MM
  const pct =
    typeof cellWidthMm === 'number' && cellWidthMm > 0
      ? Math.max(MIN_CELL_CHILD_PCT, Math.min(100, (boxH / cellWidthMm) * 100))
      : 100
  /*
   * ⚠️ **必须清掉 `cellPos`**（2026-10-13 用户报的 bug）：
   *   「将该元素从画布中拖回单元格内后，该元素**不会出现在单元格内，而是出现在画布中**，
   *    但**样式依旧是单元格内元素的样式**」。
   *
   * 根因：`cellPos` 是"格内偏移"，**只在格内有意义**。上一版进/出格子都没动它 ⇒
   * 元素出去时带着旧偏移（自由层不读它，所以看不出来）⇒ **再进格子时那个旧偏移复活** ⇒
   * 被绝对定位到格子外面 ⇒ 看起来"跑到画布上了"，而 `w`/`h` 已被本函数换成格内口径
   * ⇒ **"位置在画布、样式是格内"**，正是用户描述的那个诡异状态。
   * ⇒ 进/出格子都**归零**：进格子 = 从左上角开始（新的流式/定位起点），
   *   出格子 = 位置由画布自由层接管（`x`/`y` 那套）。
   */
  return { ...child, w: round1(pct), h: round1(boxH), cellPos: undefined }
}

/**
 * **出格子**：把格内子元素换回自由层。
 *
 * `w` 从百分比换算成 mm（`cellWidthMm * pct / 100`）—— 这样"取出到画布"后
 * 它在纸上的**视觉宽度与在格子里一致**，不会突然变成 100% 版心宽。
 * `h` 保持原值：`'auto'` 在自由层同样是"高度由内容决定"，是合法的自由层取值。
 */
export function normalizeChildOutOfCell<T extends AnyElement>(child: T, cellWidthMm: number): T {
  const pct = childWidthPct(child)
  const w = Math.max(2, round1((Number.isFinite(cellWidthMm) && cellWidthMm > 0 ? cellWidthMm : 20) * pct / 100))
  /* ⚠️ `cellPos` 必须清掉 —— 那是"格内偏移"，出了格子就是脏数据（见 `normalizeChildInCell` 的注释）。 */
  return { ...child, w, x: 0, y: 0, cellPos: undefined }
}
