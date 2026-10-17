/**
 * 格内子元素的**尺寸口径**（纯函数，无任何依赖）。
 *
 * 为什么单独一个文件、而不是留在 `components/editor/cell-child.ts`：
 * **渲染引擎（`render/html.ts`）也要用同一套口径**。而 `render/` 绝不能反向 import
 * `components/editor/`（那是 UI 层，还带着 doc-bands / round 这些版式区原语）——
 * 渲染引擎必须能被 Node 直接加载，反向依赖会形成循环。
 *
 * 本项目在这一点上已经栽过两次（`table-query.ts`、`cell-child.ts`），
 * 所以凡是被"画布 + 打印"两端共用的判据，一律下沉到 `lib/`。
 *
 * 口径定义见 `types.ts` 的 `TableCell.children` 第 ④ 条：
 * 格内 `w` = **占单元格内容宽度的百分比**（默认 100），`h` = 固定盒高（`'auto'` = 由内容决定），
 * `x` / `y` 在格内**无意义**。
 */

/** 占单元格宽度的百分比**下限**：再窄就看不见了，那种"拖了半天什么都没了"必须堵掉 */
export const MIN_CELL_CHILD_PCT = 10

/**
 * 子元素占单元格宽度的百分比（渲染用）。
 *
 * 容错要点：老数据（这个字段还没被当成百分比之前建的）里 `w` 是 mm 数（如 40），
 * 直接当百分比用会得到 40% —— 那还能看；但 `w` 缺失/为 0/为负时会退化成"0 宽"（看不见），
 * 所以**一律退回 100**。超过 100 的也夹回 100（格子里的东西不该横向溢出去）。
 */
export function childWidthPct(child: { w?: number | string }): number {
  const raw = typeof child.w === 'number' && Number.isFinite(child.w) ? child.w : 100
  if (raw <= 0) return 100
  return Math.max(MIN_CELL_CHILD_PCT, Math.min(100, raw))
}

/**
 * 子元素的固定高度（mm）；`h: 'auto'` 或非正数 → `null`（= 由内容决定，与自由层同一语义）。
 *
 * 有固定高度时画布/打印会给它一个**定高的盒子**（`overflow:hidden`），
 * 图片按 `fit` 适配这个盒子 —— 和自由层那张图片的行为一模一样，用户不用学第二套。
 */
export function childHeightMm(child: { h?: number | string }): number | null {
  const h = child.h
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null
  return h
}

/**
 * 子元素在格子里的**实际渲染宽度**（mm）。
 *
 * ⚠️ 这是修 2026-09-23 真机反馈第 1 / 2 条的关键：
 * 格内子元素原先拿到的 `scope.widthMm` 是**表格自己的宽度**（`render/pipeline.ts` 的
 * `scopeOfRecord` 给的是 `wMm` = 表宽）⇒ 一张附件图片被"适配"到表宽、二维码被画成表宽那么大，
 * 于是图片横向撑满整张表、码大到看不见。
 *
 * `cellContentWidthMm` 必须是**单元格内容区宽度**（列宽含 colspan 再减左右内边距）——
 * 外层盒子的 `width:N%` 是相对包含块（= td 内容区）算的，两边口径必须一致，
 * 否则"占格宽 50%"会与内层真实尺寸差一点，肉眼看不出来但打印会偏。
 */
export function childBoxWidthMm(child: { w?: number | string }, cellContentWidthMm: number): number {
  const base = Number.isFinite(cellContentWidthMm) && cellContentWidthMm > 0 ? cellContentWidthMm : 0
  return Math.max(1, (base * childWidthPct(child)) / 100)
}

/**
 * 格内元素的**默认盒高**（mm）。
 *
 * 2026-09-24 第四批 ④ 用户口径：「二维码、条形码、图片、附件，放入单元格后，
 * **默认按照单元格的尺寸等比适应，不把单元格撑变形**」。
 *
 * ⚠️ 原来只有**码**有这个默认高（18mm），图片与附件是 `h: 'auto'`（"由内容决定"）——
 * 而格内"由内容决定"的真实含义是**把行撑到原图那么高**：
 * 一张 800×1200 的竖图进格子会把整行撑到上百毫米，用户读作"表格被撑变形了"
 * （真机反馈原话就是"每个都长的不一样，导致表格变形严重"）。
 * ⇒ 现在四种统一用这个默认高；"等比适应"由内容层的 `object-fit: contain` 负责（等比、不拉伸）。
 */
export const CELL_CHILD_DEFAULT_H_MM = 18

/**
 * 格内元素的**盒高**（mm）：显式给了正数就用它，否则用默认高。
 *
 * ⚠️ 与 `childHeightMm` 的分工要分清：
 *   · `childHeightMm` 对 `h: 'auto'` 返回 `null`（"由内容决定"）—— 在**自由层**这是对的；
 *   · 但在**格内**，"由内容决定"就等于"把行撑破" ⇒ 一律走本函数。
 * ⇒ 好处：**老模板**（拖入时存下的 `'auto'`）不必让用户重拖，渲染时就自动变好。
 */
export function childBoxHeightMm(child: { h?: number | string }): number {
  return childHeightMm(child) ?? CELL_CHILD_DEFAULT_H_MM
}

/**
 * 格内元素盒子的**水平对齐**（`margin-left` / `margin-right` 取值）。
 *
 * 2026-10-13 用户反馈：「单元格内的二维码、图片元素，**没办法靠右、居中摆放**，
 * 默认靠左，**改了属性设置也无效**」。
 *
 * ⚠️ 根因：格内盒子以前只有 `width` / `height` / `overflow` —— **没有一个字关于"摆哪边"**。
 * 而用户改的是**单元格**的「水平对齐」（`cell.style.align`），那份设置此前只作用于
 * **文字**（`<td>` 的 `text-align`），**格内的块级子元素完全没读它** ⇒ 永远靠左。
 *
 * ⚠️ 为什么**复用单元格的对齐**、不给子元素另开一个属性：
 *   「格子里的东西怎么摆」本来就是**格子**的属性，何况用户已经找到那个开关了。
 *   另开一个属性 = 同一件事两个真相源（本项目反复吃过这个亏）。
 *
 * ⚠️ 为什么用 `margin: auto` 而不是 flex / text-align：
 *   两端（画布 `.bp-el-cell__child` / 打印 `<div>`）都是 **block 盒子 + 百分比宽度**，
 *   而 `margin: auto` 正是块级盒子水平对齐的标准手段 —— **一套机制两边通用**，
 *   不必给哪一端额外套容器。放在这里（而不是各端自己写）是为了**只有一份口径**。
 *
 * ⚠️ 宽度 = 100%（默认）时 `margin:auto` **看不出效果** —— 那是正常的：
 *   占满整格就没有"左右"可言。要让对齐可见，得先把「占格宽」调小。
 *
 * @param cellAlign 单元格的 `style.align`（`left` / `center` / `right`，可能未设）
 */
export function childBoxAlign(cellAlign: string | undefined): {
  marginLeft: 'auto' | '0'
  marginRight: 'auto' | '0'
} {
  if (cellAlign === 'center') return { marginLeft: 'auto', marginRight: 'auto' }
  if (cellAlign === 'right') return { marginLeft: 'auto', marginRight: '0' }
  /* left / 未设 ⇒ 靠左：与修之前的**逐字一致**，老模板不受影响 */
  return { marginLeft: '0', marginRight: 'auto' }
}

/**
 * 格内元素盒子的**左偏移（占格宽百分比）** —— 把"手动偏移"与"单元格水平对齐"合成一个值。
 *
 * ⚠️ 为什么需要它（2026-10-13 第 2 次重构带来的变化）：
 *    格内元素改成**绝对定位**（外层容器 = 元素盒子本身）之后，`margin:auto` 那套**不再适用**
 *    ⇒ 对齐只能表达成 `left`。这个函数就是那个换算，**两端共用**。
 *
 * 优先级：**用户手动设过偏移（`xPct > 0`）就听他的**；否则按单元格的 `align`。
 * ⚠️ 不这么做的话，"设了右对齐"会被一个 0 覆盖、或者"手动拖到 30%"又被对齐拽回去。
 */
export function childBoxLeftPct(
  child: { w?: number | string; cellPos?: { xPct?: number } },
  cellAlign: string | undefined,
): number {
  const x = childOffsetXPct(child)
  /*
   * ⚠️⚠️ **判断"用户有没有手动定位过"，不能用 `x > 0`**（2026-10-14 修）。
   *
   * 用户报：「设置内边距为 0 后，上下右紧贴，**左边反而不会紧贴了**」。
   * 根因：用户把元素拖到**贴左**时 `xPct === 0` ⇒ `x > 0` 为假 ⇒
   *   **被当成"没手动设过"** ⇒ 掉进下面的 `cellAlign` 分支 ⇒
   *   而他的对齐设置是"**右**" ⇒ **被强制推到右边** ⇒ 左边自然贴不上。
   * ⇒ 改用 `isChildPositioned()`（看的是"`cellPos` 这个对象在不在"）——
   *   `xPct = 0` 是一个**有效的**手动位置，不能被当成"没设"。
   */
  if (isChildPositioned(child)) return x
  const w = childWidthPct(child)
  if (cellAlign === 'center') return Math.round(Math.max(0, (100 - w) / 2) * 10) / 10
  if (cellAlign === 'right') return Math.round(Math.max(0, 100 - w) * 10) / 10
  return 0
}

// ============================================================
// 格内子元素的**定位**（2026-10-13 起 x/y 生效）
// ============================================================

/**
 * 这个格内子元素**是否已被手动定位**（= 有没有 `cellPos`）。
 *
 * ⚠️ 渲染端**靠它决定走流式还是绝对定位** —— 这是"老模板零影响"的开关：
 *    没有 `cellPos` ⇒ 完全维持原来的流式排布（靠左贴顶 + 受单元格 `align` 影响）。
 * ⚠️ 用它而不是"xPct === 0"来判：0 也是**合法的用户选择**（左对齐），
 *    拿 0 当"未设"会让"用户特意拖回最左边"和"从没动过"变成同一件事。
 */
export function isChildPositioned(child: { cellPos?: unknown }): boolean {
  return !!child.cellPos
}

/**
 * 格内子元素的**左偏移**（占单元格内容宽的百分比）。
 *
 * 用户反馈原文：「单元格内的图片、二维码、附件等元素**无法通过手动缩放**，
 * 参照这些元素在画布中的逻辑，可以手动缩放，也可以**手动拖动调整位置**，
 * 也可以**预设位置**」。
 *
 * ⚠️ 读的是 **`cellPos.xPct`**、不是 `x` —— 为什么不用 `x` 见 `types.ts` 的 `cellPos` 注释
 *    （一句话：老模板的 `x` 是版心坐标，直接当百分比用会让元素飞到格外面）。
 * ⚠️ 用**百分比**：宽度轴本来就是百分比体系（`childWidthPct`），
 *    混用 mm 会让"格子变宽时元素的相对位置漂掉"。
 */
export function childOffsetXPct(child: { cellPos?: { xPct?: number } }): number {
  const n = child.cellPos?.xPct
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  /* 允许小幅负偏移（往格外出一点）但夹在合理范围内，避免手抖输入把元素丢到看不见的地方 */
  return Math.min(200, Math.max(-100, n))
}

/**
 * 格内子元素的**上偏移**（mm）。
 *
 * ⚠️ 读 **`cellPos.yMm`**、用 **mm**：高度轴本来就是 mm 体系（`childBoxHeightMm`）。
 * ⚠️ 下限夹到 0（不允许向上负偏移）：向上偏移会让元素盖住单元格上边框、
 *    并且和"行高由内容撑开"的模型打架（撑高的量算不出来）。
 */
export function childOffsetYMm(child: { cellPos?: { yMm?: number } }): number {
  const n = child.cellPos?.yMm
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  /*
   * ⚠️ **下限从 0 放开到 −10**（2026-10-13 用户报：
   *   「单元格内的附件元素，自由拖动位置，**永远无法贴紧单元格的上边框，总会有空隙**」）。
   *
   * 根因：`y = 0` 是**内容区**顶部，而内容区在 `padding` 之内（单元格默认 1.5mm 内边距）⇒
   * 元素顶部离**边框**永远差一个内边距。用户要的是"贴到边框上"。
   * ⇒ 允许小幅负值：−10mm 足够覆盖常见的单元格内边距（也让"故意让元素压住边框"成为可能）。
   * ⚠️ 只放开下限、不放开上限的对称性不是遗漏：往上溢出会被 `<td>` 的 `overflow:hidden` 裁掉，
   *    往下同理 —— 那正是"不能超出单元格"的实现方式。
   */
  return Math.min(500, Math.max(0, n))
}

/**
 * 格内子元素的**有效 `yMm`** = `childOffsetYMm` **＋ 上限夹紧**（2026-10-15）。
 *
 * ⚠️⚠️ **为什么必须有它**：`childOffsetYMm` 的上限是 `500`（等于**不夹**），
 *   而横向的 `xPct` 有真上限（`100 − w`）⇒ **纵向能穿出单元格、横向不能**。
 *   用户实测正是这个现象：「**上/左/右三边留空隙，只有底边能贴（其实是超出）**」。
 *
 * ⇒ 上限 = **`行高 − 盒高`**。
 *   ⚠️ **`row.heightMm` 本身就是「内容区高」**（内边距加在它外面，实测
 *     `td 高 39.1mm = 行高 36.1 + 2×1.5`）⇒ **不要再减内边距**。
 *   ⚠️ 行高缺席（自适应）时**不夹**（没有可用的分母）。
 *
 * ⚠️ **两端（画布 / 打印）必须都走这个函数** —— 这一块已经因为"只改一端"
 *   反复翻车多次（钳制改了渲染没改、画布改了打印没改）。
 */
export function effectiveChildYMm(
  child: { h?: number | string; cellPos?: { yMm?: number } },
  rowHeightMm: number | undefined,
  /**
   * ⚠️ 单元格的**内边距**（mm）。
   * **必须减掉它**：`<tr style="height:39mm">` 里的 39 是 `td` 的 **border box 总高**
   *   （实测 `box-sizing: border-box`、`td 高 39.0mm = 39mm`）
   *   ⇒ **内容区高 = `行高 − 2×pad`** = `39 − 3 = 36mm`。
   * ⚠️ 我一度以为"行高就是内容区高、不用减 pad"（**错了**，那会让上限多 3mm，
   *   元素穿出单元格 1mm 压线 —— 用户实测 `toB = 0.4mm` 而非 1.5mm 正是它）。
   */
  padMm = 0,
): number {
  const y = childOffsetYMm(child)
  if (typeof rowHeightMm !== 'number' || !Number.isFinite(rowHeightMm) || rowHeightMm <= 0) return y
  const contentH = rowHeightMm - 2 * Math.max(0, padMm)
  const maxY = Math.max(0, contentH - childBoxHeightMm(child))
  return Math.min(y, maxY)
}

/**
 * 格内子元素**占用的总高度**（mm）= `y + h`。
 *
 * ⚠️ 这是"定位容器"的高度，**行高靠它撑住**。
 *
 * ⚠️⚠️ 为什么必须有它（改绝对定位时最容易踩的坑）：
 *    旧注释反对绝对定位的理由就是"**没人给高度、格子会塌掉**"（见 types.ts 第 ④ 条）。
 *    现在两端都插一层 `position: relative` 的容器、高度取本函数 ⇒
 *    子元素虽然绝对定位、**容器仍占 `y + h` 的高度** ⇒ 行高照旧被撑住，塌不了。
 *
 * ⚠️ 只有"已定位"的元素才需要它；流式元素的高度仍由它自己撑（现在就是这样）。
 * ⚠️ 必须与两端**逐字一致**：画布端（`Canvas.tsx`）与打印端（`render/html.ts`）——
 *    否则"画布上好好的、打印出来行高不对"。
 */
export function childBoxSpanMm(child: {
  cellPos?: { yMm?: number }
  h?: number | string
}): number {
  return childOffsetYMm(child) + childBoxHeightMm(child)
}
