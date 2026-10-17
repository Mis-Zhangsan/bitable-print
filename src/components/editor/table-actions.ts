/**
 * 表格动作层：合并 / 拆分 / 行列增删 / 列宽 / 行高。
 *
 * 也收一个**读取侧**的换算 `colEdgeFrac`（列宽数组 → 列边界占比）：它读的正是
 * `setColWidthPatch` 写的那个 `colWidthsMm`，读写方同处一文件，将来改列宽语义
 * （最小列宽钳制 / 列宽和与总宽的关系）时不会漏掉另一头 —— 理由详见该函数自己的注释。
 *
 * ## 为什么要有这个文件
 *
 * 这些动作原来**各自关在组件闭包里**：
 *   - `Inspector.tsx` 的 `TableAttrs` 里：`addRow` / `delRow` / `addCol` / `delCol` / `setColWidth`
 *   - `Inspector.tsx` 的 `CellPanel` 里：`mergeRight` / `mergeDown` / `splitCell` / `patchCell`
 *
 * 顶栏的表格工具条与 `CellPanel` 是**兄弟组件**，够不到那两处闭包。B 批要在工具条上
 * 再给一套合并 / 拆分 / 边框线，如果不先提升，**顺手就会各写一份** —— 这个项目在
 * "同一个逻辑两处各写一套"上已经栽过三次。
 *
 * 所以这里把动作提成**纯函数**：输入 `TableElement` + 定位，输出 `Partial<TableElement>`
 * 的补丁，由调用方 `api.mergeElement(el.id, patch, mergeKey)` 写回。
 *
 * ## 两条硬约束
 *
 * 1. **本文件的运行时依赖只有 `src/lib/types.ts`、`./round.ts` 与 `./table-query.ts`**
 *    （后两者同样只依赖类型 / 纯函数）。它要能被 Node 直接加载 —— `__selftest.mts` 就是跑在 Node 下的；
 *    一旦这里 import 了 React / `.tsx`，Node 层就再也跑不起来。
 *    **不要**为了一个数据表去 import `./useEditorState`（1301 行 hooks 模块）。
 *    `findCell` / `updateCell` 走 `./table-query`：一份实现，两个调用方（本文件与 `useEditorState`），
 *    而不是各自扫一遍 `rows`。
 *    `round1` 走 `./round`：收口前项目里有 5 份副本、且不是同一种行为，详见 `round.ts` 的文件头。
 *
 * 2. **确认层在动作里，不在调用方**。合并会**整个丢掉**被并进来的那个单元格
 *    （连同它的字段绑定），拆分补回来的是空单元格 —— 这是修过的真实数据丢失缺陷。
 *    `applyMergeRight` / `applyMergeDown` 强制接收一个 `decide` 回调：
 *    被丢弃的单元格非空时**必须**先问过它，返回 false 就整体不产生补丁。
 *
 *    这样"工具条绕过确认层"在结构上就做不到 —— 不是靠调用方自觉。
 */

import {
  DEFAULT_CELL_PADDING_MM,
  finite,
  newId,
  type InlineNode,
  type SysVarKey,
  type AnyElement,
  type CellBorders,
  type TableBorderStyle,
  type TableCell,
  type TableElement,
  type TableRow,
  type TextStyle,
} from '../../lib/types'
import { round1 } from './round'
import { findCell, tableGrid, updateCell, type GridCell } from './table-query'

/*
 * `tableGrid` / `GridCell` 的实现住在 `./table-query`（见那里 `findCell` 也要算网格列号），
 * 这里转出去：本文件内部照样用，`__selftest.mts` 里的 `A.tableGrid(...)` 也照旧。
 */
export { tableGrid } from './table-query'
export type { GridCell } from './table-query'
import { childHeightMm, childOffsetXPct, childOffsetYMm, childWidthPct } from '../../lib/cell-geometry'

/**
 * 这一层要写回的补丁。
 *
 * 刻意不是 `TableElement`：动作只该改它自己那几项，写成整个元素会把调用方
 * 手里那份可能已经过期的 `element` 整个盖上去（把别人刚改的字段冲掉）。
 */
export interface TableActionResult {
  patch: Partial<TableElement>
  /** 动作结束后建议选中的单元格（合并后是留下的那一格）；undefined = 保持当前选中 */
  nextCellId?: string
}

/** 一次动作的"要不要做"决策：`discarded` 非空时被调用；返回 false = 取消 */
export type MergeDecision = (discarded: DiscardedPart[]) => boolean

/**
 * 被合并**丢掉**的那个单元格里有什么。
 *
 * 刻意返回**结构**而不是中文串（原实现返回 `['字段「产品名称」']` 这种给人看的串）：
 *   - 断言中文串等于断言文案，改一个字测试就红，而那**不是行为**；
 *   - 拼中文字面量要用 `SYSVAR_LABEL`，那会把 1301 行的 hooks 模块拖进 Node 套件。
 *
 * 所以：**"丢了什么"是结构（这里），"怎么说"是文案（`discardedPartsText`）**，各有一条断言守着。
 */
export type DiscardedPart =
  /** `fieldName` 为 null = 未绑定字段的占位符（打印时会输出空白，更要拦） */
  | { kind: 'field'; fieldName: string | null }
  | { kind: 'sysvar'; key: SysVarKey }
  | { kind: 'text'; text: string }
  /**
   * 多出来的**图片单元格**（2026-09-22 加）。
   *
   * 一格只装得下一个 `attachment`（它的打印配置是单份的）⇒ 矩形选区合并时，
   * 除锚点那格以外的图片会被丢掉。文本可以按换行拼进去、图片不行 —— 所以它是
   * "合并保留文本"之后**唯一仍然会丢东西**的一类，必须能进确认层。
   */
  | { kind: 'attachment'; count: number }

/**
 * 只算"有内容"的节点：空白单元格被并掉是正常操作，拦下来只会变成无谓的摩擦。
 * 字段占位符是最贵的一种内容 —— 用户得重新找字段、重新配一遍。
 */
export function discardedPartsOf(cell: TableCell): DiscardedPart[] {
  const out: DiscardedPart[] = []
  for (const n of cell.nodes) {
    if (n.type === 'field') out.push({ kind: 'field', fieldName: n.fieldName ? n.fieldName : null })
    else if (n.type === 'sysvar') out.push({ kind: 'sysvar', key: n.key })
    else if (n.type === 'text' && n.text.trim() !== '') out.push({ kind: 'text', text: n.text.trim() })
  }
  return out
}

/** 结构里是不是"有东西"（决定要不要弹确认） */
export function hasDiscardedContent(parts: DiscardedPart[]): boolean {
  return parts.length > 0
}

/**
 * 结构 → 用户看到的那句话。
 *
 * **文案与以前逐字一致**（用户已经看过那句话，改措辞就是行为变化、不是重构）：
 *   `字段「产品名称」` / `一个未绑定的字段占位符` / `「页码」` / `「合计」`
 *   超过 3 项时只列前 3 项 + `等 N 处内容`。
 *
 * 系统变量的标签由调用方注入（浏览器侧传 `SYSVAR_LABEL`），
 * 所以本文件仍然不需要知道标签表长什么样、也不必 import 它。
 */
export function discardedPartsText(parts: DiscardedPart[], sysvarLabel: (key: SysVarKey) => string): string[] {
  const out = parts.map((p) => {
    if (p.kind === 'field') return p.fieldName ? `字段「${p.fieldName}」` : '一个未绑定的字段占位符'
    if (p.kind === 'sysvar') return `「${sysvarLabel(p.key)}」`
    if (p.kind === 'attachment') return `${p.count} 个图片单元格`
    return `「${p.text}」`
  })
  // 一格堆了太多东西时只列前三个，剩下的用数量带过 —— 提示要说人话，不是把内容倒出来
  if (out.length > 3) return [...out.slice(0, 3), `等 ${out.length} 处内容`]
  return out
}

// ============================================================
// 基础
// ============================================================

/** 空白单元格（增列 / 拆分会用到）。整表面板与单元格面板共用同一份形状 */
export function emptyCell(): TableCell {
  return { id: newId('cell'), colspan: 1, rowspan: 1, nodes: [] }
}

/**
 * 去掉「表头那三项」：`bold` / `align` / `background`。
 *
 * 用于**标题格被拆到非标题行**的情形（2026-10-17 用户报：
 * 「随着合并、拆分的进行，标题行的样式（加粗、灰底）会散乱到表格之中」）。
 *
 * 只删这三项 —— 它们正是 `setHeaderStylePatch` 写进去的那组；字体 / 字号 / 字色与
 * "是不是表头"无关，一律保留（用户可能已经调过）。
 */
function stripHeaderStyle(s: TextStyle | undefined): TextStyle | undefined {
  if (!s) return undefined
  const rest: TextStyle = { ...s }
  delete rest.bold
  delete rest.align
  delete rest.background
  return rest
}

/**
 * 按 `headerCol` 这一位**重刷第一列的标题样式** —— 列结构变动后的**唯一收口**。
 *
 * ## 为什么必须有它
 *
 * `headerCol` 是"**第 0 列**是标题列"这个**列位**标记，而标题的视觉（加粗/居中/灰底）
 * 是逐格快照。列结构一动，"谁是第 0 列"就变了，快照必然错位。用户实测（2026-10-17）：
 *
 *   · 第一列拆 1×2 ⇒ `insertColAt` 给**每一行**补列、新格继承左邻（第 0 列）⇒
 *     **拆出来的第 1 列整列都是灰底加粗**（不止拆到的那一行）；
 *   · 在最左边插一列 ⇒ 原第一列变成第 1 列，但它的灰底**留着** ⇒ 两列都像标题列；
 *   · 删除第一列 ⇒ 新的第一列**不带**标题样式，可 `headerCol` 还是 true ⇒ 标记与视觉脱节。
 *
 * 所以"插列 / 删列 / 拆分补列 / 取消合并补格"之后都要过一遍这里：
 *   第 0 列 ⇒ 补上三项（底纹沿用格子已有色）；
 *   其余列 ⇒ 清掉三项（**但 `isHeader` 行的格归行表头管，不碰**）。
 *
 * ⚠️ 只处理"样式"，不改 `headerCol` 这个位 —— 位由 `setHeaderColPatch` 唯一负责。
 * ⚠️ 代价：用户如果手动把某格涂成 `#f2f3f5` 又碰巧改了列结构，会被当成标题样式清掉。
 *    这个色本来就是表头专用灰，且只在结构变动时发生，接受。
 */
function restyleHeaderColRows(headerCol: boolean | undefined, rows: TableRow[], colCount: number): TableRow[] {
  if (headerCol !== true || colCount <= 0) return rows
  const grid = tableGrid(rows, colCount)
  return rows.map((row, r) => ({
    ...row,
    cells: row.cells.map((c) => {
      /* 用对象引用定位（同一行里可能被 rowspan 覆盖过，`grid` 里指向同一对象） */
      const g = (grid[r] ?? []).find((x) => x?.cell === c)
      if (!g) return c
      if (g.colStart === 0) {
        if (c.style?.bold === true && c.style?.align === 'center' && c.style?.background) return c
        return {
          ...c,
          style: {
            ...c.style,
            bold: true,
            align: 'center' as const,
            background: c.style?.background ?? '#f2f3f5',
          },
        }
      }
      /* 行表头的格由 `isHeader` 管，列这边不要抢 */
      if (row.isHeader === true) return c
      if (c.style?.bold !== true && c.style?.background !== '#f2f3f5') return c
      const stripped = stripHeaderStyle(c.style)
      return { ...c, style: stripped && Object.keys(stripped).length > 0 ? stripped : undefined }
    }),
  }))
}

/**
 * 深拷贝到"可以就地改"的层级。
 *
 * 只拷 `rows` / `cells` 两层：行内 `nodes` 是只读的（合并只搬 `colspan` / `rowspan`，
 * 不动节点），深拷它会白白重建一堆对象，还让 `nodes` 的引用相等性失效
 * （Canvas 与 Inspector 都靠引用相等判断"这一格没变"）。
 */
function cloneRows(rows: TableRow[]): TableRow[] {
  return rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) }))
}

function cols(el: TableElement): number {
  return el.colWidthsMm.length
}

// ============================================================
// 合并 / 拆分
// ============================================================

interface MergeRightHit {
  rowIdx: number
  aId: string
  bId: string
}

/**
 * 「能不能右合并」的**唯一判据** —— 动作层与工具条可用性共用（与 `mergeDownHit` 对称）。
 *
 * ⚠️ **标题列的第一列不许向右合并**（2026-10-17）：合并块会以第 0 列为起点、`colspan` 扩到
 * 第 2 列，于是标题列的灰底加粗**视觉上盖到普通列**。列不像行那样有"跨页重复"，
 * 但"标题列只有第 1 列"这个结构位同样不能被一个跨界的合并块打穿。
 */
export function mergeRightHit(el: TableElement, cellId: string): MergeRightHit | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const row = el.rows[loc.rowIdx]
  const a = row?.cells[loc.colIdx]
  const b = row?.cells[loc.colIdx + 1]
  if (!row || !a || !b) return null
  if (el.headerCol === true) {
    const grid = tableGrid(el.rows, cols(el))
    const aPos = (grid[loc.rowIdx] ?? []).find((g) => g?.cell.id === a.id)
    if (aPos && aPos.colStart === 0) return null
  }
  return { rowIdx: loc.rowIdx, aId: a.id, bId: b.id }
}

/** 右合并按钮/菜单项是否可点（`mergeRightHit` 的薄封装，口径完全相同） */
export function canMergeRight(el: TableElement, cellId: string): boolean {
  return mergeRightHit(el, cellId) !== null
}

/**
 * 右合并。`decide` 只在**被并掉的那一格非空**时被调用；它返回 false 就整体不产生补丁。
 *
 * 为什么必须经过 `decide`：合并丢弃的 `nodes` 是不可恢复的（拆分补的是空单元格）。
 * 把这一步做进动作里，工具条与面板就不可能各自决定"要不要问用户"。
 *
 * 定位规则已收敛进 `mergeRightHit`（含"标题列第一列不许右合并"那条护栏），这里只负责落地。
 */
export function applyMergeRight(el: TableElement, cellId: string, decide: MergeDecision): TableActionResult | null {
  const hit = mergeRightHit(el, cellId)
  if (!hit) return null
  const rows = cloneRows(el.rows)
  const row = rows[hit.rowIdx]
  const idx = row?.cells.findIndex((c) => c.id === hit.aId) ?? -1
  const a = idx >= 0 ? row.cells[idx] : null
  const b = idx >= 0 ? row.cells[idx + 1] : null
  if (!row || !a || !b) return null
  const parts = discardedPartsOf(b)
  // ⚠️ 只在**真的会丢东西**时才问 `decide`。
  // "空单元格合并不弹确认"是原实现的行为（不给无谓摩擦），把它做成动作层的结构性保证，
  // 而不是指望每个调用方都记得"空的时候点确认要返回 true"。
  if (hasDiscardedContent(parts) && !decide(parts)) return null
  row.cells.splice(idx, 2, { ...a, colspan: Math.max(1, a.colspan) + Math.max(1, b.colspan) })
  return { patch: { rows }, nextCellId: a.id }
}

interface MergeDownHit {
  /** `a` 所在行（数组下标 = 网格行号，行不会因 rowspan 消失） */
  rowIdx: number
  /** `a` 的网格列起点 */
  colStart: number
  /** 正下方那一行的行号 */
  belowRowIdx: number
  aId: string
  bId: string
}

/**
 * 「能不能下合并」的**唯一判据** —— 动作层与工具条可用性共用。
 *
 * 为什么要单独抽出来：工具条原来用 `rows[rowIdx+1]?.cells[colIdx]` 判断"下面还有格"，
 * 与这里刚修好的网格口径**又不一致** ⇒ 会出现"按钮亮着但点下去没反应"，
 * 或者"明明能合并却灰着"。判据只准有一份。
 */
export function mergeDownHit(rows: readonly TableRow[], colCount: number, cellId: string): MergeDownHit | null {
  const grid = tableGrid(rows, colCount)
  let aPos: GridCell | null = null
  let rowIdx = -1
  for (let r = 0; r < grid.length && !aPos; r += 1) {
    for (const g of grid[r]) {
      /* `rowStart === r` ⇒ 只认**起始行**那一份，被 rowspan 覆盖的行不算 */
      if (g && g.cell.id === cellId && g.rowStart === r) {
        aPos = g
        rowIdx = r
        break
      }
    }
  }
  if (!aPos) return null
  const aCs = Math.max(1, aPos.colSpan)
  const belowRowIdx = rowIdx + Math.max(1, aPos.rowSpan)
  if (belowRowIdx >= rows.length) return null
  /*
   * ⚠️ 不许跨「表头行 / 数据行」的边界（2026-10-17）。
   *
   * 表头的语义是"打印多行数据时**每页重复**"，而打印层按 `isHeader` 连续行切分
   * （`render/html.ts` 的 `tableHeaderRowCount`）。真让一格跨在边界上，那一格
   * 一半属于表头、一半属于数据体 —— 跨页重复时必然错位，而且是"看起来像样式散乱"
   * 的那种错（灰底跑到数据区）。宁可在这一层就不让做。
   */
  if ((rows[rowIdx]?.isHeader === true) !== (rows[belowRowIdx]?.isHeader === true)) return null
  const bPos =
    (grid[belowRowIdx] ?? []).find(
      (g) => g && g.colStart === aPos!.colStart && g.rowStart === belowRowIdx && g.cell.id !== cellId,
    ) ?? null
  /* `colspan` 不一致 ⇒ 拼出来不是矩形，合并会破坏网格 */
  if (!bPos || Math.max(1, bPos.colSpan) !== aCs) return null
  return { rowIdx, colStart: aPos.colStart, belowRowIdx, aId: aPos.cell.id, bId: bPos.cell.id }
}

/** 下合并按钮/菜单项是否可点（`mergeDownHit` 的薄封装，口径完全相同） */
export function canMergeDown(el: TableElement, cellId: string): boolean {
  return mergeDownHit(el.rows, cols(el), cellId) !== null
}

/**
 * 下合并。与 `applyMergeRight` 同一套确认口径。
 *
 * ⚠️⚠️ **2026-10-17 修：正下方必须按"网格列"找，不能按数组下标**
 *
 * 旧写法 `b = rows[loc.rowIdx + 1]?.cells[loc.colIdx]` 里的 `colIdx` 是
 * `findCell` 给的**数组下标**。span 模型下数组下标 ≠ 网格列号：
 * 只要上方有 `rowspan` 跨下来，那一行的 `cells` 就会**少几个元素**，下标整体左移。
 *
 * 用户实测场景（3×3 把中间整列合并成一格）：
 *   第一次合并后 行1 = `[c_1_0, c_1_2]`（`c_1_1` 已被吃掉）。
 *   第二次对同一个 `c_0_1` 下合并：`loc.colIdx` 仍是 1 ⇒ 取到 `cells[1]` = **`c_1_2`**，
 *   而 3 列里正下方应该是网格列 1（此时已经是 `c_1_2` 所在的列 2）。
 *   ⇒ 把 **`c_1_2` 吞掉**、`rowspan` 却 +1 ⇒ 行1 只剩 `[c_1_0]`，
 *     表格右侧凭空塌掉一块（用户看到"最右侧那个大的单元格点不中"，就是它没了）。
 *
 * 定位规则已收敛进 `mergeDownHit`（工具条判可用性也用它），这里只负责在副本上落地。
 */
export function applyMergeDown(el: TableElement, cellId: string, decide: MergeDecision): TableActionResult | null {
  const hit = mergeDownHit(el.rows, cols(el), cellId)
  if (!hit) return null
  const rows = cloneRows(el.rows)
  const a = rows[hit.rowIdx]?.cells.find((c) => c.id === hit.aId) ?? null
  const belowRow = rows[hit.belowRowIdx]
  const bIdx = belowRow?.cells.findIndex((c) => c.id === hit.bId) ?? -1
  const b = bIdx >= 0 ? belowRow.cells[bIdx] : null
  if (!a || !b) return null

  const parts = discardedPartsOf(b)
  if (hasDiscardedContent(parts) && !decide(parts)) return null
  a.rowspan = Math.max(1, finite(a.rowspan, 1)) + Math.max(1, finite(b.rowspan, 1))
  belowRow.cells.splice(bIdx, 1)
  // 下合并后留下的还是原来那一格，选中不需要变 —— 与原实现一致
  return { patch: { rows } }
}

/** 拆分能不能点（跨列 / 跨行任一 > 1） */
export function canSplitCell(el: TableElement, cellId: string): boolean {
  const loc = findCell(el.rows, cellId)
  if (!loc) return false
  return Math.max(1, finite(loc.cell.colspan, 1)) > 1 || Math.max(1, finite(loc.cell.rowspan, 1)) > 1
}

/**
 * 拆分。补回来的是**空单元格** —— 这就是合并会丢内容的原因，也是确认层存在的理由。
 *
 * ⚠️⚠️ **2026-10-17 修：补格位置必须按"网格列"算，不能按数组下标**
 *
 * 旧写法给下方行补格用的是 `splice(loc.colIdx + k, 0, ...)`。`loc.colIdx` 是
 * **起始行**里的数组下标，而下方行可能被别的 `rowspan` 覆盖、数组更短，下标会偏。
 *
 * 用户场景（左上角先纵向合并再拆）：行0 列0 跨 2 行 ⇒ 行1 的 `cells` 变成
 * `[c_1_1, c_1_2]`（列 0 没有元素）。此时把 `c_1_1`（网格列 **1**）向下合并再取消合并，
 * `loc.colIdx = 0` ⇒ 在行2 的**数组开头**插格 ⇒ 行2 变成 `[新, c_2_0, c_2_2]`，
 * 整行**右移一格**、新空格跑到最左边。正确是 `[c_2_0, 新, c_2_2]`。
 *
 * 修法：先用摊平网格拿到目标格的 `colStart / rowSpan / colSpan`，
 * 再把"每行要插入的下标"**在改 span 之前**预算出来（改完 span 网格会缺列、摊不平）。
 */
export function applySplitCell(el: TableElement, cellId: string): TableActionResult | null {
  const colCount = cols(el)
  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)
  const pos = grid.flat().find((g) => g?.cell.id === cellId) ?? null
  if (!pos) return null
  const c = pos.cell
  const r0 = pos.rowStart
  const c0 = pos.colStart
  const cRs = Math.max(1, pos.rowSpan)
  const extraCols = Math.max(0, Math.max(1, pos.colSpan) - 1)
  const extraRows = Math.max(0, cRs - 1)

  /* 下方每一行"网格列 c0 的位置"对应哪个数组下标 —— 必须在复位 span 之前算 */
  const slots: { row: number; idx: number; style?: TextStyle }[] = []
  for (let r = 1; r <= extraRows; r += 1) {
    const row = rows[r0 + r]
    if (!row) break
    const rg = grid[r0 + r] ?? []
    let idx = row.cells.length
    for (let i = 0; i < row.cells.length; i += 1) {
      const g = rg.find((x) => x?.cell === row.cells[i])
      if (g && g.colStart >= c0) {
        idx = i
        break
      }
    }
    /*
     * ⚠️ 补出来的格**继承这一行自己的样式**（2026-10-17）：
     *    原来是 `emptyCell()`（无样式）⇒ 在标题行里取消合并，补回来的格变成白底普通格，
     *    表头就"缺了一块"。取插入位右边那格（没有就取左边那格）当样本 ——
     *    它就在这一行里，所以标题行拿到的是标题样式、数据行拿到的是数据样式。
     */
    const sample = row.cells[idx]?.style ?? row.cells[idx - 1]?.style
    slots.push({ row: r0 + r, idx, style: sample })
  }

  c.colspan = 1
  c.rowspan = 1
  /* 起始行：新格补在它**右边**（同行相邻，数组下标就是它的位置） */
  const idx0 = rows[r0].cells.indexOf(c)
  for (let k = 1; k <= extraCols; k += 1) {
    const fresh = emptyCell()
    /* 起始行就在 `c` 旁边 ⇒ 直接跟 `c` 一个样（标题格拆出来仍是标题格） */
    if (c.style) fresh.style = { ...c.style }
    rows[r0].cells.splice(idx0 + k, 0, fresh)
  }
  /* 下方行：每行补 `extraCols + 1` 个，落在预算好的位置 */
  for (const s of slots) {
    for (let k = 0; k <= extraCols; k += 1) {
      const fresh = emptyCell()
      if (s.style) fresh.style = { ...s.style }
      rows[s.row].cells.splice(s.idx + k, 0, fresh)
    }
  }
  /* 补格会改变列位（跨列合并被拆开）⇒ 标题列样式按新列位重刷 */
  return { patch: { rows: restyleHeaderColRows(el.headerCol, rows, colCount) } }
}

// ============================================================
// 列宽 / 行高
// ============================================================

/** 拖列边框或改列宽输入框：列宽数组与元素总宽**必须同步**（类型注释里的约束，见 E-45） */
export function setColWidthPatch(el: TableElement, colIdx: number, mm: number): Partial<TableElement> | null {
  if (colIdx < 0 || colIdx >= el.colWidthsMm.length) return null
  const next = [...el.colWidthsMm]
  next[colIdx] = mm
  return { colWidthsMm: next, w: round1(next.reduce((a, b) => a + b, 0)) }
}

/**
 * 拖**元素外框**改总宽时：按比例缩放列宽，保住「Σ 列宽 === 元素 `w`」这个不变量。
 *
 * 背景（2026-09-18 飞书真机反馈）：元素 resize 过去**只写 `w`、不同步 `colWidthsMm`**
 * —— 唯一保持二者同步的是列宽专用路径 `setColWidthPatch`。
 * 而画布把列宽写成**绝对 mm** 并配 `table-layout: fixed`，按 CSS 定宽表格算法
 * `used width = max(W, Σ列宽)` ⇒ **把蓝框缩窄，表格纹丝不动**。
 * 用户原话："把蓝色选区的宽高都缩小，发现蓝色区域是缩小了，但实际的原表格还保持不变，
 * 这个蓝色选区和实际的表格压根就不是一体的一样。"
 *
 * 打印侧本来就会按 `w` 压缩列宽（`render/html.ts` 的 `table-compressed`）⇒
 * 这条修完，画布与打印的口径也一致了。
 *
 * @param newWMm 元素的新总宽（mm）
 */
/**
 * 拖**外框的上下边**改表格总高时，**按比例缩放每一行的行高**（2026-10-14 补）。
 *
 * ⚠️ **为什么必须有它**：宽边有 `scaleColWidths`，高边**一直是空的** ——
 *   于是用户实测：「**点击表格的上下锚点拖动大小，只会改变表格外侧的蓝框大小，
 *   表格高度一点没变，只是蓝色选取框变大了**」（左右锚点正常）。
 *   根因：默认 `row.heightMm` 是空 ⇒ 行高**由内容撑** ⇒ 表格高完全不受 `el.h` 影响。
 *
 * ⚠️ **行高为"自适应"（缺席）时**：按**均分**处理 ——
 *   新总高 ÷ 行数。这样"拖高"这个动作第一次就把自适应行变成**显式行高**，
 *   之后的行高就有了"真值"，`Σ行高 === el.h` 这个不变量才能成立
 *   （与宽边"`Σ列宽 === w`"完全对称）。
 *
 * ⚠️ 尾行吸收取整误差 —— 否则 `Σ` 会比 `target` 差 0.1mm 量级，越拖越偏（同 `scaleColWidths`）。
 */
export function scaleRowHeights(el: TableElement, newHMm: number): Partial<TableElement> {
  const target = Math.max(1, round1(newHMm))
  const rows = el.rows ?? []
  if (rows.length === 0) return { h: target }
  const cur = rows.map((r) => (typeof r.heightMm === 'number' && r.heightMm > 0 ? r.heightMm : 0))
  const sum = cur.reduce((a, b) => a + b, 0)
  // 全是自适应（或全是 0）⇒ 均分
  const next =
    sum <= 0
      ? rows.map(() => round1(target / rows.length))
      : cur.map((c) => (c > 0 ? round1((c / sum) * target) : 0))
  const acc = next.reduce((a, b) => a + b, 0)
  next[next.length - 1] = round1(next[next.length - 1] + (target - acc))
  return { h: round1(next.reduce((a, b) => a + b, 0)), rows: rows.map((r, i) => ({ ...r, heightMm: next[i] })) }
}

export function scaleColWidths(el: TableElement, newWMm: number): Partial<TableElement> {
  const target = Math.max(1, round1(newWMm))
  const cur = el.colWidthsMm.map((c) => Math.max(0, c))
  const sum = cur.reduce((a, b) => a + b, 0)
  if (cur.length === 0 || sum <= 0) return { w: target }
  const scaled = cur.map((c) => round1((c / sum) * target))
  // 尾列吸收取整误差：否则 Σ 会比 target 差 0.1mm 量级，越拖越偏
  const acc = scaled.reduce((a, b) => a + b, 0)
  scaled[scaled.length - 1] = round1(scaled[scaled.length - 1] + (target - acc))
  return { w: round1(scaled.reduce((a, b) => a + b, 0)), colWidthsMm: scaled }
}

/**
 * 第 `i` 条**列边界**在表格总宽里的占比（0..1）。`i` = "这条边界左边那一列"的下标，
 * 也就是"第 `i` 列右沿"。
 *
 * 边界序列（含两端外沿）恒为 `[0, c₀, c₀+c₁, …, Σc] / Σc`：
 * 左外沿是 0（`i = -1`）、右外框是 1（`i = 列数-1`）。列表里只有第 `1..n` 条
 * —— **左外沿没有手柄**，与需求 ⑧「左外/上外不加手柄」同一口径。
 *
 * 内部竖线（`i = 0..n-2`）与最右边那条外框（`i = n-1`）共用这一份换算 ——
 * 两处各写一套的话，"拖外框"和"拖内部竖线"的落点迟早会分叉。
 *
 * ## 为什么分母是**列宽之和**，不是元素总宽 `el.w`
 *
 * 这两个量**必然**对不上，而且差得很有规律：上面 `setColWidthPatch` 写回的总宽是
 * `round1(列宽和)`（留一位小数），列宽数组自己则是两位小数。真实模板实测
 * `Σc = 150.14` 而 `el.w = 150.1`。
 *
 * 若拿 `el.w` 当分母，末边界会算成 `150.14 / 150.1 = 1.00027` —— **吃到 1 以上**，
 * 最后那根外框手柄被推到表格外一点点。那正是需求 ⑧ 要修的"竖线没落在格线上"的
 * 同一种毛病（只差半个像素，肉眼看着"偶发"）。
 *
 * 用列宽和当分母则：两端恒为 0 与 1，分数随列宽**单调**，且与 `el.w` 的取整无关。
 * 代价是"列宽和 ≠ 打印出来的实际总宽"这层信息在这里被忽略 —— 那是对的：
 * 几何误差归 `setColWidthPatch`（它负责让两者一致），这里只负责"按作者给的列宽分格子"。
 *
 * 列宽和不是正数（空数组 / 全 0 列宽）时用一个占位分母兜底，**不产生 NaN / Infinity**
 * —— 画布会把 NaN 写成 `NaN%` 的 left，那一整排手柄会静默消失。
 */
export function colEdgeFrac(colWidthsMm: readonly number[], i: number): number {
  const total = colWidthsMm.reduce((a, b) => a + b, 0) || 1
  let sum = 0
  for (let k = 0; k <= i && k < colWidthsMm.length; k += 1) sum += colWidthsMm[k]
  return sum / total
}

/**
 * 硬行高下限（mm）。**拖到这条线以下就写回 `undefined`（自适应），不是写这个值。**
 *
 * 写成"下限 6mm"是数据损失：那一行再也长不回去，内容会溢出。
 * `undefined` 才是 `TableRow.heightMm` 的第三态（见 `types.ts:355`），也是可逆的那一态。
 */
/**
 * 行高下限 = **24px**（用户规格 三："限制最小值：行高 ≥ 24px，列宽 ≥ 32px"）。
 *
 * 数值为什么是 mm：模型里行高列宽都存 mm（打印单位），而规格给的是**屏幕像素**。
 * 换算按 96dpi（CSS 标准）：24px = 24 ÷ 96 × 25.4 ≈ 6.35mm，取 6.4 留一点余量。
 * ⚠️ 改之前是 6mm（≈22.7px）—— 是一个"看着差不多"的手感值，不是任何规格要求的数。
 */
export const MIN_ROW_MM = 6.4

/**
 * 列宽下限 = **32px**（同上）≈ 8.47mm，取 8.5。
 *
 * ⚠️ 2026-09-22 之前这里是 4mm（≈15px），而且**同一个量在这个文件里还有第二个定义**
 *    （`MIN_COL_MM_TABLE`，我给 insertColAt 写的时候另开的一份）。
 *    两个常量描述同一件事 ⇒ 迟早一个改了另一个没改。现在只留这一个，画布也从这里 import。
 */
export const MIN_COL_MM = 8.5

/** 拖行边框。`mm === undefined` = 复位成自适应（双击行边框也走这里） */
export function setRowHeightPatch(el: TableElement, rowIdx: number, mm: number | undefined): Partial<TableElement> | null {
  const row = el.rows[rowIdx]
  if (!row) return null
  const rows = el.rows.map((r, i) => {
    if (i !== rowIdx) return r
    if (mm === undefined || mm < MIN_ROW_MM) {
      // 显式删掉这个键，而不是写 undefined —— JSON 序列化后两种写法不同，
      // 而"复位自适应"必须产出与从未设过行高的行**完全一样**的对象
      const { heightMm: _drop, ...rest } = r
      return rest as TableRow
    }
    return { ...r, heightMm: round1(mm) }
  })
  return addTableHeightPatch(el, rows)
}

/**
 * ⚠️ **改行高之后，把 `el.h` 同步成「行高之和」**（2026-10-14 补）。
 *
 * 用户报：「**右键菜单中修改行高、使其缩小的话，单元格是缩小了，
 *  但表格外面的蓝色选区（元素外框）不会缩小**」。
 * 根因：`setRowHeightPatch` 只改了 `rows`，**从不更新 `el.h`** ——
 *   而它在宽边是**对称地做过**的（`setColWidthPatch` 会同步 `w`）⇒ 又是"只做了一半"。
 *
 * ⚠️ **只在"所有行都有显式行高"时才同步**：有自适应行时
 *   "Σ行高"根本表达不了表格的真实高（自适应行的实际高由内容撑）⇒
 *   那种情况**不动 `el.h`**，避免把外框改成一个错的数。
 * ⚠️ 取整用 `round1`，与列宽同一口径（否则 Σ 会差 0.1mm 量级、越改越偏）。
 */
function addTableHeightPatch(el: TableElement, rows: TableRow[]): Partial<TableElement> {
  const heights = rows.map((r) => (typeof r.heightMm === 'number' && r.heightMm > 0 ? r.heightMm : null))
  if (heights.some((h) => h === null)) return { rows }
  const nums = heights.filter((h): h is number => h !== null)
  const sum = round1(nums.reduce((a, b) => a + b, 0))
  return { rows, h: sum }
}

// ============================================================
// 行列增删
// ============================================================

export function addRowPatch(el: TableElement): TableActionResult {
  const n = cols(el)
  return { patch: { rows: [...el.rows, { id: newId('row'), cells: Array.from({ length: n }, emptyCell) }] } }
}

export function delRowPatch(el: TableElement): TableActionResult | null {
  if (el.rows.length <= 1) return null
  return { patch: { rows: el.rows.slice(0, -1) } }
}

/** 上限 12 列：与原实现一致（再多在 A4 版心里已经没法看了） */
export const MAX_COLS = 12

export function addColPatch(el: TableElement): TableActionResult | null {
  const n = cols(el)
  if (n >= MAX_COLS) return null
  /*
   * ⚠️ 真机反馈（2026-09-22）：「增加列会导致整个表格尺寸扩张，改为在**不改变表格整体尺寸**的
   *    前提下增加列」。原来新列拿一个平均列宽、`w` 跟着变大 ⇒ 表格变宽，用户排好的版式随即错位。
   * ⇒ 总宽守恒：老列按 `n/(n+1)` 等比缩、新列拿 `1/(n+1)`，Σ 恒等于原来的 `w`。
   *    `w` 刻意**不写进补丁** —— 它不该变（写个同值只会多一次无意义写入）。（加行不涉及宽度，保持现状。）
   */
  const total = finite(el.w, el.colWidthsMm.reduce((a, b) => a + b, 0))
  const share = total / (n + 1)
  const shrink = n / (n + 1)
  return {
    patch: {
      colWidthsMm: [...el.colWidthsMm.map((w) => round1(finite(w, share) * shrink)), round1(share)],
      rows: el.rows.map((r) => ({ ...r, cells: [...r.cells, emptyCell()] })),
    },
  }
}

export function delColPatch(el: TableElement): TableActionResult | null {
  const n = cols(el)
  if (n <= 1) return null
  const removed = el.colWidthsMm[n - 1] ?? 0
  return {
    patch: {
      colWidthsMm: el.colWidthsMm.slice(0, -1),
      // 下限 10mm：删列时元素可以变窄，但不该窄到负值 / 0（那样画布上就点不到了）
      w: round1(Math.max(10, finite(el.w, 100) - removed)),
      rows: el.rows.map((r) => ({ ...r, cells: r.cells.length > 1 ? r.cells.slice(0, -1) : r.cells })),
    },
  }
}

// ============================================================
// 行内节点（供单元格内容编辑复用；同样保持纯）
// ============================================================

/** 就地替换某一格的全部节点（走共享的 `updateCell`，不自己再写一遍 map） */
export function setCellNodesPatch(rows: TableRow[], cellId: string, nodes: InlineNode[]): Partial<TableElement> | null {
  const next = updateCell(rows, cellId, { nodes })
  // updateCell 找不到时原样返回同一个引用 —— 靠这条契约判断"点空了"
  return next === rows ? null : { rows: next }
}

// ============================================================
// 网格摊平 + 按位置插入 / 删除行列（2026-09-22，用户规格 一·二）
// ============================================================
//
// 用户原话："直接在表格上增删行列（不进属性面板）……**关键**：增删行列时：
// 已有的合并关系、单元格内挂的子元素、行高列宽数组都要**正确平移**，不能错位或丢失。"
//
// ── 为什么必须有这一节（而不是照抄既有实现）────────────────────────
// 既有的 `addRowPatch` / `addColPatch` / `delRowPatch` / `delColPatch` 只能**在末尾**
// 追加 / 删最后一行列 —— 它们是"整表结构"面板用的。真机上"在某一行下方插入"必须支持任意位置，
// 而任意位置 + 合并关系 = 一个**二维几何问题**，凭数组下标硬推一定会在合并处错位。
//
// 本表的合并是 **span 模型**（见 `applyMergeRight/Down`）：
//   · 被合并覆盖的格子**不在数组里** —— 所以"第 i 行有 5 个 cells"不代表"第 i 行有 5 列"；
//   · 数组下标 ≠ 网格列号。⇒ 任何按列的操作都必须先摊平成网格。
// `tableGrid()` 就是那一步，且它是**只读**的：把 `(行, 列) → {cell, colStart, rowSpan…}` 算出来，
// 后面四个动作全部基于它，谁也不用再自己数列。
//
// ⚠️ 2026-10-17：实现**已下沉到 `./table-query`** —— `findCell` 也要算网格列号（面包屑用），
// 而那一层是两者共同的底层。这里保留 re-export，本文件与自测的 `A.tableGrid(...)` 照旧可用。

/** 某一行里"从这一行开始"的格子（按数组顺序），带它们的网格列起点 */
function rowEntries(grid: (GridCell | null)[][], rowIdx: number, colCount: number): GridCell[] {
  const out: GridCell[] = []
  const seen = new Set<string>()
  const row = grid[rowIdx] ?? []
  for (let c = 0; c < colCount; c += 1) {
    const g = row[c]
    if (!g || g.rowStart !== rowIdx || seen.has(g.cell.id)) continue
    seen.add(g.cell.id)
    out.push(g)
  }
  return out
}

/**
 * 某一格在纸上的**实际宽度**（mm）—— 合并单元格取跨列之和，找不到就退回整表宽。
 *
 * 为什么要有它（而不是各处自己 `colWidthsMm[colIdx]`）：
 * "这一格多宽"是**百分比 ↔ mm 换算的基准**（格内子元素的 `w` 是占格宽百分比，
 * 见 types.ts 第 ④ 条），至少有三处要用：取出到画布（EditorShell）、复制格内元素（useEditorState）、
 * 以及以后任何"把格内东西换算到纸上"的动作。`colWidthsMm[colIdx]` 那种写法在**合并单元格**
 * 上是错的（数组下标 ≠ 网格列号），而错的方式是"尺寸差一点"，不会报错。
 */
export function cellWidthMm(el: TableElement, cellId: string): number {
  const loc = findCell(el.rows, cellId)
  if (!loc) return finite(el.w, 0)
  const grid = tableGrid(el.rows, el.colWidthsMm.length)[loc.rowIdx] ?? []
  const g = grid.find((x) => x?.cell.id === cellId)
  if (!g) return finite(el.w, 0)
  const span = Math.max(1, finite(g.colSpan, 1))
  const sum = el.colWidthsMm
    .slice(g.colStart, g.colStart + span)
    .reduce((a, b) => a + finite(b, 0), 0)
  // 列宽数组缺失/全是 0 时别返回 0（那会让调用方算出 0 宽的元素）—— 退回整表宽
  return sum > 0 ? sum : finite(el.w, 0)
}

/**
 * 单元格**内容区高度**（mm）= 行高 − 上下内边距。
 *
 * ⚠️ 行高是**自适应**（`heightMm` 缺席 / ≤0）时返回 `undefined` —— 那种格子没有分母：
 * "元素多高 → 行多高 → 元素该多高"是循环依赖，只能退回按格宽那一档。
 *
 * ⚠️ 为什么单开一个函数、不直接传 `row.heightMm`：
 *   `heightMm` 是 **border box 总高**（含内边距），而格内元素是画在**内容区**里的。
 *   拿总高去约束元素 ⇒ 元素比内容区高 2×内边距 ⇒ **压在单元格边框上**
 *   （2026-10-17 用户报："附件不会根据单元格当前的高度自动压缩嵌入，反而是压在单元格之上"）。
 */
export function cellContentHeightMm(el: TableElement, cellId: string): number | undefined {
  const loc = findCell(el.rows, cellId)
  if (!loc) return undefined
  const h = loc.row?.heightMm
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return undefined
  const pad = Math.max(
    0,
    finite(loc.cell.paddingMm, finite(el.cellPaddingMm, DEFAULT_CELL_PADDING_MM)),
  )
  return Math.max(0, h - pad * 2)
}

/** 表格行列的下限：至少要留一行一列（否则表格就不存在了） */
export const MIN_TABLE_ROWS = 1
export const MIN_TABLE_COLS = 1

/**
 * 表格**行数上限**。
 *
 * 原来这个 200 是写死在 `resizeTableTo` 里的字面量，而新写的「拆分单元格」也要用同一个上限
 * ⇒ 提成常量，免得两处各写一个数、哪天只改一处（列那边本来就有 `MAX_COLS`）。
 * 200 行是"画布上还能用"的经验上限（一行按 6mm 算，200 行 = 1.2m 长的纸）。
 */
export const MAX_TABLE_ROWS = 200

/**
 * 「拆分单元格」一次最多拆成几行。
 *
 * 与 `MAX_TABLE_ROWS` 分开：那是"整表能有多长"，这是"一根格子里切几块"。
 * 用户在弹窗里手输，给 20 是够用且不会被手滑成 200 的档位（列数沿用 `MAX_COLS`）。
 */
export const MAX_SPLIT_ROWS = 20

/**
 * 在 `rowIdx` 的**上方 / 下方**插入一行。
 *
 * 平移规则（两条，缺一个就会错位）：
 *   ① 跨过插入线的竖向合并 ⇒ `rowspan + 1`（它现在多盖一行）；
 *   ② 新行**只补没被那些合并盖住的列** —— 盖住的槽位在 span 模型里本来就该"没有格子"，
 *      补了会变成"合并区域里多出一格"，渲染时表现为表格被撑歪。
 */
export function insertRowAt(el: TableElement, rowIdx: number, where: 'above' | 'below'): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const at = where === 'above' ? rowIdx : rowIdx + 1
  if (!Number.isFinite(at) || at < 0 || at > el.rows.length) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  // ① 跨线的竖向合并加一行
  for (let r = 0; r < at; r += 1) {
    for (const cell of rows[r].cells) {
      const rs = Math.max(1, finite(cell.rowspan, 1))
      if (r + rs > at) cell.rowspan = rs + 1
    }
  }

  // ② 新行：只给"没被跨线合并覆盖"的列补空格
  const covered = new Set<number>()
  for (let c = 0; c < colCount; c += 1) {
    const g = grid[at - 1]?.[c] ?? null
    if (g && g.rowStart + g.rowSpan > at) covered.add(c)
  }
  /*
   * ⚠️⚠️ **2026-10-17 修：新行要"像它所在的那一行"，不能是白底空行**
   *
   * 用户报：「表格设置了标题行之后…新增加的格子哪怕是在原来的标题行位置，
   *          也没有继承标题行的样式」。
   * 根因：新行只写了 `heightMm`，`cells` 全是 `emptyCell()`（无样式）、也没 `isHeader`。
   * ⇒ 在表头里插一行，冒出来的是一条白底普通行，把表头劈成两半：
   *   视觉上"表头断了一行"，打印时跨页重复也会漏掉它。
   *
   * 模板行取**用户操作的那一行**（`rowIdx`），行高 / `isHeader` / 单元格样式全部从它继承。
   * 样式按**网格列**取（`refGrid[c]`），不是按数组下标 —— 上方有 rowspan 时数组会短。
   */
  const refRow = rows[rowIdx] ?? rows[at - 1] ?? rows[at] ?? null
  const inheritH =
    typeof refRow?.heightMm === 'number' && refRow.heightMm > 0 ? refRow.heightMm : 10
  const newRow: TableRow = { id: newId('row'), heightMm: inheritH, cells: [] }
  if (refRow?.isHeader === true) newRow.isHeader = true
  const refGrid = grid[rowIdx] ?? []
  for (let c = 0; c < colCount; c += 1) {
    if (covered.has(c)) continue
    const fresh = emptyCell()
    const sample = refGrid[c]?.cell
    if (sample?.style) fresh.style = { ...sample.style }
    newRow.cells.push(fresh)
  }
  rows.splice(at, 0, newRow)
  return { patch: { rows }, nextCellId: newRow.cells[0]?.id }
}

/**
 * 在 `colIdx` 的**左侧 / 右侧**插入一列。
 *
 * 平移规则：
 *   ① 跨过插入线的横向合并 ⇒ `colspan + 1`；
 *   ② 其余行**补一个空单元格**，插入位置 = 该行里第一个"列起点 ≥ 插入位"的格子之前；
 *      跨线合并那一行**不补**（它自己变宽了）。
 *   ③ `colWidthsMm` 同步插入一列（取左邻列宽，缺省取 20mm），并按总和更新元素总宽 `w`
 *      —— 这是 `setColWidthPatch` 那条不变量的延续：**Σ列宽 === w**。
 */
export function insertColAt(el: TableElement, colIdx: number, where: 'left' | 'right'): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const at = where === 'left' ? colIdx : colIdx + 1
  if (!Number.isFinite(at) || at < 0 || at > colCount) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  for (let r = 0; r < rows.length; r += 1) {
    const entries = rowEntries(grid, r, colCount)
    // ① 本行里跨线的格子变宽；它覆盖了插入位 ⇒ 本行不再补空格
    let covered = false
    for (const g of entries) {
      if (g.colStart < at && g.colStart + g.colSpan > at) {
        g.cell.colspan = Math.max(1, finite(g.cell.colspan, 1)) + 1
        covered = true
      }
    }
    if (covered) continue
    /*
     * ② 还没被"从上方延伸下来的 rowspan"盖住才补。
     *    判据用摊平后的网格：插入位的左右两格任意一个属于"上面那行开始的合并" ⇒ 该槽被占。
     */
    const leftOfPos = at > 0 ? (grid[r]?.[at - 1] ?? null) : null
    const atPos = grid[r]?.[at] ?? null
    const fromAbove =
      (leftOfPos && leftOfPos.rowStart < r && leftOfPos.colStart + leftOfPos.colSpan > at) ||
      (atPos && atPos.rowStart < r && atPos.colStart < at)
    if (fromAbove) continue
    const idx = entries.findIndex((e) => e.colStart >= at)
    const insertAt = idx === -1 ? rows[r].cells.length : idx
    /*
     * 新格**继承左邻格的样式**（2026-09-23 真机反馈第 4 条：「新增加的列不会继承同行的标题行效果」）。
     *
     * 不继承的话：在标题行上插入一列，那一行的新格子是**白底普通字**，与同行的标题格明显不一致；
     * 用户得再手动设一遍（而这个"再设一遍"没有任何提示，很容易漏）。
     * 取左邻格而不是右邻格：插入点右边的格可能是被合并块盖住的位置，左边一定存在。
     */
    const neighbour = rows[r].cells[Math.max(0, insertAt - 1)]
    const freshCell = emptyCell()
    if (neighbour?.style) freshCell.style = { ...neighbour.style }
    rows[r].cells.splice(insertAt, 0, freshCell)
  }

  const widths = [...el.colWidthsMm]
  const w = where === 'left' ? (widths[Math.max(0, at - 1)] ?? 20) : (widths[at] ?? widths[widths.length - 1] ?? 20)
  widths.splice(at, 0, round1(Math.max(MIN_COL_MM, finite(w, 20))))
  /*
   * ⚠️ **总宽守恒**（真机反馈 2026-09-23 第 6 条）：「编辑单元格后，插入新列，整个表格会被横向扩张，
   *    改为插入列后**不改变原表格大小**，在此基础插入列」。
   *
   * 新列先按邻列宽度占位，再把**所有列等比缩回原来的总宽**：表格外框一动不动，
   * 只是每列窄了一点 —— 这才是"在原尺寸里塞进一列"。不这么做的话 `w` 会跟着变大，
   * 用户排好的版式立刻错位（表格还会盖住右边的元素）。
   *
   * 口径与 `addColPatch`（末尾加列）**完全一致**：两条路都插列，宽度语义必须一样。
   * 缩放**复用 `scaleColWidths`**，不在本函数里再写一遍等比 + 取整 ——
   * 那个函数还负责"把取整误差让尾列吸收"，少了这一步 `Σ列宽 === w` 这条不变量会因
   * 浮点尾差（119.99999999999999 ≠ 120）被判红（第一版就是这么红的）。
   * 只加行不涉及宽度，保持原样。
   */
  const origTotal = el.colWidthsMm.reduce((a, b) => a + finite(b, 0), 0)
  const scaled = scaleColWidths({ ...el, colWidthsMm: widths }, origTotal > 0 ? origTotal : finite(el.w, 100))
  const nextWidths = scaled.colWidthsMm ?? widths
  return {
    patch: {
      /* 插列会改变"谁是第 0 列" ⇒ 标题列的样式必须按新列位重刷（见 `restyleHeaderColRows`） */
      rows: restyleHeaderColRows(el.headerCol, rows, nextWidths.length),
      colWidthsMm: nextWidths,
      w: scaled.w ?? round1(finite(el.w, 100)),
    },
  }
}

/**
 * 删除第 `rowIdx` 行。
 *
 * 三条规则，按"数据会不会丢"分开处理：
 *   ① 上方跨进来的合并 ⇒ `rowspan - 1`；
 *   ② **从这一行开始**的纵向合并 ⇒ 内容不丢，整格下沉到下一行（`rowspan - 1`）；
 *   ③ 只属于这一行的格子（rowspan === 1 且不是②） ⇒ **丢弃**，丢弃前必须过 `decide`
 *      —— 与合并同一套口径：宁可弹一次确认，也不能静默删掉用户打的字。
 */
export function deleteRowAt(el: TableElement, rowIdx: number, decide: MergeDecision): TableActionResult | null {
  const colCount = cols(el)
  if (el.rows.length <= MIN_TABLE_ROWS) return null
  if (!Number.isFinite(rowIdx) || rowIdx < 0 || rowIdx >= el.rows.length) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  // ③ 先问：这一行里"只属于这一行"的格子会被丢掉
  const doomed: TableCell[] = []
  for (const g of rowEntries(grid, rowIdx, colCount)) {
    if (Math.max(1, finite(g.cell.rowspan, 1)) <= 1) doomed.push(g.cell)
  }
  const parts = doomed.flatMap((c) => discardedPartsOf(c))
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  // ② 从这一行开始的纵向合并：下沉到下一行
  const movers = rowEntries(grid, rowIdx, colCount)
    .filter((g) => Math.max(1, finite(g.cell.rowspan, 1)) > 1)
    .map((g) => ({ cell: g.cell, colStart: g.colStart, rowSpan: Math.max(1, finite(g.cell.rowspan, 1)) }))

  // ① 上方跨进来的合并收缩
  for (let r = 0; r < rowIdx; r += 1) {
    for (const cell of rows[r].cells) {
      const rs = Math.max(1, finite(cell.rowspan, 1))
      if (r + rs > rowIdx) cell.rowspan = rs - 1
    }
  }

  rows.splice(rowIdx, 1)

  // ②（续）把下沉的格子放进新的第 rowIdx 行，位置按列起点排
  for (const m of movers) {
    const target = rows[rowIdx]
    if (!target) break
    m.cell.rowspan = m.rowSpan - 1
    const g = tableGrid(rows, colCount)
    const entries = rowEntries(g, rowIdx, colCount)
    const idx = entries.findIndex((e) => e.colStart > m.colStart)
    target.cells.splice(idx === -1 ? target.cells.length : idx, 0, m.cell)
  }

  return { patch: { rows } }
}

/**
 * 删除第 `colIdx` 列。
 *
 * 与删行对称：
 *   ① 跨线横向合并 ⇒ `colspan - 1`；
 *   ② 从这一列开始的横向合并 ⇒ `colspan - 1`（内容保留，位置自然左移一位）；
 *   ③ 只属于这一列的格子 ⇒ 丢弃（过 `decide`）；
 *   ④ `colWidthsMm` 同步删一列并更新 `w`。
 */
export function deleteColAt(el: TableElement, colIdx: number, decide: MergeDecision): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= MIN_TABLE_COLS) return null
  if (!Number.isFinite(colIdx) || colIdx < 0 || colIdx >= colCount) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  const doomed: TableCell[] = []
  for (let r = 0; r < rows.length; r += 1) {
    for (const g of rowEntries(grid, r, colCount)) {
      const span = Math.max(1, finite(g.cell.colspan, 1))
      if (g.colStart === colIdx && span <= 1 && Math.max(1, finite(g.cell.rowspan, 1)) <= 1) doomed.push(g.cell)
    }
  }
  const parts = doomed.flatMap((c) => discardedPartsOf(c))
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  for (let r = 0; r < rows.length; r += 1) {
    for (const g of rowEntries(grid, r, colCount)) {
      const span = Math.max(1, finite(g.cell.colspan, 1))
      if (span <= 1) continue
      if (g.colStart < colIdx && g.colStart + span > colIdx) g.cell.colspan = span - 1
      else if (g.colStart === colIdx) g.cell.colspan = span - 1
    }
    rows[r].cells = rows[r].cells.filter((c) => !doomed.includes(c))
  }

  const widths = [...el.colWidthsMm]
  widths.splice(colIdx, 1)
  return {
    patch: {
      /* 删列后原来的第 1 列可能升为第 0 列 ⇒ 标题列样式跟着重刷 */
      rows: restyleHeaderColRows(el.headerCol, rows, widths.length),
      colWidthsMm: widths,
      w: round1(widths.reduce((a, b) => a + b, 0)),
    },
  }
}

// ============================================================
// 矩形选区合并 / 拆分（2026-09-22，用户规格 四·核心）
// ============================================================
//
// 用户原话："在表格内按下鼠标并拖动，形成矩形多选区域……**合并单元格**：矩形选区合并为一个大单元格；
// 被合并单元格内的文本按换行拼接保留，图片等子元素保留首个并提示用户。"
//
// ── 三个必须先想清楚的点（不然一定出错）─────────────────────────────
//
// ① **选区的边界不能切进已有的合并块**。
//    用户框选时常见的是"从某个合并格中间划过去"。若按原始矩形合并，会把那个合并块**切开** ——
//    切出来的半块既不符合他点选的东西，也毁掉了原来的合并。所以先把矩形**扩张**到覆盖所有被碰到的格。
//
// ② **扩张之后，覆盖集未必还是矩形**。
//    例：一个 2×1 的横合并格 + 它右下角一个独立格 —— 框选到横合并格的右半 + 独立格，
//    扩张后覆盖集是"上排两格 + 下排一格"，不是矩形。这时**拒绝合并并说明原因**，
//    而不是硬合并成一个奇怪的结果（本项目一贯口径：宁可说"不行"，不要产出怪东西）。
//
// ③ **文本按换行拼接**，但附件/子元素这类**装不进一格**的东西只能保留第一个，
//    并且必须走 `decide` 让用户知情 —— 与 `applyMergeRight/Down` 同一套确认口径。

/** 网格坐标（0-based，含两端） */
export interface CellRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** 把两个角点归一成"左上 / 右下"（用户可能从右下往左上拖） */
export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  }
}

/** 选区内覆盖了几格（按网格算，不是按数组长度） */
export function rangeArea(range: CellRange): number {
  return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
}

/**
 * 把矩形扩张到"不切开任何已有合并块"。
 *
 * 反复扩张直到稳定：一个合并块被碰到 ⇒ 它的完整范围并进来 ⇒ 可能又碰到别的块。
 * （实际表格里这种连锁很少超过两轮，但循环写到稳定为止才是对的 —— 写"扩张一次"是能过大多数用例、
 *   在个别布局下静默出错的写法。）
 */
export function expandRangeToWholeCells(
  rows: readonly TableRow[],
  colCount: number,
  range: CellRange,
): CellRange {
  const grid = tableGrid(rows, colCount)
  let cur = { ...range }
  for (let guard = 0; guard < 64; guard += 1) {
    let changed = false
    for (let r = cur.r1; r <= cur.r2 && r < rows.length; r += 1) {
      for (let c = cur.c1; c <= cur.c2 && c < colCount; c += 1) {
        const g = grid[r]?.[c]
        if (!g) continue
        const gr2 = Math.min(rows.length - 1, g.rowStart + g.rowSpan - 1)
        const gc2 = Math.min(colCount - 1, g.colStart + g.colSpan - 1)
        if (g.rowStart < cur.r1 || g.colStart < cur.c1 || gr2 > cur.r2 || gc2 > cur.c2) {
          cur = {
            r1: Math.min(cur.r1, g.rowStart),
            c1: Math.min(cur.c1, g.colStart),
            r2: Math.max(cur.r2, gr2),
            c2: Math.max(cur.c2, gc2),
          }
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return cur
}

/**
 * 扩张后的覆盖集**是不是一个矩形**。
 * 不是的话合并的语义就说不清（用户框出来的是 L 形），必须拒绝。
 */
export function rangeIsRectangular(rows: readonly TableRow[], colCount: number, range: CellRange): boolean {
  const grid = tableGrid(rows, colCount)
  const want = new Set<string>()
  for (let r = range.r1; r <= range.r2; r += 1) for (let c = range.c1; c <= range.c2; c += 1) want.add(`${r},${c}`)

  // 选区内碰到的每个合并块，它的**完整覆盖**必须都落在选区里
  const seen = new Set<string>()
  for (const key of want) {
    const [r, c] = key.split(',').map(Number)
    const g = grid[r]?.[c]
    if (!g || seen.has(g.cell.id)) continue
    seen.add(g.cell.id)
    for (let rr = g.rowStart; rr < g.rowStart + g.rowSpan && rr < rows.length; rr += 1) {
      for (let cc = g.colStart; cc < g.colStart + g.colSpan && cc < colCount; cc += 1) {
        if (!want.has(`${rr},${cc}`)) return false
      }
    }
  }
  return true
}

/** 把一个单元格的 nodes 收成"一段文本"的行内节点（合并时按换行拼接用） */
function nodesAsLine(cell: TableCell): InlineNode[] {
  return cell.nodes.length > 0 ? cell.nodes : []
}

/**
 * 矩形合并**为什么不能做**（`null` = 可以做）。
 *
 * 与 `mergeRange` 内部的护栏是**同一份判据** —— 工具条用它提前置灰 + 说清原因，
 * 动作层用它做最后把关。两边各写一份必然分叉（这个项目已经栽过三次）：
 * 单步合并（下/右）有 `Toolbar` 的 title 说明，矩形合并原来只有**静默 null** ——
 * 用户拖选跨过表头边界后点"合并"，界面上一点反应都没有。
 */
export function mergeRangeBlockReason(el: TableElement, rawRange: CellRange): string | null {
  const colCount = cols(el)
  if (colCount <= 0 || el.rows.length === 0) return '表格结构还不完整'
  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  if (el.headerCol === true && range.c1 === 0 && range.c2 > 0) {
    return '选区从标题列跨进了普通列 —— 合并后标题列的底纹会盖到第 2 列。请分成两次合并'
  }
  let seeHead = false
  let seePlain = false
  for (let r = range.r1; r <= range.r2 && r < el.rows.length; r += 1) {
    if (el.rows[r]?.isHeader === true) seeHead = true
    else seePlain = true
  }
  if (seeHead && seePlain) {
    return '选区跨过了「表头行 / 数据行」的分界 —— 表头要按行每页重复打印，跨界的合并会让表头错位'
  }
  return null
}

/**
 * 矩形选区 → 一个合并格。
 *
 * 保留**左上角那一格**（它的 id 不变 ⇒ 后续"选中/编辑"的锚点稳定），其余格：
 *   · 文本 / 字段 / 系统变量 ⇒ 依次拼到左上角那格后面，**格子之间插一个换行**（规格 四 原话）；
 *   · 附件配置等"一格只能留一个"的东西 ⇒ 保留第一个，其余进 `decide` 让用户确认（与合并同口径）；
 *   · 新格的 `colspan/rowspan` = 选区尺寸。
 *
 * 返回 `null` 的情况都表示"这一下不该发生"：范围非法、不是矩形、跨了表头边界、或用户取消了确认。
 */
export function mergeRange(
  el: TableElement,
  rawRange: CellRange,
  decide: MergeDecision,
): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0 || el.rows.length === 0) return null
  if (rawRange.r1 > rawRange.r2 || rawRange.c1 > rawRange.c2) return null
  if (rangeArea(rawRange) < 2) return null
  if (rawRange.r1 < 0 || rawRange.c1 < 0 || rawRange.r2 >= el.rows.length || rawRange.c2 >= colCount) return null

  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  if (!rangeIsRectangular(el.rows, colCount, range)) return null

  /*
   * ⚠️ **不许跨「表头 / 数据」的边界**（2026-10-17，与 `mergeRightHit` / `mergeDownHit` 同一底线）：
   * 表头靠"**连续的行**"或"**第 0 列**这个列位"表达，跨界的合并块会让"表头"失去边界 ——
   * 行表头会让打印的跨页重复错位，列表头会让底纹盖到普通列。
   * 选区完全落在表头内、或完全落在数据区，都照常允许。
   * 判据与工具条**共用** `mergeRangeBlockReason`（它还会给用户一句人话）。
   */
  if (mergeRangeBlockReason(el, rawRange)) return null

  const grid = tableGrid(el.rows, colCount)
  const anchor = grid[range.r1]?.[range.c1]
  if (!anchor) return null

  const rows = cloneRows(el.rows)
  // 选区内、**不是**锚点那一格的单元格（按 id 去重，因为一个合并块会在多格出现）
  const others: TableCell[] = []
  const seen = new Set<string>([anchor.cell.id])
  for (let r = range.r1; r <= range.r2; r += 1) {
    for (let c = range.c1; c <= range.c2; c += 1) {
      const g = grid[r]?.[c]
      if (!g || seen.has(g.cell.id)) continue
      seen.add(g.cell.id)
      others.push(g.cell)
    }
  }
  if (others.length === 0) return null

  /*
   * ⚠️ **文本不进 `parts`**：规格明说"被合并单元格内的文本按换行拼接保留" ⇒ 它没有丢，
   * 丢掉的是**多出来的图片单元格**（一格只装得下一个 `attachment`，锚点那格自己的留下）。
   * 把保留的东西也报成"会丢弃"，用户会为了不存在的事点一次确认。
   */
  const attachments = others.filter((c) => c.attachment).length
  const parts: DiscardedPart[] = attachments > 0 ? [{ kind: 'attachment', count: attachments }] : []
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  // 锚点格：尺寸变成选区大小 + 文本按换行拼接
  const target = rows[range.r1].cells.find((c) => c.id === anchor.cell.id)
  if (!target) return null
  const merged: InlineNode[] = [...nodesAsLine(target)]
  for (const c of others) {
    const line = nodesAsLine(c)
    if (line.length === 0) continue
    if (merged.length > 0) merged.push({ type: 'br' })
    merged.push(...line)
  }
  target.colspan = range.c2 - range.c1 + 1
  target.rowspan = range.r2 - range.r1 + 1
  target.nodes = merged

  // 其余格的 id 全部从数组里摘掉（span 模型：被覆盖的格子不该留在数组里）
  const dropIds = new Set(others.map((c) => c.id))
  const nextRows = rows.map((row, r) => {
    if (r < range.r1 || r > range.r2) return row
    return { ...row, cells: row.cells.filter((c) => !dropIds.has(c.id)) }
  })

  return { patch: { rows: nextRows }, nextCellId: target.id }
}

// ============================================================
// 选区样式（2026-09-22，用户规格 四：浮动工具条上的对齐 / 加粗 / 底纹 / 表头行）
// ============================================================

/**
 * 列出选区里**真正要改的单元格**（按 id 去重）。
 *
 * 为什么不去重不行：一个合并块会在它覆盖的每个网格位置出现 ⇒ 不去重就会对同一格写同一份 patch 好几次
 * （结果一样，但每次都会新建对象、破坏 `nodes`/`style` 的引用相等性，画布那边靠它判断"这格没变"）。
 */
export function rangeCells(el: TableElement, rawRange: CellRange): TableCell[] {
  const colCount = cols(el)
  if (colCount <= 0) return []
  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  const grid = tableGrid(el.rows, colCount)
  const out: TableCell[] = []
  const seen = new Set<string>()
  for (let r = range.r1; r <= range.r2 && r < el.rows.length; r += 1) {
    for (let c = range.c1; c <= range.c2 && c < colCount; c += 1) {
      const g = grid[r]?.[c]
      if (!g || seen.has(g.cell.id)) continue
      seen.add(g.cell.id)
      out.push(g.cell)
    }
  }
  return out
}

/**
 * 给选区批量套一层样式（对齐 / 加粗 / 底纹 / 垂直对齐 / 字色 / 行高）。
 *
 * ⚠️ `style` 是**合并**而不是替换：`{...cell.style, ...patch}` —— 直接替换会把这一格原有的
 *    字体/字号一起抹掉，用户点一下"居中"发现字全变回去了。
 * ⚠️ `undefined` 值要**能清掉**原来的设置（比如取消加粗）：所以调用方传 `{bold: undefined}`
 *    时这一项会变成显式 undefined，而 `TextStyle` 的语义正是"undefined = 用默认"。
 */
export function patchRangeStyle(
  el: TableElement,
  rawRange: CellRange,
  patch: Partial<TextStyle>,
): TableActionResult | null {
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) => (targets.has(c.id) ? { ...c, style: { ...c.style, ...patch } } : c)),
  }))
  return { patch: { rows } }
}

/**
 * 把选区内涉及的行**设为 / 取消表头行**（规格 五：整行加粗 + 居中 + 底纹，打印跨页重复）。
 *
 * 语义取"全部已是表头 ⇒ 取消，否则设为表头"（与右键菜单那一项同口径）——
 * 混合状态下一律"设为"，因为用户点它的意图通常是"我要这几行当表头"。
 */
export function setHeaderRowsPatch(el: TableElement, rawRange: CellRange, on: boolean): TableActionResult | null {
  const r = setHeaderStylePatch(el, rawRange, on)
  if (!r) return null
  const colCount = cols(el)
  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  /* 行还多两件事：`isHeader` 标记 + 打开"跨页重复" —— 打印层读的就是这两个 */
  let rows = (r.patch.rows as TableRow[]).map((row, i) =>
    i < range.r1 || i > range.r2 ? row : { ...row, isHeader: on },
  )
  /*
   * ⚠️ 取消标题行时**角格要留着**（第 1 行第 1 列）：它同属标题列，列还勾着的时候
   *    把它清成普通格，用户看到的就是"标题列还在、但左上角那格掉队了"
   *    （真机反馈 2026-09-23 第 5 条）。
   */
  if (!on && el.headerCol === true) {
    rows = rows.map((row, i) =>
      i !== 0
        ? row
        : {
            ...row,
            cells: row.cells.map((c, ci) =>
              ci !== 0
                ? c
                : { ...c, style: { ...c.style, bold: true, align: 'center' as const, background: c.style?.background ?? '#f2f3f5' } },
            ),
          },
    )
  }
  /*
   * ⚠️ **取消表头行之后按"标题列"这一位再刷一遍**（2026-10-17 补漏）：
   * `setHeaderStylePatch(on=false)` 是把选区里**所有**格的三项都清掉的，
   * 连第 0 列（标题列）的格也不放过。上面那段只补了**角格**（`i === 0`），
   * 于是「表头 3 行 + 标题列」取消表头行后，第 2、3 行的第一列会变成普通格 ——
   * 可 `headerCol` 还开着，它们本该还是标题列。
   * `restyleHeaderColRows` 正好干这件事（第 0 列补、其余列清），幂等。
   */
  rows = restyleHeaderColRows(el.headerCol, rows, colCount)
  return { patch: { ...r.patch, rows, repeatHeader: on ? true : el.repeatHeader } }
}

/**
 * 这一格是不是**标题格**（2026-09-23 真机反馈第 9 条：标题行 / 标题列里**不允许插入字段**）。
 *
 * 判据分两半，各有出处：
 *   · **行** —— `row.isHeader`（结构位；打印层也读它，用于"跨页重复表头"）；
 *   · **列** —— `el.headerCol` + **这一格确实落在第一网格列**。
 *
 * ⚠️ 列这一半原来靠**样式**反推，2026-09-23 改掉了：角格（第 1 行第 1 列）同属行与列，
 *    用样式反推会让"只勾了标题行"被读成"标题列也开着"。位标记与样式各管一件事
 *    （见 types.ts 的 `TableElement.headerCol`）。
 */
export function isHeaderCellAt(el: TableElement, cellId: string): boolean {
  const grid = tableGrid(el.rows, cols(el))
  for (let r = 0; r < el.rows.length; r += 1) {
    const g = (grid[r] ?? []).find((x) => x?.cell.id === cellId)
    if (!g) continue
    if (el.rows[r]?.isHeader === true) return true
    return el.headerCol === true && g.colStart === 0
  }
  return false
}

/** 第一列是不是标题列（面板里的开关读它）。**判据只有 `headerCol` 这一位**，不再看样式 */
export function isFirstColHeaderStyled(el: TableElement): boolean {
  return el.headerCol === true
}

/**
 * 「设置标题列」：改第一列的标题样式 + 记下 `headerCol` 这一位。
 *
 * ⚠️ 取消时**不能动角格**（第 1 行第 1 列）：它同属标题行，行还勾着的时候把它清成普通格
 * 正是真机反馈第 5 条那句「取消设置标题列，那么第一行第一个单元格就会变成普通单元格，
 * 但这个单元格是行和列共有的」。
 */
export function setHeaderColPatch(el: TableElement, on: boolean): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const grid = tableGrid(el.rows, colCount)
  const rows = cloneRows(el.rows).map((row, r) => ({
    ...row,
    cells: row.cells.map((c) => {
      const g = (grid[r] ?? []).find((x) => x?.cell.id === c.id)
      if (!g || g.colStart !== 0) return c
      /*
       * ⚠️ **取消标题列时，属于表头行的格一律不动**（2026-10-17 修）。
       * 原来只保住**角格**（`r === 0`）：于是「表头 3 行 + 标题列」取消标题列，
       * 第 2、3 行第 0 列会被清成普通格 —— 可它们明明还是表头行的一部分，
       * 用户看到的是"表头右半边还在、左边一列掉了"。
       * 判据用 `isHeader`（结构位），不是 `r === 0`。
       */
      if (!on && el.rows[r]?.isHeader === true) return c
      return {
        ...c,
        style: {
          ...c.style,
          bold: on,
          align: (on ? 'center' : 'left') as 'center' | 'left',
          background: on ? (c.style?.background ?? '#f2f3f5') : undefined,
        },
      }
    }),
  }))
  return { patch: { rows, headerCol: on } }
}

/**
 * 表头**样式**（整行/整列加粗 + 居中 + 底纹）—— 行与列**共用这一份实现**。
 *
 * ⚠️ 为什么列没有 `isHeader` 那样的标记位（2026-09-22，规格 五："任意列右键 → 设为标题列，规则同上"）：
 *    行上的 `isHeader` 不是给样式用的，而是**打印层**用来算"跨页重复表头"的（`render/html.ts` 的
 *    `headerRowCount`）。列**不存在跨页重复**这回事，加一个没人读的标记只会变成第二个真相源 ——
 *    "我明明是标题列，为什么打印不重复"这种问题就是这么长出来的。
 *    ⇒ 列的"是标题"完全由它自己的样式表达（加粗/居中/底纹），这三样跟着格子走，
 *      插列删列时天然正确（新插入的空格没有这些样式，也就不是标题列）。
 */
export function setHeaderStylePatch(el: TableElement, rawRange: CellRange, on: boolean): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) =>
      targets.has(c.id)
        ? {
            ...c,
            style: {
              ...c.style,
              bold: on,
              align: (on ? 'center' : 'left') as 'center' | 'left',
              background: on ? (c.style?.background ?? '#f2f3f5') : undefined,
            },
          }
        : c,
    ),
  }))
  return { patch: { rows } }
}

// ============================================================
// 拆分单元格（2026-09-23 真机反馈第 7 条）
// ============================================================

export type SplitCellResult = { ok: true; patch: Partial<TableElement> } | { ok: false; reason: string }

/**
 * 把某一格拆成 `wantRows × wantCols` 个格子。
 *
 * 用户原话（第 7 条）：「改为拆分单元格（点击后被选中的单元格会被拆分，会出现弹窗，提示输入几行几列）」。
 *
 * ── 语义（对齐 Word 的「拆分单元格」）──────────────────────────────────
 * 目标区域 = 从这一格开始、向下 `wantRows` 行、向右 `wantCols` 列的**矩形**，
 * 矩形里每一格都变成 1×1：
 *   · 这一格原本是合并块（如 2×2）⇒ 填 2×2 就是**取消合并**；
 *   · 这一格是普通格（1×1）⇒ 填 2×2 会先给它补 1 行 1 列，再切成 4 格。
 * 所以要求 `wantRows ≥ 当前 rowspan`、`wantCols ≥ 当前 colspan`（比它小没有意义，明确拒绝并说明原因）。
 *
 * ── 为什么直接复用 `insertRowAt` / `insertColAt` 来"补行补列" ─────────────
 * 这两个函数已经处理了**合并格跨线**（上面/左边有 rowspan/colspan 时要顺手加宽它，而不是补一个空格子
 * 把网格撑歪）以及**总宽守恒**。自己再写一遍"补一行/补一列"必然会和它们分叉，而分叉的表现是
 * "表格看着歪了"，极难归因。
 *
 * ⚠️ 结构副作用要说清（**不是 bug，是"真拆"模型下不可避免的**）：
 *    列是**整表共享**的 ⇒ 补出来的列会贯穿所有行，**别的行里那一列也会被切成多个窄列**
 *    （它们的格子和内容都在，只是被分到更窄的列里）。要避免这个只能做"嵌套子表格"，
 *    而那会让"选中 / 右键 / 行高列宽 / 面板"全部要再认一层，已明确否决。
 *    ⇒ 宽度上**只等分被拆的那一块**，区间外的列一毫米都不动，总宽严格不变
 *      （见下面 `widthsBefore` / `blockW0` 那段）。
 *
 * ── 三条护栏（宁可不做，也不做错）──────────────────────────────────
 *   ① 目标格找得到、行列数合法、且不小于它当前占的行列；
 *   ② 目标区域里**不能有别的合并格**跨进来（那是要给别人做 span 手术的情形）；
 *   ③ 目标区域里别的格子**不能有内容**（静默清掉用户打的字是这个项目最不能接受的一类缺陷）。
 * 被拒时返回 `reason`，调用方原样显示。
 */
export function splitCellToGrid(
  el: TableElement,
  cellId: string,
  wantRowsRaw: number,
  wantColsRaw: number,
): SplitCellResult {
  const wantRows = Math.floor(finite(wantRowsRaw, 1))
  const wantCols = Math.floor(finite(wantColsRaw, 1))
  if (wantRows < 1 || wantCols < 1) return { ok: false, reason: '行列数都得填 1 或更多' }
  if (wantCols > MAX_COLS) return { ok: false, reason: `一次最多拆成 ${MAX_COLS} 列` }
  if (wantRows > MAX_SPLIT_ROWS) return { ok: false, reason: `一次最多拆成 ${MAX_SPLIT_ROWS} 行` }

  const loc = findCell(el.rows, cellId)
  if (!loc) return { ok: false, reason: '找不到这一格' }
  /* 网格列起点：合并格在 `row.cells` 里的**数组下标 ≠ 网格列号**，必须摊平后取 */
  const g0 = (tableGrid(el.rows, cols(el))[loc.rowIdx] ?? []).find((x) => x?.cell.id === cellId)
  if (!g0) return { ok: false, reason: '找不到这一格的位置' }
  const r0 = loc.rowIdx
  const c0 = g0.colStart
  const cs = Math.max(1, g0.colSpan)
  const rs = Math.max(1, g0.rowSpan)
  if (wantRows < rs || wantCols < cs) {
    return { ok: false, reason: `这一格现在占 ${rs} 行 × ${cs} 列，拆不成更小的 ${wantRows} × ${wantCols}` }
  }

  /*
   * ⚠️ **2026-10-17 回退**：这里原本走"嵌套子表格"（用户选 ③），后改为 ② Word 式"真拆"。
   *   原因：嵌套让"选中/右键/行高列宽/面板"全都要**再认一层**，成本持续叠加；
   *   而 Excel 本身**没有"块内拆成 2×2"这个功能**（它的"拆分"= 取消合并）。
   *   ⇒ 恢复"真拆"（往表里插行/列），与 Word 一致。
   */

  /*
   * ① 补足行列。补在目标块的**外侧**（行补在块下方、列补在块右侧）⇒ 补出来的格子必然落在块内且是空的
   *
   * ⚠️⚠️ **补完要把"块内那几行"的行高重新均分**（2026-10-17 用户报：
   *   「拆分后表格变成 3×2，且中间增加的那一行高度也是 0 ……
   *     正常应该第一行那个单元格变成 2×2 的四个小单元格，**表格整体大小不变**」）。
   *
   * 根因：`insertRowAt` 是"**往表里插一行**" ⇒ 表格总高 = 原高 + 新行高 ⇒ **整体变高** ✅
   * ⇒ 先记下"块原本占的总高"，补完后**按 `wantRows` 均分回去**（总高不变）。
   * ⚠️ 只改 `r0 .. r0+wantRows-1` 这几行，其它行一个字都不动。
   */
  const blockH0 = (() => {
    let h = 0
    for (let i = 0; i < rs; i += 1) {
      const v = el.rows[r0 + i]?.heightMm
      h += typeof v === 'number' && v > 0 ? v : 10
    }
    return h
  })()
  /*
   * ⚠️⚠️ **补出来的行该不该算表头？**（2026-10-17 用户报：
   *   「把第一行的某个单元格拆分为两行或者两行以上后，这多出来的几行都有标题行的样式」）
   *
   * `insertRowAt` 现在会"像它参照的那一行"，而补行的参照行正是**被拆的那一行** ⇒
   * 表头行一拆，多出来的行全是表头（灰底 + `isHeader`）。
   * 但拆分的语义是"**把这个格切成几块**"，不是"新增几行表头"：
   * 用户勾了几行表头，拆完还得是几行。
   *
   * 判据取**块下方那一行**：
   *   · 它是数据行 ⇒ 补出来的行也是数据行（本次修的就是这条）；
   *   · 它是表头行（说明表头本来就有多行、这次拆分插在表头区内部）⇒ 保持表头，
   *     否则会把 `tableHeaderRowCount` 的"开头连续"打断，后面的表头行静默失效。
   */
  const belowIsHeader = el.rows[r0 + rs]?.isHeader === true
  let cur = el
  for (let i = rs; i < wantRows; i += 1) {
    const r = insertRowAt(cur, r0 + rs - 1, 'below')
    if (!r) return { ok: false, reason: '补行失败（已经到行数上限）' }
    cur = { ...cur, ...r.patch }
  }
  /* ⚠️ **均分行高**：补了行之后，把块内那几行摊成同一个高度（总和 = `blockH0`） */
  if (wantRows > rs) {
    const per = Math.max(2, round1(blockH0 / wantRows))
    cur = {
      ...cur,
      rows: cur.rows.map((row, ri) =>
        ri >= r0 && ri < r0 + wantRows ? { ...row, heightMm: per } : row,
      ),
    }
  }
  /*
   * 数据区里补出来的行：**整行**都去掉表头标记与标题样式。
   * 只清"目标区间里那几格"不够 —— `insertRowAt` 把参照行（表头）的样式复制给了新行**每一格**，
   * 区间左右两侧那些格子照样是灰底加粗。
   */
  if (wantRows > rs && !belowIsHeader) {
    cur = {
      ...cur,
      rows: cur.rows.map((row, ri) => {
        if (ri < r0 + rs || ri >= r0 + wantRows) return row
        return {
          ...row,
          isHeader: false,
          cells: row.cells.map((c) => {
            const stripped = stripHeaderStyle(c.style)
            return stripped && Object.keys(stripped).length > 0
              ? { ...c, style: stripped }
              : { ...c, style: undefined }
          }),
        }
      }),
    }
  }
  let colsAdded = false
  /*
   * ⚠️ **补列前先记下"被拆那一块原本占的宽度"**（2026-10-17 用户报：
   *   「没有被选中的单元格不受影响，整个表格的大小也不受影响」）。
   *
   * `insertColAt` 的宽度策略是**整表等比缩**（那是"插入一列"该有的语义：表格外框不动）。
   * 但拆分不一样 —— 用户要的是"**等分这个被拆分的单元格**"：
   *   只有被拆的那 1 列（或 cs 列）变窄，其余列**一毫米都不动**。
   * 整表等比缩虽然也守住了总宽，但用户看到的是"整张表每一列都微调了" ⇒ 正是"没选中的单元格也受影响"。
   *
   * ⇒ 补完列之后用 `widthsBefore` 重建列宽数组：区间 `[c0, c0 + cs)` 的总宽不变，
   *   均摊到 `[c0, c0 + wantCols)` 这 wantCols 列上；区间外的列原值照抄。
   *   `Σ列宽` 因此严格不变（`Σ === w` 这条不变量照旧成立）。
   */
  const widthsBefore = [...el.colWidthsMm]
  const blockW0 = (() => {
    let s = 0
    for (let i = c0; i < c0 + cs; i += 1) s += finite(widthsBefore[i], 0)
    return s
  })()
  for (let i = cs; i < wantCols; i += 1) {
    const r = insertColAt(cur, c0 + cs - 1, 'right')
    if (!r) return { ok: false, reason: '补列失败（已经到列数上限）' }
    cur = { ...cur, ...r.patch }
    colsAdded = true
  }

  /* ② 护栏：块内除它自己以外，不许有别的合并格、也不许有内容 */
  const grid = tableGrid(cur.rows, cols(cur))
  for (let ri = r0; ri < r0 + wantRows; ri += 1) {
    for (let ci = c0; ci < c0 + wantCols; ci += 1) {
      const g = grid[ri]?.[ci]
      if (!g) return { ok: false, reason: '这块区域超出了表格范围' }
      if (g.cell.id === loc.cell.id) continue
      if (Math.max(1, finite(g.colSpan, 1)) > 1 || Math.max(1, finite(g.rowSpan, 1)) > 1) {
        return { ok: false, reason: '这块区域里有别的合并格，请先把它们拆开' }
      }
      if (g.cell.nodes.length > 0 || (g.cell.children?.length ?? 0) > 0) {
        return { ok: false, reason: `「${cellBrief(g.cell)}」里有内容，拆下去会丢东西；请先清空它` }
      }
    }
  }

  /* ③ 重建目标矩形：每格都变成 1×1。内容留在**左上那一格**（分开放会让人分不清哪块是原文），
        样式沿用原格（标题格的加粗/底纹因此跟着走） */
  const style = loc.cell.style
  /*
   * ⚠️⚠️ **2026-10-17 修：按"网格区间"重建，不按数组下标切片**
   *
   * 旧写法是 `cut = 该行里目标块的下标` → `[...slice(0,cut), ...fresh(wantCols), ...slice(cut+wantCols)]`，
   * 它只在"目标块在这一行正好占 `wantCols` 个数组元素"时才成立。而 span 模型里：
   *   · 一个 `colspan=N` 的合并格在 `row.cells` 里**只占 1 个元素**；
   *   · 被 `rowspan` 覆盖到的第 2..N 行**根本没有这个元素**（旧写法 `cut < 0` ⇒ 整行不动）。
   *
   * 用户实测场景（3×3 把中间整列合并成一格 → 再拆 3×3）：
   *   补 2 列后第 1 行是 `[左, 目标格(colspan=3), 右]` 共 3 个元素，
   *   旧写法 `slice(1 + 3)` = `slice(4)` ⇒ **把"右"那一格误删**；
   *   第 2、3 行找不到目标格 ⇒ 一列都没补。
   *   结果 `colWidthsMm` 是 5 列、每行元素数却是 4 / 2 / 2 ⇒ 网格错位，
   *   最后一列没有 cell 对象 ⇒ **点不中**（用户报"最右侧那个大的单元格无法点击选中"）。
   *
   * 正确口径：拿补完行列后的网格，按区间 `[c0, c0 + wantCols)` 给**每个真实 cell** 定位：
   *   与区间不相交 ⇒ 保留（左边的一律在前、右边的一律在后）；
   *   与区间相交   ⇒ 丢弃（就是被拆掉的那块，以及补出来的空位）；
   *   中间插入 `wantCols` 个新格。
   * 这样"删掉几个、插入几个"与网格宽度严格一一对应，`Σ(colspan) === colWidthsMm.length` 不会被破坏。
   */
  const rows = cur.rows.map((row, ri) => {
    if (ri < r0 || ri >= r0 + wantRows) return row
    const rowGrid = grid[ri] ?? []
    /* 真实 cell → 它在网格里的起点/跨度（rowspan 覆盖行里同一 cell 会出现多次，取第一次=起始位置） */
    const pos = new Map<TableCell, { colStart: number; colSpan: number }>()
    for (const g of rowGrid) {
      if (g && !pos.has(g.cell)) pos.set(g.cell, { colStart: g.colStart, colSpan: Math.max(1, g.colSpan) })
    }
    const left: TableCell[] = []
    const right: TableCell[] = []
    for (const c of row.cells) {
      const p = pos.get(c)
      /* 网格里查不到位置（结构已不一致的极端情况）⇒ 保守留在右侧，宁可多一格也不静默丢内容 */
      if (!p) {
        right.push(c)
        continue
      }
      const overlaps = p.colStart < c0 + wantCols && p.colStart + p.colSpan > c0
      if (overlaps) continue
      if (p.colStart < c0) left.push(c)
      else right.push(c)
    }
    /*
     * ⚠️⚠️ **2026-10-17 修：新格的样式不能无脑抄"被拆的那一格"**
     *
     * 用户报：「表格设置了标题行之后，随着合并、拆分的进行，标题行的样式（加粗、灰底）
     *          会散乱到表格之中」。
     * 旧写法是 `if (style) freshCell.style = { ...style }` ⇒ 把一个**标题格**的
     * `bold + 居中 + #f2f3f5 灰底` 复制给 `wantRows × wantCols` 个新格；
     * 只要拆分跨出标题行（`wantRows` 补出来的行在数据区），灰底加粗就"漏"进数据行。
     *
     * 正确口径：**逐格按"结构位"决定**，而不是整行共用一个样式：
     *   · `rowHead`（`isHeader` 行）或 `colHead`（`headerCol` 且落在第 0 列）⇒ 一定是表头格，
     *     要有 `bold + 居中 + 底纹`（底纹沿用原格/邻居已有的色，没有才用默认灰）；
     *   · 不是表头格 ⇒ 用邻居（左优先、右兜底）的样式，并把标题三项剥掉
     *     （`stripHeaderStyle`）—— 邻居就在这一行里，所以字体/字号照样跟着走。
     */
    const rowHead = cur.rows[ri]?.isHeader === true
    const neighbourStyle = left[left.length - 1]?.style ?? right[0]?.style
    const baseStyle = neighbourStyle ?? style
    const fresh: TableCell[] = Array.from({ length: wantCols }, (_, k) => {
      const freshCell = emptyCell()
      /* 表头列只认**第一网格列**：拆出 3 列时只有落在第 0 列的那一格算表头 */
      const isHead = rowHead || (cur.headerCol === true && c0 + k === 0)
      if (isHead) {
        freshCell.style = {
          ...baseStyle,
          bold: true,
          align: 'center',
          background: baseStyle?.background ?? '#f2f3f5',
        }
      } else if (baseStyle) {
        const stripped = stripHeaderStyle(baseStyle)
        /* 剥完啥也不剩就别挂一个空对象（`style` 有值会走"显式覆盖"那条路） */
        if (stripped && Object.keys(stripped).length > 0) freshCell.style = stripped
      }
      if (ri === r0 && k === 0) {
        freshCell.nodes = [...loc.cell.nodes]
        if (loc.cell.children) freshCell.children = [...loc.cell.children]
      }
      return freshCell
    })
    return { ...row, cells: [...left, ...fresh, ...right] }
  })

  /* 补列 / 补格都会改变列位 ⇒ 标题列样式按新列位重刷（`headerCol` 是列位标记，样式得跟着走） */
  const patch: Partial<TableElement> = { rows: restyleHeaderColRows(el.headerCol, rows, cols(cur)) }
  /* 补过列才需要回写列宽（结构上已经补好了，这里只解决"宽度怎么分"） */
  if (colsAdded) {
    /*
     * 只等分"被拆那一块"：区间 `[c0, c0+wantCols)` 的总宽 = 原 `blockW0`，区间外的列原值照抄。
     * 先向下取到 0.1mm，让**尾列吸收全部取整误差** ⇒ `Σ列宽` 严格不变，不会出现负宽的尾列。
     * 极端情况 `blockW0` 小到每列不足 0.1mm ⇒ 退回 `insertColAt` 的整表等比缩（宁可微调，也不产生 0 宽列）。
     */
    const per = Math.floor((blockW0 / wantCols) * 10) / 10
    if (per > 0) {
      const tail = round1(blockW0 - per * (wantCols - 1))
      patch.colWidthsMm = [
        ...widthsBefore.slice(0, c0),
        ...Array.from({ length: wantCols }, (_, k) => (k === wantCols - 1 ? tail : per)),
        ...widthsBefore.slice(c0 + cs),
      ]
      patch.w = el.w
    } else {
      patch.colWidthsMm = cur.colWidthsMm
      patch.w = cur.w
    }
  }
  return { ok: true, patch }
}

/** 护栏文案里给"别的格子"一个短名字（那里没有行列号可用，只能拿内容当标识） */
function cellBrief(c: TableCell): string {
  const t = c.nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'field' ? `「${n.fieldName}」` : ''))
    .join('')
    .trim()
  return t.slice(0, 8) || '这一格'
}


/** 新建表格的默认列数（规格："默认 3 行 × 4 列"）。也用来反推"一格大概多宽" */
export const DEFAULT_TABLE_COLS = 4

/**
 * 新建表格时**一行大概多高**（mm）。
 *
 * 为什么是 8：默认字体 10.5pt + 1.5 倍行距 + 上下 padding 差不多就是这个量级
 * （画布上实测一行约 30px ≈ 8mm）。用它把"拖出的高度"换算成行数，
 * 换算出来的表格才不会一放上去就比用户画的框高出一大截。
 */
export const TABLE_ROW_MM = 8

/**
 * 「拖出矩形 → 自动换算行列数」（规格 一：**或**支持在画布上按住拖出矩形后按矩形宽高自动换算行列数）。
 *
 * 两条换算规则：
 *   · **列**按"单元格宽度 ≈ 版心宽 ÷ 默认列数"折算 —— 用户画的框有多宽，就放得下几列；
 *   · **行**按 `TABLE_ROW_MM` 折算。
 * 上下限与动作层一致（列 ≤ `MAX_COLS`、行 ≤ 50，至少 1×1）：
 * 拖得再小也是一个 1×1 的表格，而不是"什么都没插进去"。
 */
export function tableSizeFromRect(rectWMm: number, rectHMm: number, contentWMm: number): { rows: number; cols: number } {
  const cellW = Math.max(4, finite(contentWMm, 180) / DEFAULT_TABLE_COLS)
  const rawCols = finite(rectWMm, 0) / cellW
  const rawRows = finite(rectHMm, 0) / TABLE_ROW_MM
  /*
   * ⚠️ 返回的是 `{ rows, cols }`（行在前）—— 不只是好看：本项目的断言做的是**深比较**，
   *    `{cols, rows}` 与 `{rows, cols}` 会被判成不相等（实测：6 条断言因为这个红）。
   *    统一成"行在前"，与 `createDefaultElement({kind:'table', rows, cols})` 的写法一致。
   */
  return {
    rows: Math.max(MIN_TABLE_ROWS, Math.min(Math.round(rawRows), 50)),
    cols: Math.max(MIN_TABLE_COLS, Math.min(Math.round(rawCols), MAX_COLS)),
  }
}

// ============================================================
// 拖拽尺寸时的弱吸附（2026-09-22，用户规格 三 的可选项）
// ============================================================

/**
 * 拖行高 / 列宽时，新尺寸与**其它行列的尺寸**相差在容差内就吸上去（纯函数）。
 *
 * 规格原文："拖拽时若偏移量小于 6px，可轻微吸附到邻近行列的尺寸（可选）"。
 *
 * 三个刻意的决定：
 *   ① **只吸其它行列已有的尺寸**，不吸"5mm 整数网格" —— 后者会让"我就想要 47.3mm"变成做不到，
 *      而"和旁边那一列一样宽"才是用户真正在做的事（对齐表头与内容行）。
 *   ② 多峰时取**最近**的；距离相等取**先出现**的（表格里"先出现的"= 靠上的行/靠左的列，
 *      在视觉上更"像参照物"）。
 *   ③ 容差由调用方换算成 mm 传入（屏幕 6px ÷ 缩放 = 物理容差），本函数**只认 mm** ——
 *      与 `align-guides` 同一条纪律：判定层不出现 px。
 */
export function snapSizeToNeighbors(mm: number, neighborsMm: readonly number[], tolMm: number): number {
  if (!(tolMm > 0) || neighborsMm.length === 0) return mm
  let best: number | null = null
  let bestGap = Infinity
  for (const n of neighborsMm) {
    if (!Number.isFinite(n) || n <= 0) continue
    const gap = Math.abs(n - mm)
    if (gap <= tolMm && gap < bestGap) {
      best = n
      bestGap = gap
    }
  }
  return best ?? mm
}

// ============================================================
// 单元格单边边框（2026-09-22，用户规格 八）
// ============================================================

/** 一条边最终要不要画 */
export interface CellEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

/**
 * 把「整表 mode」与「单元格覆盖」合成**这一格四条边各画不画**（纯函数，画布与打印共用）。
 *
 * 为什么需要它：`TableBorderStyle.mode` 是**表级**的，而 `outer` / `horizontal` 的语义
 * 只有知道"这一格在表的哪个位置"才落得下来（最外那圈才画外框）。把这段几何判断放在渲染层里
 * 各写一份，画布与打印迟早对不上 —— 而"画布有、打印没有"是最难被发现的一类缺陷。
 *
 * ⚠️ `outer` 模式下，表本身的边框由 `<table>` 元素负责（见 `render/html.ts` 的 `tableBorder`），
 *    这里返回的 `true` 表示"这一格要自己画这条边"—— 只有用户**显式覆盖**成 true 时才会用到。
 */
export function resolveCellEdges(
  mode: TableBorderStyle['mode'],
  borders: CellBorders | undefined,
  at: { row: number; rows: number; col: number; cols: number },
): CellEdges {
  const lastRow = at.row === at.rows - 1
  const lastCol = at.col === at.cols - 1
  const base: CellEdges =
    mode === 'all'
      ? { top: true, right: true, bottom: true, left: true }
      : mode === 'outer'
        ? { top: at.row === 0, right: lastCol, bottom: lastRow, left: at.col === 0 }
        : mode === 'horizontal'
          ? { top: at.row === 0, right: false, bottom: true, left: false }
          : { top: false, right: false, bottom: false, left: false }
  // 覆盖：undefined = 跟随（`??` 而不是 `||` —— `false` 也是有效覆盖）
  return {
    top: borders?.top ?? base.top,
    right: borders?.right ?? base.right,
    bottom: borders?.bottom ?? base.bottom,
    left: borders?.left ?? base.left,
  }
}

/** 给选区内每一格套一层单边边框覆盖（复用 `rangeCells` 的"按 id 去重"） */
export function setCellBordersPatch(
  el: TableElement,
  rawRange: CellRange,
  patch: CellBorders,
): TableActionResult | null {
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) => (targets.has(c.id) ? { ...c, borders: { ...c.borders, ...patch } } : c)),
  }))
  return { patch: { rows } }
}

// ============================================================
// 单元格作为素材容器（2026-09-22，用户规格 六）
// ============================================================

/**
 * 单元格里最多放几个块级子元素。
 *
 * ⚠️⚠️ **2026-10-16 从 1 放宽到 8**（用户报：
 *   「一个单元格内，**附件、图片、条形码二维码不能共存，会相互替换**……
 *     一个单元格内，**可以同时容纳多个**图片、条形码、二维码、附件，**不会替换**，
 *     而是**并排显示**，用户可以**自由拖动排布**」）。
 *
 * 原注释写的是「规格：一个单元格默认放一个主元素」——
 *   那正是"新拖进去的元素把旧的顶掉"的来源（`slice(-MAX)` 会切掉最早的）。
 * ⇒ 现在放宽到 8 个（够用且不至于让面板/命中测试变得难用）。
 *
 * ⚠️ 放宽后**还有两处必须跟着改**（原来写死"只操作第 0 个"）：
 *   · `EditorShell.tsx` 的 `patchCellChild`（现在支持传 `childId`）
 *   · `detachChildFromCell`（现在支持传 `childId`）
 */
export const MAX_CELL_CHILDREN = 8

/**
 * **能作为块级子元素驻留在单元格里**的取值（唯一来源）。
 *
 * ⚠️ 这份名单有**三个消费者**：画布渲染（`renderCellChild`）、拖入判定（`resolveDrop` 的探针）、
 *    以及「拖已有的元素进格子」那条路。三处各写一份必然出现「画得出来但拖不进去」。
 * 不在名单里的（表格 / 附件块 / 分页符）放进格子只会变成一个占位说明，所以**入口就该拦住**。
 */
/*
 * ⚠️ `attach`（附件字段）在 2026-09-22 被放进来：真机反馈「表格中还是无法直接放入字段类型——附件，
 *    附件一般就是图片，应该按照图片处理，如果不是图片，则在打印的时候就只打印文件名即可」。
 *    「图片→图片、非图片→文件名」正是 `AttachmentMode = 'all'` 的语义（打印端 `layoutAttachmentGroup`）。
 */
export const CELL_BLOCK_KINDS: ReadonlyArray<AnyElement['kind']> = [
  'image',
  'qrcode',
  'barcode',
  'hline',
  'text',
  'attach',
]

/**
 * 把块级元素放进单元格。
 *
 * 规则（与 `TableCell.children` 的类型注释一一对应）：
 *   · 一格最多 `MAX_CELL_CHILDREN` 个 ⇒ 已经有一个时**替换**它，并把 `replaced` 报给调用方
 *     （调用方据此提示用户"原来那个被换掉了"——静默替换是数据丢失，必须说出来）；
 *   · 只动 `children`，**不碰 `nodes`**：格子里的说明文字与放进去的图是两件事，各留各的；
 *   · 不碰 `w`/`h`：子元素跟着格子走，不参与版式计算（否则循环区高度会被格子里的图片撑变）。
 */
export function attachChildToCell(
  el: TableElement,
  cellId: string,
  child: AnyElement,
): (TableActionResult & { replaced: boolean }) | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const existing = loc.cell.children ?? []
  /*
   * ⚠️ **满了就不加，绝不顶掉已有的**（2026-10-16 用户报："会相互替换"）。
   *   原来是 `[...existing, child].slice(-MAX)` —— 上限为 1 时**等于替换**，
   *   放宽到 8 之后这个写法仍然会在第 9 个时**悄悄吃掉第 1 个** ⇒ 必须改。
   *   `replaced` 这个返回值改为表示"已满、本次没加进去"（调用方可据此提示用户）。
   */
  const replaced = existing.length >= MAX_CELL_CHILDREN
  /*
   * ⚠️⚠️ **新元素自动避让**（2026-10-16 用户要求："并排显示，用户可以自由拖动排布"）。
   *
   * 不做这一步的话，多个子元素各自按自己的 `cellPos` 绝对定位 ⇒ **默认全叠在一起**，
   * 用户看到的就是"加进来了但只看得见一个"。
   *
   * 策略：**横排优先（紧挨着排），放不下就换行**。
   *   · 横向：`x = max(已有右边界)`；
   *   · 放不下（`x + 新宽 > 100`）⇒ `x = 0`、`y = max(已有下边界)`；
   *   · 已有元素没设过 `cellPos` ⇒ 视作 `x = 0`（老数据）。
   * ⚠️ 只在**新加**时算一次（初始摆位）；之后用户怎么拖**不再干预**。
   * ⚠️ 只有在"格子还没被手动摆过"时才避让 —— 已有元素全都没 `cellPos` 说明是"流式"数据，
   *   那种情况下第一个元素直接放 0,0（保持老观感）。
   */
  const placed = ((): AnyElement => {
    if (existing.length === 0) return child
    const wNew = childWidthPct(child)
    let maxRight = 0
    let maxBottom = 0
    for (const c of existing) {
      maxRight = Math.max(maxRight, childOffsetXPct(c) + childWidthPct(c))
      /*
       * ⚠️ **下边界要用 `childHeightMm`**（2026-10-16 修 #3）：
       *   原来写 `typeof c.h === 'number' ? c.h : 0` —— `h` 是 `'auto'`（图片/码常见）时**加 0**
       *   ⇒ `maxBottom` 偏小 ⇒ **换行后放回 y=0** ⇒ 与第一行元素**完全重叠** ✅
       *   `childHeightMm` 会正确处理 `'auto'`（与渲染端**同一口径**）。
       */
      /*
       * ⚠️ **高度给一个最小兜底 2mm**（2026-10-16 第二次修 #3）。
       *
       * 探针实测过：4 个"w=30 / h=10"的元素排得完全正确；
       *   **但 `h` 算不出来的元素**（`h: 'auto'` 的图片/码、**附件**——画布上只是占位盒、
       *   模型里常没有 `h`）会走 `?? 0` ⇒ **`maxBottom` 停在 0**
       *   ⇒ **每个换行的元素都被放回 `y = 0`** ⇒ "第四个与第三个完全重叠" ✅
       * ⇒ 兜底 2mm 之后 `maxBottom` **必然递增** ⇒ 换行不重叠。
       * ⚠️ 这里**不追求算准**（附件真实高度要单元格高，`table-actions` 里拿不到）——
       *   达到"不重叠"就够（用户随后会自己拖）。
       */
      /*
       * ⚠️ **兜底高度 2 → 10mm**（2026-10-16 第四轮）。
       *
       * 用户报："同一个格内拖入**超过四个**元素时，**从第四个开始，
       *   往后的每一个元素都会重叠到第三个元素上**"。
       *
       * 探针 + `normalizeChildInCell` 对照后确认：拖进去的元素会被归一成
       *   "**按单元格尺寸等比适应**" ⇒ **每个都很大 ⇒ 每次都在"换行"分支**；
       *   而 `y` 全靠 `maxBottom + 2` 错开 —— **2mm 相对于元素自身的高度（占位盒 ≈ 9–10mm）太小**，
       *   视觉上就是"叠在一起" ✅
       * ⇒ 兜底改 **10mm**（与格内占位盒的实际高度同量级）。
       * ⚠️ 仍**不追求算准**（附件真实高度要单元格高，这里拿不到）—— 达到"看得出是几个"就够。
       */
      maxBottom = Math.max(maxBottom, childOffsetYMm(c) + Math.max(10, childHeightMm(c) ?? 0))
    }
    const wrap = maxRight + wNew > 100 + 0.01
    const nextX = wrap ? 0 : Math.round(maxRight * 10) / 10
    const nextY = wrap ? Math.round((maxBottom + 2) * 10) / 10 : childOffsetYMm(child)
    return { ...child, cellPos: { xPct: Math.min(nextX, Math.max(0, 100 - wNew)), yMm: nextY } } as AnyElement
  })()
  const next = replaced ? existing : [...existing, placed]
  const rows = cloneRows(el.rows)
  const target = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!target) return null
  target.children = next
  return { patch: { rows }, replaced }
}

/**
 * **清空格子里的所有子元素**（2026-10-16 用户要求：
 *   「右键单元格空白处，有个**移除格内元素**的选项，**当前点击无用**，
 *     改为**点击后清空格内所有元素**」）。
 *
 * ⚠️ 与 `detachChildFromCell`（取一个、要把元素交还给调用方）不同：
 *   这里是**纯删除**，不返回元素本身。
 * ⚠️ 删空之后**把 `children` 字段整个删掉**（不留下一个空数组 ——
 *   不制造"有没有子元素"的第二种形态）。
 */
export function clearCellChildren(el: TableElement, cellId: string): TableActionResult | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  if (!loc.cell.children || loc.cell.children.length === 0) return null
  const rows = cloneRows(el.rows)
  const target = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!target) return null
  delete target.children
  return { patch: { rows } }
}

/**
 * 把单元格里的子元素**取出来**（规格："单元格内的元素可以再拖出来，回到画布自由层"）。
 *
 * 返回值里带上那个元素本身 —— 调用方要把它重新放回版式区（`addElement`），
 * 而"它是什么"只有这里知道。没有子元素时返回 `null`（= 什么都没发生，不产生空提交）。
 */
export function detachChildFromCell(
  el: TableElement,
  cellId: string,
  /**
   * ⚠️ **要取出的那一个**（2026-10-16 放宽上限后新增）。
   *   不传 ⇒ 退回"取最后一个"（**老调用点的行为逐字不变**）。
   */
  childId?: string,
): (TableActionResult & { child: AnyElement | null }) | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const existing = loc.cell.children ?? []
  if (existing.length === 0) return null
  /*
   * ⚠️⚠️ **只删"被取出的那一个"**（2026-10-16）。
   *   原来是 `const child = existing[existing.length - 1]; target.children = []`
   *     —— 上限为 1 时两者等价，**放宽后那会"取一个、丢掉整格"** ❌
   */
  const idx = childId ? existing.findIndex((c) => c.id === childId) : existing.length - 1
  if (idx < 0) return null
  const child = existing[idx] ?? null
  const rows = cloneRows(el.rows)
  const target = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!target) return null
  target.children = (target.children ?? []).filter((c) => c.id !== child?.id)
  if (target.children.length === 0) delete target.children
  return { patch: { rows }, child }
}

/**
 * 把表格调整到指定的行列数（2026-09-22，用户规格 一："添加表格时弹出默认行列数选择"）。
 *
 * ⚠️ 它不是"重建一张表"——**已存在的内容按左上角对齐保留**：
 *    加行列走 `insertRowAt` / `insertColAt`（它们已经会把合并关系、行高列宽正确平移），
 *    减行列走 `deleteRowAt` / `deleteColAt`（会把"从这一行/列开始的合并"整体下沉/左移，不丢内容），
 *    真正要丢的格子过 `decide` —— 与合并同一套口径。
 *    这样"新建时选 3×4、后来改成 8×6、再改回 2×2"都不会把已填的东西弄乱。
 *
 * 返回 `null` 表示"什么都没发生"（尺寸没变、或越界）。
 */
export function resizeTableTo(
  el: TableElement,
  rows: number,
  /** ⚠️ 名字不能叫 `cols` —— 那会**遮蔽**本模块内的 `cols()` 辅助函数（`cols(cur)` 会变成"调用一个 Number"） */
  wantColsRaw: number,
  decide: MergeDecision,
): TableActionResult | null {
  const wantRows = Math.max(MIN_TABLE_ROWS, Math.min(Math.floor(finite(rows, 1)), MAX_TABLE_ROWS))
  const wantCols = Math.max(MIN_TABLE_COLS, Math.min(Math.floor(finite(wantColsRaw, 1)), MAX_COLS))
  if (wantRows === el.rows.length && wantCols === cols(el)) return null

  let cur = el
  // 先删后加（先删可以让"从 10 列变 4 列"少几次中间态；顺序不影响结果）
  while (cols(cur) > wantCols) {
    const r = deleteColAt(cur, cols(cur) - 1, decide)
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cur.rows.length > wantRows) {
    const r = deleteRowAt(cur, cur.rows.length - 1, decide)
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cols(cur) < wantCols) {
    const r = insertColAt(cur, cols(cur) - 1, 'right')
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cur.rows.length < wantRows) {
    const r = insertRowAt(cur, cur.rows.length - 1, 'below')
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }

  /*
   * ⚠️ 返回的补丁只带**变化过的字段**：`colWidthsMm` / `w` 只在列数真的变过时才出现，
   *    否则"只改行数"也会顺手把列宽数组重写一遍（值相同但仍然是一次多余写入，
   *    而且会让调用方的 diff 判断失效）。
   */
  const patch: Partial<TableElement> = { rows: cur.rows }
  if (cols(cur) !== cols(el)) {
    patch.colWidthsMm = cur.colWidthsMm
    patch.w = cur.w
  }
  return { patch }
}
