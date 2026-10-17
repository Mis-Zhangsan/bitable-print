/**
 * 表格 span 模型的**摊平**（`rows × cols` 网格）—— 全项目唯一一份。
 *
 * ## 为什么在 `lib/`
 *
 * 它原来住在 `components/editor/table-query.ts`（编辑器层）。2026-10-17 渲染层也要用它：
 * 表格被分页拆成片段时，第二个片段的第一行可能**落在某个 `rowspan` 的中间** ——
 * 那一行的 `cells` 数组里没有那个格（span 模型：被覆盖的格不在数组里），
 * 于是片段里这一行会**少一个 `<td>`** ⇒ 后面的内容整体左移、右边框也缺一条
 * （用户 2026-10-17 的截图："有合并的单元格，打印时格内内容会错位，表格边框也不打印"）。
 *
 * 渲染端要修这件事，就必须能把 `rows` 摊平成网格、看出"哪一列是被上面的格盖住的"。
 * 而 `render/` **不能依赖 `components/`**（那是 UI 层，会把 React 拖进来、Node 自测跑不了）。
 * ⇒ 下沉到这里：`lib/types.ts` 之外零依赖，两边都能用。
 *
 * `components/editor/table-query.ts` 与 `table-actions.ts` 都改成 re-export，老引用一行不动。
 */

import { finite, type TableCell, type TableRow } from './types'

/** 网格里的一格：指向真实的单元格对象，外加它在网格中的位置 */
export interface GridCell {
  cell: TableCell
  /** 网格列起点（0-based） */
  colStart: number
  colSpan: number
  /** 网格行起点 */
  rowStart: number
  rowSpan: number
}

/**
 * 把 span 模型摊平成 `rows × cols` 的网格。
 *
 * `grid[r][c]` = 覆盖这一格的单元格（**同一个对象**会在它覆盖的每格出现 —— 靠引用相等判重）；
 * `null` = 这一格是空的、需要补一个 `emptyCell()`。
 *
 * ⚠️ 传入的 `rows` 决定了返回的 `cell` 引用：**要就地改就得传副本**
 *    （所以调用方一律 `cloneRows` 之后再摊平，否则会改到原始文档对象）。
 */
export function tableGrid(rows: readonly TableRow[], colCount: number): (GridCell | null)[][] {
  const n = Math.max(0, Math.floor(colCount))
  const grid: (GridCell | null)[][] = rows.map(() => Array.from({ length: n }, () => null))
  for (let r = 0; r < rows.length; r += 1) {
    let col = 0
    for (const cell of rows[r].cells) {
      // 跳过已经被**上方 rowspan** 占住的列
      while (col < n && grid[r][col]) col += 1
      if (col >= n) break
      const colSpan = Math.max(1, finite(cell.colspan, 1))
      const rowSpan = Math.max(1, finite(cell.rowspan, 1))
      const gc: GridCell = { cell, colStart: col, colSpan, rowStart: r, rowSpan }
      for (let rr = r; rr < Math.min(rows.length, r + rowSpan); rr += 1) {
        for (let k = 0; k < colSpan && col + k < n; k += 1) grid[rr][col + k] = gc
      }
      col += colSpan
    }
  }
  return grid
}
