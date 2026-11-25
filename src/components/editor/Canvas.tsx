/**
 * 画布：纸张 + 元素 + 直接操作（拖动 / 缩放 / 就地编辑）。
 *
 * 拖拽为什么不用 HTML5 drag-and-drop：
 * 插件跑在飞书 sandbox iframe 里，HTML5 DnD 在这个环境下面目全非 ——
 * 拖影由浏览器合成、无法自定义，`dragover`/`drop` 偶发不触发，且 pointer capture 与它互斥。
 * 这里全程用 Pointer Events（pointerdown/move/up）手写会话，行为在所有环境下一致，
 * 也顺带解决了"从抽屉拖到画布"这个跨容器拖拽（见 EditorShell 的 ghost 浮层）。
 *
 * 坐标：元素坐标一律 mm；写 CSS 时统一 `pxOf(mm)` 换算，再靠纸张的 `transform: scale()` 缩放。
 * 因此"画布缩放"不会污染任何一次命中测试 —— hitTest 一律拿 getBoundingClientRect 反推。
 */

import type { CellBorders } from '../../lib/types'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  Fragment,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  MM_TO_PX,
  contentBoxSize,
  finite,
  mmToPx,
  pageRenderSize,
  type AnyElement,
  type InlineNode,
  type TableElement,
  type TemplateDoc,
  type TemplateKind,
  type TextStyle,
  DEFAULT_TEXT_STYLE,
  /* ⚠️ 表格/单元格的兜底值 —— 与打印端 `render/html.ts` 引用**同一份**（2026-10-02 体检 P1） */
  BOLD_FONT_WEIGHT,
  DEFAULT_TABLE_BORDER_PT,
  DEFAULT_TABLE_LINE,
  GRID_STEPS_MM,
} from '../../lib/types'
import { fieldMeta } from '../../lib/field-types'
import type { FieldMeta } from '../../lib/data-source'
import { barcodeSvg, isCode128Encodable, qrCodeSvg, QR_MAX_BYTES, utf8ByteLength } from '../../render/code-elements'
import type { BandLayout } from './useEditorState'
import {
  BAND_HINT,
  DEFAULT_CODE_BG,
  DEFAULT_CODE_FG,
  SYSVAR_LABEL,
  cellLabel,
  elementHeightMm,
  elementLabel,
  findCell,
  findElement,
  gridOptions,
  heightOf,
  nodesToText,
  readBand,
  snapMm,
  textToNodes,
  updateCell,
  type BandKey,
} from './useEditorState'
// `round1` 的规范实现（B 批收口：此前全项目 5 份副本、且不是同一种行为，见 round.ts 的文件头）
import { round1 } from './round'
// 拖表格边框线调大小：与右侧面板的列宽/行高输入框**同一份**纯函数。
// 列宽必须走 setColWidthPatch —— 它在改列宽数组的同时同步元素总宽 `w`（E-45 的约束），
// 另写一遍就一定会有一天不同步（总宽和列宽之和对不上，渲染层会按比例压缩，画布与打印对不上）。
// `colEdgeFrac`（列宽 → 边界占比）与它同处一文件：读写的是同一个 `colWidthsMm`，
// 将来改列宽语义时改一处就能看见另一处 —— 原来它是本文件里的一个局部函数，
// 移出去是为了能单测（"末边界恒为 1、不吃到 >1"这条只有测得到才守得住）。
// `scaleColWidths`：拖**外框**改总宽时按比例缩放列宽，保住「Σ列宽 === w」这个不变量。
// 没有它，`table-layout:fixed` 会让表格宽度纹丝不动（定宽表格 used width = max(W, Σ列宽)）。
import {
  MIN_COL_MM,
  MIN_ROW_MM,
  colEdgeFrac,
  rowChildScale,
  scaleColWidths,
  scaleRowHeights,
  setColWidthPatch,
  setRowHeightPatch,
} from './table-actions'
// 智能对齐线：判定是纯函数（全在 mm 空间，见 align-guides.ts 的文件头），画布只负责画
import { buildDocRefs, computeGuides, dedupeGuides, type BoxMm, type GuideLine } from './align-guides'
/*
 * 模板图片（飞书附件）的临时链接表（2026-10-19）。
 * 固定图片现在可以只存 `fileToken`（图片在附件里），渲染前由这里换成 URL。
 * ⚠️ 链接 10 分钟过期 ⇒ 只做内存缓存，绝不写进模板。
 */
import { getTemplateImageUrls, subscribeTemplateImageUrls } from './template-image-store'
import { docImageElements } from '../../lib/template-images'
import { BAND_META, layoutBandBars, layoutBandGutters, type BandGeometry } from './band-bars'
// 表格的悬浮操作层（表格手柄 / 行首列首「+」/ 边缘感应区）——纯展示 + 纯回调，见它的文件头
import { TableAfford, tableAnchors } from './TableAfford'
// 矩形选区的浮动工具条（规格 四）+ 它用到的选区纯函数
import { CellRangeBar, type RangeOp } from './CellRangeBar'
import { TableSizePanel } from './TableSizePanel'
// 「拆分单元格」的输入弹层（第 7 条）：本组件只负责开/关与把动作层的拒绝原因透给它
import { SplitCellDialog } from './SplitCellDialog'
import { CellSizeDialog } from './CellSizeDialog'
import {
  MAX_CELL_CHILDREN,
  canSplitCell,
  expandRangeToWholeCells,
  isFirstColHeaderStyled,
  isHeaderCellAt,
  mergeRangeBlockReason,
  normalizeRange,
  rangeArea,
  resolveCellEdges,
  setHeaderColPatch,
  setHeaderRowsPatch,
  setHeaderStylePatch,
  splitCellToGrid,
  snapSizeToNeighbors,
  tableGrid,
  type CellRange,
} from './table-actions'
// 右键菜单：菜单本体是独立组件（含视口收边 / 四条关闭出口），画布只负责「命中什么、给哪些项」
import { ContextMenu, type CtxItem } from './ContextMenu'
// 表格动作层：合并走 `onAskMerge`（确认层在 EditorShell，那里已有「丢弃内容」的确认流程），
// 拆分与「设为表头行」没有丢失风险，画布直接改数据
import { applySplitCell } from './table-actions'
import type { AlignMode } from './useEditorState'
// 格内子元素：复合 id（点击要选它自己）、百分比宽 / 固定高（渲染要认这两个口径）
import { SCALABLE_CELL_KINDS, cellChildId, childHeightMm, childWidthPct, parseCellChildId } from './cell-child'
/* 格内盒高的口径（`h:'auto'` 也走默认高）—— 与打印端共用同一份实现，见它的注释 */
import {
  childBoxAlign,
  childBoxLeftPct,
  childBoxHeightMm,
  childBoxSpanMm,
  childOffsetXPct,
  childOffsetYMm,
  effectiveChildYMm,
  isChildPositioned,
  MIN_CELL_CHILD_PCT,
} from '../../lib/cell-geometry'
import { cellWidthMm } from './table-actions'

/**
 * 1pt = 1/72 inch → CSS px
 */
/*
 * ⚠️ **网格间距档位不再单独定义**（2026-10-17 用户报"两套逻辑"）：
 *   原来这里是 `[2,5,10,20]`，而右侧页面属性用的是 `GRID_STEPS_MM`（`[1,2,2.5,5,10]`）
 *   ⇒ 同一个"网格间距"在右键菜单里**少了 1mm / 2.5mm**，看着像两个功能 ✅
 * ⇒ 统一取 `GRID_STEPS_MM`（全项目唯一来源）。
 */

/** 页边距预设（四边同值）—— 真机反馈要求右键里能直接调页边距 */
const MARGIN_PRESETS: { name: string; mm: number }[] = [
  { name: '无', mm: 0 },
  { name: '窄', mm: 10 },
  { name: '常规', mm: 12 },
  { name: '宽', mm: 20 },
]

const ptToPx = (pt: number): number => finite(pt, 0) * (96 / 72)

/** 写进 style 的数值统一兜底：getBoundingClientRect / 拖动算出来的数在无头环境下可能是 NaN */
const nz = (n: number, fb = 0): number => (Number.isFinite(n) ? n : fb)

/** 缩放手柄的 8 个方向：四角 + 四边中点 */
type ResizeEdge = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const RESIZE_EDGES: readonly ResizeEdge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * 这些元素的**内容应该填满声明框**（而不是让框去迁就内容）。
 *
 * 2026-09-19 真机 + 自测定位（`_cdp.mjs` 在 mock 画布上实测）：
 * 元素外壳用的是 `min-height`（= max(声明高, 内容自然高)）⇒ **声明高 > 内容自然高时，
 * 外壳就比内容高**，于是"蓝色选区比里面的东西大一圈"。
 * 用户报的三种都命中：
 *   · 表格声明 15mm、真实约 13mm ⇒ 蓝框多出 2mm（截图 `image#8`）；
 *   · 二维码/条形码声明 25mm、占位内容约 22mm ⇒ 同上（`g06-code`）；
 *   · 附件同理。
 *
 * 为什么是"填满框"而不是"框去迁就内容"：
 *   框架式文档（Word/PPT/Excel）里，**框的尺寸就是对象的尺寸** —— 声明 15mm 就该看起来 15mm。
 *   而且打印侧本来就是 `min-height: 声明高`（`render/html.ts`），
 *   内容不填满只会在纸上留一段看不见的空隙；**让内容撑满，画布与打印才真正一致**。
 *
 * 顺带治好"拖表格底边、表格不动"：填满之后，声明高变大 ⇒ 表格行跟着分摊，
 * 表格**真的会变高**（以前只改了框、行纹丝不动）。
 *
 * 为什么只给这几种：文本/字段块本来就是行盒决定高度、实测差 0.1~0.9px（可忽略），
 * 给它们加 flex 拉伸反而会把单行文字拉到框底、改变基线，是没必要的风险。
 */
const FILL_KINDS = new Set(['table', 'qrcode', 'barcode', 'attach', 'image'])

/**
 * 「有固有尺寸」的元素：它们的高度该由**框**说了算（图片缩放到框里即可）。
 *
 * 与 `FILL_KINDS` 成员相同但**语义不同**，所以刻意不合并：
 *   · `FILL_KINDS` 管的是"内容要不要撑满声明框"（样式上的 fill）；
 *   · `PIC_LIKE` 管的是"显式高度算精确值还是下限"（几何语义）。
 * 哪天两者的成员要分开变，合在一起就会互相拖着走。
 * ⚠️ 必须与 `render/html.ts` 里 `heightCss` 的 `picLike` 判断**保持一致**。
 */
const PIC_LIKE = new Set(['attach', 'qrcode', 'barcode', 'image'])

/** 页边距的四条边（顺序固定，便于渲染时稳定输出） */
const MARGIN_SIDES = ['top', 'right', 'bottom', 'left'] as const

/** 页边距的中文名（画布标注与 prompt 文案共用一份，避免两处措辞不一致） */
const MARGIN_SIDE_CN: Record<(typeof MARGIN_SIDES)[number], string> = {
  top: '上',
  right: '右',
  bottom: '下',
  left: '左',
}

/** 拖列边框的最窄列宽（mm）。与右侧面板「第 N 列」那个输入框的 min 是同一个数 */

// 列宽/行高的下限**只在 table-actions 里定义一份**（MIN_COL_MM / MIN_ROW_MM，规格：32px / 24px）。
// 这里原来还有一个 `const MIN_COL_MM = 4` —— 同一个量两处定义，今天统一掉了。

export interface DropHit {
  xMm: number
  yMm: number
}

/**
 * 投放探针：把"要从左侧面板放进来的东西"告诉画布。
 * 画布据此判断"这个落点收不收"——**不收的话必须给一句人能看懂的理由**。
 */
export interface DropProbe {
  /** 能不能作为**行内节点**进格子（字段 / 系统变量 / 文字为 true）。 */
  inline: boolean
  /**
   * 能不能作为**块级子元素**进格子（规格 六，2026-09-22 加）。
   *
   * 在这之前，这个探针只有 `inline` 一个档 ⇒ 从面板拖图片/二维码到格子上会被
   * 「表格单元格里只能放字段、系统变量或文字」直接拒掉 —— 而规格六要的正是让它们住进去。
   * ⚠️ 名单的唯一来源是 `table-actions` 的 `CELL_BLOCK_KINDS`，这里只是把判定结果传进来。
   */
  cellBlock?: boolean
  /**
   * 是不是**字段占位符**这一类的载荷（2026-09-23 第 9 条）。
   *
   * 用途只有一个：标题行 / 标题列里**不允许放字段**（用户明确要求）。
   * 用它在**拖动过程中**就把那一格标成"不行"，而不是等用户松手才弹一句拒绝 ——
   * 松手才知道成不成，是这个项目反复强调要避免的"点了没反应/最后才说不"。
   * 只认字段（`field`）；系统变量（页码/行号）不进这条禁令，标题行里写"第 X 页"是合理的。
   */
  field?: boolean
  /** 报错文案里用的名字，如「客户名称」「表格」 */
  label: string
}

/**
 * 投放判定。三选一，没有第四种：
 *  - `cell`：落点在表格单元格里，且放的东西能被单元格装下 → 塞进那个格子
 *  - `free`：落点可用 → 正常落位
 *  - `reject`：落点不能用（不在纸张上 / 在下页边距里 / 格子装不下这东西）→ 拒绝，
 *    并把 `reason` 说给用户听
 *
 * ⚠️ **刻意没有"与已有元素重叠"这一条**：用户明确要求取消元素之间的重叠限制
 * （原来只有"从左侧面板拖进来"这条路会拦，拖动画布上已有的元素却不拦，
 * 同一个操作两种结果 —— 那条限制本来就不自洽）。重叠改由画布上的
 * `.bp-overlap` 高亮画出来（见下面的 overlaps），看得见、但不拦。
 * 剩下的三条拒绝理由都**保留**，它们和重叠无关。
 */
export type DropVerdict =
  | { kind: 'cell'; tableId: string; cellId: string; label: string }
  | { kind: 'free'; xMm: number; yMm: number }
  | { kind: 'reject'; reason: string }

/** 拖拽过程中的实时反馈：让用户**松手之前**就知道这一下会成还是不会成 */
export type DropTarget =
  | { kind: 'cell'; cellId: string }
  | { kind: 'reject'; reason: string }
  /**
   * 拖出矩形的**实时预览框**（规格 一 后半句：「或支持在画布上按住拖出矩形后，
   * 按矩形宽高自动换算行列数」）。坐标全是版心 mm ——
   * 画布只负责把它画出来，换算行列数在编辑器那一侧做。
   */
  | { kind: 'rect'; xMm: number; yMm: number; wMm: number; hMm: number }
  | null

export interface CanvasHandle {
  /** 屏幕坐标 → 版心坐标(mm)。不在纸张内返回 null。供 EditorShell 完成拖放落点 */
  hitTest(clientX: number, clientY: number): DropHit | null
  /** 判断这次投放落在哪儿、收不收（见 DropVerdict）。拖拽过程中也会调，所以必须是纯计算 */
  resolveDrop(clientX: number, clientY: number, probe: DropProbe): DropVerdict
  /** 把某元素滚动到可视区（检查条点击定位用） */
  scrollToElement(id: string): void
  /**
   * ⚠️ **打开"行高 / 列宽"对话框**（2026-10-17 用户要求：单元格面板里也要能设）。
   *   ⚠️ **不重复造轮子**：对话框本来就在 `Canvas` 里（右键菜单那条路），
   *   这里只是"多开一扇门" —— 面板按钮 → 这个 handle → 同一个 `sizeAsk`。
   */
  askCellSize(tableId: string, cellId: string, kind: 'row' | 'col'): void
}

/**
 * 右键菜单的动作集。**签名刻意窄**：都是"给 id 就干活"，不泄漏编辑器内部状态。
 * 复制/剪切作用在**当前选中**的元素上 —— 右键时画布会先把命中的元素选中（见 handler），
 * 所以"点菜单时选中的就是刚才右键的那个"这件事由**流程**保证，不由参数重复传一遍。
 */
export interface CanvasContextActions {
  copy(id: string): void
  cut(id: string): void
  paste(band: BandKey, at: { x: number; y: number }): void
  /** 剪贴板里有没有东西（决定「粘贴」可不可点） */
  clipboardHas: boolean
  align(id: string, mode: AlignMode): void
  /** 网格吸附开关（空白处右键那一项，带勾选态） */
  toggleSnap(): void
  /**
   * 页面设置：网格间距 / 显示网格 / 网格吸附 / 页边距（四边同值）。
   * 真机反馈（2026-09-22）要求空白右键菜单里能直接调这几项。
   */
  setPageSetup(patch: {
    gridMm?: number
    showGrid?: boolean
    snapToGrid?: boolean
    marginAllMm?: number
    /** 「允许拖出页面」开关（第 10 条）。布尔开关类设置都从这里进 */
    allowOutOfPage?: boolean
  }): void
  zIndex(id: string, where: 'front' | 'back' | 'forward' | 'backward'): void
  remove(id: string): void
  /** 合并：交给 EditorShell 那套（它会在"被丢的那格非空"时先弹确认） */
  askMerge(tableId: string, cellId: string, dir: 'right' | 'down'): void
  /** 插入行列：不丢数据，直接做 */
  insertRow(tableId: string, cellId: string, where: 'above' | 'below'): void
  insertCol(tableId: string, cellId: string, where: 'left' | 'right'): void
  /** 删除行列：会丢内容 ⇒ 走确认层（与合并同一个）。定位器是 cellId，不是行/列号 */
  deleteRow(tableId: string, cellId: string): void
  deleteCol(tableId: string, cellId: string): void
  /** 矩形选区合并（会丢图片格 ⇒ 与合并共用确认层） */
  askMergeRange(tableId: string, range: CellRange): void
  /** 选区样式（对齐/加粗/底纹/表头行）：不丢东西，直接套补丁 */
  applyRange(tableId: string, range: CellRange, op: RangeOp): void
  /**
   * 把格子里的块级子元素取出放回画布（规格 六：「可以再拖出来，回到画布自由层」）。
   *
   * `at` 给了就落在指定的版心坐标（**拖出来**那条路用它），
   * 不给就落在表格右侧（右键菜单那条路用它）。
   */
  /**
   * **把格内子元素取出到自由层**。
   * ⚠️ `childId` 可选（2026-10-16）：一格多个时**必须传**，否则取到的"倒数第一个"
   *   可能不是你抓的那个。不传 ⇒ 退回老行为（行为逐字不变）。
   */
  takeOutChild(
    tableId: string,
    cellId: string,
    at?: { xMm: number; yMm: number },
    childId?: string,
  ): void
  /**
   * **格内子元素在格子里的偏移**（2026-10-13）：横向占格宽百分比、纵向 mm。
   * ⚠️ 一旦调用，该子元素就从"流式"变成"绝对定位"（见 `types.ts` 的 `cellPos` 注释）。
   */
  /**
   * ⚠️ **`childId`：改"哪一个"子元素**（2026-10-16 放宽 `MAX_CELL_CHILDREN` 后新增）。
   *   不传 ⇒ 退回"第 0 个"（老调用点行为不变）。
   */
  patchCellChild(
    tableId: string,
    cellId: string,
    patch: Partial<AnyElement>,
    mergeKey?: string,
    childId?: string,
  ): void
  /** 只删掉格子里的子元素（保留格子里的文字） */
  /** ⚠️ `childId` 可选：不传 ⇒ 删"最后一个"（老调用点行为不变）；一格多个时**必须传** */
  removeChild(tableId: string, cellId: string, childId?: string): void
  /**
   * **清空这一格的所有子元素**（2026-10-16 用户要求 —— 右键格空白处的「移除格内元素」）。
   * ⚠️ 与 `removeChild`（删一个、要把元素交还画布）分开：这里是**纯删除**。
   */
  clearChildren(tableId: string, cellId: string): void
  /** 把子元素从一格**挪到另一格**（拖到别的格子上松开） */
  /**
   * **把格内子元素换到另一格**。
   * ⚠️ `childId` 可选（2026-10-16）：一格多个时必须传（同 `takeOutChild`）。
   */
  moveChildToCell(
    fromTableId: string,
    fromCellId: string,
    toTableId: string,
    toCellId: string,
    childId?: string,
  ): void
  /** 拆分单元格（无丢失风险，直接改数据） */
  splitCell(tableId: string, cellId: string): void
  /** 设为/取消表头行（整行样式 + 打印时跨页重复） */
  setHeaderRow(tableId: string, rowIdx: number): void
}

/** 右键命中的三种对象 —— 菜单项按它分岔，这就是用户要的"依据元素类型智能弹出" */
type CtxTarget =
  /** 格内子元素（真机反馈第 3 条）：它住在格子里，不是画布上的自由元素 */
  /**
   * ⚠️ **`childId`：右键点的到底是哪一个子元素**（2026-10-16 放宽 `MAX_CELL_CHILDREN` 后新增）。
   *   一格多个时，没有它就只能"删最后一个" —— 会删错。
   */
  | { kind: 'child'; tableId: string; cellId: string; childId: string }
  | { kind: 'blank'; band: BandKey; xMm: number; yMm: number }
  | { kind: 'element'; id: string; band: BandKey }
  | { kind: 'cell'; tableId: string; cellId: string }

export interface CanvasProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  layout: BandLayout
  /** 当前缩放比 */
  scale: number
  selectedId: string | null
  selectedCellId: string | null
  /** 检查出来的超界元素 id，用于打斜纹遮罩 */
  outOfBoundsIds: string[]
  /** 模板类型：只影响循环区的提示文案（记录模板只渲染首行） */
  kind?: TemplateKind
  /** 外部（Palette）正在拖拽，纸张需要给出"可放置"提示 */
  dropActive?: boolean
  /**
   * 请求把「表格尺寸」小窗开到某张表上 —— 进编辑态时用
   * （真机反馈 2026-09-23 第 6 条：「点击编辑表格再次出现」）。
   *
   * 小窗的**状态**握在 EditorShell 手里（`newTableId`），画布只负责"请求打开"与"请求关闭"，
   * 这样"什么时候该收"只有一个判据（见 EditorShell 里那个 effect），不会两处各判一次。
   */
  onOpenTableSize?(tableId: string): void
  /**
   * 把"退出**表格编辑态**"的能力交给宿主（2026-09-23 真机反馈第 5 条）。
   *
   * 用户原话：「画布编辑下，按 Esc 是退出编辑，不是退出大屏」。
   * `editTableId` 是画布内部状态，而 Esc 的仲裁链在 `EditorShell` ——
   * 与其为它做一次受控 prop 提升（会牵动画布里 3 处用法），不如让画布
   * **把"当前怎么退出去"注册上去**：调用方拿到 `null` 就表示"现在没有在编辑"。
   * 传 `null` 表示注销（组件卸载或编辑态结束时）。
   */
  onExposeExitEdit?(fn: (() => boolean) | null): void
  /** 正在拖拽时，这一下的落点判定结果（可放置的格子 / 会被拒绝的理由） */
  dropTarget?: DropTarget
  /** 节点级选中（字段/文字/系统变量占位符本身） */
  selectedNode?: NodeSel | null
  onSelect(id: string | null): void
  onSelectCell(elementId: string | null, cellId: string | null): void
  /**
   * 在画布上直接改某一侧的页边距（2026-09-19 用户要求："点击数字后，可以修改四边的页边距"）。
   *
   * 为什么要在画布上也能改：页边距的可视化（红线丈量）就画在画布上，
   * 用户看到"左边距 12mm"时**下一步就是想改它**；让他去右侧面板找四个数字框，
   * 等于把"看到问题"和"解决问题"拆到两个地方 —— 那正是这次要消掉的摩擦。
   *
   * 为什么用"单侧 + 数值"而不是直接传整个 `PageSetup`：
   * 画布只需要"改哪一边、改成多少"，不该知道 PageSetup 的其余字段（纸张、方向…）。
   * 接口越窄，画布与页面设置模块的耦合越少。
   */
  onSetMargin(side: 'top' | 'right' | 'bottom' | 'left', mm: number): void
  /**
   * **把画布上已有的元素"放进"某个表格单元格**（2026-09-19 用户要求）。
   *
   * 用户原话："单元格内可以依靠从左边的工具栏手动拖元素、字段，直接绑定至某个单元格，
   * **但如果是从画布的其他区域拖过去，那么这个元素就无法拖入到单元格内绑定，
   * 只会叠加在整个表格上**，改为从画布中拖其他元素或者字段到表格上时，
   * 可以**自动吸附到单元格内**完成绑定。"
   *
   * 为什么会不一致：左侧面板拖入走的是 `resolveDrop`（它**会**判定 `td`），
   * 而在画布上拖动已有元素走的是 `beginSession('move')`，落点**只写 x/y、从不看落点是什么**
   * ⇒ 拖到表格上就等于叠上去。
   *
   * 返回 `true` 表示这次落点已被"放进单元格"消费掉。
   */
  onElementIntoCell?(elementId: string, tableId: string, cellId: string): boolean
  /**
   * 右键菜单要用的动作集（2026-09-22）。
   *
   * 为什么是**一个对象**而不是八个 prop：这八件事全是"菜单项 → 编辑器动作"的一对一映射，
   * 它们的共同点是"只在右键菜单里用"。拆成八个 prop 会让组件签名长一倍，
   * 而且下次再加一个菜单项就要再动一次签名 —— 归一化成一个可选对象，
   * 缺省时右键菜单**整体不启用**（画布仍可只读预览）。
   */
  actions?: CanvasContextActions
  /** 刚插入的那张表的 id（规格 一：插完立刻浮出「表格尺寸」让他微调，默认已是 3 行 4 列） */
  newTableId?: string | null
  onResizeTable?(tableId: string, rows: number, cols: number): void
  onCloseTableSize?(): void
  /**
   * 画布想临时高亮某个单元格（拖子元素换格时用）。
   * ⚠️ 落点提示状态（`dropTarget`）一直握在 EditorShell 手里，画布只上报 ——
   *    画布自己再存一份就会有两个真相源。
   */
  onDropTargetChange?(t: DropTarget | null): void
  /** 点选某个行内节点；传 null 表示取消 */
  onSelectNode?(sel: NodeSel | null): void
  onMerge(id: string, patch: Partial<AnyElement>, mergeKey?: string): void
  /** 拖动/缩放松开时通知外部关闭撤销合并窗口 */
  onCommitEnd?(): void
}

// ============================================================
// 样式小工具
// ============================================================

/** `useSyncExternalStore` 的服务端快照必须**引用稳定**，所以用模块级常量 */
const EMPTY_IMAGE_URLS = new Map<string, string>()

const FONT_STACKS: Record<string, string> = {
  system: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
}

function fontCss(name?: string): string {
  if (!name || name === 'system') return FONT_STACKS.system
  if (FONT_STACKS[name]) return FONT_STACKS[name]
  // 用户自定义字体（含 Word 导入的中文字体名）原样引用，含空格时加引号
  return `${JSON.stringify(name)}, ${FONT_STACKS.system}`
}

/** 文本样式 → CSS。行距的固定值(pt)优先于倍数 */
function textCss(el: AnyElement): CSSProperties {
  const s = el.style
  const deco = [s?.underline ? 'underline' : '', s?.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  const lh =
    typeof s?.lineHeightPt === 'number' && Number.isFinite(s.lineHeightPt)
      ? `${ptToPx(s.lineHeightPt)}px`
      : `${nz(finite(s?.lineHeight, DEFAULT_TEXT_STYLE.lineHeight), 1.5)}`
  return {
    fontFamily: fontCss(s?.fontFamily),
    fontSize: ptToPx(finite(s?.fontSizePt, DEFAULT_TEXT_STYLE.fontSizePt)),
    fontWeight: s?.bold ? BOLD_FONT_WEIGHT : 400,
    fontStyle: s?.italic ? 'italic' : 'normal',
    textDecoration: deco || 'none',
    /* 下划虚线（`underline: true` + `underlineStyle: 'dashed'`）—— 用来拼填空线 */
    ...(s?.underline && s?.underlineStyle === 'dashed' ? { textDecorationStyle: 'dashed' as const } : null),
    color: s?.color || DEFAULT_TEXT_STYLE.color,
    background: s?.background || undefined,
    textAlign: s?.align ?? DEFAULT_TEXT_STYLE.align,
    lineHeight: lh,
    paddingLeft: mmToPx(finite(s?.indentLeftMm, 0)),
    paddingRight: mmToPx(finite(s?.indentRightMm, 0)),
    textIndent: mmToPx(finite(s?.indentFirstLineMm, 0)),
    marginTop: ptToPx(finite(s?.spaceBeforePt, 0)),
    marginBottom: ptToPx(finite(s?.spaceAfterPt, 0)),
  }
}

/**
 * **行内节点自己的**样式 → CSS。
 *
 * 与 `textCss` 的关键区别：这里只输出**显式设过**的那几项，没设的一律 undefined 交给继承 ——
 * 节点级样式是"元素样式之上的一层覆写"，把整份默认值铺上去会把外层样式全顶掉，
 * 用户改了整块文本的字号，chip 却纹丝不动。渲染层（render/html.ts 的 inlineCss）是同一个口径。
 */
function nodeCss(s?: TextStyle): CSSProperties | undefined {
  if (!s) return undefined
  const out: CSSProperties = {}
  if (s.fontFamily) out.fontFamily = fontCss(s.fontFamily)
  if (typeof s.fontSizePt === 'number' && Number.isFinite(s.fontSizePt)) out.fontSize = ptToPx(s.fontSizePt)
  if (s.bold !== undefined) out.fontWeight = s.bold ? BOLD_FONT_WEIGHT : 400
  if (s.italic !== undefined) out.fontStyle = s.italic ? 'italic' : 'normal'
  /*
   * ⚠️ 进入条件是 `underline` / `strike` **本身**设过，不能把 `underlineStyle` 也算进来：
   *   只设线型、没设 `underline` 时算出的是 `textDecoration: 'none'`，
   *   会把外层（单元格/元素）已经开着的下划线**抵消掉**。
   */
  if (s.underline !== undefined || s.strike !== undefined) {
    out.textDecoration =
      [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none'
    if (s.underline && s.underlineStyle === 'dashed') out.textDecorationStyle = 'dashed'
  }
  if (s.color) out.color = s.color
  if (s.background) out.background = s.background
  return Object.keys(out).length ? out : undefined
}

/**
 * 文本**元素**（块级）自己的样式 → CSS。
 *
 * 与 `nodeCss` 同一个口径：**只输出显式设过的那几项**，其余交给画布的默认样式。
 *
 * 为什么不是直接铺整份 `textCss`：`textCss` 会给没设过的项补默认值（例如
 * `fontSizePt ?? 10.5`），那样一来**所有**文本元素的字号都会在画布上整体跳一档 ——
 * 明明没动过任何东西、观感却变了，这是最难查的一类回归。
 *
 * 为什么必须有这个函数：`kind === 'text'` 的元素在画布上原来**完全不吃** `el.style`
 * （只有 fieldBlock 吃），于是"给文本元素改字体/字号/加粗"在画布上毫无反应 ——
 * 顶栏「文本编辑」点下去画布纹丝不动，用户只会认为功能坏了。
 * 渲染层（render/html.ts 的 `textCss(el.style, [TEXT_FLOW])`）一直是应用的，
 * 所以补上它同时也把"画布 vs 打印"的这条偏差一起收掉。
 */
function blockCss(s?: TextStyle): CSSProperties | undefined {
  const out: CSSProperties = { ...(nodeCss(s) ?? {}) }
  if (!s) return Object.keys(out).length ? out : undefined
  if (s.align) out.textAlign = s.align
  // 行距的固定值(pt)优先于倍数 —— 与 textCss / 渲染层同一口径
  if (typeof s.lineHeightPt === 'number' && Number.isFinite(s.lineHeightPt)) out.lineHeight = `${ptToPx(s.lineHeightPt)}px`
  else if (typeof s.lineHeight === 'number' && Number.isFinite(s.lineHeight)) out.lineHeight = s.lineHeight
  if (typeof s.indentLeftMm === 'number') out.paddingLeft = mmToPx(s.indentLeftMm)
  if (typeof s.indentRightMm === 'number') out.paddingRight = mmToPx(s.indentRightMm)
  if (typeof s.indentFirstLineMm === 'number') out.textIndent = mmToPx(s.indentFirstLineMm)
  if (typeof s.spaceBeforePt === 'number') out.marginTop = ptToPx(s.spaceBeforePt)
  if (typeof s.spaceAfterPt === 'number') out.marginBottom = ptToPx(s.spaceAfterPt)
  return Object.keys(out).length ? out : undefined
}

function tableCss(el: TableElement): {
  table: CSSProperties
  cell: (rowIdx: number, colIdx: number, cellBorders?: CellBorders) => CSSProperties
} {
  // 没写线色时的兜底必须和渲染层一致（render/html.ts 用的是 #d0d3d9）。
  // 原来这里兜的是 var(--paper-line) —— 那**同时也是网格线的颜色**，于是"没设过线色的表格"
  // 画出来和网格几乎同色，用户根本分不清哪条是表格、哪条是网格。
  /*
   * ⚠️ `?.` 不是洁癖（2026-10-02 体检 P0-3）：`types.ts` 里 `border` 声明为必填，
   * 但 `template-store.coerceDoc` **不对表格元素做深度校验** —— 老模板 / 手改过 JSON 缺这个字段时，
   * 这里会抛 `TypeError` ⇒ **整个编辑器白屏**（不是"某个元素不显示"，是整页崩）。
   * 打印端一直写的是 `el.border?.widthPt`，说明作者本来也认为它可能为空。
   */
  const w = `${nz(ptToPx(finite(el.border?.widthPt, DEFAULT_TABLE_BORDER_PT)), 1)}px solid ${el.border?.color || DEFAULT_TABLE_LINE}`
  const none = 'none'
  const mode = el.border?.mode
  const lastRow = el.rows.length - 1
  const lastCol = el.colWidthsMm.length - 1
  const table: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    tableLayout: 'fixed',
    borderTop: mode === 'all' || mode === 'outer' ? w : none,
    borderLeft: mode === 'all' || mode === 'outer' ? w : none,
    borderRight: mode === 'all' || mode === 'outer' ? w : none,
    borderBottom: mode === 'all' || mode === 'outer' ? w : none,
  }
  const cell = (r: number, c: number, cellBorders?: CellBorders): CSSProperties => {
    /*
     * 单边边框（规格 八）：有覆盖时逐边给出最终结果 —— 与打印端读的是**同一个** `resolveCellEdges`。
     * 没有覆盖时保持原路径（老模板在画布上的观感一点不变）。
     */
    if (cellBorders) {
      const e = resolveCellEdges(mode, cellBorders, { row: r, rows: el.rows.length, col: c, cols: el.colWidthsMm.length })
      const cw = `${nz(ptToPx(finite(cellBorders.widthPt ?? el.border?.widthPt, DEFAULT_TABLE_BORDER_PT)), 1)}px solid ${cellBorders.color || el.border?.color || DEFAULT_TABLE_LINE}`
      return {
        borderTop: e.top ? cw : none,
        borderRight: e.right ? cw : none,
        borderBottom: e.bottom ? cw : none,
        borderLeft: e.left ? cw : none,
      }
    }
    if (mode === 'none') return { border: none }
    if (mode === 'all') return { border: w }
    if (mode === 'horizontal') return { borderBottom: r === lastRow ? none : w }
    // outer：只有外圈有框线
    return {
      borderRight: c === lastCol ? none : undefined,
      borderBottom: r === lastRow ? none : undefined,
      boxShadow: undefined,
    }
  }
  return { table, cell }
}

// ============================================================
// 行内节点渲染（画布上的"所见即所得"近似）
// ============================================================

/**
 * 行内节点的**节点级**选中：`元素 + 格子` 定位到一个具体节点（`nodes[index]`）。
 *
 * 为什么单元格也要进 key：同一个文本元素里不会有两份 nodes，但表格的每一格都有一份，
 * 只靠 index 的话"第 3 格的第 0 个节点"和"第 5 格的第 0 个节点"会撞在一起。
 */
export interface NodeSel {
  elementId: string
  /** 文本元素内部为 null；表格单元格为那一格的 id */
  cellId: string | null
  index: number
}

/** 渲染行内节点时的"可点选"上下文；不传就是纯展示 */
interface InlinePick {
  elementId: string
  cellId: string | null
  selectedNode: NodeSel | null
  onSelectNode(sel: NodeSel | null): void
}

const sameNode = (a: NodeSel | null, b: NodeSel): boolean =>
  !!a && a.elementId === b.elementId && a.cellId === b.cellId && a.index === b.index

/**
 * 哪些行内节点**可以被单独选中**。
 *
 * 只有"占位符"这两类：字段 `chip` 与系统变量。
 *
 * 为什么普通文字片段不算：用户的诉求是"无法对**字段内容**进行字体的设置"，
 * 要改的正是这一层。而文字片段的样式在元素/单元格那一层改更顺手 ——
 * 如果中间那段字也能被单独选中，用户在文本元素正中间点一下拿到的是"文字片段"，
 * 反而选不中元素本身（宽度、位置、所属版式区都在元素面板里），
 * 是拿一个小便利换掉一个大入口。硬换行更是没有任何样式可设。
 */
function pickableNode(n: InlineNode): boolean {
  return n.type === 'field' || n.type === 'sysvar'
}

/**
 * ⚠️ `outerColor`：**外层（单元格/元素）显式设的颜色**（2026-10-17）。
 *   字段节点是个 `.bp-chip`，CSS 里写死 `color: var(--accent)`（蓝色胶囊）——
 *   于是"外层改色"对字段**不生效**，而对手输文字生效（普通 span 会继承）⇒ 用户看到"只有文字变色"。
 *   ⇒ 这里把外层色**以最高优先级的"兜底"写进内联 style**（节点自己设过颜色就不覆盖）。
 */
/**
 * 行内 **inline-block**（字段胶囊 / 系统变量）的"继承装饰"。
 *
 * 为什么不能只靠父级的 `text-decoration`：CSS 的装饰**不会进入 atomic inline**
 * （`inline-block`）内部 —— 父级画下划线时会在胶囊这一格**断开**。
 * 于是"给一串文字加下划虚线做填空线、中间插一个字段"就会看到线断了一截，
 * 字段看起来"没骑在虚线上"（2026-10-17 用户报：
 *   「在经办人后面加入字段的话，不会出现在虚线上方」）。
 * ⇒ 胶囊自己再画一遍；位置由同一 baseline 决定，与前后文字对齐。
 */
function chipDeco(
  n: { style?: TextStyle },
  outer?: { underline?: boolean; strike?: boolean; dashed?: boolean },
): CSSProperties | undefined {
  /* 节点自己设过装饰 ⇒ 以它为准（`nodeCss` 已经输出过了，这里不重复） */
  if (n.style?.underline !== undefined || n.style?.strike !== undefined) return undefined
  const u = outer?.underline === true
  const st = outer?.strike === true
  if (!u && !st) return undefined
  return {
    textDecoration: [u ? 'underline' : '', st ? 'line-through' : ''].filter(Boolean).join(' '),
    ...(u && outer?.dashed ? { textDecorationStyle: 'dashed' as const } : null),
  }
}

/** 从一份 `TextStyle` 取出 `renderInline`/`chipDeco` 要的装饰参数（三处调用共用） */
function decoOf(s?: TextStyle): { underline?: boolean; strike?: boolean; dashed?: boolean } | undefined {
  if (!s) return undefined
  return {
    underline: s.underline === true,
    strike: s.strike === true,
    dashed: s.underline === true && s.underlineStyle === 'dashed',
  }
}

function renderInline(
  nodes: InlineNode[],
  fields: FieldMeta[],
  keyPrefix: string,
  pick?: InlinePick,
  outerColor?: string,
  /**
   * ⚠️ **这一格的"自动换行"设置**（2026-10-17 用户要求：开关从字段挪到**单元格**）。
   * `false` ⇒ 不换行 + 裁切。⚠️ 优先级：**单元格**（这是格子级语义）> 节点自己的 `wrap`。
   */
  cellWrap?: boolean,
  /**
   * 外层的装饰（下划线 / 删除线 + 线型）—— 只用于给 **inline-block 节点补画一遍**
   * （父级的 `text-decoration` 进不去 atomic inline，见 `chipDeco` 的注释）。
   */
  outerDeco?: { underline?: boolean; strike?: boolean; dashed?: boolean },
): ReactNode[] {
  const known = new Set(fields.map((f) => f.id))
  return nodes.map((n, i) => {
    const key = `${keyPrefix}_${i}`
    const mine: NodeSel = { elementId: pick?.elementId ?? '', cellId: pick?.cellId ?? null, index: i }
    /**
     * `data-node-*` 挂在**所有**可承载样式的节点上（便于诊断"这一处到底是第几个节点"），
     * 但**点击钩子只给占位符**（见 pickableNode）。
     */
    const canPick = pickableNode(n)
    const hit = !!pick && canPick && sameNode(pick.selectedNode, mine)
    const nodeProps: Record<string, unknown> =
      n.type === 'br'
        ? {}
        : {
            'data-node-index': i,
            'data-node-kind': n.type,
            ...(pick && canPick
              ? {
                  // 刻意**不** stopPropagation：点 chip 时外面那一层（单元格 / 元素）的点击也要照常发生，
                  // 否则"选中了 chip 却看不到它所在那一格的面板"。节点选中只是多叠一层。
                  onClick: () => pick.onSelectNode(hit ? null : mine),
                }
              : {}),
          }
    const selCls = hit ? ' is-node-sel' : ''
    // 换行节点没有样式（InlineBreak 上没有 style 字段）
    const own = n.type === 'br' ? undefined : nodeCss(n.style)
    if (n.type === 'text') {
      return (
        <span key={key} className={hit ? 'is-node-sel' : undefined} style={own} {...nodeProps}>
          {n.text}
        </span>
      )
    }
    if (n.type === 'br') return <br key={key} />
    if (n.type === 'field') {
      const invalid = !n.fieldId || !known.has(n.fieldId)
      return (
        <span
          key={key}
          /* ⚠️ 这一行是"蓝色胶囊"的全部来源（`bp-chip`）+ 选中态（`is-node-sel`）。
             2026-10-17 回退"行内拖动"时，我的正则误删了它 ⇒ 元素变成纯黑字、没有选中效果。 */
          /*
           * ⚠️ `is-nowrap`：**关闭自动换行**时给（2026-10-17 用户要求）。
           *   `wrap === false` ⇒ 不换行 + 省略号裁切；其余（含未设）⇒ 换行。
           */
          className={`bp-chip${invalid ? ' bp-chip--missing' : ''}${selCls}${(cellWrap === false || n.wrap === false) ? ' is-nowrap' : ''}`}
          /*
           * ⚠️ **外层色兜底**（2026-10-17）：`.bp-chip` 的 CSS 写死了 `color: var(--accent)`，
           *   所以"在编辑框里整体改颜色"时字段不会跟着变（用户报的那个 bug）。
           *   ⇒ 节点**自己没设颜色**时，把外层色写成内联 `color`（内联优先级高于类，能盖掉 accent）。
           *   ⚠️ 自己设过就**尊重用户**（单字段改色的路径）。
           */
          style={{
            ...own,
            ...chipDeco(n, outerDeco),
            ...(own?.color ? null : outerColor ? { color: outerColor } : null),
          }}
          title={invalid ? `「${n.fieldName || '未绑定'}」已失效或未绑定字段，导出时会原样输出这段文字` : n.fieldName}
          {...nodeProps}
        >
          {/* 截断放在内层：chip 自己必须 `overflow: visible`，否则它的基线会取底边、
              和同一行的前后缀错位（见 editor.css 里 .bp-chip 的注释） */}
          <span className="bp-chip__text">{n.fieldName || '未绑定字段'}</span>
        </span>
      )
    }
    return (
      <span key={key} className={`bp-chip bp-chip--sys${selCls}`} style={{ ...own, ...chipDeco(n, outerDeco) }} {...nodeProps}>
        <span className="bp-chip__text">{SYSVAR_LABEL[n.key]}</span>
      </span>
    )
  })
}

// ============================================================
// 二维码 / 条形码的编辑期预览
// ============================================================

interface CodePreview {
  /** 真的能扫的码（只有"固定内容"来源才会生成） */
  svg: string | null
  /** 占位文案：固定内容为空时是"未填写内容"，绑定字段时是字段名 */
  text: string
  /** 占位角标 */
  badge: string
  background: string
  /** 未绑定 / 未填写，画布上用警示样式 */
  warn: boolean
  hint: string
}

/**
 * 为什么"绑定字段"时不画真码：
 * 编辑期根本没有"当前记录"这个稳定值（一条模板要打几百条不同的记录），
 * 拿字段名硬编一个码出来，用户会以为那就是打印效果，扫描出来却是一串假数据。
 * 所以这里只画一个明确的占位框，并把"打印时逐条生成"写在 title 里。
 */
/**
 * 画布上的码预览。
 *
 * `boxWidthMm` = **格内**专用：这一格的内容区宽度（mm）。
 *
 * ⚠️ 为什么必须有它（真机反馈 2026-09-23 第 2 条：「单元格内拖入二维码、条形码……
 * 条形码会显示，二维码不会显示」）：
 * 格内子元素的 `w` 是**占格宽百分比**（`w: 100` = 占满这一格），而自由层的 `w` 是 **mm**。
 * 这里原来一律 `finite(el.w, …)` 当 mm 用 ⇒ 格内算出 `wMm = 100`，
 * 二维码 `sizeMm = min(100, hMm)` 直接画出**一个 10cm 见方的码**，
 * 溢出格子后被外层盒子的 `overflow:hidden` 裁掉 ⇒ 用户看到的是"**完全不显示**"；
 * 条形码是长条，被裁掉两端后还剩中间一段 ⇒ "条形码会显示"。
 * （打印端在 `render/html.ts` 里是同一个毛病，已同步修。）
 */
function codePreview(
  el: Extract<AnyElement, { kind: 'qrcode' | 'barcode' }>,
  fields: FieldMeta[],
  boxWidthMm?: number,
): CodePreview {
  const background = el.background || DEFAULT_CODE_BG
  const foreground = el.foreground || DEFAULT_CODE_FG
  const src = el.source

  if (src.kind === 'field') {
    const bound = !!src.fieldId && fields.some((f) => f.id === src.fieldId)
    const name = src.fieldName || '未绑定字段'
    return {
      svg: null,
      text: name,
      badge: bound ? '字段' : '未绑定',
      background,
      warn: !bound,
      hint: bound
        ? `「${name}」：打印时按每条记录的值逐条生成（编辑期不显示真实内容）`
        : '尚未绑定字段，打印时会输出空白',
    }
  }

  const text = src.value.trim()
  if (!text) {
    return { svg: null, text: '未填写内容', badge: '待填', background, warn: true, hint: '在右侧属性面板里填写固定内容或改为从字段取值' }
  }

  // 渲染库对超长 / 非法内容可能抛错。这里必须兜住：画布抛异常会直接冒到 window，
  // 而 e2e 断言"无未捕获异常"，一个畸形字符串就能把整条链路判死。
  let svg: string | null = null
  try {
    /*
     * 尺寸依据：**格内用格宽**（`boxWidthMm`）、自由层用元素自己的 `w`（mm）。
     * ⚠️ 混用这两套语义就会画出 100mm 的码 —— 详见函数头上那段说明。
     */
    const wMm = boxWidthMm != null ? Math.max(4, boxWidthMm) : finite(el.w, el.kind === 'qrcode' ? 28 : 50)
    const hMm = el.h === 'auto' ? elementHeightMm(el) : Math.max(1, finite(el.h, 20))
    // 二维码必须是正方形：宽高被拉成不一致时取小值，宁可留白也不要画出扫不出来的畸形码
    svg =
      el.kind === 'qrcode'
        ? qrCodeSvg(text, {
            sizeMm: Math.max(4, Math.min(wMm, hMm)),
            ...(el.ecLevel ? { ecLevel: el.ecLevel } : {}),
            foreground,
            background,
          })
        : barcodeSvg(text, {
            widthMm: Math.max(4, wMm),
            heightMm: Math.max(4, hMm),
            showText: !!el.showText,
            foreground,
            background,
          })
  } catch {
    svg = null
  }
  if (!svg) {
    // 空串是渲染库的"编不出来"约定（空内容 / 超容量 / 条形码含非 ASCII）。
    // 把原因说清楚：只说"生成失败"会让人以为插件坏了。
    const bad =
      el.kind === 'barcode'
        ? isCode128Encodable(text)
          ? '内容无法生成条形码'
          : '条形码只支持数字、字母与常用符号'
        : utf8ByteLength(text) > QR_MAX_BYTES
          ? `内容过长（上限约 ${QR_MAX_BYTES} 字节）`
          : '内容无法生成二维码'
    return { svg: null, text: bad, badge: '出错', background, warn: true, hint: '改短或换一段内容再试' }
  }
  return { svg, text, badge: '', background, warn: false, hint: text }
}

// ============================================================
// 版式区标签
// ============================================================

// ============================================================
// 说明：原来这里有一个 `BandTag` 组件（左页边距里一枚横排小胶囊）。
// 2026-09-22 分区带重做时**删掉**了 —— 它的两个问题正是用户这次抱怨的：
//   ① 三条带里只有循环区那条能显示（表头/表尾挂在"该区有元素"这个条件下，空分区什么都看不到）；
//   ② 页边距槽只有 ~30px 宽，横排文字放不下四个字，只能省略号。
// 现在由「带内标签条 + 左侧竖排标签」两件事承担（DOM 见 `.bp-band__title` / `.bp-band__gutter`），
// 落点算法在 `band-bars.ts`（纯函数、可单测）。
// ============================================================

// ============================================================
// Canvas
// ============================================================

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    doc,
    fields,
    layout,
    scale,
    selectedId,
    selectedCellId,
    outOfBoundsIds,
    dropActive,
    dropTarget,
    selectedNode = null,
    kind = 'view',
    onSelect,
    onSelectCell,
    onOpenTableSize,
    onExposeExitEdit,
    onSetMargin,
    onElementIntoCell,
    onSelectNode,
    onMerge,
    onCommitEnd,
    actions,
    newTableId,
    onResizeTable,
    onCloseTableSize,
    onDropTargetChange,
  },
  ref,
) {
  const paperRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 正在就地编辑的单元格（仅表格元素用；null 表示编辑的是元素自身） */
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * 正被拖到"版式区上边界"上、已经推不动的元素 id。
   *
   * 为什么需要它：版式区的上边界是硬约束（循环区元素不能压到页级重复区上），元素顶到边界后
   * 再怎么拖位置都不变 —— 如果画面上没有任何反应，用户会认为"拖动坏了"，
   * 而不是"到头了"。所以顶住期间给出可见反馈（描边 + 一枚"已贴版式区上边"小标）。
   */
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  /**
   * 当前鼠标悬停的元素 id（2026-09-19）。
   *
   * 只为**表格悬浮工具栏**服务（见 renderBand 里那段）：工具栏在"悬停或选中"时出现。
   * 用 `onPointerEnter/Leave` 而不是 `onPointerOver/Out`：后者会在子元素之间反复触发
   * （表格里全是 `td`），每次进出都 setState 会把画布刷爆。
   */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** Esc 取消编辑时置位，防止随后的 blur 把内容又提交回去 */
  const cancelledRef = useRef(false)

  /**
   * 选中表格时，**行边框手柄**的纵向位置（未缩放 CSS px，相对表格左上角）。
   * 每行一条，**最后一条就是表底边**（= 最后一行的下边框）—— 那里也要有手柄，
   * 否则"最下面那一行"的高度调不了（需求 ⑧）。
   *
   * 为什么行手柄要量 DOM、列手柄却不用：
   *   列宽是**显式给定**的（`colWidthsMm`），按列宽占比换算就准；
   *   行高是可选的 —— `TableRow.heightMm` 为空时由内容撑开，而模型里估的高与画出来的差得远
   *   （这个文件 resolveDrop 上面那段注释记着实测：估 20mm，实际 9.08mm）。
   *   与其再造第三份"单元格几何"，不如直接量真正画出来的 `<tr>` —— 与落点判定同一个道理。
   */
  const [rowEdges, setRowEdges] = useState<number[]>([])

  /** 正在拖 / 缩放时显示的对齐参考线（内容坐标，mm）。松手即清 */
  const [guides, setGuides] = useState<GuideLine[]>([])

  /**
   * 拖行高 / 列宽时的**预览线 + 数值浮层**（用户规格 三）。
   *
   * 规格原话："按下拖拽时：显示一根 1px 主题色（蓝色）预览线跟随鼠标，
   * 旁边浮层显示当前像素值（如 120px）。"
   *
   * 坐标用**视口坐标系**（`position: fixed`）：拖动过程中手指下那一根线必须**1:1 跟手**，
   * 而纸张整体有 `transform: scale()` —— 换算成纸张坐标再乘回去，只要有一次取整就会"线在手指旁边 1px 处抖"。
   * 起点直接取按下时的 `clientX/clientY`（那一下就落在边界线上），于是预览线天然与指针重合。
   */
  const [sizeGhost, setSizeGhost] = useState<{ axis: 'col' | 'row'; x: number; y: number; label: string } | null>(null)
  /**
   * 表格的**编辑态**（真机反馈 2026-09-22 第 6 条）。
   *
   * 未编辑时：悬浮菜单只给「编辑表格 / 删除表格」，**不显示**行首列首的「+」等编辑手柄；
   * 编辑中：手柄全出（加号 / 行首列首 / 拖拽调尺寸），菜单换成编辑功能 + 「完成编辑」。
   * 这样平时是一块可移动的内容，点了编辑才是一张可改的表。
   */
  /*
   * 模板图片的临时链接（`fileToken → url`）。
   * 固定图片走附件存时，元素里只有 token —— 渲染前必须先换成 URL，见 store 的文件头。
   */
  const tplImageUrls = useSyncExternalStore(subscribeTemplateImageUrls, getTemplateImageUrls, () => EMPTY_IMAGE_URLS)

  /*
   * ⚠️ 诊断（2026-10-19）：用户报"图片糊"时，先确认**画布到底拿到了什么**。
   * 用 `warn` 而不是 `info`：控制台默认级别下 info 有可能被过滤掉，
   * 之前那条 info 在用户机器上一次都没显示（无法区分"没执行"和"被过滤"）。
   */
  useEffect(() => {
    const imgs = docImageElements(doc)
    console.debug('[BP 模板图片] 画布挂载', {
      images: imgs.length,
      tokens: imgs.map((i) => i.fileToken ?? null),
      names: imgs.map((i) => i.fileMeta?.name ?? null),
      urlKeys: [...tplImageUrls.keys()],
    })
    // 只在挂载时看一次（后面每次渲染都打会淹掉控制台）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** 图片元素的最终 src：**token 链接优先**（原图），取不到退回内联的 dataUrl（老模板/降级） */
  const imgSrcOf = (el: {
    dataUrl?: string
    fileToken?: string
    fileMeta?: { name: string }
  }): string => {
    /*
     * 三级：**token → 附件名 → 内联 dataUrl**。
     * 中间那级是 2026-10-19 加的：`batchUploadFile` 返回的 token 与附件字段里最终存下的
     * token 可能不是同一个值（飞书入库时会重写），只按 token 查会永远命中不了。
     * 附件名是我们自己在保存时写进去的（`tplimg-<elementId>`，唯一），不受重写影响。
     */
    const byToken = el.fileToken ? tplImageUrls.get(el.fileToken) : undefined
    const byName = el.fileMeta?.name ? tplImageUrls.get(el.fileMeta.name) : undefined
    return byToken || byName || el.dataUrl || ''
  }

  const [editTableId, setEditTableId] = useState<string | null>(null)
  /**
   * 把"退出表格编辑态"注册给宿主（2026-09-23 真机反馈第 5 条：全屏下 Esc 该**先退编辑**、
   * 而不是把整块画布缩回小尺寸）。宿主（`EditorShell`）的 Esc 仲裁链需要两样东西：
   * 「现在有没有在编辑」的判据 + 「怎么退出去」的动作，而 `editTableId` 是画布内部状态 ——
   * 用注册回调比受控 prop 提升改动小得多（后者要动画布里 3 处 `setEditTableId`）。
   * 每次 `editTableId` 变化就重注册一次，宿主拿到的永远是**当前**那个函数。
   * ⚠️ 卸载/编辑结束时注册 `null`（表示"没在编辑"），否则宿主会拿着一把过期的钥匙。
   */
  useEffect(() => {
    if (!onExposeExitEdit) return
    onExposeExitEdit(
      editTableId
        ? () => {
            setEditTableId(null)
            // 顺带清掉格子选区：编辑表格与"选中某几个格子"是同一件事的两面
            setCellSel(null)
            return true
          }
        : null,
    )
    return () => onExposeExitEdit(null)
  }, [editTableId, onExposeExitEdit])
  /** 选中项一旦不再是那张表（点了别的元素 / 空白），就退出编辑态 —— 不留一个幽灵编辑态 */
  useEffect(() => {
    if (editTableId && selectedId !== editTableId) setEditTableId(null)
  }, [editTableId, selectedId])

  /**
   * 正在原地编辑的那一侧页边距（真机反馈 2026-09-22：不要弹原生窗口，就地改）。
   * `value` 存**字符串**：用户输到一半的 `1`、`12.`、空串都要原样留着，不然光标会跳。
   */
  const [editMargin, setEditMargin] = useState<{ side: 'top' | 'right' | 'bottom' | 'left'; value: string } | null>(null)

  /** 提交页边距：非法输入（NaN / 负数 / > 60）一律**忽略并退出编辑**，不动文档 */
  const commitMargin = useCallback(
    (side: 'top' | 'right' | 'bottom' | 'left', raw: string, fallback: number) => {
      const n = Number(raw.trim())
      setEditMargin(null)
      if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 60) {
        if (raw.trim() !== '' && !Number.isFinite(n)) onSetMargin(side, fallback)
        return
      }
      onSetMargin(side, Math.round(n * 10) / 10)
    },
    [onSetMargin],
  )

  /** 从格子里往外拖子元素时跟着指针的小浮标（规格 六）。视口坐标，与预览线同理 */
  /**
   * 拖动格内元素时的**跟随显示**（2026-10-13 起支持"渲染元素本体"）。
   *
   * ⚠️ 原来只有 `{x, y, label}`（一个文字胶囊）。用户口径：
   *   「元素**不能闪现出现**，而是拖动的时候**依然要跟手移动**，用户可以**实时看到元素的状态**，
   *    如果是拖动到单元格外，元素的**样式应当在拖动过程中就变换**」。
   * ⇒ 拖出格子的那一刻要把**元素本体**跟着鼠标画出来（用画布样式），
   *   而不是等松手才让它"跳"到画布上。
   *
   * ⚠️ `child` 只在"已脱离格子"时给（未脱离时元素自己就在格子里跟手，不需要 ghost）。
   */
  const [childGhost, setChildGhost] = useState<{
    x: number
    y: number
    label: string
    /** 脱离格子时带上元素本体与它在画布上的尺寸（mm），供渲染 */
    child?: AnyElement
    wMm?: number
    hMm?: number
  } | null>(null)
  /*
   * ⚠️ **"顶到边界"的视觉反馈**（2026-10-15 用户要求："醒目地知道已经在蓄力了"）。
   *
   * 为什么需要：为了修"压线/脏数据"，`xPct`/`yMm` 都被夹死了 ⇒
   *   顶到边界后元素**一动不动** ⇒ 用户看不到"我还在往外推"。
   * ⇒ 这里只记一个**布尔状态**，渲染时给元素加 `is-pushing` 类（脉冲发光）。
   *   **只影响观感、不碰数据** —— 数据那条线仍然严格夹紧。
   */
  const [childPush, setChildPush] = useState<{
    cellId: string
    l: boolean
    r: boolean
    t: boolean
    b: boolean
  } | null>(null)
  /** ⚠️ 防抖：只在"顶到哪几条边"真的变化时才 setState（否则拖动每帧都 setState，会卡） */
  const childPushRef = useRef('')
  /*
   * ⚠️ **定位辅助线**（2026-10-16 用户要求："拖动时有定位辅助线" + "要有一定的吸附作用"）。
   *
   * `lineX` / `lineY`：参考线的位置（**百分比 %** / **mm**），`null` = 这个方向没对齐到任何线。
   * 画在 `<td>` 里（绝对定位 + 百分比）⇒ 随格子移动天然跟着走。
   * ⚠️ **与 `childPush`（被挤压边高亮）分开** —— 语义不同
   *   （一个"顶到边界"、一个"对齐到参考线"），合并会出现"两个都对但只显示一个"。
   */
  const [childSnap, setChildSnap] = useState<{
    cellId: string
    lineX: number | null
    lineY: number | null
  } | null>(null)
  /** ⚠️ 防抖：只在"吸附目标"变化时才 setState（拖动每帧都 set 会卡） */
  const childSnapRef = useRef('')

  useLayoutEffect(() => {
    /*
     * ⚠️ 2026-09-22：目标从 `selectedId` 扩成 `selectedId ?? hoverId`。
     * 规格 一·二 要求**行手柄与行首「+」在悬停时就能看见**，而行高只能量 DOM
     * （`heightMm` 为空时由内容撑开，模型里估的高与画出来的差得远 —— 见上面那段实测）。
     * 只按 selectedId 量 ⇒ 悬停时 `rowEdges` 是空数组 ⇒ **行手柄与行「+」一个都不渲染**
     * （实测读数 `{cols: 4, rows: 0}`：列手柄全在、行的一个没有）。
     */
    const targetId = selectedId ?? hoverId
    const host = targetId ? paperRef.current?.querySelector<HTMLElement>(`[data-el-id="${targetId}"]`) : null
    const tbl = host?.querySelector<HTMLTableElement>('table.bp-el-table') ?? null
    if (!tbl) {
      setRowEdges((cur) => (cur.length === 0 ? cur : []))
      return
    }
    const next: number[] = []
    for (const tr of Array.from(tbl.querySelectorAll<HTMLElement>('tbody > tr'))) next.push(tr.offsetTop + tr.offsetHeight)
    // 不 pop：最后一条是表底边，那里也要有个手柄去调"最后一行"的行高（需求 ⑧）。
    // 只在真的变了时写回：测量 → setState → 重渲染 → 再测量，不给它打转的机会
    setRowEdges((cur) =>
      cur.length === next.length && cur.every((v, i) => Math.abs(v - next[i]) < 0.5) ? cur : next,
    )
  }, [selectedId, hoverId, doc])

  const render = pageRenderSize(doc.pageSetup)
  const content = contentBoxSize(doc.pageSetup)
  const margin = doc.pageSetup.margin
  const grid = gridOptions(doc.pageSetup)
  const oob = useMemo(() => new Set(outOfBoundsIds), [outOfBoundsIds])

  /** mm → 未缩放 CSS px */
  const pxOf = useCallback((mm: number) => mmToPx(nz(mm, 0)), [])

  // 左侧页边距槽：够宽才放版式区标签。标签字号用 --bp-inv 反向缩放，屏幕上恒定约 9px，
  // 因此它在纸张坐标系里占的宽度是 26px/inv —— 槽宽必须大于它，否则会溢进正文。
  const inv = 1 / Math.max(scale, 0.05)
  /**
   * 版式区标签（表头 / 循环 / 表尾）的槽宽。
   *
   * ⚠️ 标签挂在纸张**左侧外面**（用负 `left`），**本来就不受页边距宽度约束**；
   * 但下面那个 `>= 34px` 的闸门是按"标签写在页边距里"的老做法设的，
   * 于是 2026-09-19 把默认页边距从 20mm 调到 12mm 之后，
   * 12mm 在画布缩放下只有约 31px ⇒ **闸门没过 ⇒ 三个版式区标签全部不显示了**。
   * 用户原话："表头区和表尾区也没有可以调整的地方，**看也看不到**。"
   *
   * ⇒ 给标签一个**最小槽宽**（40px，够放"表头/循环/表尾"两个字），不随页边距收缩。
   */
  const TAG_MIN_PX = 72
  const gutterPx = Math.max(pxOf(margin.left), TAG_MIN_PX * inv)
  const showGutterTags = gutterPx >= 34 * inv

  /**
   * 「你现在在哪一个分区」——三条带里唯一被高亮的那条。
   *
   * 用户原话把这件事说得很清楚："循环区（**橙色高亮，因为现在在循环区**）" ⇒
   * 高亮表达的是**当前所在**，不是"循环区天生是橙的"。
   * 判据取**选中元素所在的区**（没选中时退回 `loop` —— 新元素默认落在这里，
   * 也是绝大多数模板的主战场）。这样"选中循环区里的表格 ⇒ 循环区亮"是自解释的。
   */
  const activeBand = useMemo<BandKey>(() => {
    if (selectedId) {
      for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
        if (readBand(doc, b).some((e) => e.id === selectedId)) return b
      }
      /*
       * 选中的是**格内子元素**：它自己不在任何版式区里，但它所在的那张表在。
       * 不补这一步，“表头区那张表格里的图片被选中 ⇒ 循环区被高亮” —— 高亮在讲一件错的事。
       */
      const owner = parseCellChildId(selectedId)
      if (owner) {
        for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
          const table = readBand(doc, b).find((e) => e.id === owner.tableId)
          if (table) return b
        }
      }
    }
    return 'loop'
  }, [doc, selectedId])

  /**
   * 三条分区的**像素几何**（paper 坐标系，未叠加画布缩放）。
   * 高度用 `computeBandLayout` 的真实值 —— 空分区的高度就是 0，不许在这里"补一个好看的数"，
   * 否则画出来的边界线是假的（用户会照着一个不存在的边界去放东西）。
   */
  const bandGeoPx = useMemo((): Record<BandKey, BandGeometry> => {
    const headerH = pxOf(layout.loopTopMm)
    const loopTop = headerH
    const loopH = pxOf(layout.loopExtentMm)
    const footerTop = pxOf(layout.footerTopMm)
    const footerH = Math.max(0, pxOf(content.h) - footerTop)
    return {
      header: { key: 'header', topPx: 0, heightPx: headerH },
      loop: { key: 'loop', topPx: loopTop, heightPx: loopH },
      footer: { key: 'footer', topPx: footerTop, heightPx: footerH },
    }
  }, [layout.loopTopMm, layout.loopExtentMm, layout.footerTopMm, content.h, pxOf])

  /**
   * 标签条 / 左侧竖排标签的落点（纯函数在 band-bars.ts，含"空分区不画条""挤了就下推"两条规则）。
   * 尺寸都要乘 `inv`(=1/缩放)：画布整体 `transform: scale()` 会把这些小标签一起缩小，
   * 乘回去之后**屏幕上视觉尺寸恒定**（18px / 11px），这是本文件的既定做法（见 `--bp-inv`）。
   */
  const BAND_BAR_PX = 18 * inv
  const bandBars = useMemo(
    () =>
      layoutBandBars(Object.values(bandGeoPx), {
        barHpx: BAND_BAR_PX,
        gapPx: 2 * inv,
        // 带太矮塞不下一条 18px 的标签条 ⇒ 不画条（名字交给左侧竖排标签，那里不挤）
        minBandPx: BAND_BAR_PX * 1.15,
      }),
    [bandGeoPx, BAND_BAR_PX, inv],
  )
  /*
   * ⚠️ `labelHpx` 以前写的是 16px —— 那是**横排**标签的高度；竖排标签的高度等于**它的文字长度**，
   *    真实值约 3 字 × 9px + 内边距 ≈ 40px ⇒ 原来三条标签必然互相压（真机反馈：「三个标签不要挤压」）。
   *    现在按最长名字（3 字）算，并留 6px 间隙。
   */
  const bandGutters = useMemo(
    () =>
      layoutBandGutters(Object.values(bandGeoPx), {
        labelHpx: (BAND_META.header.name.length * 9 + 10) * inv,
        gapPx: 6 * inv,
      }),
    [bandGeoPx, inv],
  )


  // 循环区「一张连续大表」时，画布上仍是模板原样（一行），真正的按记录铺开发生在导出/打印时。
  // 不说清楚的话，用户会以为开关没生效。判定口径与渲染层 mergedLoopTableOf 一致。
  const loopOnly = doc.bands.loop.elements.length === 1 ? doc.bands.loop.elements[0] : null
  const continuousTable = !!loopOnly && loopOnly.kind === 'table' && loopOnly.rowsFromRecords === true

  /**
   * 分区标签的 tooltip。循环区那条要**分情况说话**，因为它有三种完全不同的行为：
   *   · 连续大表：画布按模板原样显示一行，导出时才按记录铺开；
   *   · 记录模板：循环区只渲染首行（一条记录一份）；
   *   · 其余：按行重复。
   * 这几句原来挂在胶囊的 `hint` 上，2026-09-22 分区带重做时原样搬到标签条/竖排标签的 title 上 ——
   * 句子是**同一个事实**，不该因为换了载体就被丢掉。
   */
  const bandTip = useCallback(
    (k: BandKey): string => {
      if (k === 'loop') {
        return continuousTable
          ? '画布按模板原样显示，导出时按记录逐行铺开'
          : kind === 'record'
            ? '记录模板下循环区只渲染首行'
            : BAND_HINT.loop
      }
      return k === 'header' ? BAND_HINT.header : BAND_HINT.footer
    },
    [continuousTable, kind],
  )

  /**
   * 表头区元素的**估算底边**（mm，版心坐标系）—— 渲染层 `headerReserve` 的画布等价量。
   *
   * ⚠️ 它**只用来做避让上限**，绝不能再当循环区的 `floorMm`（那是真机反馈第 3 条的现场）：
   *
   * 真机反馈 2026-09-23 第 3 条：「拖动表头区的元素时，会带动循环区的元素移动」（附 GIF）。
   * 上一批已经把 `computeBandLayout` 改成"分区互不依赖"，但画布这边**又把它装回去了** ——
   * 循环区元素的落点当时是 `max(el.y + (loopTop - headerReserve), headerReserve)`，
   * 而 `headerReserve` 是表头区元素的实测底边：在表头里往下拖 3mm，它就从 12 变 15，
   * 落点跟着从 12 变 15，整个循环区被推下去 —— GIF 里那个"表格整体下移"就是这么来的。
   *
   * 现在改用**声明值优先**（见下面 `loopStartMm`）：`headerReserve` 只在
   * "表头内容真的比声明高度还高"时才会顶上去（不避让就会与循环区叠在一起）。
   * 而表头区元素被夹在这一带之内（见 `beginSession` 的 `ceilMm`），
   * `headerReserve ≤ layout.loopTopMm` 是个**不变量** ⇒ 拖表头元素不会让循环区动一分。
   */
  const headerReserveMm = useMemo(
    () => doc.bands.header.reduce((m, el) => Math.max(m, nz(el.y, 0) + elementHeightMm(el)), 0),
    [doc.bands.header],
  )
  /**
   * 循环区起点（mm）= `max(用户声明的表头区高度, 表头块估算底边)`。
   *
   * ⚠️ 这个公式必须与渲染侧 `render/pipeline.ts` 的 `loopOffset` **逐字一致**
   *    （那边用实测高度，这边用估算）—— 两份实现一旦分叉，
   *    就会出现"画布上摆得好好的、打印出来整体偏几毫米"这类极难归因的问题。
   */
  const loopStartMm = Math.max(layout.loopTopMm, headerReserveMm)

  /**
   * 表尾区整组占用的高度（mm）—— 渲染层 `footerReserve`（`render/layout.ts:176`
   * 对表尾块的 `reservedHeight`）的画布等价量，同样把"实测"换成"估算"。
   *
   * 打印侧表尾是**从版心底部往上量**的（`render/layout.ts:409-410`）：
   * `top = max(0, contentH - footerReserve)`，块落在 `top + el.y`。
   * 实测（见任务 5 第 1 步）：同一模板 1 / 6 / 20 / 60 条记录下，表尾两条的
   * 打印 y 恒为 263.75 / 271.64mm，一个字都不动 —— 记录数只影响循环区，
   * 表尾永远贴着版心底部（最底那条的底边正好落在版心边界 277mm 上）。
   */
  const footerReserveMm = useMemo(
    () => doc.bands.footer.reduce((m, el) => Math.max(m, nz(el.y, 0) + elementHeightMm(el)), 0),
    [doc.bands.footer],
  )

  /**
   * 版式区把元素往下推多少（`offsetMm`）、推到哪儿就不许再往上（`floorMm`）。
   *
   * ⚠️ **两个数必须只来自"该区自己声明的量"**（2026-09-23 真机反馈第 3 条）：
   *    只要有一个数来自别区的**内容高度**，那个区就会"被拖走"。
   *    这里每个区的 offset 与 floor 都取同一个值，于是落点恒为 `起点 + el.y`，
   *    拖别区的元素不会让本区动一分。
   *
   *  - 表头区 `placeBlock(b, b.xMm, b.yMm)` —— 绝对定位，每页克隆一份，起点 = 0
   *  - 循环区 起点 = `loopStartMm`（= `max(声明值, 表头块估算底边)`，见上面）
   *  - 表尾区 起点 = `layout.footerTopMm`（贴版心底部，且已有保底高度）
   *    —— 打印时表尾是从版心**底部往上量**的（`render/layout.ts` 的
   *    `top = max(0, contentH - footerReserve)`）。画布**故意不照抄**那个位移：
   *    底部锚定下"最靠下的那条表尾元素"画出来恒等于 `contentH - h`，与它自己的 y
   *    毫无关系 —— 拖动它画布上纹丝不动，反是同区其它元素跟着往上跑，那一区就没法编辑了。
   *    所以画布按"版式区自上而下"堆叠，真实打印落点由 `.bp-band__note` 明说。
   */
  const bandGeom = useCallback(
    (band: BandKey): { offsetMm: number; floorMm: number } => {
      if (band === 'loop') return { offsetMm: loopStartMm, floorMm: loopStartMm }
      if (band === 'footer') return { offsetMm: layout.footerTopMm, floorMm: layout.footerTopMm }
      return { offsetMm: 0, floorMm: 0 }
    },
    [layout.footerTopMm, loopStartMm],
  )

  /**
   * 元素在画布上的 y（**版心内** mm，不含页边距）。
   *
   * ⚠️ 曾经这里是直接 `el.y`，于是「通用清单」的列头表（每页重复区）与数据表（循环区）
   * 在画布上**完全叠在一起**：循环区那张表既看不见、也只能靠撒点采样才点得到，
   * 刚做的「多记录并成一张大表」开关几乎不可达。根因是 `el.y` 一律从版心顶部算，
   * 而循环区元素的真正落点还要叠加版式区的起点（见上面 `bandGeom` 的注释）。
   */
  const bandTopMm = useCallback(
    (band: BandKey, el: AnyElement): number => {
      const { offsetMm, floorMm } = bandGeom(band)
      return Math.max(nz(el.y, 0) + offsetMm, floorMm)
    },
    [bandGeom],
  )

  /**
   * 某个版式区里所有元素的**画出来的**盒子（mm）。
   *
   * y 一律过一遍 `bandTopMm`（不是模型里的 `el.y`）：循环区元素会被页级重复区顶下去 20mm，
   * 拿模型 y 去比，算出来的线和重叠区都会落在离两个元素都不对的地方。
   * 高度与 `renderBand` 里写 CSS 用的是同一个表达式（`elementHeightMm` / `heightOf`）。
   *
   * 对齐线（guidesFor）与重叠区（overlaps）都从这里取 —— 两处各建一套坐标的话，
   * "同一个量两处各写一套"这个坑就又要踩一次（这个文件已经栽过三次）。
   */
  const bandBoxes = useCallback(
    (band: BandKey): BoxMm[] =>
      readBand(doc, band).map((e) => ({
        id: e.id,
        x: nz(e.x, 0),
        y: bandTopMm(band, e),
        w: Math.max(1, nz(e.w, 20)),
        h: e.h === 'auto' ? Math.max(1, elementHeightMm(e)) : Math.max(1, heightOf(e.h, 10)),
      })),
    [bandTopMm, doc],
  )

  /**
   * 文档级参考线（2026-09-22 新增）：版心左 / **版心水平居中** / 版心右 / 纸张居中 /
   * 分区边界。用户原话："需要更加适用、智能，**不仅仅和其他元素关联，能识别整个文档居中等位置**"。
   *
   * 与元素间对齐线**同一套容差、同一条渲染路径**（都从 `computeGuides` 出来），
   * 唯一区别是渲染时多挂一个 `is-doc` 类（画得实一点）+ 一枚小标签（写清是哪条基准线）。
   */
  const docRefs = useMemo(
    () =>
      buildDocRefs({
        contentW: content.w,
        contentH: content.h,
        margin,
        bandTopsMm: { loop: layout.loopTopMm, footer: layout.footerTopMm },
      }),
    [content.w, content.h, margin, layout.loopTopMm, layout.footerTopMm],
  )

  /**
   * 拖 / 缩放过程中算一次对齐参考线。**只在同一版式区里比**。
   *
   * 三件事都只在调用方看得见，所以写在这里：
   *   ① y 用"画出来的位置"（过一遍 `bandTopMm`）而不是 `el.y`。循环区的元素会被页级
   *      重复区顶下去 20mm，拿模型 y 去比，线会画在离两个元素都不对的地方；
   *   ② 只在同一 band 内比。跨版式区比"对齐"没有意义（它们本来就不在一个坐标系里跑）；
   *   ③ 只画线、**不吸附**。吸附已经由网格那条路负责（`snapMm`），两套吸附同时生效会打架 ——
   *      指针往左一点，网格吸到 5mm，对齐线又把它拽回 6mm，手感是"拖不动"。
   *      ⚠️ 文档级参考线**同样遵守这条**：本次只让它们参与"画线"，不参与吸附。
   *         （`computeGuides` 会顺带算出 `snapped`，这里刻意不取 —— 见上面那条理由。）
   *
   * mm → px 的换算只在渲染那一行（`pxOf`），这里从头到尾是 mm。
   */
  const guidesFor = useCallback(
    (band: BandKey, box: BoxMm): GuideLine[] => {
      const others = bandBoxes(band).filter((b) => b.id !== box.id)
      return dedupeGuides(computeGuides({ moving: box, others, refs: docRefs }).guides)
    },
    [bandBoxes, docRefs],
  )

  /**
   * 任意两个元素的**重叠区**（mm，画出来的坐标），在全模板范围内两两求交。
   *
   * 需求 ⑨ 取消了"元素不能重叠"的拦截，重叠本身不再被阻止 —— 于是"哪里叠了"
   * 必须看得见，否则用户只能靠肉眼在一堆框里找（需求 ⑩：重叠区域用另一种颜色展示）。
   *
   * 性能取舍（刻意**不**做的东西写在这里，免得下次有人"优化"）：
   *   · 全是 mm 空间的纯算术，**一次 DOM 测量都没有**（所以每次 doc 变化重算也不疼）；
   *     真正的坐标只有渲染那一行的 `pxOf` 才转成 px —— 与全文件的约定一致。
   *   · 两两相交是 O(n²)，但 n 是"一页上的元素个数"，几十个也就是几百次浮点比较，
   *     比一次 React 重渲染便宜得多。因此**不引入**虚拟化 / 网格索引 / 空间哈希这类东西。
   *   · `useMemo` 只认 `bandBoxes`（= doc + 版式区几何），拖动时每帧重算的代价即上面那点算术。
   */
  const overlaps = useMemo(() => {
    const boxes = (['header', 'loop', 'footer'] as BandKey[]).flatMap((b) => bandBoxes(b))
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        const x = Math.max(a.x, b.x)
        const y = Math.max(a.y, b.y)
        const w = Math.min(a.x + a.w, b.x + b.w) - x
        const h = Math.min(a.y + a.h, b.y + b.h) - y
        // 0.05mm 才认：紧挨着的两个元素会因为取整差出千分之几毫米，不该画成"重叠了一条线"
        if (w > 0.05 && h > 0.05) out.push({ x, y, w, h })
      }
    }
    return out
  }, [bandBoxes])

  // ---- 命中测试 ----
  /**
   * 屏幕坐标 → 版心坐标(mm) 的**唯一一份**换算，`onPaper` 顺带报出"在不在纸张里"。
   *
   * 为什么要抽出来：`hitTest` 要的是"夹进版心之后的落点"，`resolveDrop` 要的是
   * **夹之前**的原始位置（下页边距里的落点必须被拒，见 ⑪ 那段）。两处各写一套
   * pxPerMm / margin 换算的话，改了一处另一处不会跟着变 —— 这个文件已经栽过三次。
   */
  const toContent = useCallback(
    (clientX: number, clientY: number): { xMm: number; yMm: number; onPaper: boolean } | null => {
      const paper = paperRef.current
      if (!paper) return null
      const r = paper.getBoundingClientRect()
      if (!Number.isFinite(r.width) || r.width <= 0) return null
      // r.width 是缩放后的视觉宽度，除以纸张 mm 宽即得"每 mm 多少屏幕像素"
      const pxPerMm = r.width / Math.max(render.w, 1)
      if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null
      // 纸张左上角为原点、还没减页边距的"原始"落点。分开成两个方向各一份，
      // 是因为下面 `onPaper` 还要按屏幕矩形判一次，横纵两轴的参照边不同。
      const rawX = (px: number): number => (px - r.left) / pxPerMm
      const rawY = (px: number): number => (px - r.top) / pxPerMm
      return {
        xMm: rawX(clientX) - margin.left,
        yMm: rawY(clientY) - margin.top,
        onPaper: clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom,
      }
    },
    [margin.left, margin.top, render.w],
  )

  /**
   * 指针底下是**哪一个单元格**（找不到就 null）。
   *
   * ⚠️ 必须用 `elementsFromPoint`（**整摞**命中）而不是 `elementFromPoint`：
   *    拖动时被拖的东西（元素本身 / 拖拽浮标 / 格内子元素）就压在指针底下，
   *    `elementFromPoint` 只拿最上面那一个 ⇒ `closest('td')` 恒为 null
   *    ⇒「拖进格子」这条链路上全线失灵。本项目在这一点上栽过**两次**
   *    （一次拖已有元素、一次拖格内子元素）。
   *
   * 这段"整摞穿透 + closest"的逻辑原来在本文件里**抄了三遍**（落点判定 / 拖格内子元素 /
   * 拖已有元素落格），三份的差别只有变量名 —— 任何一份漏改都会让某一条路悄悄失灵，
   * 而失灵的表现一律是"没反应"。现在只有这一份。
   */
  const cellAtPoint = useCallback((clientX: number, clientY: number): { tableId: string; cellId: string } | null => {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      const td = (node as HTMLElement | null)?.closest?.('td[data-cell-id]') as HTMLElement | null
      if (!td) continue
      const cellId = td.getAttribute('data-cell-id') ?? ''
      const tableId = td.closest('[data-el-id]')?.getAttribute('data-el-id') ?? ''
      if (cellId && tableId) return { tableId, cellId }
    }
    return null
  }, [])

  const hitTest = useCallback(
    (clientX: number, clientY: number): DropHit | null => {
      const at = toContent(clientX, clientY)
      if (!at || !at.onPaper) return null
      // 落在页边距里不拒绝，直接吸附到版心内 —— 否则"差一点点"就插不进去，体感很差。
      // 先吸附再钳制：反过来的话，吸附可能把已经钳到边界的坐标又推出去半格。
      const snapClamp = (v: number, max: number): number =>
        Math.min(Math.max(snapMm(v, grid.gridMm, grid.snapToGrid), 0), Math.max(0, max))
      return {
        xMm: snapClamp(at.xMm, content.w),
        yMm: snapClamp(at.yMm, content.h),
      }
    },
    [content.h, content.w, grid.gridMm, grid.snapToGrid, toContent],
  )

  /**
   * 投放判定。
   *
   * 为什么这一步必须由画布来做、不能放到 EditorShell：
   * "落点在哪个格子里"只有 DOM 知道 —— 表格行高是可选的（`row.heightMm` 为 0 时由浏览器按内容撑开），
   * 模型里的高度是估的、和真正画出来的差得远（实测页级列头表 9.08mm vs 估算 20mm）。
   * 与其再造第三份"单元格几何"，不如直接问真正画出来的那个 `<td>`。
   */
  const resolveDrop = useCallback(
    (clientX: number, clientY: number, probe: DropProbe): DropVerdict => {
      const at = toContent(clientX, clientY)
      if (!at) return { kind: 'reject', reason: '画布还没准备好，请再试一次' }
      if (!at.onPaper) return { kind: 'reject', reason: '松手的位置不在纸张上，没有插入' }

      /*
       * 下页边距里**不收**（需求 ⑪）。
       *
       * 落点是元素的**左上角**，元素只会往右下长。落点落在版心底边之下时，
       * `hitTest` 会把它夹到 `content.h` —— 元素整块吊在版心外、压在下页边距上，
       * 编辑期看得见，打印时那片区域什么都没有（用户原话："元素可以正常拖放过去，
       * 但实际打印预览界面不会显示内容"）。这里直接拒绝，"能放下的地方 = 能打印出来的地方"。
       *
       * 为什么只拒下面这一侧：上/左页边距里的落点会被夹到 0，元素往**里**长，落点仍然有效
       * ——"差一点点也能插进去"是刻意的体感，不能一起否掉。右侧同理
       * （`insertPayload` 按元素宽把 x 收回来，落点落在右页边距里也不会跑出版心）。
       */
      if (at.yMm > content.h) {
        return { kind: 'reject', reason: '这里是下页边距，打印时不会显示内容；请放在上面的网格区域内' }
      }

      // 1) 容器（表格单元格）优先：落点在格子里，且这东西塞得进格子
      const hitCell = cellAtPoint(clientX, clientY)
      if (hitCell) {
        const { tableId, cellId } = hitCell
        if (!probe.inline && !probe.cellBlock) {
          return {
            kind: 'reject',
            reason: `格子里能放图片 / 二维码 / 条形码 / 水平线 / 文字 / 字段，装不下「${probe.label}」；请把它放到表格外的空白处`,
          }
        }
        const table = findElement(doc, tableId)?.el
        const loc = table?.kind === 'table' ? findCell(table.rows, cellId) : null
        /*
         * 标题行 / 标题列里不放**字段**（2026-09-23 第 9 条）。
         * 在拖动过程中就拒掉，用户不必等松手才知道 —— 那不是"限制"，是提前把话说清。
         */
        if (probe.field && table?.kind === 'table' && loc && isHeaderCellAt(table, cellId)) {
          return {
            kind: 'reject',
            reason: `标题行 / 标题列里不放字段（「${probe.label}」请放到下面的数据格子里）`,
          }
        }
        const where = table && loc ? `${elementLabel(table)} ${cellLabel(loc)}` : '表格单元格'
        return { kind: 'cell', tableId, cellId, label: where }
      }

      // 2) 元素之间**允许重叠**（需求 ⑨，用户明确要求取消这条限制）：
      //    这里原来有一句"这里已经放了「X」，元素之间不能重叠"的拒绝。
      //    它只在"从左侧面板拖进来"时生效，拖动画布上已有的元素却完全不拦 ——
      //    同一个动作两种结果，本身就是不自洽的。重叠现在只提示、不阻止：
      //    重叠区域由画布上的 `.bp-overlap` 画出来（见下面的 overlaps）。
      return { kind: 'free', xMm: at.xMm, yMm: at.yMm }
    },
    // ⚠️ `cellAtPoint` 必须进依赖（`useCallback` 漏依赖 = 闭包永远停在首次渲染）
    [cellAtPoint, content.h, doc, toContent],
  )

  const scrollToElement = useCallback((id: string) => {
    const paper = paperRef.current
    if (!paper) return
    const node = paper.querySelector<HTMLElement>(`[data-el-id="${id}"]`)
    node?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      hitTest,
      resolveDrop,
      scrollToElement,
      /* ⚠️ 面板那条入口：打开同一个"行高/列宽"对话框（见 `sizeAsk`） */
      askCellSize: (tableId, cellId, kind) => setSizeAsk({ tableId, cellId, kind }),
    }),
    [hitTest, resolveDrop, scrollToElement],
  )

  // ---- 指针会话（拖动 / 缩放共用） ----
  const beginSession = useCallback(
    (
      e: ReactPointerEvent,
      el: AnyElement,
      mode: 'move' | 'resize',
      band: BandKey,
      edge?: ResizeEdge,
    ) => {
      const startX = e.clientX
      const startY = e.clientY
      const ox = finite(el.x, 0)
      const oy = finite(el.y, 0)
      const ow = Math.max(1, finite(el.w, 20))
      const oh = el.h === 'auto' ? Math.max(1, elementHeightMm(el)) : Math.max(1, finite(el.h, 10))
      // 拖动/缩放的锚点取**画出来的位置**，不是模型里的 `el.y`：
      // 版式区会先把元素顶到自己的起点（`bandTopMm` 的 floor），被顶掉的这一段如果
      // 还拿 `el.y` 当锚点，元素就会和指针差一个固定偏移 —— 拖一段完全不动（循环区
      // 元素尤其明显：它被表头区顶下去 20mm，往下拖 20mm 都毫无反应）。
      // 以画出来的位置为锚点后：还能动就是 1:1 跟着指针，动不了就正好停在
      // 版式区的可见边界上，模型里也不会留下"画不出来"的 y。
      const geom = bandGeom(band)
      const oDrawn = Math.max(oy + geom.offsetMm, geom.floorMm)
      /**
       * **表头区元素的天花板**（真机反馈 2026-09-23 第 3 条）。
       *
       * 用户原话：「拖动表头区的元素时，会导致循环区的元素也一起变动……请检查其他区域有没有类似BUG」。
       * 根因：循环区起点原来取 `max(循环区声明起点, 表头区**实测内容高度**)` ⇒
       * 表头元素往下一拖，表头"变高"，整个循环区被顶下去（打印端同理）。
       *
       * 修法不是改渲染公式（那会牵动分页），而是**让表头元素出不了自己的带**：
       * 它的底边不许越过 `layout.loopTopMm`（= 表头区高度，用户可在页面属性里改）。
       * 带内自由活动，带外一步都不给 —— 于是它永远撑不破表头区，也就推不动任何人。
       *
       * 表尾区不需要同理的"地板"：它在画布上就是**贴版心底部**画的（见 computeBandLayout），
       * 往下拖只会把自己拖出可见范围（越界由检查条提示），不会推动别的区。
       */
      const ceilMm = band === 'header' ? Math.max(0, layout.loopTopMm) : Number.POSITIVE_INFINITY
      /** 表头区里，元素底边能到的最远"画出来的 y" */
      const maxDrawnY = Math.max(geom.floorMm, ceilMm - oh)
      // 反解：把"画出来的位置"换算回模型 y
      const toModelY = (drawnY: number): number => Math.max(0, drawnY - geom.offsetMm)
      // 以"另一条边固定"的方式做缩放：先把被拖动的那条边换算成 mm 并吸附，再由两条边反推 x/y/w/h。
      // 增量式（w += dx 再取整）在吸附下会抖动：每次都从已经取整的值再叠加，误差会累积。
      const rightEdge = ox + ow
      const bottomEdge = oy + oh
      /** 下边在**画布坐标系**里的位置：缩放"上边"时要拿它当不动的基准（被 floor 顶过就不等于 bottomEdge） */
      const drawnBottom = oDrawn + oh
      // 每 mm 对应多少屏幕像素：受缩放影响，必须按当前 scale 反算
      const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
      const mergeKey = `${mode}:${el.id}`
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const dxPx = ev.clientX - startX
        const dyPx = ev.clientY - startY
        if (!moved) {
          if (Math.abs(dxPx) + Math.abs(dyPx) < 3) return
          moved = true
        }
        const dx = dxPx * mmPerPx
        const dy = dyPx * mmPerPx
        // 按住 Alt 临时不吸附：拖到"网格中间"的精确位置时用，不必先去关开关
        const snap = (v: number): number => snapMm(v, grid.gridMm, grid.snapToGrid, ev.altKey)

        if (mode === 'move') {
          /*
           * 「允许拖出页面」开关（真机反馈 2026-09-23 第 10 条）：
           * 关着（默认）时把元素**夹在版心内** —— 拖到边缘就停住；
           * 开着才允许越界（越界仍然由检查条提示，不是静默允许）。
           */
          const allowOut = doc.pageSetup.allowOutOfPage === true
          const clampX = (v: number): number => (allowOut ? v : Math.min(v, Math.max(0, content.w - ow)))
          const clampY = (v: number): number => (allowOut ? v : Math.min(v, Math.max(0, content.h - oh)))
          // x 没有版式区偏移，直接按模型 x 吸附（原点就是版心左上角，吸到的位置就是看得见的网格线）
          const nx = clampX(Math.max(0, snap(ox + dx)))
          // y 走"画出来的位置"：先算画布上的落点（夹在版式区上边界内），再反解模型 y。
          // 只钳制到版心左上角，允许拖出右下（越界由检查条提示，不阻止操作，见 F2-14）
          const nd = clampY(Math.min(Math.max(geom.floorMm, snap(oDrawn + dy)), maxDrawnY))
          setPinnedId(nd <= geom.floorMm + 0.01 ? el.id : null)
          setGuides(guidesFor(band, { id: el.id, x: nx, y: nd, w: ow, h: oh }))
          onMerge(el.id, { x: nx, y: round1(toModelY(nd)) }, mergeKey)
          /*
           * ---- 落点反馈（2026-09-23 真机反馈第 4 条）----------------------------------
           *
           * 用户原话：「元素拖到表格上时，没有吸附动画，导致不知道元素最终会落到哪个单元格」。
           *
           * 病根：单元格高亮那一套原本**只接在"从左侧面板拖"那条路**上（`beginPaletteDrag`
           * 里上报 dropTarget），拖**画布上已有的元素**时，`onMove` 从头到尾没有一个字提到单元格
           * —— 只有松手的那一刻才问一次 DOM（见 onUp）。于是整段拖动过程零反馈，
           * 用户只能靠猜。现在拖动过程中实时上报，目标格立刻亮起并脉冲
           * （`.bp-el-cell.is-drop-target` 的 `bpCellSnap` 动画 + "松开即放进这个单元格"提示）。
           *
           * `hit.tableId !== el.id`：拖表格自己时不该提示"放进本表的格子"（表格装不进格子）。
           */
          const hit = cellAtPoint(ev.clientX, ev.clientY)
          onDropTargetChange?.(hit && hit.tableId !== el.id ? { kind: 'cell', cellId: hit.cellId } : null)
          return
        }

        const dir = edge ?? 'se'
        let x = ox
        let y = oy
        let w = ow
        let h = oh
        if (dir.includes('w')) {
          x = snap(ox + dx)
          w = rightEdge - x
        } else if (dir.includes('e')) {
          w = snap(rightEdge + dx) - ox
        }
        if (dir.includes('n')) {
          // 上边同样按"画出来的位置"移动（否则这条边的吸附落点会和画布差一个版式区偏移）。
          // 不动的基准是"画出来的下边"，不是模型里的 `oy + oh` —— 元素被 floor 顶下去时两者不相等。
          const nd = Math.min(Math.max(geom.floorMm, snap(oDrawn + dy)), maxDrawnY)
          setPinnedId(nd <= geom.floorMm + 0.01 ? el.id : null)
          y = toModelY(nd)
          /*
           * ⚠️⚠️ **必须用"画坐标的位移量"算高度**（2026-10-16 修，用户报：
           *   「按住**左上和右上角**两个锚点，稍微拖动，**元素立刻放大、鼠标焦点跟丢**」）。
           *
           * 根因：`drawnBottom` 是**画坐标**（含 `geom.offsetMm` 的版式区偏移），
           *   而 `y = toModelY(nd)` 已经把偏移减掉了 ——
           *   ⇒ 原来的 `h = drawnBottom - y` 是"**画坐标 − 模型坐标**"，**多算了一个 `offsetMm`** ❌
           *   ⇒ 顶部锚点（`n`）一拖，`h / oh` 立刻偏大 ⇒ **等比缩放的 `k` 虚高** ⇒ 元素爆大。
           *   ⚠️ 这也解释了"**只有左上/右上角有问题**"—— 只有它们走 `n` 分支。
           *
           * ✅ 正确算法：**两个画坐标相减**（`nd - oDrawn` = 上边下移了多少）
           *   ⇒ `h = oh − 下移量`，**全程同一坐标系**。
           */
          h = oh - (nd - oDrawn)
        } else if (dir.includes('s')) {
          /* 表头区里往下拉高也要夹住（否则底边越过循环区起点，等于又去推别人） */
          h = Math.min(snap(bottomEdge + dy) - oy, ceilMm - oy)
        }

        /*
         * ⚠️⚠️ **四个"角落"锚点 = 等比缩放**（2026-10-16 用户要求：
         *   「**格外的元素也按照格内元素的缩放逻辑** —— 上下左右四个点可以随意修改，
         *     而拖动**四个角落点，应该是等比例缩放**」）。
         *
         * ⚠️ 与格内那套（`onChildResizeDown` 的 `isCorner` 分支）**同一套规则**：
         *   ① **以"偏离起点更大"的那根轴为准** —— 往横向拉得狠就听横向、往纵向狠就听纵向，
         *      否则会出现"我明明在往右拉，它却先动高度"的别扭手感；
         *   ② **对角固定** —— 拖左边就推 `x`、拖上边就推 `y`（与上面 n/w 分支同一条纪律）。
         * ⚠️ 顶层比格内**简单**：`w` / `h` 都是 **mm** ⇒ `ow / oh` 就是真实比例，不用折算；
         *   格内那条要先把百分比的 `w` 换成 mm（分母 = 内容区宽）。
         * ⚠️ `dir.length === 2` 就是角落（`nw` / `ne` / `sw` / `se`）—— 
         *   四边锚点（`n`/`s`/`e`/`w`）**保持自由拉伸**，行为逐字不变。
         */
        const isCornerResize = dir.length === 2 && ow > 0 && oh > 0
        if (isCornerResize) {
          /*
           * ⚠️⚠️ **用"相对起点的缩放因子"，不是"选一根轴"**（2026-10-16 修）。
           *
           * 我第一版写的是 `devW >= devH ? w : h * ratio` —— 那是**错的**：
           *   元素的**当前宽高比**与"你拉出来的宽高比"不同时，另一根轴会**跳到按比例的值**
           *   ⇒ 表现为"**元素突然放大、锚点脱离鼠标、不跟手**" ✅
           *
           * ✅ 正确写法（与 Figma 一致）：**从 1 倍开始连续变化**
           *   `k = max(w / ow, h / oh)` ⇒ `w = ow * k`、`h = oh * k`
           *   · **起点时 `k = 1`** ⇒ **绝不跳**；
           *   · 取 `max` ⇒ 跟随"鼠标推得更远的那根轴" ⇒ **连续、单调** ⇒ **跟手**。
           */
          const kFromW = w / ow
          const kFromH = h / oh
          const kScale = Math.max(kFromW, kFromH)
          w = ow * kScale
          h = oh * kScale
          /* 对角固定：拖左边 ⇒ 右边界不动；拖上边 ⇒ 下边界不动（与 n/w 分支同算法） */
          if (dir.includes('w')) x = rightEdge - w
          if (dir.includes('n')) {
            /* ⚠️ **同样要同坐标系**（2026-10-16）：`h` / `oh` 都是**模型 mm**，
               所以用 `oDrawn + (oh − h)` 得到新的上边（**画坐标**）；
               写 `drawnBottom − h` 是"画 − 模型"，会多算一个 `geom.offsetMm`。 */
            const nd = Math.min(Math.max(geom.floorMm, oDrawn + (oh - h)), maxDrawnY)
            setPinnedId(nd <= geom.floorMm + 0.01 ? el.id : null)
            y = toModelY(nd)
          }
        }

        const MIN = 4
        // 撞到最小尺寸时，让"被拖的那条边"停在 min 处，另一条边原地不动
        if (w < MIN) {
          if (dir.includes('w')) x = rightEdge - MIN
          w = MIN
        }
        if (h < MIN) {
          if (dir.includes('n')) {
            const nd = Math.max(geom.floorMm, drawnBottom - MIN)
            y = toModelY(nd)
          }
          h = MIN
        }
        // 撞到上/左边界时把宽度还原到边界外侧，保持对边不动
        if (x < 0) {
          if (dir.includes('w')) {
            w = rightEdge
            x = 0
          } else {
            w = Math.max(MIN, w + x)
            x = 0
          }
        }
        if (y < 0) {
          if (dir.includes('n')) {
            h = bottomEdge
            y = 0
          } else {
            h = Math.max(MIN, h + y)
            y = 0
          }
        }
        // 缩放时也画对齐线：拖右边时最想看到的就是"和谁一样宽"。
        // y 传画出来的位置（过 floor），与上面 move 分支同一套坐标。
        setGuides(
          guidesFor(band, {
            id: el.id,
            x,
            y: Math.max(geom.floorMm, y + geom.offsetMm),
            w,
            h,
          }),
        )
        /**
         * ⚠️ **只有真的拖了上/下边，才允许把 `h` 写成数字**（2026-09-18 真机反馈后修正）。
         *
         * 旧式无条件写 `h: round1(h)`，而 `h` 的初值来自 `elementHeightMm(el)` 的**估算值**
         * ⇒ 用户只是横向拖了一下宽度，`h: 'auto'` 就被静默改成了 `5.6`（估算值量化到 0.1mm）。
         * 后果有两个，都很隐蔽：
         *   ① 高度模式从"自动"变成"固定值"（用户在属性面板里才发现）；
         *   ② 同一个 5.6mm，固定值渲染出来比自动矮一点 ⇒ "看着缩水了"。
         * 用户原话："我发现如果手动拖动宽度，那么属性中的'高度模式'就会从自动变为固定值，
         * 这个应该就是 BUG 所在。"
         *
         * ⇒ 移动（`mode==='move'`）与纯横向缩放都**不写 h**；只有 n/s 边才写。
         * 反向对照：本来固定值的元素，横向拖也不会被改回 'auto'（我们只是不写，不是重写）。
         */
        const touchesVerticalEdge =
          mode === 'resize' && !!edge && (edge.includes('n') || edge.includes('s'))
        /*
         * ⚠️ **"任意方向的缩放"**（2026-10-15 三模式重构）。
         *
         * 用户口径：「**用户如果拖动大小，那么自动归类到自由模式**……
         *   ⚠️ 注意：**如果用户没有手动拖动图片的大小，仅仅是拖动了位置，那么就不会归类到自由中**」。
         * ⇒ 判据 = **`mode === 'resize'`（缩放，不是移动）**，**方向不限** ——
         *   原来只认上下边（`touchesVerticalEdge`），于是"只拖左右把手"不会归入自由模式，
         *   用户会觉得"我把框拖窄了，但它还是按适配格渲染"。
         * ⚠️ 与 `touchesVerticalEdge` 分开保留：后者只管"写不写 `h`"（纯横向拖动不该动高度）。
         */
        const touchesAnyEdge = mode === 'resize' && !!edge
        /**
         * 类型放宽到 `unknown`：这个 patch 里既有数字（x/y/w/h）、数组（列宽），
         * 也有**嵌套对象**（附件的 `config`，见下面"自动转固定宽高"）。
         * 调用处本来就有 `as unknown as Partial<AnyElement>`，所以放宽不影响安全性。
         */
        const patch: Record<string, unknown> = {
          x: round1(x),
          y: round1(y),
          w: round1(w),
        }
        if (touchesVerticalEdge) patch.h = round1(h)
        /**
         * **手动拖动缩放 ⇒ 自动转为「固定宽高」**（2026-09-20 用户指定）。
         *
         * 用户原话："手动去拖动缩放的话，自动转为固定宽高"。
         * 道理也很自然：用户亲手把框拖到某个尺寸，就是明确要"就这么大"；
         * 此时若还停留在「原图尺寸 / 固定高度」那些**由内容决定尺寸**的模式，
         * 框会被内容顶回去 —— 用户的手势等于白做（这正是他报"拖不小"的观感来源）。
         *
         * 只对附件元素做这件事（其它图片类元素本来就是用一个固定的框）。
         * 且只在**真的拖了上下边**时改 —— 纯横向拖动不该顺带改尺寸模式。
         */
        const autoFixedBox =
          touchesAnyEdge && el.kind === 'attach' && el.config.sizeMode !== 'fixedBox'
        if (autoFixedBox) patch.config = { ...el.config, sizeMode: 'fixedBox' }
        /**
         * 表格：拖外框改宽度时**必须同步列宽**。
         *
         * 画布把列宽写成**绝对 mm**（`<col style="width:Nmm">`）并配 `table-layout: fixed`，
         * 按 CSS 定宽表格算法 `used width = max(W, Σ列宽)` —— 只改 `w` 不改列宽时，
         * **表格宽度纹丝不动、只有蓝框变窄**。
         * 用户原话："蓝色区域是缩小了，但实际的原表格还保持不变，这个蓝色选区和实际的表格
         * 压根就不是一体的一样。"
         * 打印侧本来就会按 `w` 压缩列宽 ⇒ 修完画布与打印口径也一致了。
         */
        if (el.kind === 'table' && Math.abs(round1(w) - finite(el.w, 0)) > 0.05) {
          Object.assign(patch, scaleColWidths(el as TableElement, round1(w)))
        }
        /*
         * ⚠️⚠️ **高度那半**（2026-10-14 补）——宽边有 `scaleColWidths`，高边一直是空的：
         *   用户实测：「**点击表格的上下锚点拖动大小，只会改变表格外侧的蓝框大小，
         *   表格高度一点没变，只是蓝色选取框变大了**」（左右锚点正常）。
         *   根因：默认 `row.heightMm` 为空 ⇒ 行高**由内容撑** ⇒ 表格高完全不受 `el.h` 影响。
         * ⇒ 与宽边**完全对称**地做一次：按比例缩放各行行高（全自适应时均分），
         *   让 `Σ行高 === el.h` 这个不变量成立（首次拖高会把"自适应行"变成"显式行高"）。
         * ⚠️ 条件是 `touchesVerticalEdge`（真的拖了上下边）—— 纯横向拖动不该顺带改行高。
         */
        /* ⚠️ `h` 是 `number | 'auto'` 且在闭包外可能被改写 ⇒ TS 的收窄会失效，先固化成局部常量 */
        const hNum = typeof h === 'number' ? h : null
        /* ⚠️ `el.h` 同样是 `number | 'auto'` —— `finite` 只收 number/null/undefined ⇒ 先归一 */
        const elHNum = typeof el.h === 'number' ? el.h : 0
        if (el.kind === 'table' && touchesVerticalEdge && hNum !== null && Math.abs(round1(hNum) - elHNum) > 0.05) {
          Object.assign(patch, scaleRowHeights(el as TableElement, round1(hNum)))
        }
        onMerge(el.id, patch as unknown as Partial<AnyElement>, mergeKey)
      }

      const onUp = (ev: PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setPinnedId(null)
        // 参考线是"拖动过程中"的东西，松手就收
        setGuides([])
        // 落点高亮同理：松手就收（否则那一格会一直亮着，看起来像选中）
        onDropTargetChange?.(null)
        /**
         * **拖动已有元素、松手落在表格单元格上 ⇒ 交给上层"放进单元格"**（2026-09-19）。
         *
         * 只在 `mode === 'move'`（不是缩放）且**真的移动过**（`moved`）时判定 ——
         * 单纯点一下不该把元素吞进单元格里。
         *
         * 用 `elementFromPoint` 真问 DOM（而不是拿模型算）：表格行高是可选的、
         * 合并格会错位，只有真正画出来的那个 `<td>` 知道"落点在哪个格子里"
         * —— 这个口径与 `resolveDrop` 完全一致，不另造一套几何。
         */
        if (mode === 'move' && moved && onElementIntoCell) {
          /* 整摞命中交给 `cellAtPoint`（与落点判定、拖格内子元素**同一份**实现）。
             被拖的元素就压在指针下，只有 `elementsFromPoint` 才拿得到底下的 td。 */
          const hit = cellAtPoint(ev.clientX, ev.clientY)
          if (hit && hit.tableId !== el.id) onElementIntoCell(el.id, hit.tableId, hit.cellId)
        }
        // 一次拖动/缩放 = 一步撤销，不给"下一个 800ms"继续合并的机会
        if (moved) onCommitEnd?.()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    // ⚠️ `cellAtPoint` / `onDropTargetChange` / `doc` / `content` 都是被闭包引用的新项，漏进依赖 = 永久失效
    [bandGeom, cellAtPoint, content.h, content.w, doc, grid.gridMm, grid.snapToGrid, guidesFor, onCommitEnd, onDropTargetChange, onMerge, onElementIntoCell, scale],
  )

  /**
   * 拖表格的列 / 行边框线调大小。
   *
   * 列宽走 `setColWidthPatch`：它在改 `colWidthsMm[i]` 的同时把元素总宽 `w` 同步成列宽之和
   * （E-45 的约束）。与右侧面板「第 N 列」输入框调的是**同一个函数** —— 两处各写一遍，
   * 迟早会有一处忘了同步总宽，画布上就表现为"改完列宽，表格右边多出一截/少一截"。
   *
   * 行高走 `setRowHeightPatch`，它的第三态是**自适应**（`heightMm` 缺席）：
   *   · 往下拖到 6mm 以下 → 写回自适应（这一行由内容重新撑开）；
   *   · 双击行边框 → 也是写回自适应（更明确的一条路，不必先拖过头再拖回来）。
   * 写成"下限 6mm"是数据损失 —— 那一行再也长不回去，内容会溢出，所以下限处必须**换态**而不是钳值。
   *
   * 与元素缩放手柄同一套纪律：锚点取按下那一刻的值（不是增量累加），按 `scale` 反算 mm，
   * 松手调一次 `onCommitEnd` 收成一步撤销。
   */
  const onBorderPointerDown = useCallback(
    (
      e: ReactPointerEvent,
      el: TableElement,
      axis: 'col' | 'row',
      index: number,
      /**
       * 拖的是**哪一侧**的边界：
       *   · `'end'`（默认）= 这一列的**右**边界 / 这一行的**下**边界 —— 拖它，另一端（左/上）不动；
       *   · `'start'`      = **表格的**左外框 / 上外框 —— 拖它改**第 1 列宽 / 第 1 行高**，
       *                      但**右边界 / 下边界保持不动**（见下面 `originShift` 的注释）。
       *
       * ⚠️ 为什么要有 `'start'`（2026-10-13 用户反馈："表格的**第一行、第一列**无法用鼠标拖动缩放，
       *    其他行、其他列倒是正常"）：
       *    探针实测（`_probe-table-handles.mjs`）证明**内线是好的** ——
       *    拖第 1 列右沿、第 1 行下沿都能改尺寸。用户拖不动的是**表格的左外框 / 上外框**，
       *    因为那两条边上**压根没有手柄**（旧注释写着"故意不加"）。
       *    ⚠️ 但旧注释的理由（"拖左外框到底算改列宽还是移动元素，一个手柄表达不了"）
       *      **在本项目里其实可以表达**：列宽之和 = 元素总宽（E-45），
       *      所以"改第 1 列宽 + 同步挪 x"的净效果就是**左边界动、右边界不动** ——
       *      正是 Excel 里拖表格左边界的手感。这个语义是唯一的，不存在歧义。
       */
      side: 'start' | 'end' = 'end',
    ) => {
      // 不冒泡：否则 .bp-el 的 pointerdown 会把这一下当成"拖整个元素"
      e.stopPropagation()
      e.preventDefault()
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
      const startColMm = finite(el.colWidthsMm[index], 10)
      // 起始行高：模型里写了就用它，没写（自适应）就用**画出来的**高度当锚点，
      // 否则第一次拖动会从"估的高度"跳一下
      const domTr = (e.currentTarget as HTMLElement)
        .closest('.bp-tbl-size')
        ?.parentElement?.querySelector<HTMLElement>(`tr[data-row-index="${index}"]`)
      const startRowMm = finite(el.rows[index]?.heightMm, domTr ? domTr.offsetHeight / MM_TO_PX : 8)
      /*
       * ⚠️ 元素原点的**起始值**（`x` / `y`，mm）。
       * `side === 'start'` 时要靠它反算"另一端不动"的原点位移 —— 见下面的 `originShift`。
       * ⚠️ 取的是**按下那一刻**的值（不是 `el.x` 的实时值）：拖动过程中每帧都会 patch 文档，
       *    用实时值会**增量累加**，快速拖动时会出现指数级的漂移。
       */
      const startXMm = finite(el.x)
      const startYMm = finite(el.y)
      const mergeKey = `${axis}:${el.id}:${index}`
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const dPx = axis === 'col' ? ev.clientX - startX : ev.clientY - startY
        if (!moved) {
          if (Math.abs(dPx) < 3) return
          moved = true
        }
        const dMm = dPx * mmPerPx
        /*
         * ⚠️ **两侧的"正方向"是相反的**：
         *   · `end` 侧：往右/下拖 = 变大（`+dMm`）；
         *   · `start` 侧：往左/上拖才是变大 ⇒ **取负**。
         * 这样两条手柄的手感一致（"往外拉 = 变大"）。
         */
        const signed = side === 'start' ? -dMm : dMm
        /*
         * 预览线 + 浮层：**每帧更新**（松手才写文档）。
         * 浮层里的像素值按 96dpi 的**打印像素**算（`mm × MM_TO_PX`）—— 那才是"这一行印出来多高"，
         * 而屏幕像素会随缩放变，拿它当读数会让人以为改一次大小值就变了。
         */
        /*
         * 弱吸附（规格 三 的可选项）：新尺寸离「别的行/列已有的尺寸」在 6px 以内就吸上去。
         * ⚠️ 容差在这里从**屏幕 px 换算成 mm**（`mmPerPx` 里已经含缩放）——
         *    判定函数只认 mm，与对齐线同一套纪律。
         * ⚠️ 邻居**排除自己**：不排除的话，拖动一开始就会「吸回自己原来的尺寸」，手感像拖不动。
         */
        const baseMm = axis === 'col' ? startColMm : startRowMm
        const rawMm = baseMm + signed
        const neighbors =
          axis === 'col'
            ? el.colWidthsMm.filter((_, i) => i !== index)
            : el.rows
                .filter((_, i) => i !== index)
                .map((r) => r.heightMm)
                .filter((h): h is number => typeof h === 'number' && h > 0)
        const snappedMm = snapSizeToNeighbors(rawMm, neighbors, 6 * mmPerPx)
        /*
         * ⚠️ 行高掉到下限以下 ⇒ 换态成"自适应"（见函数头的说明）。
         *    **但只允许 `end` 侧这么做**：从**上边框**往下拖到极矮时，
         *    "这一行改由内容撑开"会让高度变成不可预测的值 ⇒ `originShift` 失去意义、表格会跳。
         *    ⇒ `start` 侧一律钳到 MIN，不换态。
         */
        /*
         * ⚠️ **拖到极小不再换成"自适应"**（2026-10-19 用户报：
         *   「一直拖动缩小的时候，画布中目测大小已经不变，但值会缩小为 0」）。
         * 原来这里是 `snappedMm < MIN_ROW_MM ⇒ heightMm: undefined` —— 面板读出来是 0，
         * 画布却按内容撑开 ⇒ 读数与实际彻底脱节。现在一律钳到下限，
         * 换态只认"双击行边框"（显式 `undefined`）。
         *
         * 下限 = `max(1mm, 这一行/列里元素占用的尺寸)` —— 用户要求"不能比格内元素还小"。
         */
        /* 下限只有 1mm：装不下时元素会等比缩小（见 `rowChildScale`），不再"被元素顶住" */
        const floorMm = axis === 'col' ? MIN_COL_MM : MIN_ROW_MM
        const nextMm = Math.max(floorMm, snappedMm)
        setSizeGhost({
          axis,
          x: ev.clientX,
          y: ev.clientY,
          label: `${axis === 'col' ? '列宽' : '行高'} ${Math.round(nextMm * MM_TO_PX)}px`,
        })
        /*
         * ⚠️ **"另一端不动"的核心**：用**吸附/钳制之后**的 `nextMm` 反算实际增量，
         *    再把这个增量**反向**加到元素原点上。
         *
         * 推导（以列为侧，`side='start'`）：列宽 `+Δ` ⇒ 总宽 `w` 也 `+Δ`（E-45：`w` = 列宽之和）；
         * `x − Δ` ⇒ 右边界 = `(x−Δ) + (w+Δ)` = **`x + w`，与拖动前逐字相同** ✅
         * 行同理：`y − Δ` 与"行高 +Δ"抵消，下边界不动 ✅
         *
         * ⚠️ 必须用 `nextMm` 而不是 `signed`：弱吸附和下限钳制都会改变最终值，
         *    用原始 `signed` 会让右边界在吸附发生时**漂移**（"吸一下、边就错一点"）。
         */
        const delta = nextMm - baseMm
        const originShift = side === 'start' ? -delta : 0
        /* 写入和浮层读数用**同一个** nextMm（上面算好的，含弱吸附）—— 两处各算一遍必然对不上 */
        if (axis === 'col') {
          const p = setColWidthPatch(el, index, round1(nextMm))
          if (p) {
            onMerge(
              el.id,
              (side === 'start'
                ? { ...p, x: round1(startXMm + originShift) }
                : p) as Partial<AnyElement>,
              mergeKey,
            )
          }
          return
        }
        const p = setRowHeightPatch(el, index, round1(nextMm))
        if (p) {
          onMerge(
            el.id,
            (side === 'start'
              ? { ...p, y: round1(startYMm + originShift) }
              : p) as Partial<AnyElement>,
            mergeKey,
          )
        }
      }

      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setSizeGhost(null)
        if (moved) onCommitEnd?.()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [onCommitEnd, onMerge, scale],
  )

  /** 双击行边框 → 这一行回到自适应（与"拖过下限"是同一个终态，但不必先拖过头） */
  const onRowBorderReset = useCallback(
    (el: TableElement, index: number) => {
      const p = setRowHeightPatch(el, index, undefined)
      if (p) onMerge(el.id, p as Partial<AnyElement>)
      onCommitEnd?.()
    },
    [onCommitEnd, onMerge],
  )

  const onElementPointerDown = useCallback(
    (e: ReactPointerEvent, el: AnyElement, band: BandKey) => {
      e.stopPropagation()
      if (e.button !== 0) return
      const editing = editingId === el.id
      // 正在就地编辑时不重选、也不清单元格：点在 textarea 里（选词、拖选）不该把
      // 右侧属性面板从"单元格"打回"整表"，否则一边打字一边面板乱跳。
      if (!editing) {
        onSelectCell(el.id, null)
        onSelect(el.id)
      }
      // 分页符/锁定元素不可拖动（PRD F2-11）
      if (editing || el.locked || el.kind === 'pagebreak') return
      /*
       * ⚠️ **表格恢复"按住就拖"**（2026-10-19 第二轮）。
       *
       * 早上按用户要求把主体拖动去掉（怕和"直接拖行高列宽"打架），改成只有悬浮栏里的
       * 「移动」图标能拖；用了一轮他反馈**还是想直接按住表格拖** ⇒ 加回来。
       *
       * ⚠️ 两个手势怎么共存：**尺寸手柄在 pointerdown 时 `stopPropagation`**
       *    （见 `.bp-tbl-size` 的那几条），所以落在手柄上的按下不会走到这里 ——
       *    拖宽高仍然优先，只有点在手柄以外的区域才是"拖整表"。
       * ⚠️ 悬浮栏里的「移动」图标**保留**：它是"想明确移动"时的稳妥入口，
       *    尤其表格很大、编辑区被裁切时，手柄/主体都可能点不到。
       */
      beginSession(e, el, 'move', band)
    },
    [beginSession, editingId, onSelect, onSelectCell],
  )

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent, el: AnyElement, edge: ResizeEdge, band: BandKey) => {
      e.stopPropagation()
      e.preventDefault()
      beginSession(e, el, 'resize', band, edge)
    },
    [beginSession],
  )

  // ---- 就地编辑 ----
  const stopEditing = useCallback(() => {
    setEditingId(null)
    setEditingCellId(null)
    setDraft('')
  }, [])

  /**
   * ⚠️ **解析"格内子表的坐标"**（2026-10-17 第 5 步）：
   *   `editingCellId` 允许是复合串 `"<cellId>@<r>,<c>"` —— 表示"子表的第 r 行第 c 列"。
   *   ⚠️ 不带 `@` ⇒ 普通格（`r = -1`）⇒ **老行为逐字不变**。
   */
  const parseEditTarget = (raw: string | null): { cellId: string; r: number; c: number } | null => {
    if (!raw) return null
    const m = /^(.+)@(\d+),(\d+)$/.exec(raw)
    if (!m) return { cellId: raw, r: -1, c: -1 }
    return { cellId: m[1] as string, r: Number(m[2]), c: Number(m[3]) }
  }

  const beginEditing = useCallback((elId: string, cellId: string | null, text: string) => {
    cancelledRef.current = false
    setEditingId(elId)
    setEditingCellId(cellId)
    setDraft(text)
  }, [])

  const commitEdit = useCallback(
    (el: AnyElement) => {
      if (editingId !== el.id) return
      const target = parseEditTarget(editingCellId)
      const cellId = target?.cellId ?? null
      if (cancelledRef.current) {
        cancelledRef.current = false
        stopEditing()
        return
      }
      /* ⚠️ 先找"普通格"；找不到再看是不是"子表的某一小格"（复合坐标） */
      const hitCell =
        cellId && el.kind === 'table' ? el.rows.flatMap((r) => r.cells).find((c) => c.id === cellId) : undefined
      const prevNodes =
        hitCell && target && target.r >= 0
          ? hitCell.subTable?.rows[target.r]?.cells[target.c]?.nodes
          : hitCell
            ? hitCell.nodes
            : el.kind === 'text'
              ? el.nodes
              : undefined
      stopEditing()
      const next = textToNodes(draft, fields, prevNodes)
      // 原样关掉时短路：不写文档、不产生撤销记录（见 textToNodes 的注释）
      if (JSON.stringify(next) === JSON.stringify(prevNodes ?? [])) return
      if (hitCell && target && target.r >= 0 && el.kind === 'table') {
        /* ⚠️ **写回子表的那一小格**（复合坐标） */
        const st = hitCell.subTable
        if (!st) return
        const subRows = st.rows.map((row, ri) =>
          ri === target.r
            ? { ...row, cells: row.cells.map((c2, ci) => (ci === target.c ? { ...c2, nodes: next } : c2)) }
            : row,
        )
        onMerge(el.id, { rows: updateCell(el.rows, cellId as string, { subTable: { ...st, rows: subRows } }) })
        return
      }
      if (cellId && el.kind === 'table') {
        onMerge(el.id, { rows: updateCell(el.rows, cellId, { nodes: next }) })
        return
      }
      onMerge(el.id, { nodes: next })
    },
    [draft, editingCellId, editingId, fields, onMerge, stopEditing],
  )

  /** 就地编辑用 textarea 的三件套：提交 / Esc 取消 / 回车行为随内容而定 */
  const inlineEditProps = (el: AnyElement) => ({
    value: draft,
    autoFocus: true,
    /*
     * ⚠️ **输入时按内容自动长高**（2026-10-17 用户报："编辑框无法显示所有内容"）。
     *   `textarea` 的 `height:auto` **不会**按内容长高（那是 div 的行为）——
     *   必须**手动**把 height 设成 `scrollHeight`。
     *   ⚠️ 必须先设 `height:auto` 再读 `scrollHeight`：
     *     否则元素只会"越来越高"，删字也不会缩回去（textarea 的经典坑）。
     */
    onInput: (ev: React.FormEvent<HTMLTextAreaElement>) => {
      const t = ev.currentTarget
      t.style.height = 'auto'
      t.style.height = `${t.scrollHeight}px`
    },
    /*
     * ⚠️⚠️ **挂载时也要按内容撑高**（2026-10-17 用户报：
     *   「双击单元格编辑后，**编辑的区域太小**，文字显示不全」）。
     *
     * 上面 `onInput` 只在**输入时**触发 —— 双击打开、还没输入时，`textarea` 只有
     *   CSS 给的默认高度（约 1.4em）⇒ **多行内容一打开就是被裁的** ✅
     *
     * ⚠️ 用 `requestAnimationFrame` 而不是同步执行：`ref` 回调发生在"挂载"当帧，
     *   那时样式还没结算，`scrollHeight` 可能读到 0（尤其格子刚切到编辑态）。
     * ⚠️ 仍然"先置 auto 再读" —— 与 `onInput` 同一套，避免只增不减。
     */
    ref: (ta: HTMLTextAreaElement | null) => {
      if (!ta) return
      requestAnimationFrame(() => {
        ta.style.height = 'auto'
        ta.style.height = `${ta.scrollHeight}px`
      })
    },
    onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(ev.target.value),
    onBlur: () => commitEdit(el),
    onKeyDown: (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        cancelledRef.current = true
        stopEditing()
      }
    },
  })

  /**
   * ---- 右键菜单（2026-09-22）--------------------------------------------------
   *
   * 用户原话："全屏画布增加右键菜单，现在按右键弹出的是**飞书的兜底宿主菜单**，
   * 只有个重新加载，需要**依据元素类型**，智能弹出右键菜单。"
   *
   * 三件事一起做才算"智能"：
   *   ① `preventDefault()` 掉宿主菜单（不做这一步，我们的菜单会**和飞书那个一起弹**）；
   *   ② 命中判定分三档：单元格 / 元素 / 空白，各给各的项；
   *   ③ 右键同时**选中**命中对象 —— 这是各家编辑器的通行约定，也让"复制/剪切/对齐"
   *      这类作用在选中项上的动作有了确定对象（不必再往菜单项里塞一份 id）。
   */
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(null)
  /**
   * 「拆分单元格」弹层（2026-09-23 第 7 条）。
   *
   * 存的是 `{tableId, cellId}` 而**不是**当次渲染的 `rows` —— 弹层开着的这段时间里用户可能改了表格
   * （加了一行、删了一列），闭包里的 `rows` 就是旧快照，一点确认就把这期间的改动整片盖掉。
   * 这与 `PendingMerge` 是同一条理由（见 MergeConfirm 的文件头）。
   */
  const [splitAsk, setSplitAsk] = useState<{ tableId: string; cellId: string } | null>(null)

  /**
   * 「行高 / 列宽」输入弹层（2026-10-13 用户需求：「单元格右键属性无法修改行高、列宽数据」）。
   *
   * ⚠️ 与 `splitAsk` **同一套模式**（state 持有目标 → 弹层 → 确认时回写）：
   *    从**当前**文档重新定位表格，而不是把 `TableElement` 抓进 state ——
   *    弹层开着的这段时间里表格可能已经被改过（面板输入框每一步都在 patch）。
   * ⚠️ `kind` 决定改行还是改列、以及弹层的标题文案。
   */
  const [sizeAsk, setSizeAsk] = useState<{
    tableId: string
    cellId: string
    kind: 'row' | 'col'
  } | null>(null)
  /** 上一次拆分被护栏拒掉的原因（动作层的原话）；显示在弹层里，改个数字就能重试 */
  const [splitErr, setSplitErr] = useState<string | null>(null)

  /** 元素在哪个版式区（右键菜单要知道，粘贴/移动都用得上） */
  const bandOf = useCallback(
    (id: string): BandKey => {
      for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
        if (readBand(doc, b).some((e) => e.id === id)) return b
      }
      return 'loop'
    },
    [doc],
  )

  /**
   * 执行拆分（弹层点「拆分」）。
   *
   * ⚠️ 从**当前**文档重新定位：弹层开着的这段时间里表格可能已经被改过（见 `splitAsk` 的注释）。
   * 被护栏拒绝时**不关弹层**，把原因显示出来让用户改数字重试 ——
   * 关掉再让他重新点开、重新输，是把一次纠正变成三次操作。
   *
   * ⚠️ 它必须声明在 `bandOf` / `splitAsk` **之后**：`const` 箭头函数没有提升，
   *    放前面会被 tsc 判 `used before its declaration`（同作用域内的词法引用，与"何时调用"无关）。
   */
  const doSplit = useCallback(
    (rows: number, cols: number) => {
      if (!splitAsk) return
      const table = readBand(doc, bandOf(splitAsk.tableId)).find((e) => e.id === splitAsk.tableId)
      if (!table || table.kind !== 'table') {
        setSplitAsk(null)
        setSplitErr(null)
        return
      }
      const r = splitCellToGrid(table, splitAsk.cellId, rows, cols)
      if (!r.ok) {
        setSplitErr(r.reason)
        return
      }
      onMerge(splitAsk.tableId, r.patch)
      setSplitAsk(null)
      setSplitErr(null)
    },
    [bandOf, doc, onMerge, splitAsk],
  )

  const onCanvasContextMenu = useCallback(
    (ev: React.MouseEvent): void => {
      // ① 干掉飞书兜底菜单。**必须在最前面**：后面任何一步提前 return，宿主菜单都会弹出来。
      ev.preventDefault()
      if (!actions) return
      const node = ev.target as HTMLElement | null
      const cellEl = node?.closest?.('td[data-cell-id]') as HTMLElement | null
      const elEl = node?.closest?.('[data-el-id]') as HTMLElement | null
      const at = toContent(ev.clientX, ev.clientY)

      if (cellEl) {
        const tableId = cellEl.closest('[data-el-id]')?.getAttribute('data-el-id') ?? ''
        const cellId = cellEl.getAttribute('data-cell-id') ?? ''
        if (tableId && cellId) {
          // ③ 右键即选中（单元格级）
          onSelectCell(tableId, cellId)
          setCtx({ x: ev.clientX, y: ev.clientY, target: { kind: 'cell', tableId, cellId } })
          return
        }
      }
      if (elEl) {
        const id = elEl.getAttribute('data-el-id') ?? ''
        if (id) {
          onSelect(id)
          setCtx({ x: ev.clientX, y: ev.clientY, target: { kind: 'element', id, band: bandOf(id) } })
          return
        }
      }
      setCtx({
        x: ev.clientX,
        y: ev.clientY,
        target: { kind: 'blank', band: 'loop', xMm: at?.xMm ?? 0, yMm: at?.yMm ?? 0 },
      })
    },
    [actions, bandOf, onSelect, onSelectCell, toContent],
  )

  /**
   * 菜单项。**每次渲染现算**（不用 useMemo）：它依赖 `ctx` 与十来个回调，
   * 记依赖列表比现算更容易漏，而这点计算量（十来个对象字面量）完全不值得缓存。
   */
  const ctxItems: CtxItem[] = (() => {
    if (!ctx || !actions) return []
    const SEP: CtxItem = { id: '__sep', label: '', separator: true }
    const snapToGrid = grid.snapToGrid

    if (ctx.target.kind === 'child') {
      return [
        /*
         * 真机反馈第 3 条（「完全无法对单元格内的图片、二维码和条形码进行编辑」）的落地方式。
         *
         * 曾经这里只有一条「取出并编辑」—— 先取出到画布、改完再拖回格子。那是**绕路**：
         * 用户的心智是"就改格子里这个东西"。现在选中模型认复合 id（`child:<tableId>:<cellId>`），
         * 选中它右侧面板就是它自己的属性，所以第一项回到"编辑属性"。
         * 「取出到画布」保留 —— 它解决的是另一个真需求（元素要脱离表格自由摆放）。
         *
         * ⚠️ 复制/剪切**必须在这里有条目**：键盘处理器只认 Z / Y / Delete / Esc（**没有 Ctrl+C 分支**），
         *    所以"能复制格内元素"唯一可达的入口就是这条菜单。加了 `copyElement` 的子元素分支
         *    却不给入口 = 死代码（本项目在这一点上很严：要么接上，要么别写）。
         */
        { id: 'child:edit', label: '编辑属性', hint: '右侧面板' },
        SEP,
        { id: 'child:copy', label: '复制', hint: '供粘贴' },
        { id: 'child:cut', label: '剪切', hint: '取走它' },
        SEP,
        SEP,
        { id: 'child:remove', label: '移除格内元素', danger: true },
      ]
    }

    if (ctx.target.kind === 'cell') {
      const { tableId, cellId } = ctx.target
      const table = readBand(doc, bandOf(tableId)).find((e) => e.id === tableId)
      const loc = table && table.kind === 'table' ? findCell(table.rows, cellId) : null
      const row = loc && table && table.kind === 'table' ? table.rows[loc.rowIdx] : null
      const canSplit = !!(table && table.kind === 'table' && loc && (loc.cell.colspan > 1 || loc.cell.rowspan > 1))
      const rowCount = table && table.kind === 'table' ? table.rows.length : 0
      const colCount = table && table.kind === 'table' ? table.colWidthsMm.length : 0
      /** 右键那一格所在的**网格列号**（标题列作用在整列上）；拿不到就是 null ⇒ 菜单项不出现 */
      const colIdxOfCell =
        table && table.kind === 'table' && loc
          ? ((tableGrid(table.rows, table.colWidthsMm.length)[loc.rowIdx] ?? []).find(
              (g) => g?.cell.id === cellId,
            )?.colStart ?? null)
          : null
      return [
        { id: 'cell:edit', label: '编辑此单元格', hint: '双击同效' },
        /*
         * ⚠️ **右键直接改单元格字号**（2026-10-01 第五批 · 补齐"所有能调字号的地方"）。
         *
         * 用户要求的是"在所有可以调整字符大小的**字段**、元素的右键菜单中"都能改字号 ——
         * 表格单元格正是承载字段的地方，缺了它这一条只算做了一半。
         * 写法与 Inspector 的 `patchCellStyle` 同源（`onMerge` + `updateCell`），
         * 区别只是那里走右侧面板、这里走右键菜单。
         * ⚠️ 用条件展开而不是空项占位：`table` / `loc` 拿不到时**这一项根本不出现**，
         *    比渲染一个点不动的"字号"诚实（本项目对"灰控件"一贯是这个态度）。
         */
        ...(table && table.kind === 'table' && loc
          ? [
              {
                id: 'cell:fontsize',
                label: '字号',
                input: {
                  value: typeof loc.cell.style?.fontSizePt === 'number' ? loc.cell.style.fontSizePt : 10.5,
                  min: 2,
                  max: 72,
                  step: 0.5,
                  suffix: 'pt',
                  /* 实时生效 + 整轮合并成一次撤销步（见元素那条的同一段注释） */
                  onInput: (v: number) =>
                    onMerge(tableId, {
                      rows: updateCell(table.rows, cellId, {
                        style: { ...(loc.cell.style ?? {}), fontSizePt: v },
                      }),
                    }),
                  onCommit: (v: number) =>
                    onMerge(
                      tableId,
                      {
                        rows: updateCell(table.rows, cellId, {
                          style: { ...(loc.cell.style ?? {}), fontSizePt: v },
                        }),
                      },
                      `cellfs:${cellId}`,
                    ),
                },
              } as CtxItem,
            ]
          : []),
        SEP,
        { id: 'cell:rowAbove', label: '在上方插入行' },
        { id: 'cell:rowBelow', label: '在下方插入行' },
        { id: 'cell:colLeft', label: '在左侧插入列' },
        { id: 'cell:colRight', label: '在右侧插入列' },
        SEP,
        /*
         * ⚠️ **行高 / 列宽**（2026-10-13 用户需求：「单元格右键属性**无法修改行高、列宽数据**，增加该功能」）。
         *
         * 在这之前，改行高/列宽只有三条路：拖边框（要精确瞄 7px 的细条）、
         * 顶部工具条的「表格尺寸」面板（只给**行列数**，不给尺寸）、
         * 以及右侧面板里按「第 N 列」输数值（要先把面板滚到那一节）。
         * ⇒ 右键在格子上直接改，是最短的那条路 —— 用户已经在格子上点了右键。
         *
         * ⚠️ 用 `…` 后缀：这个动作**会弹输入框**（和"插入行"这种立即生效的动作不同），
         *    菜单文案要能预告这件事。
         */
        /*
         * ⚠️ **行高 / 列宽 = 菜单内联输入**（2026-10-13 用户要求）：
         *   「改为和右键修改**字号**的逻辑样式一样，**不要再额外弹出一个小窗**输入高宽值，
         *     直接在右键菜单中修改，修改**实时反映**到表格中」。
         *
         * ⇒ 走 `it.input`（`bp-ctx__row--input`）那条路 —— 与「字号」项**同一套控件**：
         *    点上下箭头或敲字**立刻** patch 文档（`onInput`）；失焦 / 回车时再 commit 一次收成一步撤销。
         *
         * ⚠️ 行高的第三态（`heightMm` 缺席 = "按内容自适应"）在这里表达为 **0**：
         *    输入 0 就是"回到自适应"。不这么做的话，用户把行高设成 20 之后**没有路回到自动**。
         * ⚠️ 列宽没有"自适应"这个态（恒是显式值）⇒ 下限直接给 `MIN_COL_MM`。
         */
        ...(loc && table && table.kind === 'table'
          ? ([
              {
                id: 'cell:rowHeight',
                label: '行高',
                input: {
                  value: typeof row?.heightMm === 'number' ? Math.round(row.heightMm * 10) / 10 : 0,
                  /* ⚠️ 最小 1mm（2026-10-19 用户口径："数值不能为 0，最小为 1"）。
                     "自适应"的入口不再是"填 0"，而是**双击行边框**（见 `onSizeDoubleClick`）。 */
                  min: 1,
                  max: 500,
                  step: 1,
                  suffix: 'mm',
                  onInput: (v: number) => {
                    const p = setRowHeightPatch(table, loc.rowIdx, v)
                    if (p) onMerge(table.id, p, `rh:${table.id}:${loc.rowIdx}`)
                  },
                  onCommit: (v: number) => {
                    const p = setRowHeightPatch(table, loc.rowIdx, v)
                    if (p) onMerge(table.id, p)
                    onCommitEnd?.()
                  },
                },
              },
              ...(colIdxOfCell != null
                ? [
                    {
                      id: 'cell:colWidth',
                      label: '列宽',
                      input: {
                        value: Math.round((table.colWidthsMm[colIdxOfCell] ?? 10) * 10) / 10,
                        min: MIN_COL_MM,
                        max: 500,
                        step: 1,
                        suffix: 'mm',
                        onInput: (v: number) => {
                          const p = setColWidthPatch(table, colIdxOfCell, v)
                          if (p) onMerge(table.id, p, `cw2:${table.id}:${colIdxOfCell}`)
                        },
                        onCommit: (v: number) => {
                          const p = setColWidthPatch(table, colIdxOfCell, v)
                          if (p) onMerge(table.id, p)
                          onCommitEnd?.()
                        },
                      },
                    } as CtxItem,
                  ]
                : []),
            ] as CtxItem[])
          : []),
        SEP,
        /*
         * ⚠️ **菜单里不再直接"合并"**（2026-10-19 用户要求）：
         * 「取消合并单元格的这两个按钮，改为编辑表格，点击后进入表格编辑状态，
         *   右侧的属性也同步切换到表格的属性编辑页」。
         * 合并属于**表格结构**操作，放进"编辑表格"模式里做（那里有合并/居中/加粗的浮层），
         * 右键菜单只留一个直达入口，免得一张菜单里既有"改这一格"又有"改整表"。
         */
        { id: 'cell:editTable', label: '编辑表格', hint: '增删行列 / 合并' },
        /*
         * ⚠️ **「拆分单元格」改名「恢复单元格」**（同一天）：
         * 用户原话：「这个菜单中的'拆分单元格'只有在右键已经合并过的单元格才会生效，
         *   所以名字改为'恢复单元格'」—— 名字要说出它真正的作用（取消合并），
         * 而不是让人以为能把一个普通格切成 2×2（那是"编辑表格 → 拆分"里的活）。
         */
        { id: 'cell:split', label: '恢复单元格', disabled: !canSplit, hint: '拆回单格' },
        SEP,
        {
          id: 'cell:headerRow',
          label: row?.isHeader ? '取消表头行' : '设为表头行',
          checked: !!row?.isHeader,
          hint: '跨页重复',
        },
        /*
          标题列（规格 五）：作用范围是**整列**，不是右键点中的那一格。
          ⚠️ 要拿「这一格在网格里是第几列」得先摊平 —— `loc.colIdx` 是数组下标，
             span 模型下与列号不是一回事（同一个坑这个项目里已经踩过三次）。
        */
        ...(colIdxOfCell != null
          ? [
              { id: 'cell:headerCol', label: '设为标题列', hint: '整列加粗居中' } as CtxItem,
              { id: 'cell:unheaderCol', label: '取消标题列' } as CtxItem,
            ]
          : []),
        SEP,
        /* 规格 六：「单元格内的元素可以再拖出来，回到画布自由层」——这里给的是**菜单入口**
           （拖出需要"从格子里起拖"的一整套手势，本轮先用可发现的入口满足同一诉求）。 */
        ...(loc?.cell.children && loc.cell.children.length > 0
          ? [
              /* 右键落在**格子**上（不是子元素本身）时也得能进去改它 —— 否则用户得先
                 精确点在图片上；图片旁边那片留白也会被当成"这一格" */
              { id: 'cell:editChild', label: '编辑格内元素', hint: '右侧面板' } as CtxItem,
              { id: 'cell:rmChild', label: '移除格内元素', danger: true } as CtxItem,
              SEP,
            ]
          : []),
        /* 只剩一行/一列时把菜单项**禁用**（而不是删掉）：位置稳定，用户也能看出"为什么不能删" */
        { id: 'cell:delRow', label: '删除当前行', danger: true, disabled: rowCount <= 1 },
        { id: 'cell:delCol', label: '删除当前列', danger: true, disabled: colCount <= 1 },
      ]
    }

    if (ctx.target.kind === 'element') {
      const { id, band } = ctx.target
      const list = readBand(doc, band)
      const i = list.findIndex((e) => e.id === id)
      return [
        { id: 'el:cut', label: '剪切' },
        { id: 'el:copy', label: '复制' },
        { id: 'el:paste', label: '粘贴', disabled: !actions.clipboardHas, hint: '⌘V' },
        SEP,
        {
          id: 'align',
          label: '对齐',
          sub: [
            { id: 'el:align:left', label: '左对齐' },
            { id: 'el:align:hcenter', label: '水平居中' },
            { id: 'el:align:right', label: '右对齐' },
            SEP,
            { id: 'el:align:top', label: '顶对齐' },
            { id: 'el:align:vcenter', label: '垂直居中' },
            { id: 'el:align:bottom', label: '底对齐' },
          ],
        },
        {
          id: 'zorder',
          label: '排列',
          sub: [
            { id: 'el:z:front', label: '置顶', disabled: i === list.length - 1 },
            { id: 'el:z:forward', label: '上移一层', disabled: i === list.length - 1 },
            { id: 'el:z:backward', label: '下移一层', disabled: i <= 0 },
            { id: 'el:z:back', label: '置底', disabled: i <= 0 },
          ],
        },
        SEP,
        /*
         * ⚠️ **右键直接改字号**（2026-10-01 第五批新增）。
         *
         * 用户原话：「在所有可以调整字符大小的字段、元素的右键菜单中，增加调整字符大小的功能，
         * **可以直接输入**」。有了它就不必「先选中 → 视线移到右侧面板 → 找那个输入框」——
         * 全屏画布上视线跨半屏找面板确实累。
         *
         * ⚠️ `mergeKey` 用 `fs:<id>`：连续改字号要**合并成一次撤销步**，
         *    否则调三次字号得按三次 Ctrl+Z 才退得回去（与项目里其它样式补丁同一套约定）。
         * ⚠️ 初值从**当前元素**读（不是从默认值读）—— 否则一打开菜单就把用户的字号重置了。
         */
        {
          id: 'el:fontsize',
          label: '字号',
          input: {
            value: typeof list[i]?.style?.fontSizePt === 'number' ? list[i].style.fontSizePt : 10.5,
            min: 2,
            max: 72,
            step: 0.5,
            suffix: 'pt',
            /*
             * ⚠️ **实时生效**（2026-10-01 用户要求："点一下箭头，画布中的元素字段就立即调整到
             * 对应的大小，这样方便实时预览"）。
             *
             * ⚠️ `onInput` 与 `onCommit` **必须用同一个 `mergeKey`**：
             *    不带的话每按一下箭头都会新增一个撤销步，用户调 10 次要按 10 次 Ctrl+Z；
             *    带了才会把整轮调整合并成**一步**。
             */
            onInput: (v) => onMerge(id, { style: { ...(list[i]?.style ?? {}), fontSizePt: v } }, `fs:${id}`),
            onCommit: (v) => onMerge(id, { style: { ...(list[i]?.style ?? {}), fontSizePt: v } }, `fs:${id}`),
          },
        },
        SEP,
        { id: 'el:delete', label: '删除', hint: 'Del', danger: true },
      ]
    }

    return [
      { id: 'blank:paste', label: '粘贴到此处', disabled: !actions.clipboardHas, hint: '⌘V' },
      SEP,
      /*
       * ⚠️ 真机反馈（2026-09-22）：「不论网格间距设置多少，都一致提示 5mm 步进」——
       *    那句提示原来是**写死**的字符串。现在读 grid.gridMm（真实值），
       *    并按用户点名把「显示网格 / 网格间距 / 页边距」也放进菜单。
       */
      { id: 'blank:toggleGrid', label: '显示网格', checked: grid.showGrid },
      { id: 'blank:toggleSnap', label: '网格吸附', checked: grid.snapToGrid, hint: `${grid.gridMm}mm 步进` },
      {
        id: 'gridStep',
        label: '网格间距',
        hint: `${grid.gridMm}mm`,
        sub: GRID_STEPS_MM.map((mm) => ({ id: `blank:grid:${mm}`, label: `${mm}mm`, checked: grid.gridMm === mm })),
      },
      {
        id: 'gridMargin',
        label: '页边距',
        sub: MARGIN_PRESETS.map((m) => ({ id: `blank:margin:${m.mm}`, label: `${m.name}（${m.mm}mm）` })),
      },
      SEP,
      /*
       * 「允许拖出页面」（2026-09-23 真机反馈第 10 条）。
       * 用户要求它出现在**页面属性与画布右键菜单**两处 —— 右键是"正拖不动"时最顺手的入口。
       */
      { id: 'blank:allowOut', label: '允许拖出页面', checked: doc.pageSetup.allowOutOfPage === true },
    ]
  })()

  const onCtxPick = useCallback(
    (id: string): void => {
      if (!ctx || !actions) return
      const t = ctx.target
      if (t.kind === 'child') {
        if (id === 'child:edit') {
          // 右键时已经选好了（见渲染处的 onContextMenu）；这里再落一次是为了
          // "菜单执行时对象与打开时一致"那条约束（中间可能被别的事件改过选中）
          onSelect(cellChildId(t.tableId, t.cellId))
          return
        }
        /*
         * 复制/剪切传的是**复合 id**（子元素在选中模型里的 id）。
         * `copyElement` 里专门有一段处理它：把 `w` 从"占格宽百分比"换算成 mm 再进剪贴板
         * （否则粘到画布上会变成 100mm 宽）。`cutElement` = 复制 + 摘掉它。
         */
        const childId = cellChildId(t.tableId, t.cellId)
        if (id === 'child:copy') {
          actions.copy(childId)
          return
        }
        if (id === 'child:cut') {
          actions.cut(childId)
          return
        }
        /* ⚠️ **传 `t.childId`**（2026-10-16）：一格多个时取到的应是"你点的那个" */
        if (id === 'child:takeOut') actions.takeOutChild(t.tableId, t.cellId, undefined, t.childId)
        /* ⚠️ **传 t.childId**：一格多个时若删最后一个会删错（2026-10-16）*/
        if (id === 'child:remove') actions.removeChild(t.tableId, t.cellId, t.childId)
        return
      }

      if (t.kind === 'cell') {
        if (id === 'cell:edit') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          const cell = table && table.kind === 'table' ? findCell(table.rows, t.cellId)?.cell : null
          if (cell) beginEditing(t.tableId, cell.id, nodesToText(cell.nodes))
          return
        }
        if (id === 'cell:headerCol' || id === 'cell:unheaderCol') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          if (!table || table.kind !== 'table') return
          const loc = findCell(table.rows, t.cellId)
          if (!loc) return
          const col =
            (tableGrid(table.rows, table.colWidthsMm.length)[loc.rowIdx] ?? []).find((g) => g?.cell.id === t.cellId)
              ?.colStart ?? null
          if (col == null) return
          actions.applyRange(
            t.tableId,
            { r1: 0, c1: col, r2: table.rows.length - 1, c2: col },
            { kind: 'headerCol', on: id === 'cell:headerCol' },
          )
          return
        }
        if (id === 'cell:editChild') {
          onSelectCell(t.tableId, t.cellId)
          onSelect(cellChildId(t.tableId, t.cellId))
          return
        }
        if (id === 'cell:takeOut') {
          /* ⚠️ 格级菜单：用"当前选中的那个子元素"（解不出来就退回老行为） */
          const sel = parseCellChildId(selectedId)
          const hint = sel && sel.tableId === t.tableId && sel.cellId === t.cellId ? sel.childId : undefined
          return actions.takeOutChild(t.tableId, t.cellId, undefined, hint)
        }
        /*
         * ⚠️⚠️ **「移除格内元素」= 清空整格**（2026-10-16 用户要求：
         *   「右键单元格空白处，有个**移除格内元素**的选项，**当前点击无用**，
         *     改为**点击后清空格内所有元素**」）。
         *
         * ⚠️ **"点击无用"的真因**：**这个 id 根本没有处理分支** ——
         *   菜单里定义了项（见上面的 `{ id: 'cell:rmChild', ... }`），
         *   但下面这串 `if (id === ...)` 里**漏了它** ⇒ 点击落到函数尾、什么都不做。
         * ⚠️ 顺带把语义也改了：格级菜单本来就该是"清空这一格"，
         *   而不是"猜一个子元素删掉"（那是子元素右键菜单的事）。
         */
        if (id === 'cell:rmChild') return actions.clearChildren(t.tableId, t.cellId)
        if (id === 'cell:rowAbove') return actions.insertRow(t.tableId, t.cellId, 'above')
        if (id === 'cell:rowBelow') return actions.insertRow(t.tableId, t.cellId, 'below')
        if (id === 'cell:colLeft') return actions.insertCol(t.tableId, t.cellId, 'left')
        if (id === 'cell:colRight') return actions.insertCol(t.tableId, t.cellId, 'right')
        if (id === 'cell:delRow') return actions.deleteRow(t.tableId, t.cellId)
        if (id === 'cell:delCol') return actions.deleteCol(t.tableId, t.cellId)
        /*
         * 「编辑表格」：进表格编辑态 + **把右侧面板切回表格属性**（2026-10-19）。
         * 只 `setEditTableId` 的话，面板还停在"这一格"上 —— 用户点了"编辑表格"却看到
         * 单元格属性，会以为点错了。
         */
        if (id === 'cell:editTable') {
          onSelectCell(t.tableId, null)
          onSelect(t.tableId)
          setEditTableId(t.tableId)
          return
        }
        if (id === 'cell:split') {
          actions.splitCell(t.tableId, t.cellId)
          return
        }
        /* 行高 / 列宽：只开弹层，**不在这一刻算行列号** —— 见 `sizeAsk` 的注释 */
        if (id === 'cell:rowHeight' || id === 'cell:colWidth') {
          setSizeAsk({
            tableId: t.tableId,
            cellId: t.cellId,
            kind: id === 'cell:rowHeight' ? 'row' : 'col',
          })
          return
        }
        if (id === 'cell:headerRow') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          const loc = table && table.kind === 'table' ? findCell(table.rows, t.cellId) : null
          if (loc) actions.setHeaderRow(t.tableId, loc.rowIdx)
          return
        }
        return
      }
      if (t.kind === 'element') {
        if (id === 'el:copy') return actions.copy(t.id)
        if (id === 'el:cut') return actions.cut(t.id)
        if (id === 'el:paste') return actions.paste(t.band, { x: 0, y: 0 })
        if (id === 'el:delete') return actions.remove(t.id)
        if (id.startsWith('el:align:')) return actions.align(t.id, id.slice('el:align:'.length) as AlignMode)
        if (id.startsWith('el:z:')) {
          const where = id.slice('el:z:'.length) as 'front' | 'back' | 'forward' | 'backward'
          return actions.zIndex(t.id, where)
        }
        return
      }
      if (id === 'blank:paste') actions.paste(t.band, { x: t.xMm, y: t.yMm })
      if (id === 'blank:toggleSnap') actions.toggleSnap()
      if (id === 'blank:toggleGrid') actions.setPageSetup({ showGrid: !grid.showGrid })
      if (id.startsWith('blank:grid:')) actions.setPageSetup({ gridMm: Number(id.slice('blank:grid:'.length)) })
      if (id.startsWith('blank:margin:')) actions.setPageSetup({ marginAllMm: Number(id.slice('blank:margin:'.length)) })
      if (id === 'blank:allowOut') actions.setPageSetup({ allowOutOfPage: doc.pageSetup.allowOutOfPage !== true })
    },
    [actions, bandOf, beginEditing, ctx, doc],
  )

  /**
  /**
   * ---- 矩形选区（2026-09-22，用户规格 四·核心）---------------------------------
   *
   * 用户原话："在表格内按下鼠标并拖动，形成矩形多选区域：被选中的所有单元格整体用主题色半透明高亮。
   * 支持 Shift + 点击单元格扩展选区、Esc 取消选中。"
   *
   * ⚠️ 这里**故意改变了"拖动表格"的入口**：单元格从 click-only 变成 pointerdown 起选区。
   *    原来的注释写着"用 click 而不是 pointerdown 选单元格：pointerdown 一旦拦住冒泡，
   *    整个表格就没法拖动了"—— 那是 2026-09-22 之前没有**表格手柄**时的取舍。
   *    规格 一 明确给了手柄这个角色（"表格手柄（点按后整个表格可拖动）"），
   *    而规格 四 又要求"在表格内按下鼠标并拖动" ⇒ 两者只能二选一：现在**拖表格走手柄，拖格子走选区**。
   *    点选单格仍然走 `onClick`（不受影响）。
   */
  const [cellSel, setCellSel] = useState<{
    tableId: string
    anchor: { r: number; c: number }
    head: { r: number; c: number }
  } | null>(null)

  /** 选区归一化 + 扩张（把被切到的合并块整块纳入），所有下游共用这一份 */
  const selRange = useMemo(() => {
    if (!cellSel) return null
    const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
    if (!found || found.kind !== 'table') return null
    const raw = normalizeRange(cellSel.anchor, cellSel.head)
    return expandRangeToWholeCells(found.rows, found.colWidthsMm.length, raw)
  }, [bandOf, cellSel, doc])

  /** 单元格的网格坐标 → 是不是落在当前选区里 */
  const inSel = useCallback(
    (tableId: string, r: number, c: number, range: CellRange | null): boolean => {
      if (!cellSel || !range || cellSel.tableId !== tableId) return false
      return r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2
    },
    [cellSel],
  )

  /**
   * 工具条的落点：取"所有高亮格子"的并集矩形，**浮在它上方**（规格：不遮挡选区）。
   *
   * 位置每次 `cellSel` / 文档 / 缩放变化后**量一次 DOM**（`is-rsel` 是刚渲染上去的），
   * 量不到（选区被删了/不可见）就当没有选区。
   * 上方空间不够（< 56px）时翻到下方 —— 这就是规格说的"自动避让边缘"。
   */
  const [barAt, setBarAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!cellSel) {
      setBarAt(null)
      return
    }
    const nodes = Array.from(paperRef.current?.querySelectorAll<HTMLElement>('td.is-rsel') ?? [])
    if (nodes.length === 0) {
      setBarAt(null)
      return
    }
    let l = Infinity
    let t = Infinity
    let r2 = -Infinity
    for (const n of nodes) {
      const b = n.getBoundingClientRect()
      l = Math.min(l, b.left)
      t = Math.min(t, b.top)
      r2 = Math.max(r2, b.right)
    }
    const BAR_H = 30
    const below = t < BAR_H + 26
    setBarAt({
      left: Math.round(Math.min(Math.max(8, (l + r2) / 2), window.innerWidth - 12)),
      top: Math.round(below ? t + 26 : t - BAR_H - 4),
    })
  }, [cellSel, doc, scale])

  /**
   * 单元格 pointerdown：起一个"拖动扩选"会话。
   * 用 `document` 上的监听器而不是 td 自己的 —— 指针一定会移出这一格（甚至移出表格）。
   * 扩展目标靠 `elementFromPoint` 反查那一格的 `data-cell-id`，再换算成网格坐标：
   * 网格坐标不能从"渲染时的 r/ci"拿（那是数组下标，span 模型下与列号不是一回事）。
   */
  const onCellPointerDown = useCallback(
    (ev: ReactPointerEvent, el: TableElement, rowIdx: number, colIdx: number, cellId: string) => {
      if (ev.button !== 0) return
      /*
       * ⚠️ **真机反馈（2026-09-22）**：原来这里无条件 `stopPropagation`，于是"按住表格里的
       *    任何一格都拖不动表格"，只有把准心压到最外框那一圈才能拖 —— 用户原话
       *    「明明图标已经变成拖动的样式，必须要把准心放到表格最外框的中央才可以移动」。
       *
       * ⇒ 判据改成：**只有按住 Shift 才接管**（Shift + 拖 = 框选）。不按 Shift 时直接 return，
       *    事件照常冒泡到 `.bp-el` ⇒ 走"拖动整个元素"那条老路 ✓
       *    「移动元素」是最高频的动作，不该被"框选"抢走 —— 框选的入口还有表格手柄那条路。
       */
      /* 非编辑态不接管（事件冒泡 ⇒ 按住任意位置都能拖动整个表格）；编辑态才接管 = 框选。 */
      if (editTableId !== el.id) {
        /*
         * ⚠️ 顺手把**上一次的矩形选区**清掉（2026-09-23）。
         *
         * `cellSel` 只在编辑态里被维护，退出编辑态后它一直留着 ⇒ 高亮还在、右侧工具条还在，
         * 而"合并单元格"这类按钮会按那个**陈旧选区**判成可用 ——
         * 用户此刻明明只点了这一格，看到的却是"合并"亮着（真机 e2e 里就是这条先红的）。
         * 落一次新指针 = 上一次交互结束，这是最自然的清理时机。
         */
        if (cellSel) setCellSel(null)
        return
      }
      ev.stopPropagation()
      const grid = tableGrid(el.rows, el.colWidthsMm.length)
      const at = (r: number, c: number) => grid[r]?.[c] ?? null
      const anchorCell = at(rowIdx, colIdx)
      if (!anchorCell) return
      const anchor = { r: anchorCell.rowStart, c: anchorCell.colStart }

      if (ev.shiftKey && cellSel && cellSel.tableId === el.id) {
        // Shift + 点击：只改 head，锚点不动（与各家表格一致）
        setCellSel({ ...cellSel, head: anchor })
        return
      }
      setCellSel({ tableId: el.id, anchor, head: anchor })

      /** 指针位置 → 网格坐标（反查 DOM，再按 id 在网格里定位） */
      const gridAt = (x: number, y: number): { r: number; c: number } | null => {
        const node = document.elementFromPoint(x, y) as HTMLElement | null
        const id = node?.closest?.('td[data-cell-id]')?.getAttribute('data-cell-id') ?? null
        if (!id) return null
        for (let r = 0; r < el.rows.length; r += 1) {
          for (let c = 0; c < el.colWidthsMm.length; c += 1) {
            const g = grid[r]?.[c]
            if (g && g.cell.id === id && g.rowStart === r) return { r, c }
          }
        }
        return null
      }

      const onMove = (mv: PointerEvent): void => {
        const to = gridAt(mv.clientX, mv.clientY)
        if (!to) return
        setCellSel((cur) => (cur && (cur.head.r !== to.r || cur.head.c !== to.c) ? { ...cur, head: to } : cur))
      }
      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [cellSel, editTableId],
  )

  /**
   * 单元格子元素的拖动会话（规格 六 的最后一句）。
   *
   * 三种落点三种结果：
   *   · 落在**别的格子**上 ⇒ 换格（`moveChildToCell`）；
   *   · 落在纸张上、但不在任何格子里 ⇒ 取出放回自由层（`takeOutChild` 带坐标）；
   *   · 落回原地 / 落在纸外 ⇒ 什么都不做（**不弹提示**：那是用户自己取消的动作，
   *     弹一句「已取消」只会变成噪音）。
   *
   * ⚠️ 拖动**拖过 4px 才算拖**（与面板拖拽同一口径）：否则"点一下子元素"会被当成拖动，
   *    而点一下本来该是"选中这一格"。
   */
  const onChildPointerDown = useCallback(
    (ev: ReactPointerEvent, table: TableElement, cellId: string, child: AnyElement) => {
      if (ev.button !== 0 || !actions) return
      ev.stopPropagation()
      const startX = ev.clientX
      const startY = ev.clientY
      let moved = false
      /** ⚠️ 是否已"脱钩"（拖出格子足够远）—— 松手时据此决定走"取出/换格" */
      let detached = false
      let lastCell: { tableId: string; cellId: string } | null = null

      /*
       * ⚠️ **"按下那一刻"的格内几何**（2026-10-13 新增，供"格内移动"用）。
       *
       * 为什么现在才需要它：在这之前格内元素**没有位置概念**（`x`/`y` 被定义为无意义），
       * 拖动只可能是"拖到别处"（别的格子 / 画布）。现在有了 `cellPos` ⇒
       * 拖到**同一格**里就该是"调整它在这一格内的位置"。
       *
       * ⚠️ 内容区宽 = `td` 的宽度**减去左右内边距**（padding 是格子属性，
       *    从计算样式读，不能拿 `cell.paddingMm` 猜 —— 那还要考虑表格默认值）。
       * ⚠️ 取的是**按下那一刻**的值：拖动中 `cellPos` 每帧都变，
       *    用实时值算增量会**指数漂移**（和画布拖元素同一个坑）。
       */
      const tdEl = (ev.currentTarget as HTMLElement).closest('td')
      const cellGeom = (() => {
        if (!tdEl) return null
        const r = tdEl.getBoundingClientRect()
        const cs = window.getComputedStyle(tdEl)
        const padL = parseFloat(cs.paddingLeft) || 0
        const padT = parseFloat(cs.paddingTop) || 0
        const padR = parseFloat(cs.paddingRight) || 0
        const padB = parseFloat(cs.paddingBottom) || 0
        return {
          /** 内容区左边界（屏幕 px） */
          left: r.left + padL,
          /** 内容区上边界（屏幕 px） */
          top: r.top + padT,
          /** 内容区宽度（屏幕 px）—— `xPct` 的分母 */
          width: Math.max(1, r.width - padL - padR),
          /*
           * ⚠️ **内容区高度（屏幕 px）—— 纵向钳制的分母**（2026-10-13 补）。
           *
           * 用户反馈：「元素在单元格内拖动时，**左右会被单元格本身限制，元素不会被裁切**，
           *  但**上下拖动时，元素会被裁切限制**」——
           *  两个方向行为不一致是错的（一个夹住、一个裁掉）。
           *
           * 根因：横向的钳制分母是**格宽**（模型里有 `colWidthsMm`）；
           * 纵向我以为"没有分母"（行高是自适应的），于是退回靠 `<td>` 的 `overflow:hidden` 裁切。
           * ⇒ 其实**拖动的这一刻行高是量得出来的**（格子已经渲染出来了）
           *   ⇒ 拿它当分母，纵向也能"夹住"而不是"裁掉"。
           * ⚠️ 只在**拖动开始时量一次**：拖动中山元素移动不影响行高（容器高 0），所以是稳定的。
           */
          /*
           * ⚠️ **用整格高（不减内边距）** —— 因为 `y` 的原点已经是**边框内沿**
           *   （holder 绝对定位在 `<td>` 的 padding box 顶）。
           *   减掉 `padT/padB` 会让"往下拖"**提前一个内边距就停住** ——
           *   正是用户报的「往上能贴上边框，但**往下拖又拖不下去了**」。
           */
          /*
           * ⚠️ **用 `r.height`（border box），不要用 `clientHeight`**（2026-10-14 回退）。
           *
           * 我试过改用 `tdEl.clientHeight`（想排除 1px 边框、把"底边差 0.5mm"抹掉），
           * **结果更糟**：用户实测「**底边彻底拖不下去了**，不论内边距多少都是这样」。
           * ⚠️ `clientHeight` 是**取整**值、且不含边框，量出来的可用高**偏小** ⇒ `maxY` 变小 ⇒ 拖不到底。
           * ⇒ **回退到 `r.height`**。
           * ⚠️ 那 0.5mm 的边框误差（2×1px）**先接受** ——
           *   它比"彻底拖不动"轻得多；要精确处理得把 `borderWidth` 读出来单独减，
           *   而不是换一个口径更粗的量。
           *   （教训：**"换一个 API"不等于"更精确"** —— 先确认新 API 的口径和你以为的一致。）
           */
          height: Math.max(1, r.height),
        }
      })()
      const startPos = { xPct: childOffsetXPct(child), yMm: childOffsetYMm(child) }
      /*
       * ⚠️ **抓取偏移**（2026-10-13 修用户报的严重 bug）：
       *   「把元素从单元格中拖动到画布中，**无法判断这个元素会出现在哪儿**」。
       *
       * 根因：取出时把**鼠标位置**直接当成了**元素的左上角**坐标传给 `takeOutChild`
       * ⇒ 抓元素中间时元素会**跳一下**（左上角瞬间跑到鼠标处）。
       * ⇒ 记下"按下点相对元素左上角的距离"，落点时减掉它，元素才真正**跟手**。
       * ⚠️ 用子元素那个 `<span>` 的 rect（`currentTarget`）—— 它才是元素在屏幕上的实际框。
       */
      const childRect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
      const mmPerPxGrab = 1 / (MM_TO_PX * Math.max(scale, 0.05))
      const grab = {
        dxMm: (ev.clientX - childRect.left) * mmPerPxGrab,
        dyMm: (ev.clientY - childRect.top) * mmPerPxGrab,
      }

      const onMove = (mv: PointerEvent): void => {
        if (!moved) {
          if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 4) return
          moved = true
        }
        const hit = cellAtPoint(mv.clientX, mv.clientY)
        /* ⚠️ 落在**同一格**内 ⇒ 不是"换格"，交给"格内移动"那条路（`lastCell` 保持 null） */
        const sameCell = !!hit && hit.tableId === table.id && hit.cellId === cellId
        lastCell = hit && !sameCell ? hit : null
        /*
         * ⚠️⚠️ **实时预览**（2026-10-13 用户反馈："拖动中间没有画面，即拖动的时候，
         *   只能看到鼠标指针移过去，松开鼠标左键，元素**立刻闪现**过来了"）。
         *
         * 原来是**松手才写文档** ⇒ 整个拖动过程零反馈。
         * ⇒ 改成**每帧写**：元素真的跟着鼠标走 —— 比"画一个 ghost 跟着鼠标"更真实
         *   （ghost 只是一个标签，看不出缩放后的实际效果），也少一套临时状态。
         * ⚠️ 每帧写必须带**同一个 `mergeKey`**，否则撤销栈会被每一帧塞一条
         *   （拖一次产生上百步，"撤销"就废了）。
         */
        /*
         * ⚠️⚠️ **"离格子多远"必须在 `if (sameCell)` 之外算**（2026-10-13 第 2 次返工）。
         *
         * 上一版把它写在 `if (sameCell && cellGeom)` 里面 ⇒
         * **鼠标一出格子 `sameCell` 就变 false ⇒ 整块不执行 ⇒ `detached` 永远设不上**
         * ⇒ 拖出去时只有文字胶囊（用户两次报"只有蓝色的文字标签过去"）。
         *
         * ⚠️ **这类 bug 的性质**：字段写在一个**永远不会执行到的分支**里。
         *   读代码看不出来（每处都"看起来对"），必须**追一遍每条路径会不会执行到**。
         */
        const r0 = tdEl?.getBoundingClientRect()
        let outside = 0
        if (r0) {
          const ox = Math.max(0, r0.left - mv.clientX, mv.clientX - r0.right)
          const oy = Math.max(0, r0.top - mv.clientY, mv.clientY - r0.bottom)
          outside = Math.hypot(ox, oy)
        }
        /*
         * ⚠️⚠️ **"脱钩"的判据要包含"已经离开格子"**（2026-10-13 用户第 3 次反馈：
         *   「拖动到边缘的时候，**先出现的是蓝色文字标签**，继续拖动**才会出现蓝色虚线框**，
         *     **没有一开始就出现**，正常应该是这个虚线框**替代**现在的蓝色文字标签」）。
         *
         * 根因：这里原本只看"离格子多远 ≥ 18px"。
         *   ⇒ 鼠标刚出格子时距离还不到 18px ⇒ **脱钩没触发** ⇒ 走了下面的文字胶囊分支
         *     ⇒ 于是"先标签、后虚线框"。
         * ⇒ 改成：**一旦不在格子里（`!sameCell`）就脱钩** ——
         *   阻力（0.35 阻尼）仍然保留，但它的作用域是**格内推动**的手感，
         *   不该决定"什么时候才让用户看见元素本体"。
         */
        /*
         * ⚠️⚠️ **"脱钩"只由"累积的阻力"决定，不再"鼠标出格即脱钩"**（2026-10-15 用户反馈）。
         *
         * 用户原话：「之前我们设置了**拖动到单元格边框的时候，有个阻力的效果**，
         *   现在这个效果好像没在了，导致在单元格内拖动的时候，
         *   **很容易就拖出单元格或者拖动到其他单元格之中**」。
         *
         * 根因：上一版是 `if (!sameCell || outside * 0.35 >= 18)` ——
         *   **`!sameCell` 一票通过** ⇒ 鼠标**一出格子（哪怕 1px）立刻脱钩**
         *   ⇒ 下面那个 `0.35` 的阻尼**根本没机会生效**（它就是"阻力"）。
         *
         * ⚠️ **但不能简单删掉 `!sameCell`**：它是为"先标签、后虚线框"修的（第 3 次反馈）。
         * ⇒ 调和：**只看累积阻力，但把阈值从 18px 降到 8px** ——
         *   鼠标离开格子约 23px（8 ÷ 0.35）才脱钩 ⇒ **既有"推不动但在累积"的阻力手感，
         *   又不会迟钝到"拖半天还不脱钩"**。
         */
        if (outside * 0.35 >= 8) detached = true

        if (sameCell && cellGeom) {
          /*
           * ⚠️⚠️ **"吸附 + 阻力 + 脱钩"三段式**（2026-10-13 用户口径）：
           *   「元素在单元格内拖动时，**触碰到四个边框就立刻吸附，并有一个阻力**，
           *     继续沿着受阻的方向拖动，整个元素即可完成**移动到其他单元格或者拖出到画布**的操作；
           *     此时该元素**不能闪现出现**，拖动的时候**依然要跟手移动**，
           *     拖动到单元格外时，**样式应当在拖动过程中就变换**」。
           *
           * ⚠️ **阻力怎么表达**：鼠标在**格子外**的距离 × **阻尼系数**（0.35）——
           *   手感是"推不动、但在累积"，而不是"一下就出去"。
           * ⚠️ 越过阈值（18px）⇒ **脱钩**：ghost 换成"**渲染元素本体 + 画布样式**"。
           *   这样"样式在拖动过程中就变"，不必等松手。位置 = **鼠标 − 抓取偏移**
           *   （与 `takeOutChild` 的落点同算法 ⇒ 与最终落点一致，不跳）。
           */
          /* ⚠️ `detached` 的判定已移到 `if (sameCell)` **外面**了（见那段注释）—— 这里只看结果 */
          if (detached) {
            const pxPerMmNow = MM_TO_PX * Math.max(scale, 0.05)
            setChildGhost({
              x: mv.clientX - grab.dxMm * pxPerMmNow,
              y: mv.clientY - grab.dyMm * pxPerMmNow,
              label: elementLabel(child),
              child,
              /* 画布口径的宽（`w` 是"占格宽百分比"⇒ 换成 mm） */
              wMm: Math.round(((cellWidthMm(table, cellId) * childWidthPct(child)) / 100) * 10) / 10,
              hMm: childBoxHeightMm(child),
            })
          }
          let dxPct = ((mv.clientX - startX) / cellGeom.width) * 100
          let dyMm = (mv.clientY - startY) / (MM_TO_PX * Math.max(scale, 0.05))
          /*
           * ⚠️ **吸附继承画布的开关**。用户口径：「**继承画布中的吸附开关**，
           *   如果画布全局开了吸附，就自动吸附到当前的网格；如果关闭了吸附，就可以完全自由拖动」。
           *
           * ⚠️ 吸附要在 **mm 空间**里做（网格是 mm 的），而 `xPct` 是**百分比** ⇒
           *   先换算到 mm、吸附、再换算回去。直接在百分比上取整是错的：
           *   同一个 1% 在不同宽度的格子里对应的 mm 数不同，"吸附到网格"就名不副实了。
           */
          if (grid.snapToGrid && grid.gridMm > 0) {
            const cwMm = Math.max(1, cellWidthMm(table, cellId))
            const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
            const xMm = (startPos.xPct / 100) * cwMm + (mv.clientX - startX) * mmPerPx
            const yMmNow = startPos.yMm + dyMm
            const sxMm = Math.round(xMm / grid.gridMm) * grid.gridMm
            const syMm = Math.round(yMmNow / grid.gridMm) * grid.gridMm
            dxPct = ((sxMm - (startPos.xPct / 100) * cwMm) / cwMm) * 100
            dyMm = syMm - startPos.yMm
          }
          /*
           * ⚠️⚠️ **横向夹在 `[0, 100 − w]`**（2026-10-13 用户报的 bug）：
           *   「拖动移动时，可以把元素移动到**两个单元格之间，覆盖在这个单元格上**……
           *     当拖动的元素**超过该单元格边界**时，应当出现**吸附到单元格**的动画」。
           *
           * 根因：这里原来的上限是 **200**（想给"往格外出一点"留余地）⇒
           * 元素可以**跨出本格右边界、盖到旁边那一格上**。
           * ⇒ 上限改成 `100 − 占格宽`（**元素右边界不得越过格内容区右边界**）——
           *   拖到头就"贴"在格子右内边，这正是用户要的"吸附到单元格"。
           * ⚠️ 上限**随 `w` 变化**：宽度 100% 时上限是 0（只能贴左，因为它本来就撑满）。
           * ⚠️ `Math.min` 放在**吸附之后**：网格吸附可能把 x 推到越界的位置，夹回来才算数。
           */
          /*
           * ⚠️ **右/下的上限放宽一个 pad**（2026-10-14 用户报：
           *   「能拖到底边了，但**上左右三边无法紧贴**……右边却没有这种距离，
           *    甚至可以拖动到单元格边框上」——
           *   左/上的 0 = 边框内沿 ⇒ 能贴；
           *   右/下的上限原来是“内容区宽/高”⇒ 停在“内容区边缘”，**离边框还差一个 pad**。
           * ⇒ 四边对称：上限放到“**边框内沿**”= 内容区宽/高 **＋ 一个 pad**。
           *   （pad 对应的百分比 = padMm ÷ 内容区宽 × 100）。
           */
          /*
           * ⚠️⚠️ **钳制必须收回 `100 − w`**（2026-10-14 深夜，上一轮的"放宽 pad"是错的）。
           *
           * 上一轮为了让"右边能贴边框"放宽了上限，**结果超界的坐标（xPct + w > 100）
           * 被直接写进了文档** —— 用户清单实测：`xPct = 64.748% + w = 38.7% = 103.45%` ❗
           * ⇒ 渲染时元素右沿超出格子 1.6mm，且这个**脏数据会一直留在模板里**。
           *
           * ⇒ **钳制收回**。同时需要在 `coerceDoc` 里加一道**自愈**：
           *   把已存的超界 `cellPos` 夹回合法范围（否则老用户的脏数据会一直渲染出界）。
           *
           * ⚠️ 教训：**钳制是"数据合法性"的一部分，不能为了让某个视觉效果好实现就放宽** ——
           *   放宽后写进去的数据，渲染端、打印端、保存端都要能正确处理，否则就是脏数据源。
           */
          const maxX = Math.max(0, 100 - childWidthPct(child))
          const nextX = Math.min(maxX, Math.max(0, Math.round((startPos.xPct + dxPct) * 10) / 10))
          /*
           * ⚠️ **纵向上限 = 内容区高 − 元素盒高**（2026-10-13 用户报：
           *   「元素在单元格内拖动时，**左右会被单元格本身限制、不会被裁切**，
           *    但**上下拖动时，元素会被裁切限制**」）。
           *
           * 横向早就有这个上限（`100 − 占格宽`）；**纵向原来没有** ——
           * 我以为行高算不出来（自适应），于是靠 `<td>` 的 `overflow:hidden` 裁切兜底
           * ⇒ 两个方向行为不一致：**左右"夹住"、上下"裁掉"**。
           * ⇒ 现在用**拖动开始时量到的内容区高度**当分母，纵向也改成夹住。
           * ⚠️ 下限 −10：`y=0` 是**内容区**顶部、离边框还差一个内边距 ——
           *    用户要"贴紧上边框"就必须允许小幅负值（见 `childOffsetYMm` 的注释）。
           * ⚠️ 两层 `Math.max(-10, …)`：`maxY` 本身可能小于 −10（元素比格子还高），
           *    那时下限仍然让到 −10，不至于产生"下限 > 上限"的颠倒区间。
           */
          /*
           * ⚠️ 纵向上限 = **"内容区容器"的高 − 元素盒高**（2026-10-14 与打印端的容器方案配套）。
           *
           * 打印端现在把格内子元素包进了一层"内容区容器"（四边内缩 `pad`，见 `render/html.ts`），
           * 元素的 `top` 是**相对那个容器**的 ⇒ 所以这里钳制也必须是"**容器高**"，
           * 否则 `y` 能一直加到"内容区高 − 盒高" ⇒ **元素冒出容器** ⇒ 又变成"压线"。
           * ⚠️ 容器高 = `td 内容区高 − 2 × pad`。
           *   `cellGeom.height` 量的是 `td` 的**内容区高**（已减过上下 padding）……
           *   ⚠️ 注意：`cellGeom.height` 是按 `r.height` 量的（整格），这里再减 `2 × pad` 才是容器高。
           */
          /*
           * ⚠️ **单元格级内边距优先**（2026-10-14，与 `<td>` 的渲染、以及打印端**同口径**）。
           *   这一处原来只读表格级 `table.cellPaddingMm` ⇒ 用户在单元格上改内边距时
           *   **渲染变了、钳制没变** ⇒ 钳制范围与渲染位置差一个 pad ⇒ "四边贴不齐"的又一个来源。
           */
          const padCell = findCell(table.rows, cellId)?.cell
          const padPx = mmToPx(finite(padCell?.paddingMm, finite(table.cellPaddingMm, 1.5)))
          /*
           * ⚠️⚠️ **上限的"来源"必须和渲染端一致**（2026-10-15）。
           *
           * 渲染端（画布 td 与打印）用的是**模型值** `row.heightMm`；
           * 而这里原来用 **DOM 实测**（`cellGeom.height`）—— 两个来源必然偶尔对不上
           *   ⇒ 用户实测"拖到底了、但离底还差 1mm"（存进去的 19mm 超过了真实上限 18mm）。
           * ⇒ **模型行高优先**（与渲染同源）；只有行高是**自适应**（缺席）时才退回 DOM 实测。
           * ⚠️ 口径：`row.heightMm` 是 td 的 **border box 总高**（实测 box-sizing: border-box）
           *   ⇒ **内容区高 = 行高 − 2×pad**。
           * ⚠️ DOM 兜底那条 `(cellGeom.height − 2×pad)` **本来就是内容区高**，不用再减。
           */
          const padMmEff = finite(padCell?.paddingMm, finite(table.cellPaddingMm, 1.5))
          const rowHmmModel = table.rows.find((rw) => rw.cells.some((x) => x.id === cellId))?.heightMm
          const contentHmm =
            typeof rowHmmModel === 'number' && rowHmmModel > 0
              ? rowHmmModel - 2 * padMmEff
              : (cellGeom.height - padPx * 2) / (MM_TO_PX * Math.max(scale, 0.05))
          const maxY = cellGeom ? contentHmm - childBoxHeightMm(child) : 500
          const rawY0 = Math.round((startPos.yMm + dyMm) * 10) / 10
          const nextY = Math.min(
            Math.max(0, maxY),
            Math.max(0, Math.round((startPos.yMm + dyMm) * 10) / 10),
          )
          /*
           * ⚠️ **"是否顶到边界"** —— 用来驱动"蓄力"动效（见 `childPush` 的注释）。
           *   判据：**未夹紧的原始值**超出了合法区间（`[0, 上限]`）。
           *   ⚠️ 必须用**原始值**判断，不能用 `nextX/nextY`（那两个已经被夹紧了，永远在区间内）。
           */
          const rawX = startPos.xPct + dxPct
          /*
           * ⚠️ **顶到了哪几条边** —— 驱动「被挤压的那条单元格边框」高亮（2026-10-15 用户澄清：
           *   「**动效应该加在被挤压的那条边上，不是加在元素上**」）。
           *   ⚠️ 用 **未夹紧的原始值**判断：`nextX/nextY` 已被夹紧 ⇒ 判断恒为 false。
           */
          const dirKey =
            (rawX < 0 ? 'l' : '') +
            (rawX > maxX ? 'r' : '') +
            (rawY0 < 0 ? 't' : '') +
            (rawY0 > maxY ? 'b' : '')
          if (dirKey !== childPushRef.current) {
            childPushRef.current = dirKey
            setChildPush(
              dirKey
                ? {
                    cellId,
                    l: dirKey.includes('l'),
                    r: dirKey.includes('r'),
                    t: dirKey.includes('t'),
                    b: dirKey.includes('b'),
                  }
                : null,
            )
          }
          /*
           * ⚠️⚠️ **拖动时顺便同步「对齐」**（2026-10-14 用户明确要求，且是"左边莫名很宽"的真凶）。
             *
             * 用户原话：「附件紧贴左侧 ⇒ 对齐自动切『左』；紧贴右侧 ⇒ 自动切『右』；
             *   没有紧贴 ⇒ 保持『居中』。**这些也可以手动修改调整**」
             * 并指出：「我之前总觉得**左边比较宽**，其实是因为我把附件拖到紧贴左边的时候，
             *   **对齐处于『右』的状态**」——
             *   ⇒ `childBoxLeftPct()` 在"没手动偏移"时会退回 `config.align`，
             *     而 `align='right'` 会把元素**推到右边** ⇒ 用户以为拖到了左边，实际渲染在右边。
             *
             * ⇒ 在写 `cellPos` 的**同一处**顺手把推断出的 `align` 也写进去：
             *   · 阈值：`x ≤ 2%` ⇒ 左、`x + w ≥ 98%` ⇒ 右、其余 ⇒ 中；
             *   · ⚠️ 只在 `attach` 上写（别的 kind 没有 `align` 这个配置项）；
             *   · ⚠️ 用**同一个 mergeKey** ⇒ 和位置一起收成**一步撤销**（不会多出一堆步）。
             *   · ⚠️ 用户手动改 `align` 之后**仍会生效** —— 直到他**再次拖动**位置
             *     （那本来就是"重新决定对齐"的动作，与用户说的"也可以手动修改"不冲突）。
             */
            /*
             * ⚠️⚠️ **吸附 + 定位辅助线**（2026-10-16 用户要求：
             *   「附件、图片等在单元格中拖动时，也**有定位辅助线**出现，方便判断是否居中」+
             *   「定位辅助线要**有一定的吸附作用**」）。
             *
             * 参考线：横向 **内容区左沿 / 水平中线 / 右沿**；纵向 **上沿 / 垂直中线 / 下沿**。
             * 阈值：横向 **1.5%**、纵向 **1.5mm** —— 太小吸不住、太大"抢鼠标"。
             * ⚠️ 只吸**位置**、不改尺寸（尺寸归锚点管）。
             * ⚠️ 状态放**独立 state**（`childSnap`），**不跟"被挤压边高亮"（`childPush`）混** ——
             *   语义不同（一个"顶到边界"、一个"对齐到参考线"），合并会出现"两个都对但只显示一个"。
             */
            const SNAP_PCT = 1.5
            const SNAP_MM = 1.5
            const wPctForSnap = childWidthPct(child)
            const snapXs = [0, Math.max(0, (100 - wPctForSnap) / 2), Math.max(0, 100 - wPctForSnap)]
            let snapX = nextX
            let lineX: number | null = null
            for (const c of [snapXs[2], snapXs[1], snapXs[0]]) {
              if (Math.abs(nextX - c) <= SNAP_PCT) {
                snapX = Math.round(c * 10) / 10
                /* 线画在"被对齐的那条边/中线"上：左对齐看左边、居中看中线、右对齐看右边 */
                lineX = c + (c === snapXs[1] ? wPctForSnap / 2 : c === snapXs[0] ? 0 : wPctForSnap)
                break
              }
            }
            const contentHmmSnap =
              typeof rowHmmModel === 'number' && rowHmmModel > 0 ? rowHmmModel - 2 * padMmEff : cellGeom ? contentHmm : 0
            const hMmForSnap = childHeightMm(child) ?? 0
            const snapYs = [
              0,
              Math.max(0, (contentHmmSnap - hMmForSnap) / 2),
              Math.max(0, contentHmmSnap - hMmForSnap),
            ]
            let snapY = nextY
            let lineY: number | null = null
            if (contentHmmSnap > 0) {
              for (const c of [snapYs[2], snapYs[1], snapYs[0]]) {
                if (Math.abs(nextY - c) <= SNAP_MM) {
                  snapY = Math.round(c * 10) / 10
                  lineY = c + (c === snapYs[1] ? hMmForSnap / 2 : c === snapYs[0] ? 0 : hMmForSnap)
                  break
                }
              }
            }
            /* ⚠️ 独立 state（见上面的注释）：只在"吸附目标变了"时才 setState（拖动每帧都 set 会卡） */
            const snapKey = `${lineX ?? ''}:${lineY ?? ''}@${cellId}`
            if (snapKey !== childSnapRef.current) {
              childSnapRef.current = snapKey
              setChildSnap(
                lineX === null && lineY === null
                  ? null
                  : { cellId, lineX, lineY },
              )
            }
            const nextW = childWidthPct(child)
            const autoAlign: 'left' | 'center' | 'right' =
              snapX <= 2 ? 'left' : snapX + nextW >= 98 ? 'right' : 'center'
            /*
             * ⚠️ **四种元素共用这套对齐**（2026-10-14 用户要求："都遵循同一套规则"）：
             *   · **附件**用 `config.align`（`AttachmentPrintConfig`）；
             *   · **图片 / 二维码 / 条形码**用元素自己的 `align`（`types.ts` 的 `CellChildAlign`）。
             *   ⇒ 拖到贴边时**自动写入**；用户手动改过也保留（直到他**下次再拖位置**）。
             */
            const isAttach = child.kind === 'attach'
            const curAlign = isAttach
              ? child.config.align
              : (child as { align?: 'left' | 'center' | 'right' }).align
            const alignPatch =
              curAlign !== undefined && curAlign !== autoAlign
                ? isAttach
                  ? { config: { ...child.config, align: autoAlign } }
                  : { align: autoAlign }
                : null
            actions.patchCellChild(
              table.id,
              cellId,
              alignPatch
                ? { cellPos: { xPct: snapX, yMm: snapY }, ...alignPatch }
                : { cellPos: { xPct: snapX, yMm: snapY } },
              `cpos:${table.id}:${cellId}:${child.id}`,
              /* ⚠️ 一格可能有多个子元素 ⇒ **必须指定改哪一个** */
              child.id,
            )
        } else if (detached) {
          /*
           * ⚠️⚠️ **脱钩后 ghost 必须继续跟着鼠标走**（2026-10-13 第 2 次返工的关键一步）。
           *
           * 上一版只在 `if (sameCell)` 里设 ghost ⇒ 鼠标一出格子就**不再更新位置** ⇒
           * 那个"元素本体"会**停在原地不动**（看起来就是"本体没跟过来"）。
           * ⇒ 位置 = **鼠标 − 抓取偏移**，与 `takeOutChild` 的落点**同一个算法**（松手不跳）。
           */
          const pxPerMmNow = MM_TO_PX * Math.max(scale, 0.05)
          setChildGhost({
            x: mv.clientX - grab.dxMm * pxPerMmNow,
            y: mv.clientY - grab.dyMm * pxPerMmNow,
            label: elementLabel(child),
            child,
            /* 画布口径的宽（`w` 是"占格宽百分比"⇒ 换成 mm） */
            wMm: Math.round(((cellWidthMm(table, cellId) * childWidthPct(child)) / 100) * 10) / 10,
            hMm: childBoxHeightMm(child),
          })
        } else {
          /*
           * ⚠️ **不再有文字胶囊**（2026-10-13 用户明确：
           *   「正常应该是这个**虚线框替代**现在的蓝色文字标签」）。
           *   拖出格子 / 拖向别的格子，一律走上面的 `detached` 分支 ——
           *   **元素本体 + 画布样式**，比一个文字条更能让用户判断落点。
           */
          setChildGhost(null)
          childPushRef.current = ''
          setChildPush(null)
        childSnapRef.current = ''
        setChildSnap(null)
        }
        onDropTargetChange?.(lastCell ? { kind: 'cell', cellId: lastCell.cellId } : null)
      }

      const onUp = (up: PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setChildGhost(null)
          childPushRef.current = ''
          setChildPush(null)
        childSnapRef.current = ''
        setChildSnap(null)
        onDropTargetChange?.(null)
        if (!moved) {
          /*
           * 没越过 4px = **点击**（见函数头"拖过 4px 才算拖"那条）。
           *
           * ⚠️ 这里以前是 `if (!moved) return` —— 于是点格内元素**什么都不发生**，
           * 点击继续冒泡到 `<td>` 的 onClick，面板显示的是那一格的字段绑定
           * （真机反馈第 3 条："点击该单元格后，右侧属性面板显示 @image#1:… 未绑定字段"）。
           * 现在点击把选中落到**这个子元素自己**（复合 id `child:<tableId>:<cellId>`），
           * 面板据此显示它的属性；`onSelectCell` 照旧选中那一格 —— "它属于哪一格"是用户要看的信息。
           *
           * 注意 `<td>` 的 onClick 仍会跑到（pointerdown 的 stopPropagation 拦不住 click），
           * 它会再 `onSelect(el.id)` 把选中打回整表 —— 所以子元素那层加了
           * `onClick` 的 stopPropagation（见渲染处），两处必须成对，删一个就退化成原样。
           */
          onSelectCell(table.id, cellId)
          /*
           * ⚠️ **带上 `child.id`**（2026-10-16 放宽 `MAX_CELL_CHILDREN` 后必需）：
           *   一格多个子元素时，只写 `child:<tableId>:<cellId>` 分不清点的是**哪一个**
           *   ⇒ 面板会显示"第一个/某一个"的属性、右键删除也会删错。
           * ⚠️ 老形式（不带第三段）仍然合法 ⇒ 其它按"这一格"选中的路径不受影响。
           */
          onSelect(cellChildId(table.id, cellId, child.id))
          return
        }
        const target = lastCell as { tableId: string; cellId: string } | null
        if (target) {
          actions.moveChildToCell(table.id, cellId, target.tableId, target.cellId, child.id)
          return
        }
        /*
         * ⚠️⚠️ **落点仍在本格内 ⇒ 调整它在这一格里的位置**（2026-10-13 新增）。
         *
         * 判据用 `cellAtPoint`：落在本格就写 `cellPos`、落在纸上（格外面）才是"取出"。
         * ⚠️ 顺序很重要 —— **必须先判"是否还在本格"**，否则"格内拖动"会走进 `takeOutChild`
         *   （改之前就是这样：格内元素一拖就被取出到画布，因为格内也在纸上）。
         *
         * ⚠️ 位移换算：横向按**内容区宽的百分比**（与 `xPct` 同体系）、
         *    纵向按 **mm**（与 `yMm` 同体系）。纵向要除掉 `scale` ——
         *    屏幕 px 是缩放后的，而 mm 是纸张上的真实尺寸。
         * ⚠️ 锚点取 `startPos`（按下那一刻）+ 位移，**不是** `childOffsetXPct(child) + 位移`：
         *    后者在拖动中每次读到的都是上一帧写进去的值 ⇒ **增量累加** ⇒ 快速拖动会飞出去。
         */
        /*
         * ⚠️ **已脱钩 ⇒ 优先走"取出 / 换格"**（三段式的收尾）。
         *   此时用户已经把元素"推出"格子了，不该再要求"鼠标恰好落在格子外面"
         *   —— 那正是之前"压在边框上却没被取出"的原因。
         * ⚠️ 落点仍用 **鼠标 − 抓取偏移**，与拖动时 ghost 的位置**同一个算法**（不跳）。
         */
        if (detached) {
          const target2 = lastCell as { tableId: string; cellId: string } | null
          if (target2) {
            actions.moveChildToCell(table.id, cellId, target2.tableId, target2.cellId, child.id)
            return
          }
          const at2 = toContent(up.clientX, up.clientY)
          if (at2?.onPaper) {
            actions.takeOutChild(table.id, cellId, {
              xMm: at2.xMm - grab.dxMm,
              yMm: at2.yMm - grab.dyMm,
            })
          }
          return
        }
        const hitEnd = cellAtPoint(up.clientX, up.clientY)
        if (hitEnd && hitEnd.tableId === table.id && hitEnd.cellId === cellId && cellGeom) {
          /*
           * ⚠️ 位置**已经在 `onMove` 里逐帧写好了**（就是为了实时预览）⇒ 这里只**收成一步撤销**。
           *    再写一次不但多余，还会因为"没带同一个 mergeKey"而多塞一条撤销记录。
           */
          onCommitEnd?.()
          return
        }
        const at = toContent(up.clientX, up.clientY)
        if (at?.onPaper) {
          /*
           * ⚠️ **落点要减掉抓取偏移**，否则元素"跳到鼠标处" —— 用户抓的是元素中间，
           *    却把左上角放到了鼠标位置（"无法判断这个元素会出现在哪儿"，2026-10-13）。
           * ⇒ 这样元素才是**跟着手**出去的。
           */
          actions.takeOutChild(table.id, cellId, {
            xMm: at.xMm - grab.dxMm,
            yMm: at.yMm - grab.dyMm,
          })
        }
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    // ⚠️ `onSelect` / `onSelectCell` / `cellAtPoint` 是新增依赖：`useCallback` 漏依赖 = 闭包永远停在首次渲染，
    //    表现为"代码看起来完全正确但点击永不生效"（本项目在 `onCellPointerDown` 上刚栽过一次）。
    [actions, cellAtPoint, onDropTargetChange, onSelect, onSelectCell, scale, toContent],
  )

  /**
   * **格内元素的缩放手柄**（2026-10-13）：拖右下角的手柄改 `w`（占格宽 %）与 `h`（mm）。
   *
   * 用户原话：「单元格内的图片、二维码、附件等元素**无法通过手动缩放**，
   * 参照**这些元素在画布中的逻辑**，可以手动缩放」。
   *
   * ⚠️ 与画布上拖元素手柄**同一套纪律**：
   *   · 锚点取**按下那一刻**的 `w`/`h`（不是增量累加 —— 拖动中每帧都在 patch 文档，
   *     读实时值会指数漂移）；
   *   · 位移按 `scale` 反算 mm（屏幕 px 是缩放后的，`w`/`h` 是纸张上的真实尺寸）；
   *   · 横向换算成百分比时**除以格内容宽**（`w` 是"占格宽"的百分比、不是 mm）。
   *
   * ⚠️ **每次都带上 `cellPos`**：否则"已定位的元素一缩放就跳回流式位置"——
   *    因为 `patchCellChild` 是整体替换子元素对象的一部分，
   *    `cellPos` 不传就保持原值（这里显式传是为了**语义清楚**，不是必需）。
   *    ⚠️ 反过来说：**没定位过的元素缩放后也不该被定位** ——
   *    所以这里传的 `cellPos` 只在**原本就有时**才给（见下面 `hadPos`）。
   */
  const onChildResizeDown = useCallback(
    (
      ev: ReactPointerEvent,
      table: TableElement,
      cellId: string,
      child: AnyElement,
      /**
       * 拖的是**哪个锚点**（`nw` / `n` / `ne` / `w` / `e` / `sw` / `s` / `se`）。
       *
       * ⚠️ 为什么要 8 个方向而不是只做一个角（2026-10-13 用户要求：
       *   「点击后应该在边框出现 **8 个锚点**，鼠标移动上去出现缩放的指针图标，按住左键进行缩放」）：
       *   只给一个角的话，"往左扩"和"往上扩"这两个最自然的动作**做不到** ——
       *   只能"往右下长大，再把位置挪回去"，两步且反直觉。
       * ⚠️ 各方向的差别只在**改哪两条边**：`n` 改上边、`e` 改右边 …… 见下面的分解。
       */
      dir: 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se',
    ) => {
      if (ev.button !== 0 || !actions) return
      ev.stopPropagation()
      ev.preventDefault()
      const startX = ev.clientX
      const startY = ev.clientY
      const startW = childWidthPct(child)
      const startH = childBoxHeightMm(child)
      const hadPos = isChildPositioned(child)
      const startPos = { xPct: childOffsetXPct(child), yMm: childOffsetYMm(child) }
      const cwMm = Math.max(1, cellWidthMm(table, cellId))
      /*
       * ⚠️ **量出这一格的高度**（mm）—— 缩放的**纵向也必须夹住**
       *   （2026-10-13 用户报：「点击单元格内元素的**上方/下方**三个锚点缩放，
       *    元素的下半部分会**超出单元格**，即元素可以**向下无限拖大**」）。
       *
       * 根因：`onMove`（拖动）那条链我加了 `maxY` 夹住，但**缩放这条链漏了** ——
       * 两个入口改同一份数据，只夹住一个 ⇒ 另一个照样越界。
       * ⚠️ 量的是**整格高**（与拖动那条同口径：`y = 0` 是边框内沿）。
       */
      const tdElR = (ev.currentTarget as HTMLElement).closest('td')
      /*
       * ⚠️⚠️ **"可用高"必须减去上下内边距**（2026-10-15 用户报：
       *   「设置了内边距后，**四个元素的底边都可以被拉出单元格区域**，
       *     拉动上边也会导致底边超出单元格；**内边距为 0 就没有这个 bug**」）。
       *
       * 根因：`td.getBoundingClientRect().height` 是 **border box 高**（含上下 padding），
       *   而元素只能用**内容区** ⇒ 不减 padding 就多出 `2×pad` 的可拉空间。
       *   ⚠️ 这一处与渲染端的口径**不一致** —— 渲染端 `effectiveChildYMm` 是按
       *     `行高 − 2×pad`（内容区）夹的，所以"拖得出去、但渲染时被夹回来" ⇒
       *     用户看到的就是"能拉出单元格"。
       * ⚠️ 内边距取**单元格级优先**（与 `<td>` 的 padding、拖动钳制、打印端**同一个来源**）。
       */
      const padMmHere = finite(
        (table.kind === 'table' ? findCell(table.rows, cellId)?.cell : null)?.paddingMm,
        finite(table.cellPaddingMm, 1.5),
      )
      const cellHmm = tdElR
        ? tdElR.getBoundingClientRect().height / (MM_TO_PX * Math.max(scale, 0.05)) - 2 * padMmHere
        : 0
      /** 改哪两条边 —— 8 个方向只是这三种组合 */
      const hitLeft = dir.includes('w')
      const hitRight = dir.includes('e')
      const hitTop = dir.includes('n')
      const hitBottom = dir.includes('s')
      let moved = false

      const onMove = (mv: PointerEvent): void => {
        if (!moved) {
          if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 3) return
          moved = true
        }
        const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
        /* 横向按"占格宽百分比"、纵向按 mm —— 与 `w`/`h`/`x`/`y` 各自的体系一致 */
        const dxPct = ((mv.clientX - startX) * mmPerPx * 100) / cwMm
        const dyMm = (mv.clientY - startY) * mmPerPx
        let w = startW
        let h = startH
        let xPct = startPos.xPct
        let yMm = startPos.yMm
        /*
         * ⚠️ **拖左边**时：宽度反向变化，**同时把左偏移推着走** —— 这样**右边界不动**，
         *    手感才是"从左边拽"而不是"整体往右平移"。与表格列宽拖左外框是同一条纪律
         *    （见 `onBorderPointerDown` 的 `originShift`）。
         * ⚠️ 拖上边同理（`y` 跟着走、下边界不动）。
         */
        if (hitRight) w = startW + dxPct
        if (hitLeft) {
          w = startW - dxPct
          xPct = startPos.xPct + dxPct
        }
        if (hitBottom) h = startH + dyMm
        if (hitTop) {
          h = startH - dyMm
          yMm = startPos.yMm + dyMm
        }
        /*
         * ⚠️⚠️ **四个"角落"锚点 = 等比缩放**（2026-10-16 用户要求：
         *   「上下左右四个点可以随意修改，而拖动**四个角落点，应该是等比例缩放**」）。
         *
         * ⚠️ 判据：**同时命中横向与纵向**（`dir` 是两字母，如 `se` / `nw`）——
         *   四边的锚点（`n`/`s`/`e`/`w`）**保持自由拉伸**，行为逐字不变。
         *
         * ⚠️ **基准比例必须在 mm 下算**：`w` 是"占内容区宽的百分比"、`h` 是 mm，
         *   直接相除会得出一个**没有任何意义的数**（单位不一致）⇒ 先把 `w` 换算成 mm。
         *
         * ⚠️ **以"偏离起点更大"的那根轴为准**：用户往横向拉得狠就听横向、往纵向拉得狠就听纵向 ——
         *   否则会出现"我明明在往右拉，它却先动高度"的别扭手感。
         *
         * ⚠️ **对角固定**：拖左边就推 `x`、拖上边就推 `y`（与上面"右/下边界不动"**同一条纪律**）。
         *   不做这一步的话，等比缩放会以"左上角"为原点 ⇒ 拖左上角时元素会整体跑掉。
         */
        const isCorner = (hitLeft || hitRight) && (hitTop || hitBottom)
        /* ⚠️ `cellWidthMm` 是**函数**（`cellWidthMm(table, cellId)`）⇒ 先算出这一格的**内容区宽**
           （减掉左右内边距 —— `w` 的分母就是它，见 `cell-child.ts` 的口径注释）。 */
        const contentWmmNow = Math.max(1, cellWidthMm(table, cellId) - 2 * padMmHere)
        if (isCorner && startH > 0) {
          /*
           * ⚠️⚠️ **与顶层同一套修法**（2026-10-16）：用"相对起点的缩放因子"，
           *   不要"选一根轴" —— 后者会让元素**突然放大、锚点脱离鼠标**。
           * `k = max(w / startW, h / startH)` ⇒ 从 1 倍连续变化、跟手。
           * ⚠️ 用的是**同轴比值**（百分比 / 百分比、mm / mm）⇒ 不需要换算成 mm；
           *   下面那行 `contentWmmNow` 只在"写回百分比"时才用得到。
           */
          const kFromW = startW > 0 ? w / startW : 1
          const kFromH = startH > 0 ? h / startH : 1
          const kScale = Math.max(kFromW, kFromH)
          w = startW * kScale
          h = startH * kScale
          if (hitLeft) xPct = startPos.xPct + (startW - w)
          if (hitTop) yMm = startPos.yMm + (startH - h)
        }
        /* 夹住：宽度在 [MIN, 100]%、高度在 [2, 500]mm、位置不许为负（负了会被格子裁掉一半还找不回来） */
        const clampedW = Math.min(100, Math.max(MIN_CELL_CHILD_PCT, Math.round(w * 10) / 10))
        const clampedX = Math.round(Math.max(0, xPct) * 10) / 10
        /* ⚠️ 纵向下限 0（ = 边框内沿，元素盒子的锚点就在它上面） */
        const clampedY = Math.round(Math.max(0, yMm) * 10) / 10
        /*
         * ⚠️⚠️ **高度上限 = 格高 − 上偏移**（2026-10-13 用户报：
         *   「点击**上方/下方**三个锚点缩放，元素的下半部分会**超出单元格** ——
         *    元素可以**向下无限拖大**」）。
         *
         * 根因：`onMove`（拖动）那条链有 `maxY` 夹住，**缩放这条链漏了** ——
         * 两个入口改同一份数据，只夹住一个 ⇒ 另一个照样越界。
         * ⚠️ 用 `clampedY`（已被夹住的值）而不是原始 `yMm`：
         *   拖**上边**锚点放大时 `y` 会变小（元素往下长），
         *   拿未夹的 `y` 算上限会让区间算错。
         * ⚠️ 下限保底 2mm：极小的格子也不至于算出负的上限。
         */
        const maxH = cellHmm > 0 ? Math.max(2, cellHmm - clampedY) : 500
        const clampedH = Math.min(maxH, Math.max(2, Math.round(h * 10) / 10))
        /*
         * ⚠️ **尺寸被夹住时，位置也要跟着停**：拖左边把宽度夹在 MIN 之后，
         *    如果 `x` 还在继续右移，元素就会"一边缩一边往右跑"。
         *    ⇒ 用**实际生效的宽度差**反算 `x`（而不是用原始的 `dxPct`）。
         */
        /*
         * ⚠️ 位置也**不许越出格内容区**（与"拖动移动"那条同一个上限 `100 − w`）：
         *    拖左边把宽度拉大时 `x` 会被往回推，若不同步夹住，元素右边界就跨到隔壁格子上了
         *    —— 那正是用户报的"覆盖在两个单元格之间"。
         */
        const maxX = Math.max(0, 100 - clampedW)
        const rawX = hitLeft ? startPos.xPct + (startW - clampedW) : clampedX
        const rawY = hitTop ? startPos.yMm + (startH - clampedH) : clampedY
        const effX = Math.min(maxX, rawX)
        /*
         * ⚠️⚠️ **纵向下限 0、上限 `cellHmm − clampedH`**（2026-10-15 用户报：
         *   「设置了内边距后，四个元素的**底边都可以被拉出单元格区域**；
         *     **拉动上边也会导致底边超出单元格**」）。
         *
         * 根因：`y` 原来**只夹了下限 0、没有上限**。
         *   · 拖**上边**锚点：`h = startH − dy`、`y = startY + dy`（底边本该不动），
         *     但 `clampedH` 有 **2mm 下限** ⇒ 拖到极限后 `h` 停在 2，
         *     而 `y` 还在继续增大 ⇒ **`y + h` 冲过内容区高** ❌
         *   · 拖**下边**锚点：`y` 不动、`h` 增大，上限 `maxH = cellHmm − y` 本来是对的，
         *     但 `Math.max(2, …)` 那条下限在"格子比 2mm 还小"时同样会顶穿。
         * ⇒ **统一在最后夹一次 `y`**：保证 `y + h ≤ 内容区高`（内边距已经算进 `cellHmm`）。
         * ⚠️ 与渲染端 `effectiveChildYMm`（按 `行高 − 2×pad` 夹）**同一口径**。
         */
        const maxY = Math.max(0, cellHmm > 0 ? cellHmm - clampedH : 500)
        const effY = Math.min(maxY, Math.max(0, rawY))
        /* ⚠️ 拖角/拖边都会"从流式变成已定位"（有位置才有 8 个锚点的意义）⇒ 一律写 cellPos */
        void hadPos
        /*
         * ⚠️⚠️ **拖动大小 ⇒ 自动归「自由」**（2026-10-15 用户报：
         *   「附件元素，我手动去**拖动边框修改大小**，尺寸模式**不会从原图跳转为自由**」）。
         *
         * 根因：格内元素的缩放走的是**这条 `onChildResizeDown`**（8 个锚点），
         *   **跟顶层元素的 `onElementPointerDown` 是两条路** ——
         *   我上一轮只改了顶层那条（`touchesAnyEdge`）⇒ 格内附件当然不动。
         *   ⚠️ 而**图片"看起来生效了"**，是因为它没有 `sizeMode` 字段，
         *     "自由"是**从 `h` 是不是具体值反推**的 —— 这里写了 `h` ⇒ 自动显示为自由。
         * ⇒ 在这里也把 `sizeMode` 切到 `fixedBox`（**只对 `attach`**，别的 kind 没这个字段）。
         */
        actions.patchCellChild(
          table.id,
          cellId,
          {
            w: clampedW,
            h: clampedH,
            cellPos: { xPct: Math.round(Math.max(0, effX) * 10) / 10, yMm: Math.round(Math.max(0, effY) * 10) / 10 },
            ...(child.kind === 'attach' && child.config.sizeMode !== 'fixedBox'
              ? { config: { ...child.config, sizeMode: 'fixedBox' as const } }
              : {}),
          },
          `csize:${table.id}:${cellId}:${child.id}`,
          /* ⚠️ 同上：指定改哪一个 */
          child.id,
        )
      }

      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        if (moved) onCommitEnd?.()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [actions, cellWidthMm, onCommitEnd, scale],
  )

  /** Esc 取消选区。**先于**编辑器的 Esc（取消选中元素）处理，两件事同时发生也不冲突（都只是清状态） */
  useEffect(() => {
    if (!cellSel) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCellSel(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [cellSel])

  /**
   * 工具条的动作 → 具体怎么改。
   *
   * 合并与删除行/列**会丢东西**（图片格/整行内容），所以它们走 `actions.*` 里那条带确认层的路
   * （`askMergeRange` / `deleteRow` / `deleteCol`），而不是在这里直接改文档。
   * 样式类（对齐/加粗/底纹/表头）不丢东西，直接套补丁。
   */
  const onRangeOp = useCallback(
    (op: RangeOp): void => {
      if (!cellSel || !selRange || !actions) return
      const { tableId } = cellSel
      const found = readBand(doc, bandOf(tableId)).find((e) => e.id === tableId)
      if (!found || found.kind !== 'table') return
      const el = found
      const first = tableGrid(el.rows, el.colWidthsMm.length)[selRange.r1]?.[selRange.c1]?.cell.id ?? null

      switch (op.kind) {
        case 'merge':
          actions.askMergeRange(tableId, selRange)
          return
        case 'split':
          if (first) actions.splitCell(tableId, first)
          return
        case 'bold':
          actions.applyRange(tableId, selRange, { kind: 'bold', on: op.on })
          return
        case 'align':
          actions.applyRange(tableId, selRange, op)
          return
        case 'fill':
          actions.applyRange(tableId, selRange, op)
          return
        case 'header':
          actions.applyRange(tableId, selRange, op)
          return
        case 'border':
        case 'borderFollow':
        case 'borderWidth':
        case 'borderColor':
        case 'headerCol':
        case 'color':
          actions.applyRange(tableId, selRange, op)
          return
        case 'insertRow':
          if (first) actions.insertRow(tableId, first, 'below')
          return
        case 'insertCol':
          if (first) actions.insertCol(tableId, first, 'right')
          return
        case 'deleteRow':
        case 'deleteCol': {
          // 删除要用**定位器 cellId**（行/列号在确认层开着时会变）
          const anchor = tableGrid(el.rows, el.colWidthsMm.length)[selRange.r1]?.[selRange.c1]?.cell.id
          if (!anchor) return
          if (op.kind === 'deleteRow') actions.deleteRow(tableId, anchor)
          else actions.deleteCol(tableId, anchor)
          return
        }
        default:
          return
      }
    },
    [actions, bandOf, cellSel, doc, selRange],
  )

  /**
   * 单元格里的块级子元素怎么画（规格 六）。
   *
   * 只支持"放进格子里说得通"的几种：图片 / 二维码 / 条形码 / 文本 / 水平线。
   * 其余（表格 / 附件块 / 分页符）给一句**明确的占位说明**，而不是画成空白 ——
   * 空白会让用户以为"拖进来没成功"。
   *
   * ⚠️ 与自由层元素的画法**同一套取值**（图片的 `object-fit`、码的 svg 串），
   *    否则"同一张图在格子里和在画布上长得不一样"这种事迟早出现。
   */
  const renderCellChild = (child: AnyElement, cellW: number): ReactNode => {
    if (child.kind === 'image') {
      /*
       * ⚠️ 还没选图时**必须给占位盒**（2026-09-23 真机反馈第 2 条）。
       * `<img src="">` 会塌成一条细线：宽度撑满、高度几乎为 0 ⇒ 用户看到的就是"格内图片是窄条"。
       * 而且细线意味着**点不中**，右键自然也就落到表格上去了（第 3 条那个"菜单还是表格设置"）。
       */
      if (!imgSrcOf(child)) {
        /*
         * ⚠️ 文案结构与其它三种**逐字对齐**（2026-09-24 第四批第 1 条「保持画风一致」）：
         * 标题（绿标）+ 主文案 + 副文案，**固定三行**。
         *
         * 原来这里只有两行，于是它的盒子比码 / 附件矮一截 —— 四种元素并排时高矮不齐，
         * 用户读作"每个都长得不一样，导致表格变形严重"（他截的图里正是这个样子）。
         */
        return (
          <span className="bp-el-cell__child-phbox is-warn" title="还没选择图片：在右侧属性面板里选一张">
            <span className="bp-el-cell__child-phbox-title">固定图片</span>
            <span>还没选择图片</span>
            <span>在右侧属性面板选择</span>
          </span>
        )
      }
      return (
        <img
          className="bp-el-cell__child-img"
          src={imgSrcOf(child)}
          alt=""
          /* 图片默认可拖拽（HTML 规范）：浏览器自己起原生 dnd，我们的 pointermove 会话就不触发了
             ⇒ 表现为「格内图片拖不动」。自由层那张早加了 draggable={false}，格内这张漏了。 */
          draggable={false}
          /*
           * ⚠️⚠️ **"原图"模式要按图片的固有尺寸画**（2026-10-15 用户报：
           *   「图片在手动拖动边框修改大小后，会自动跳到自由，但此时**点击原图**，
           *    虽说边框跳转回去了，但**明显不是原始尺寸**」）。
           *
           * 原来这里只有 `object-fit` ⇒ `.bp-el-cell__child-img` 的 CSS 是 `width/height:100%`
           *   ⇒ **永远撑满元素框**，"原图"也撑满 ⇒ 看起来跟别的模式没区别。
           * ⇒ `fit === 'natural'`（= 引用"原图"，由 `imageFillModeOf` 从 `h:'auto'` 反推）时：
           *   `width/height: auto` ⇒ **让浏览器按图片固有尺寸画**；
           *   `objectFit: 'none'` ⇒ **不缩放**；
           *   `maxWidth: 100%` ⇒ **兜底**（比容器宽时仍要收住，避免溢出单元格）。
           * ⚠️ 打印端本来就是按 `wPx`（图片原始 CSS 像素）算的（见 `render/html.ts` 的
           *   `case 'original'`）—— 这一改让**画布与打印口径一致**。
           */
          style={
            child.fit === 'natural'
              ? { width: 'auto', height: 'auto', maxWidth: '100%', objectFit: 'none' }
              : {
                  objectFit: child.fit === 'cover' || child.fit === 'fill' ? child.fit : 'contain',
                  /*
                   * ⚠️ **`objectPosition` 要跟「对齐」走**（2026-10-16 用户报：
                   *   「打印的图片一直都是默认对齐左边……**检查其他类似元素有没有同样的 BUG**」）。
                   *   ⚠️ 画布端**两处都没有**这个属性 ⇒ `contain` 时图**永远居中**，
                   *   **改「对齐」在画布上完全看不出变化**（打印端已修，这里补上）。
                   *   ⚠️ 元素级 `align` 缺席 ⇒ 退回居中（与 CSS 默认一致）。
                   */
                  objectPosition:
                    (child as { align?: 'left' | 'center' | 'right' }).align === 'left'
                      ? 'left center'
                      : (child as { align?: 'left' | 'center' | 'right' }).align === 'right'
                        ? 'right center'
                        : 'center center',
                }
          }
        />
      )
    }
    if (child.kind === 'qrcode' || child.kind === 'barcode') {
      const p = codePreview(child, fields, cellW * (childWidthPct(child) / 100))
      if (p.svg) {
        return <span className="bp-el-cell__child-code" dangerouslySetInnerHTML={{ __html: p.svg }} />
      }
      /*
       * ⚠️ 占位盒必须与图片 / 附件**同一套视觉**（2026-09-24 第四批第 1 条）。
       *
       * 用户原话：「每个都长的不一样，导致表格变形严重……建议把附件、二维码、条形码、图片保持画风一致」。
       * 原来这里挂的是 `bp-el-code bp-el-code--ph` —— 那是**自由层**码占位盒的类，
       * 于是格内凭空出现了第三种长相（绿框 + 橙色虚线 + 橙色文字），而图片/附件是素框 + 灰字。
       * ⇒ 统一用 `.bp-el-cell__child-phbox`，与 `attach`、以及"还没选图"的 `image` 完全同款。
       */
      return (
        <span className={`bp-el-cell__child-phbox${p.warn ? ' is-warn' : ''}`} title={p.hint}>
          {/* 标题用**类型名**，与「固定图片 / 附件」同一口径（原来放的是 `p.badge` 状态角标，
              于是四种元素里只有码的标题不是"它是什么"，观感上就"不是一个系列"） */}
          <span className="bp-el-cell__child-phbox-title">{child.kind === 'qrcode' ? '二维码' : '条形码'}</span>
          <span>{p.text}</span>
          <span>{child.source.kind === 'field' ? '打印时逐条生成' : '在右侧属性面板填写'}</span>
        </span>
      )
    }
    if (child.kind === 'attach') {
      /*
       * 附件在**画布上只知道字段、不知道值**（值是按记录取的）⇒ 画一枚说明盒。
       *
       * ⚠️ 原来是 `display:block` 的一行小胶囊（「附件 · 字段名」），在格子里就是**一条长条**
       *    （真机反馈 2026-09-23 第 7 条：「拖动附件字段到单元格内，还是显示为一个长条」）。
       *    现在与图片/二维码占位盒同一套形态：有高度、居中、三行字说清"这是什么、打印会怎样"。
       */
      return (
        <span
          className="bp-el-cell__child-phbox"
          title={`附件字段「${child.fieldName || '未绑定'}」：打印时按每条记录显示图片；非图片显示文件名`}
        >
          <span className="bp-el-cell__child-phbox-title">附件</span>
          <span>{child.fieldName || '未绑定字段'}</span>
          <span>打印时按记录出图</span>
        </span>
      )
    }
    if (child.kind === 'text') {
      return (
        <span className="bp-el-cell__child-text">
          {renderInline(child.nodes, fields, child.id, undefined, undefined, undefined, decoOf(child.style))}
        </span>
      )
    }
    if (child.kind === 'hline') {
      return (
        <span
          className="bp-el-cell__child-hr"
          style={{ borderTopWidth: ptToPx(child.thicknessPt), borderTopColor: child.color }}
        />
      )
    }
    return <span className="bp-el-cell__child-ph">这个元素不能放进单元格</span>
  }

  // ---- 元素渲染 ----
  /**
   * 行内节点的点选上下文。`onSelectNode` 没传就不挂点击钩子 ——
   * 只读场景（预览）不该让占位符看起来可以点。
   */
  const pickFor = useCallback(
    (elementId: string, cellId: string | null): InlinePick | undefined =>
      onSelectNode ? { elementId, cellId, selectedNode, onSelectNode } : undefined,
    [onSelectNode, selectedNode],
  )

  const renderBody = (el: AnyElement): ReactNode => {
    switch (el.kind) {
      case 'text': {
        if (editingId === el.id && !editingCellId) {
          return <textarea className="bp-inline-edit" style={textCss(el)} {...inlineEditProps(el)} />
        }
        return (
          <div className="bp-el-text" style={blockCss(el.style)}>
            {renderInline(
              el.nodes,
              fields,
              el.id,
              pickFor(el.id, null),
              el.style?.color,
              undefined,
              decoOf(el.style),
            )}
          </div>
        )
      }
      case 'fieldBlock': {
        const meta = fieldMeta(fields.find((f) => f.id === el.fieldId)?.type)
        const bound = !!el.fieldId && fields.some((f) => f.id === el.fieldId)
        return (
          <div className="bp-el-text" style={textCss(el)}>
            {el.prefix ? <span>{el.prefix}</span> : null}
            <span
              className={`bp-chip${bound ? '' : ' bp-chip--missing'}`}
              title={bound ? el.fieldName : `「${el.fieldName || '未绑定'}」已失效或未绑定字段`}
            >
              <span className="bp-chip__text">{el.fieldName || '未绑定字段'}</span>
            </span>
            {el.suffix ? <span>{el.suffix}</span> : null}
            <span className="bp-el-note">{meta.renderKind === 'attachment' ? '附件字段请用附件块' : ''}</span>
          </div>
        )
      }
      case 'table': {
        const { table, cell } = tableCss(el)
        const pad = mmToPx(finite(el.cellPaddingMm, 1.5))
        return (
          <table className="bp-el-table" style={table}>
            <colgroup>
              {el.colWidthsMm.map((cw, i) => (
                <col key={i} style={{ width: `${nz(cw, 10)}mm` }} />
              ))}
            </colgroup>
            <tbody>
              {el.rows.map((row, r) => (
                <tr
                  key={row.id}
                  data-row-index={r}
                  style={row.heightMm ? { height: `${nz(row.heightMm, 5)}mm` } : undefined}
                >
                  {row.cells.map((c) => {
                    const ci = row.cells.indexOf(c)
                    /*
                     * ⚠️ **网格列号**（2026-10-17）：`ci` 是**数组下标**，合并之后 ≠ 网格列号。
                     *   选区（`selRange`）存的是网格坐标 ⇒ 判"这一格在不在选区里"必须用这个。
                     */
                    const colStart = row.cells
                      .slice(0, ci)
                      .reduce((a2, cc) => a2 + Math.max(1, Math.floor(finite(cc.colspan, 1))), 0)
                    /**
                     * ⚠️ 判据里多了 `childSel`：选中的是**这一格里的子元素**时，这一格也要亮 ——
                     * 子元素在视觉上就在格子里，格子不亮会让人以为"什么都没选中"。
                     * 复合 id 只在这里算一次（下面渲染子元素还要用同一个值）。
                     */
                    const childKey = cellChildId(el.id, c.id)
                    /*
                     * ⚠️ **"这一个子元素"被选中的判据**（2026-10-16）——
                     *   3 段 id：`child:<tableId>:<cellId>:<childId>`。
                     *   ⚠️ 必须**逐个子元素算**（每个 child 一次），所以放在 map 回调里。
                     *   见上面 `className` 处的注释（为什么要与 `childSel` 分开）。
                     */
                    const thisChildSelOf = (cid: string): boolean =>
                      selectedId === cellChildId(el.id, c.id, cid)
                    /*
                     * 这一格的**宽度（mm）** —— 只给格内码预览定尺寸用。
                     *
                     * ⚠️ 与渲染端同口径：**从本行第一格起累加 `colspan`** 推出起始列号
                     * （数组下标 ≠ 网格列号，跨列合并时尤其明显）。
                     * 取不到列宽时退化成 4mm（很小但可见），**绝不退化成 0** —— 那会让码彻底消失。
                     */
                    const cellBoxMm = (() => {
                      let col = 0
                      for (const cc of row.cells) {
                        if (cc.id === c.id) break
                        col += Math.max(1, Math.floor(finite(cc.colspan, 1)))
                      }
                      const sp = Math.max(1, Math.floor(finite(c.colspan, 1)))
                      let sum = 0
                      for (let k = 0; k < sp; k++) sum += el.colWidthsMm?.[col + k] ?? 0
                      return Math.max(4, sum)
                    })()
                    const childSel = selectedId === childKey
                    const selected = (selectedId === el.id && selectedCellId === c.id) || childSel
                    const cellEditing = editingId === el.id && editingCellId === c.id
                    const empty = c.nodes.length === 0
                    const isDropTarget = dropTarget?.kind === 'cell' && dropTarget.cellId === c.id
                    return (
                      <td
                        key={c.id}
                        colSpan={Math.max(1, finite(c.colspan, 1))}
                        rowSpan={Math.max(1, finite(c.rowspan, 1))}
                        data-cell-id={c.id}
                        /*
                         * ⚠️⚠️ **选区判断要用"网格列号 `col`"，不能用"数组下标 `ci`"**
                         *   （2026-10-17 用户报："合并后选中被合并的单元格，**悬浮菜单没有恢复的选项**"）。
                         *
                         * 根因：`selRange` 存的是**网格坐标**（`r1/c1/r2/c2`），
                         *   而合并之后 `row.cells` 的**数组下标 ≠ 网格列号**（少了被合并掉的那些）⇒
                         *   `is-rsel` 加不上 ⇒ 工具条靠 `td.is-rsel` 量位置**量不到** ⇒
                         *   `barAt = null` ⇒ **整个浮动菜单不出现** ✅
                         * ⚠️ `col` 是上面那圈 `for` 累加 `colspan` 算出来的**网格列号**，正好是同一口径。
                         */
                        className={`bp-el-cell${selected ? ' is-selected' : ''}${row.isHeader ? ' is-header' : ''}${isDropTarget ? ' is-drop-target' : ''}${inSel(el.id, r, colStart, selRange) ? ' is-rsel' : ''}${
                          childPush && childPush.cellId === c.id
                            ? ` is-push${childPush.l ? ' is-push-l' : ''}${childPush.r ? ' is-push-r' : ''}${childPush.t ? ' is-push-t' : ''}${childPush.b ? ' is-push-b' : ''}`
                            : ''
                        }`}
                        /* 按下即起"拖动扩选"（规格 四）。⚠️ 单元格从此不再兼任"拖整表"——
                           那个角色归表格手柄（规格 一），见 onCellPointerDown 的注释。 */
                        onPointerDown={(ev) => onCellPointerDown(ev, el, r, ci, c.id)}
                        /*
                         * ⚠️ **单元格的垂直对齐要在画布上生效**（2026-10-02 项目体检 P1-1）。
                         *
                         * `textCss` 不输出 `vertical-align`，而 `.bp-el-cell` 的类样式写着
                         * `vertical-align: top` ⇒ 用户在面板里设「居中 / 底端」时
                         * **打印端生效（`html.ts` 有 `vAlignCss`）、画布端纹丝不动**。
                         * 内联样式优先级高于类选择器 ⇒ 写在这里就够，不必动 CSS。
                         * 取值口径与打印端 `vAlignCss` **逐字一致**（middle / bottom / 其余按 top）。
                         */
                        style={{
                          ...cell(r, ci),
                          /*
                           * ⚠️⚠️ **单元格级内边距优先**（2026-10-14 修）。
                           *
                           * 用户报：「**不论内边距是多少，都依旧是上左右三边无法紧贴，底边可以紧贴**」——
                           * "不论多少都一样" ⇒ 那个偏移**与内边距无关** ⇒ 查下来是：
                           *   · **打印端**读 `cell.paddingMm`（**回退**表格默认）；
                           *   · **画布端**只读 `el.cellPaddingMm`（**表格级**）⇒ **完全忽略单元格级内边距**。
                           * ⇒ 用户在**单元格**上改内边距时，画布纹丝不动 ⇒ 表现"怎么改都一样"。
                           * ⇒ 与打印端**逐字同口径**：单元格优先、表格兜底。
                           */
                          padding: mmToPx(finite(c.paddingMm, finite(el.cellPaddingMm, 1.5))),
                          /*
                           * ⚠️ **「被挤压的那条边」高亮**（2026-10-15 用户澄清：
                           *   「**动效应该加在被挤压的那条边上，不是加在元素上**」）。
                           *
                           * ⚠️ 只把**阴影值**用 CSS 变量传进去（多边可以拼），
                           *   **动画由  那个类负责** ——
                           *   inline 的 box-shadow **没法做动画**（CSS 动画只能作用于样式表里的声明）。
                           * ⚠️ 用  内阴影而**不是 border**：border 会改变盒模型尺寸，
                           *   而这个文件里所有几何（命中测试/手柄落点/列宽占比）都按 border-box 读 rect。
                           */
                          ...(childPush && childPush.cellId === c.id
                            ? ({
                                '--push-shadow': [
                                  childPush.l ? 'inset 3px 0 0 0 var(--accent)' : '',
                                  childPush.r ? 'inset -3px 0 0 0 var(--accent)' : '',
                                  childPush.t ? 'inset 0 3px 0 0 var(--accent)' : '',
                                  childPush.b ? 'inset 0 -3px 0 0 var(--accent)' : '',
                                ]
                                  .filter(Boolean)
                                  .join(', '),
                              } as React.CSSProperties)
                            : {}),

                          /*
                           * ⚠️⚠️ **`position: relative` 必须在这里**（2026-10-14）。
                           *
                           * 格内子元素是 `position: absolute`，它的 `left/top` 是**相对单元格内容区**算出来的
                           * ⇒ 如果这一格**没有建立定位上下文**，绝对定位会去找**更外层的定位祖先**
                           *   （`.bp-paper` / 版心之类）⇒ 元素会**跑到别的格子上或跨格**。
                           * ⇒ 与打印端（`render/html.ts` 的 `<td>`）**同一口径**。
                           */
                          position: 'relative',
                          /*
                           * ⚠️ **这里不能有 `overflow: hidden`**（2026-10-13 用户第 2 次反馈后删掉）：
                           *   「元素**向上**拖动会被切掉大概一半，**向下**拖动也会被裁切一点点」。
                           *
                           * 上一轮我加裁切，是因为"纵向没有分母、算不出来"。**那个判断是错的** ——
                           * 拖动那一刻格子已经渲染出来，内容区高度**量得出来**
                           * （见 `onChildPointerDown` 的 `cellGeom.height`）。
                           * ⇒ 纵向改成**夹住**之后，元素永远待在内容区内，**根本不需要裁**；
                           *   留着裁切只会制造"向上被切一半"这种诡异现象
                           *   （`y` 允许负值时元素跑到内边距里，就被裁了）。
                           * ⚠️ 两端必须一致：`render/html.ts` 的 `<td>` 同样**不加**。
                           */
                          ...(c.style ? textCss({ ...el, style: c.style }) : null),
                          ...(c.style?.vAlign === 'middle'
                            ? { verticalAlign: 'middle' as const }
                            : c.style?.vAlign === 'bottom'
                              ? { verticalAlign: 'bottom' as const }
                              : c.style?.vAlign === 'top'
                                ? { verticalAlign: 'top' as const }
                                : null),
                        }}
                        title={`第 ${r + 1} 行 第 ${ci + 1} 列 · 双击编辑内容`}
                        // 用 click 而不是 pointerdown 选单元格：pointerdown 一旦拦住冒泡，
                        // 整个表格就没法拖动了（表格几乎被单元格铺满，没有空白处可抓）
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onSelect(el.id)
                          onSelectCell(el.id, c.id)
                          /*
                           * ⚠️⚠️ **只有"点在空白处"才清掉行内节点的选中**（2026-10-17）。
                           *
                           * 用户报过两个相反的问题，这条是它们的**折中点**：
                           *   1️⃣ 「选了格内字段后，点单元格空白处，右侧还是字段面板」
                           *      —— 因为 `selectedNode` 是独立状态，`<td>` 的点击没清它；
                           *   2️⃣ 「选择没办法选中格内元素了」
                           *      —— 我上一版在 `<td>` 里**无条件** `onSelectNode(null)`，
                           *         而**点 chip 时它的 `onClick` 不 `stopPropagation`**（这是有意的，
                           *         见 `renderInline` 里那条注释）⇒ 冒泡到 `<td>` ⇒ **刚选中的又被清掉** ❌
                           *
                           * ⇒ 判据：**事件目标是不是落在 `.bp-chip` 里**（字段/系统变量节点）。
                           *    · 是 ⇒ 保留节点选中（让节点那层说了算）；
                           *    · 否（格子空白/纯文字）⇒ 清掉，切回"这一格"的面板。
                           * ⚠️ 用 `closest` 而不是 `===`：chip 内部还有 `.bp-chip__text` 那一层。
                           */
                          const t = ev.target as HTMLElement | null
                          if (!t?.closest?.('.bp-chip')) onSelectNode?.(null)
                        }}
                        onDoubleClick={(ev) => {
                          ev.stopPropagation()
                          beginEditing(el.id, c.id, nodesToText(c.nodes))
                        }}
                      >
                        {/*
                          ⚠️ **定位辅助线**（2026-10-16 用户要求："拖动时有定位辅助线 +
                            要有一定的吸附作用"）。
                          ⚠️ 画在 `<td>` 里：`left` 用**百分比**（横向）、`top` 用 **mm**（纵向）——
                            与"格内元素定位"**同一套单位口径**（横向%，纵向 mm）。
                          ⚠️ `pointer-events: none`（CSS 里）⇒ 不会挡住拖动/点击。
                          ⚠️ 只在"正在吸附的那一格"显示（`childSnap.cellId === c.id`）。
                        */}
                        {childSnap && childSnap.cellId === c.id ? (
                          <>
                            {childSnap.lineX !== null ? (
                              <span
                                className="bp-snap-line bp-snap-line--v"
                                style={{ left: `${childSnap.lineX}%` }}
                                aria-hidden
                              />
                            ) : null}
                            {childSnap.lineY !== null ? (
                              <span
                                className="bp-snap-line bp-snap-line--h"
                                style={{ top: `${childSnap.lineY}mm` }}
                                aria-hidden
                              />
                            ) : null}
                          </>
                        ) : null}
                        {cellEditing ? (
                          <textarea className="bp-inline-edit bp-inline-edit--cell" {...inlineEditProps(el)} />
                        ) : empty && !(c.children && c.children.length > 0) && selected ? (
                          // 空单元格给一句提示：否则用户点了半天不知道这里能打字
                          // ⚠️ 有子元素的格子**不算空** —— 不然图片上面会盖一句"双击输入"
                          <span className="bp-el-cell__ph">双击输入</span>
                        ) : (
                          <>
                            {/*
                              规格 六：单元格是**素材容器**。子元素排在文字**前面**
                              （"图片在上、说明文字在下"是这类格子的通行排版，见 TableCell.children 的注释）。
                            */}
                            {(c.children ?? []).slice(0, MAX_CELL_CHILDREN).map((child) => {
                              /* ⚠️ **这一个子元素**是否被选中（3 段 id）—— 锚点/描边只认它 */
                              const thisChildSel = thisChildSelOf(child.id)
                              const pct = childWidthPct(child)
                              /*
                               * ⚠️ 与**打印端同口径**：`childBoxHeightMm` 把 `h:'auto'` 也当成默认高
                               * （2026-09-24 第四批 ④「不把单元格撑变形」）。
                               * 这一条必须两边一致 —— 否则就是"画布看着 18mm、打印出来把行撑破"。
                               */
                              /*
                               * ⚠️ **行高装不下时，元素跟着等比缩小**（2026-10-19 用户：
                               *   「缩小的时候，如果高宽的值不足以容纳格内的元素，就把格内元素也同步缩小」）。
                               * 不缩的话 `<tr height>` 会被内容撑住 —— 画布看着"行高没变"，
                               * 打印却按真实行高裁掉，用户永远判断不了这一行到底多高。
                               * 自适应行（没有 heightMm）不缩：它的高度本来就由内容决定。
                               */
                              const childK = rowChildScale(el, r)
                              const boxH = childBoxHeightMm(child) * childK
                              /*
                               * ⚠️ **已手动定位 ⇒ 绝对定位；没定位 ⇒ 维持流式**（2026-10-13）。
                               * 这是"老模板零影响"的开关：`cellPos` 缺席就是原来那条路。
                               * ⚠️ 与打印端**同一份口径**（`lib/cell-geometry.ts`），两端必须逐字一致。
                               */
                              const positioned = isChildPositioned(child)
                              /*
                               * ⚠️ **`boxed` = "要不要把元素装进一个精确定尺寸的盒子"**（2026-10-13 重构）。
                               *
                               * 两种情况都要：
                               *   · **已定位** ⇒ 盒子提供绝对定位的坐标系与尺寸；
                               *   · **选中但未定位** ⇒ 也要盒子 —— 否则**锚点没有参照物**，
                               *     只能靠算坐标 ⇒ 算出来的和画出来的对不上
                               *     （用户报的「点击后**不会出现**锚点」「锚点**不贴边**」就是它）。
                               * ⚠️ 代价：选中未定位的元素时它从"流式"变成"绝对定位" ⇒ 视觉上可能微跳一下。
                               *    这是**刻意的取舍**：不这么做，锚点就没有可靠的边可以贴。
                               */
                              const boxed = positioned || childSel
                              const xp = childOffsetXPct(child)
                              /*
                               * ⚠️⚠️ **行高直接用作用域里的 `row`**（2026-10-15 修）。
                               *
                               * 我昨天写成 `el.rows.find(rw => rw.cells.some(x => x.id === c.id))` ——
                               * **多此一举，而且查不到**（`el` 在这一层可能已被遮蔽），
                               * 于是传进去的是 `undefined` ⇒ `effectiveChildYMm` 走"不夹"分支 ⇒
                               * 用户实测 `topStyle = 19.4996mm`（上限本该 18.1）⇒ **压根没夹**。
                               * ⇒ 现在的外层就是 `el.rows.map((row, r) => …)`（3517 行）⇒ **直接用它**。
                               */
                              const yp = effectiveChildYMm(
                                child,
                                typeof row.heightMm === 'number' ? row.heightMm : undefined,
                                /* ⚠️ 单元格级内边距优先（与 <td> 的 padding、打印端同源）*/
                                finite(c.paddingMm, finite(el.cellPaddingMm, 1.5)),
                                /* 与 `boxH` 同一个系数 —— 只缩盒子不让 y 跟着缩，元素会在行里"下沉" */
                                childK,
                              )
                              /*
                               * ⚠️⚠️ **横向一律用 mm，不要用百分比**（2026-10-14 第 2 次对齐，与打印端同口径）。
                               *
                               * 用户报：「能拖到底边了，但**拖不到左边和上边**（总隔一点），
                               *   而**右边没有距离、甚至能拖到单元格边框上**」。
                               * 根因：**横向的 `left: X%`，其分母是"包含块的 padding box 宽"
                               *   （= 内容区宽 + 左右内边距）**，而 `X` 是按**内容区**算的
                               *   ⇒ **越靠右偏得越多**（`X=0` 时不偏 ⇒ "左边看着还行"）。
                               *   纵向用的是 mm（绝对单位）⇒ 不吃这个亏 ⇒ 四边行为不一致。
                               * ⇒ 与打印端**逐字同口径**：`xMm = xPct% × 内容区宽`、`wMm = w% × 内容区宽`。
                               *   ⚠️ `pad` 的偏移仍由下面的 `margin` 承担（等价于打印端的"内容区容器"）。
                               */
                              const cwMm = Math.max(
                                1,
                                cellWidthMm(el, c.id) - 2 * finite(c.paddingMm, finite(el.cellPaddingMm, 1.5)),
                              )
                              return (
                                <Fragment key={child.id}>
                                {/*
                                  ⚠️ **定位容器**（2026-10-13）。已定位时它撑住行高（`y + h`），
                                  否则子元素绝对定位后就没人给高度、**格子会塌**（旧设计拒绝绝对定位的
                                  理由正是这个，现在靠这层容器解决）。与打印端逐字对应。
                                  ⚠️ 未定位时它是**无样式的普通块**（`display: block` 由 CSS 给）⇒
                                  与加它之前逐字等价。
                                */}
                                <span
                                  className="bp-el-cell__holder"
                                  style={{
                                    display: 'block',
                                    /*
                                     * ⚠️⚠️ **holder 就是"元素盒子"本身**（2026-10-13 第 2 次重构）。
                                     *
                                     * 宽高与偏移**全部按元素**给 —— 这样锚点用 `0/50/100%` 定位
                                     * 就直接贴**元素**四周。
                                     * ⚠️ 上一版 holder 是 `width:100%`（**整格宽**）⇒ 锚点贴到了
                                     *   **单元格**四周（用户报："8 个锚点紧贴**单元格**四周，而不是元素四周"）。
                                     *
                                     * ⚠️⚠️ **一律绝对定位，不看是否选中/已定位**：
                                     *   上一版是"`boxed` 才绝对定位"（`positioned || childSel`）⇒
                                     *   **每点一次元素就切换一次定位模式** ⇒ 行高**来回跳**
                                     *   （用户报："拖进格子后单元格被撑大，**点击该元素后立刻恢复正常**，
                                     *     点别处又再次被撑大"）。
                                     *   ⇒ 模式必须**与选中状态无关**，否则"选中"这个动作会改变布局。
                                     * ⚠️ 代价：未定位的元素**也不占行高**了（它 `x=y=0`，视觉上仍贴左上）。
                                     *   这与用户选的"#5-A 缩放不影响行高"是同一条口径。
                                     */
                                    position: 'absolute',
                                    /* ⚠️ 横向用 mm（与打印端同口径）—— 见上面 `cwMm` 的注释 */
                                    /*
                                     * ⚠️ **元素级 `align` 优先于所在单元格的对齐**（2026-10-15 补齐）。
                                     *   打印端早就这么读了（`render/html.ts` 的 `ownAlign ?? cell.style?.align`），
                                     *   **画布端只读了 `c.style?.align`** ⇒ 用户在属性面板/拖动时设的元素级对齐
                                     *   **只在打印里生效、画布上看不到** —— 又一处只做了一半。
                                     *   ⚠️ 都没有 ⇒ 退回单元格的 `style.align`（老模板行为不变）。
                                     */
                                    left: `${
                                      Math.round(
                                        ((childBoxLeftPct(child, (child as { align?: 'left' | 'center' | 'right' }).align ?? c.style?.align) /
                                          100) *
                                          cwMm) *
                                          100,
                                      ) / 100
                                    }mm`,
                                    top: `${yp}mm`,
                                    /*
                                     * ⚠️⚠️ **与打印端的"内容区容器"等价的偏移**（2026-10-14，成对改动）。
                                     *
                                     * 打印端把格内子元素包进了一层"内容区容器"（top/left = pad）⇒
                                     *   元素的 yMm/xMm 是**相对内容区**的。
                                     * 画布端没有那层容器 ⇒ 若不加这个 margin，
                                     *   同一个 yMm 在画布上会**偏高一个 pad**（用户实测："上下贴紧、左右正常"）。
                                     * ⚠️ **成对改动**：钳制 maxY 也要按"容器高"算（见 onChildPointerDown）。
                                     */
                                    /*
                                     * ⚠️⚠️ **必须与 `<td>` 的 `padding` 用同一个值**（2026-10-14，控制台实测抓到的）。
                                     *
                                     * 实测数据：`td 的 padding = "0px"`，而这里的 `margin = "5.66929px"`（= 1.5mm）——
                                     *   ⇒ **内边距设成 0 时，`margin` 还留着表格级的 1.5mm** ⇒ 画布上永远差 1.5mm 贴不上。
                                     * 根因：`<td>` 的 `padding` 上一轮已改成"**单元格优先**"，
                                     *   而这里用的还是 `<table>` 那一层的 `pad`（**只读表格级**）——
                                     *   **同一个量被读了两遍、读的还是两份数据**（今天第 3 次栽在这上面）。
                                     * ⇒ 就地按"单元格优先"算，与 `<td>` 的 `padding` **逐字同源**。
                                     */
                                    marginLeft: `${
                                      mmToPx(finite(c.paddingMm, finite(el.cellPaddingMm, 1.5)))
                                    }px`,
                                    marginTop: `${
                                      mmToPx(finite(c.paddingMm, finite(el.cellPaddingMm, 1.5)))
                                    }px`,
                                    width: `${Math.round(((pct / 100) * cwMm) * 100) / 100}mm`,
                                    height: `${boxH}mm`,
                                    /*
                                     * ⚠️⚠️ **这条 margin 已删**（2026-10-14）。
                                     *
                                     * 它是"用 margin 补偿原点"的补丁：让 holder 整体偏移 `pad`。
                                     * **后果**：**右/下能压到边框（超出内容区）、左/上永远差一个 pad** ——
                                     *   补偿的方向是"整体推"，不是"原点挪"，所以四边行为必然不对称。
                                     *
                                     * ⚠️ **正确做法（打印端同款）**：外层包一个"内容区容器"，
                                     *   子元素相对它定位 ⇒ 原点天然是"内容区"、内边距天然生效。
                                     *   本地已验证四角都能贴（见提交说明），此处保持原点 = 边框内沿、
                                     *   由容器负责内缩 —— **两层结构各司其职，不再互相补偿**。
                                     */
                                  }}
                                >
                                <span
                                  key={child.id}
                                  /*
                                   * ⚠️⚠️ **锚点/描边只看"这一个子元素"被不被选中**（2026-10-16 修 #1/#4）。
                                   *   原来用的是 `childSel`（**格级**）⇒ 两个后果：
                                   *     · 点击某个子元素后，`selectedId` 是 3 段 id、而 `childSel` 比的是 2 段
                                   *       ⇒ **永远不相等** ⇒ 锚点不出现、面板也停在第一个元素；
                                   *     · 右键**整格**时选中的是 2 段 id ⇒ **那格所有子元素都亮**（看着像"全选中了"）。
                                   *   ⇒ 用 `thisChildSel`（`child:<t>:<c>:<id>`）精确到"这一个"。
                                   * ⚠️ `childSel`（格级）**保留** —— 它管的是"绝对定位/容器"那套，语义没变。
                                   */
                                  className={`bp-el-cell__child${thisChildSel ? ' is-selected' : ''}`}
                                  /* 规格 六：「单元格内的元素可以再拖出来，回到画布自由层」——
                                     按下即起一条拖动会话（见 onChildPointerDown） */
                                  /* 绿色描边 + 右上角类型角标（CSS 用 attr(data-kind) 画） */
                                  data-kind={elementLabel(child)}
                                  /* 复合 id 落到 DOM 上：e2e 断言与"从格子拖出"都靠它定位，
                                     不去猜"第几行第几列"（合并单元格下那种下标是假的） */
                                  data-cell-child-id={childKey}
                                  /*
                                   * 宽度用百分比、高度是**固定盒子**的高度（见 types.ts 第 ④ 条）。
                                   * 这两个值必须真的生效 —— 否则右侧面板里那两个输入框就是空转的，
                                   * 而"点了没反应"比"没有这个控件"更坏（用户会以为插件坏了）。
                                   */
                                  style={{
                                    /*
                                     * ⚠️ **铺满 holder**（holder 现在**就是元素盒子**）——
                                     * 子元素自己不再定位、也不再算宽高（那两件事都由 holder 承担）。
                                     * ⚠️ 顺带根治了"选中态改变布局"：以前这里在
                                     *   `position:absolute`（已定位）与 `margin:auto`（流式）之间切换，
                                     *   **每点一次元素都会重排一次** ⇒ 行高来回跳。
                                     * ⚠️ 水平对齐（`cell.style.align`）暂时由 holder 的 `left` 承担 ——
                                     *   未定位时 `left = 0`（靠左），与以前的默认行为一致。
                                     */
                                    width: '100%',
                                    height: '100%',
                                    overflow: 'hidden',
                                    /*
                                     * ⚠️ **正被拖出（已脱钩）时本体淡出**（2026-10-13 用户报：
                                     *   「元素样式**还留在单元格里**，不会随着鼠标指针过去」）。
                                     *    位置由 `.bp-child-ghost-body` 表达 ⇒
                                     *    本体不淡出的话，屏幕上会同时出现"两个它"。
                                     */
                                    opacity: childGhost?.child?.id === child.id ? 0.25 : undefined,
                                  }}
                                title={`${elementLabel(child)} · 单击选中，可拖到别的格子或拖出到画布`}
                                  onPointerDown={(ev) => onChildPointerDown(ev, el, c.id, child)}
                                  /*
                                   * ⚠️ 必须吃掉 click：`<td>` 的 onClick 会把选中打回整表
                                   * （pointerdown 的 stopPropagation 管不住 click）。少了这一行，
                                   * 点一下子元素会先选中自己、再被立刻改回整表 —— 面板看起来"闪了一下就没了"。
                                   */
                                  onClick={(ev) => ev.stopPropagation()}
                                  onContextMenu={(ev) => {
                                    if (!actions) return
                                    ev.preventDefault()
                                    ev.stopPropagation()
                                    /* 先选中再弹菜单：菜单里「编辑属性」要对准这一格里的那个元素，
                                       而不是上一个被选中的东西 */
                                    onSelectCell(el.id, c.id)
                                    /*
                                     * ⚠️⚠️ **必须带 `child.id`（3 段）**（2026-10-16 第二次修）：
                                     *   写 2 段的 `childKey`（格级）时，面板解不出"点的是哪一个"
                                     *   ⇒ **永远显示第一个元素**（用户报："面板显示第一个增加的元素"）✅
                                     */
                                    onSelect(cellChildId(el.id, c.id, child.id))
                                    setCtx({
                                      x: ev.clientX,
                                      y: ev.clientY,
                                      target: { kind: 'child', tableId: el.id, cellId: c.id, childId: child.id },
                                    })
                                  }}
                                >
                                  {renderCellChild(child, cellBoxMm)}
                                </span>
                                {/*
                                  ⚠️ **缩放手柄**（2026-10-13 用户需求：格内元素"可以手动缩放"）。
                                  选中时出现在子元素的右下角。

                                  ⚠️ 放在 **holder 层**而不是子元素层：子元素盒子有 `overflow:hidden`
                                  （"不把单元格撑变形"那一刀），手柄贴边会被裁掉一半、只剩几 px 能点。
                                  ⚠️ 只在**已定位**时给手柄：未定位时子元素横向由 `margin:auto`
                                  决定位置（可能居中/靠右），`left: calc(x% + w%)` 算出来的角是错的。
                                  未定位时改尺寸走右侧面板的「占格宽 / 高」。
                                  ⚠️ 位置：横向 `calc(偏移% + 占格宽%)`（两个百分比直接相加）、
                                  纵向 `偏移mm + 盒高mm`（两个 mm 直接相加）。
                                */}
                                {/*
                                  ⚠️⚠️ **锚点要跟 `thisChildSel`（3 段）走，不是 `childSel`（格级）**
                                  （2026-10-16 第二次修）：用格级条件时，点选写的是 3 段 id、
                                  这里比的是 2 段 ⇒ **永不相等** ⇒ **点一个子元素不出现锚点** ✅
                                  （而右键整格时选中的是 2 段 id ⇒ **那格所有子元素都亮** —— 正是用户描述的现象。）
                                */}
                                {/*
                                  ⚠️ **缩放手柄只给"该缩放的 4 种"**（2026-10-16 用户要求：
                                  · 所有格内元素都**可自由拖动**；
                                  · 但**只有附件/图片/码可自由缩放** —— `hline`/`text` 只拖不缩）。
                                  ⚠️ 判据取**唯一来源** `SCALABLE_CELL_KINDS`（在 `cell-child.ts`）。
                                */}
                                {thisChildSel && SCALABLE_CELL_KINDS.includes(child.kind) ? (
                                  <>
                                    {/*
                                      ⚠️ **8 个锚点**（2026-10-13 用户要求："点击后应该在边框出现 8 个锚点，
                                      鼠标移动上去出现**缩放的指针图标**，按住左键进行缩放"）。
                                      ⚠️ 只做一个角是不够的："往左扩 / 往上扩"这两个最自然的动作会做不到
                                      （只能"往右下长大、再把位置挪回去"）。
                                      ⚠️ 位置用 `calc(偏移% + 占格宽% × 系数)` 算：
                                      横向两个百分比可以直接相加；纵向 `y + h × 系数` 是 mm 相加。
                                      ⚠️ 光标由内联 `cursor` 给（8 个方向各不相同），不是靠 8 个 CSS 类。
                                    */}
                                    {(
                                      [
                                        ['nw', 0, 0, 'nwse-resize'],
                                        ['n', 0.5, 0, 'ns-resize'],
                                        ['ne', 1, 0, 'nesw-resize'],
                                        ['w', 0, 0.5, 'ew-resize'],
                                        ['e', 1, 0.5, 'ew-resize'],
                                        ['sw', 0, 1, 'nesw-resize'],
                                        ['s', 0.5, 1, 'ns-resize'],
                                        ['se', 1, 1, 'nwse-resize'],
                                      ] as const
                                    ).map(([d, fx, fy, cur]) => (
                                      <span
                                        key={d}
                                        className="bp-cellchild-h"
                                        role="separator"
                                        aria-label={`拖动调整格内元素大小（${d}）`}
                                        title="拖动调整大小"
                                        data-dir={d}
                                        style={{
                                          /* ⚠️ 相对 holder（= 元素盒子本身）⇒ **永远贴边**，不用算坐标。
                                             锚点算坐标会与元素的**实际渲染位置**对不上
                                             （`margin:auto`、内容按 `contain` 缩过）——
                                             那正是用户报的"锚点不贴着元素四周，下方特别明显"。 */
                                          left: `${fx * 100}%`,
                                          top: `${fy * 100}%`,
                                          cursor: cur,
                                        }}
                                        onPointerDown={(ev) => onChildResizeDown(ev, el, c.id, child, d)}
                                      />
                                    ))}
                                  </>
                                ) : null}
                                </span>
                                </Fragment>
                              )
                            })}
                            {(c.children?.length ?? 0) > 0 && c.nodes.length === 0
                              ? null
                              : (() => {
                                  /* ⚠️ 传"这一格"的颜色 → 元素颜色作兜底（见 renderInline 的注释） */
                                  const inline = renderInline(
                                    c.nodes,
                                    fields,
                                    c.id,
                                    pickFor(el.id, c.id),
                                    c.style?.color ?? el.style?.color,
                                    c.wrap,
                                    decoOf(c.style ?? el.style),
                                  )
                                  /*
                                   * ⚠️⚠️ **文字必须自己裁**（2026-10-19 用户实测：
                                   *   「只要格内有手动输入的文本或普通字段，单元格在视觉上就不会缩小了，
                                   *     怎么拖都不会小，但实际行高了列宽是缩小了的」）。
                                   *
                                   * 根因：`<tr height>` 只是**最小高度**，而 `td` 上的
                                   * `max-height` / `overflow:hidden` 在 `table-cell` 上**不生效**
                                   * ⇒ 文字把行撑住。（打印端早就踩过同一个坑，那里是套一层 div 解决的。）
                                   *
                                   * ⇒ 这里给**文字**单独套一层定高裁切框。
                                   * ⚠️ **不能包住整个 td 的内容**：格内子元素是 `position:absolute`，
                                   *    外层多一层定位祖先会让它们的落点全偏（见 `.bp-el-cell__holder` 的注释）。
                                   * ⚠️ 只在"有显式行高 + 没开自适应"时裁；自适应行本来就该被内容撑高。
                                   */
                                  const rowH = typeof row.heightMm === 'number' && row.heightMm > 0 ? row.heightMm : null
                                  if (rowH == null || c.autoSize === true) return inline
                                  const padMm = finite(c.paddingMm, finite(el.cellPaddingMm, 1.5))
                                  return (
                                    <div
                                      className="bp-cell-clip"
                                      style={{ maxHeight: mmToPx(Math.max(0, rowH - padMm * 2)), overflow: 'hidden' }}
                                    >
                                      {inline}
                                    </div>
                                  )
                                })()}
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      case 'image':
        return (
          <img
            className="bp-el-image"
            src={imgSrcOf(el)}
            alt=""
            draggable={false}
            /* 与打印端同一套取值：fill/cover 原样，其余（含未设）退回 contain */
            /*
             * ⚠️ 同上：**顶层图片的对齐也要落到 `object-position`**（2026-10-16）。
             *   否则用户改「对齐」在画布上看不出任何变化（打印端已修）。
             */
            style={{
              objectFit: el.fit === 'cover' || el.fit === 'fill' ? el.fit : 'contain',
              objectPosition:
                (el as { align?: 'left' | 'center' | 'right' }).align === 'left'
                  ? 'left center'
                  : (el as { align?: 'left' | 'center' | 'right' }).align === 'right'
                    ? 'right center'
                    : 'center center',
            }}
          />
        )
      case 'hline': {
        const t = Math.max(1, ptToPx(finite(el.thicknessPt, 0.75)))
        const align = el.style?.align
        const insetL = align === 'center' || align === 'right' ? undefined : mmToPx(finite(el.style?.indentLeftMm, 0))
        const insetR = align === 'center' || align === 'left' ? undefined : mmToPx(finite(el.style?.indentRightMm, 0))
        return (
          <div
            className="bp-el-hline"
            style={{
              borderTopWidth: t,
              borderTopColor: el.color || DEFAULT_TEXT_STYLE.color,
              marginLeft: insetL,
              marginRight: insetR,
            }}
          />
        )
      }
      case 'pagebreak':
        return (
          <div className="bp-el-pagebreak">
            <span className="bp-el-pagebreak__label">分页符</span>
          </div>
        )
      case 'qrcode':
      case 'barcode': {
        const code = codePreview(el, fields)
        return (
          <div
            className={`bp-el-code${code.svg ? '' : ' bp-el-code--ph'}${code.warn ? ' is-warn' : ''}`}
            // 占位框的底色交给 CSS（--pp-surface-2），真码才用用户配的背景色
            style={code.svg ? { background: code.background } : undefined}
            title={code.hint}
          >
            {code.svg ? (
              <div className="bp-el-code__svg" dangerouslySetInnerHTML={{ __html: code.svg }} />
            ) : (
              <span className="bp-el-code__body">
                <span className="bp-el-code__badge">{code.badge}</span>
                <span className="bp-el-code__name">{code.text}</span>
                <span className="bp-el-code__note">
                  {el.source.kind === 'field' ? '打印时逐条生成' : '在右侧属性面板填写'}
                </span>
              </span>
            )}
            {/* 二维码的"显示原文"由画布自己排（渲染库的 qrCodeSvg 只出码本身，没有 caption 参数），
                打印侧的留白与这里一致，都是码下方一行文字 */}
            {code.svg && el.kind === 'qrcode' && el.showText ? (
              <span className="bp-el-code__caption">{code.text}</span>
            ) : null}
          </div>
        )
      }
      case 'attach': {
        const cfg = el.config
        const bound = !!el.fieldId && fields.some((f) => f.id === el.fieldId)
        const modeText =
          cfg.mode === 'none'
            ? '不打印附件'
            : cfg.mode === 'nameOnly'
              ? '仅打印附件名称'
              : cfg.mode === 'imageOnly'
                ? '仅打印图片'
                : '打印全部附件'
        const sizeText =
          cfg.sizeMode === 'original'
            ? '原图尺寸'
            : cfg.sizeMode === 'fixedHeight'
              ? `固定高 ${finite(cfg.fixedHeightMm, 30)}mm`
              : '适配单元格'
        return (
          <div className="bp-el-attach">
            <div className="bp-el-attach__head">
              <span
                className={`bp-chip${bound ? '' : ' bp-chip--missing'}`}
                title={bound ? el.fieldName : `「${el.fieldName || '未绑定附件字段'}」已失效或未绑定字段`}
              >
                <span className="bp-chip__text">{el.fieldName || '未绑定附件字段'}</span>
              </span>
              <span className="bp-el-attach__tag">{modeText}</span>
            </div>
            <div className="bp-el-attach__meta">
              {sizeText} · {cfg.flow === 'wrap' ? '每张一行' : '并排'}
              {cfg.maxPerRow ? ` · 每行 ${cfg.maxPerRow} 张` : ''} · 间距 {finite(cfg.gapXMm, 2)}/{finite(cfg.gapYMm, 2)}mm
            </div>
            <div className="bp-el-attach__grid" aria-hidden>
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} className="bp-el-attach__ph" />
              ))}
            </div>
          </div>
        )
      }
      default:
        return null
    }
  }

  const renderBand = (band: BandKey): ReactNode =>
    readBand(doc, band).map((el) => {
      const selected = el.id === selectedId
      const isOob = oob.has(el.id)
      const pinned = pinnedId === el.id
      /**
       * 「拆分 / 合并单元格」两个按钮的**启用判据**（2026-09-23 第 7 条）。
       *
       * 都要求选中的是**这一张表**里的格子 —— 选中别的表的格子却让本表的按钮可点，
       * 点下去改的是另一张表，属于最难查的一类错。
       * 合并额外要求**两格以上**：用户明确说了"如果只选中一个单元格，则保持不可选中状态"。
       */
      /*
       * `cellSel` 存的是**网格坐标**（anchor/head），不是 cellId ⇒ 这里摊平一次取到格子 id。
       * 直接读 `cellSel.cellId` 是错的（那个字段不存在），而 tsc 会当场拦下。
       */
      const cellHereId =
        el.kind === 'table' && cellSel && cellSel.tableId === el.id
          ? (tableGrid(el.rows, el.colWidthsMm.length)[cellSel.anchor.r]?.[cellSel.anchor.c]?.cell.id ?? null)
          : null
      const canMergeSel = !!cellHereId && !!selRange && rangeArea(selRange) > 1
      return (
        <div
          key={el.id}
          data-el-id={el.id}
          className={[
            'bp-el',
            `bp-el--${el.kind}`,
            selected ? 'is-selected' : '',
            isOob ? 'is-oob' : '',
            el.locked ? 'is-locked' : '',
            pinned ? 'is-pinned' : '',
            // 让内容撑满声明框（见 FILL_KINDS 的注释：修"蓝框比内容大一圈"）
            FILL_KINDS.has(el.kind) ? 'bp-el--fill' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            // el.x / el.y 是**版心内**坐标（渲染层同样是 margin + x，见 render/html.ts），
            // 所以这里必须把页边距加回去，否则画布上的位置和导出的位置会差一个页边距。
            // y 还要过一遍版式区起点（循环区会被页级重复区顶下去，见 bandTopMm）。
            left: pxOf(nz(margin.left, 0) + nz(el.x, 0)),
            top: pxOf(nz(margin.top, 0) + bandTopMm(band, el)),
            /*
             * ⚠️ **宽度必须夹到版心内**（2026-10-09 修复：画布与预览"换行不一致"）。
             *
             * 打印端是把每个元素塞进"版心宽"的父容器里（`render/html.ts:1593` 的 `contentW`），
             * 元素自己声明得再宽也**会被收进去** ⇒ 文本在那里就换行了。
             * 而画布原来照 `el.w` 原样画 ⇒ **只要元素一超出纸张，画布就比打印多显示内容**。
             * 真机反馈原话：「同样的文字，在画布中是没有换行的，但在预览界面这个元素换行了」。
             *
             * ⇒ 口径统一成"**可见宽度 = min(声明宽, 版心宽)**"。
             *
             * ⚠️ 这里**只夹渲染宽度，一个字节都不改 `el.w`** ——
             *    用户要的是"所见即所得"，不是"被自动改窄"。
             * ⚠️ 夹的基准是**版心宽**（`content.w`）而不是纸宽：打印端的父容器就是版心。
             * ⚠️ 所有 kind 一起夹（不只是文本）：打印端对它们用的是同一个父容器，
             *    分开夹等于又制造一处"两端不同口径" —— 那正是本项目反复栽的坑。
             */
            width: pxOf(Math.min(Math.max(el.w, 0.5), Math.max(content.w, 0.5))),
            /**
             * 高度**只有下限、不写硬高** —— 与打印侧**同一条口径**
             * （`render/html.ts` 里非表格块一律 `min-height:...`）。
             *
             * 2026-09-18 真机反馈后修正。旧式是：
             *   固定值 ⇒ 写 `height`（硬高，内容多出来就被压住）
             *   自动   ⇒ 只写 `minHeight`（内容可以把盒子撑开）
             * 于是**同一个 5.6mm**，在两种模式下渲染高度不同；用户拖动宽度时
             * `onMerge` 又把 `'auto'` 静默写成数字 ⇒ 模式被改、高度看着"缩水"。
             * 用户原话："同样高度值，固定值下就是会缩水一些……哪个才是正确的值？"
             *
             * ⇒ 答案不是"两个数里选一个"，而是**画布与打印必须用同一个语义**：
             *   都只给下限。这样"属性里显示的值"与"画布上的盒子"在结构上不可能再分叉。
             */
            /**
             * ⚠️ **图片类元素显式设了高度就写死高度**（2026-09-20 用户反馈后改）。
             *
             * 旧口径一律 `minHeight`（注释写着"高度只有下限、不写硬高"），
             * 于是"固定高度"在画布上**根本不生效**：内容只要比它高，盒子就跟着长
             * ⇒ 用户改属性里的高度、往下拖，都看不出变化（用户报的正是这个）。
             *
             * 与打印侧 `render/html.ts` 的 `heightCss` **同一套判据**（图片类 + 显式高度），
             * 两处必须一起改：只改一边会让"画布/打印"分叉，而那正是上一轮特意修掉的毛病。
             * 文字块仍然只给下限（内容换行要能撑开，写死会叠字）。
             */
            ...(PIC_LIKE.has(el.kind) && typeof el.h === 'number'
              ? { height: pxOf(Math.max(el.h, 2)), overflow: 'hidden' }
              : { minHeight: pxOf(Math.max(elementHeightMm(el), 2)) }),
          }}
          onPointerDown={(ev) => onElementPointerDown(ev, el, band)}
          /*
           * 悬停追踪（只给表格用，但挂在通用包装层上 —— 非表格元素记一下也无害，
           * 工具栏那边自己判 `kind === 'table'`，不需要在这里再分叉）。
           * enter/leave 不会在子元素间反复触发（over/out 才会），这一点很关键：
           * 表格里全是 `td`，用 over/out 会变成每格一次 setState。
           */
          onPointerEnter={() => setHoverId(el.id)}
          onPointerLeave={() => setHoverId((cur) => (cur === el.id ? null : cur))}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            if (el.kind !== 'text') return
            beginEditing(el.id, null, nodesToText(el.nodes))
          }}
        >
          {renderBody(el)}
          {/*
            表格**悬浮工具栏**（2026-09-19 用户要求，参考飞书云文档）。

            用户原话："鼠标移动到表格上方后，会出现**悬浮工具栏**，可以完成表格的一系列编辑操作。"
            并附了两个飞书云文档的 GIF 作参照（`_feishu-verify/shots/_g/g07-ref1/ref2`）。

            为什么值得做：表格的行列增删与列宽行高**本来就有**（`table-actions` 一整套），
            但入口全在右侧属性面板深处 —— 用户得先选中表格、再滚到「结构」那一节。
            悬浮工具栏把最常用的三个动作搬到鼠标当前位置，**看得到就点得到**。

            触发条件 = **悬停 or 已选中**：只挂悬停的话，鼠标一移开工具栏就没了，
            用户没法"看着工具栏去点"（这是悬停式 UI 的经典陷阱）。
          */}
          {el.kind === 'table' && (hoverId === el.id || selected) ? (
            /*
             * `stopPropagation` 是必须的：工具栏压在表格上，
             * 不拦的话点按钮会先冒泡到 `.bp-el` 的 pointerdown，触发"拖动整个表格"。
             */
            <div className="bp-table-bar" onPointerDown={(ev) => ev.stopPropagation()}>
              {/*
                ---- 移动表格（2026-10-19 用户要求）----
                「把鼠标移动到表格上，会出现移动表格的光标，为了防止该功能和拖动表格宽高冲突，
                  改为在…悬浮栏中增加一个移动的图标，按照该图标完成对表格的移动」。
                ⇒ 表格主体**不再接受拖动**（`onElementPointerDown` 里对 table 直接 return），
                  只有按住这个图标才会走画布既有的移动会话。
              */}
              <button
                type="button"
                className="bp-table-bar__btn is-icon"
                title="按住拖动整个表格"
                aria-label="按住拖动整个表格"
                onPointerDown={(ev) => {
                  ev.stopPropagation()
                  beginSession(ev, el, 'move', band)
                }}
              >
                {/* 四向箭头：通用的"移动"图形（项目不引图标库，自绘 SVG） */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                  <path
                    d="M8 2.2v11.6M2.2 8h11.6M8 2.2 6.2 4M8 2.2 9.8 4M8 13.8 6.2 12M8 13.8l1.8-1.8M2.2 8 4 6.2M2.2 8 4 9.8M13.8 8 12 6.2M13.8 8 12 9.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {editTableId === el.id ? (
                /*
                 * ---- 编辑态（真机反馈第 6 条）----
                 * 用户原话：「点击编辑表格后，不再是对某个单元格进行输入编辑，而是进入编辑状态，
                 * 此时表格可以增删行和列，可以对单元格进行合并居中等操作，悬浮菜单也刷新为
                 * 各个编辑功能和完成编辑的选项」。
                 */
                <>
                  <button
                    type="button"
                    className="bp-table-bar__btn is-primary"
                    title="退出编辑（表格回到可整体移动的状态）"
                    onClick={() => setEditTableId(null)}
                  >
                    完成编辑
                  </button>
                  {/*
                    ---- 拆分 / 合并单元格（真机反馈 2026-09-23 第 7 条）----
                    用户原话：「编辑表格的这个菜单，**删除增加行列的选项**，改为拆分单元格
                    （点击后被选中的单元格会被拆分，会出现弹窗，提示输入几行几列）、
                    合并单元格（如果只选中一个单元格，则保持不可选中状态）」。

                    ⇒ 「+ 行 / + 列」从这条浮层上撤掉（加行列改走：表格右/下边缘的「+」手柄、
                      悬浮的「表格尺寸」面板、以及单元格右键菜单里的插入行列）。
                    两个按钮都**作用于当前选中的格子**：
                      · 拆分 —— 需要有一个选中的格子；弹出输入框问几行几列；
                      · 合并 —— 需要**选中两个以上**的格子（只选一格时保持不可点，
                        这正是用户要求的那条）。
                  */}
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={cellHereId ? '把这一格拆成几行几列' : '先点一下要拆的那一格'}
                    disabled={!cellHereId}
                    onClick={() => {
                      if (cellHereId) setSplitAsk({ tableId: el.id, cellId: cellHereId })
                    }}
                  >
                    拆分单元格
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={canMergeSel ? '把选中的格子合并成一格' : '先按住鼠标左键拖选两个以上的格子'}
                    disabled={!canMergeSel}
                    onClick={() => {
                      if (selRange && cellSel && actions) actions.askMergeRange(cellSel.tableId, selRange)
                    }}
                  >
                    合并单元格
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={selRange ? '把选中的格子居中' : '先按住 Shift 拖出要居中的格子'}
                    disabled={!selRange || !actions}
                    onClick={() => {
                      if (selRange && actions) actions.applyRange(el.id, selRange, { kind: 'align', h: 'center' })
                    }}
                  >
                    居中
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={selRange ? '把选中的格子加粗' : '先按住 Shift 拖出要加粗的格子'}
                    disabled={!selRange || !actions}
                    onClick={() => {
                      if (selRange && actions) actions.applyRange(el.id, selRange, { kind: 'bold', on: true })
                    }}
                  >
                    加粗
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="bp-table-bar__btn is-primary"
                    title="进入表格编辑状态（增删行列、调尺寸、选格子合并）"
                    onClick={() => {
                      setEditTableId(el.id)
                      /* ⚠️ 右侧属性同步切到**表格**属性页（2026-10-19 用户要求）——
                         否则面板还停在"这一格"，用户会以为没进编辑态 */
                      onSelectCell(el.id, null)
                      onSelect(el.id)
                      /*
                       * 进编辑态时**把「表格尺寸」小窗一起打开**（真机反馈 2026-09-23 第 6 条）。
                       * 用户原话：「只有在刚拖表格进来时才需要显示表格右侧的行列设置小窗，
                       * 点击空白处或者其他元素后，就自动消失，**点击编辑表格再次出现**」。
                       */
                      onOpenTableSize?.(el.id)
                    }}
                  >
                    编辑表格
                  </button>
                </>
              )}
              {/* #6a：删除整张表格 —— 原来只能右键最外框一个极窄的带子，用户说极难删除 */}
              <button
                type="button"
                className="bp-table-bar__btn is-danger is-icon"
                title="删除整张表格"
                aria-label="删除整张表格"
                disabled={!actions}
                onClick={() => actions?.remove(el.id)}
              >
                {/* 垃圾桶：自绘 SVG（项目不用 emoji、不引图标库）；真机反馈要求「不要显示文字」 */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <path
                    d="M3 4.2h10M6.4 4.2V2.9h3.2v1.3M4.6 4.2l.55 8.9h5.7l.55-8.9M6.8 6.6v4.6M9.2 6.6v4.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}
          {/*
            ---- 表格的悬浮操作层（2026-09-22）----
            规格 一·二：表格手柄（拖整表）、顶边列手柄点、左边行手柄点、
            行首列首的「+」（点一下插一行 / 插一列）、右 / 下边缘的虚线感应区（追加行列）。

            ⚠️ 和上面那条工具栏同一个显示条件（悬停 or 选中）：只挂悬停的话鼠标一移开入口就没了，
               用户没法"看着按钮去点"。
            ⚠️ 锚点用 `tableAnchors(el)` 现算：它是纯函数、代价是几十次浮点比较，
               而"每行/每列用哪一格当定位锚点"这件事只有网格知道（span 模型下数组下标 ≠ 列号）。
          */}
          {/*
            ⚠️ 真机反馈第 6 条：「表格未编辑状态，不再显示增加行列的『+』图标」
               ⇒ 编辑手柄（+ / 行首列首 / 拖尺寸）只在**编辑态**出现；
                  平时表格就是一块可整体拖动、可点选的内容。
          */}
          {actions && el.kind === 'table' && editTableId === el.id ? (
            <TableAfford
              el={el}
              rowEdges={rowEdges}
              rowAnchorIds={tableAnchors(el).rowAnchorIds}
              colAnchorIds={tableAnchors(el).colAnchorIds}
              insertRow={(where, cellId) => actions.insertRow(el.id, cellId, where)}
              insertCol={(where, cellId) => actions.insertCol(el.id, cellId, where)}
            />
          ) : null}
          {/*
            选中表格时的列 / 行边框线手柄（拖它们调列宽 / 行高）。

            列手柄按**列宽占比**定位（列宽是显式给定的，换算必准）；
            行手柄用上面量出来的 `rowEdges`（行高可能是内容撑的，模型值不准）。
            刻意只做 6~7px 宽的细条、且只落在边框正中：它们是压在单元格上的，
            做宽了就会把"点这一格"抢走 —— 单元格选中是表格里最常用的动作。

            **每一条边界都有手柄，包括最外侧那两条**（需求 ⑧）：
            列手柄有 `colWidthsMm.length` 条（第 0..n-2 条是内部竖线，第 n-1 条 = 最右外框），
            行手柄有 `rowEdges.length` 条（末条 = 表底边）。以前只在内部边界上画，
            于是"贴着外框的那一列 / 那一行"的尺寸根本没法调（拖右外框 = 调最后一列列宽，
            拖下外框 = 调最后一行行高，走的是和内部竖线**同一个** `onBorderPointerDown`）。

            为什么左外 / 上外**不加**手柄：元素原点就在左上角，那两条边上的"改尺寸"语义只能是
            "移动 x/y 并改 w/h"，而列宽数组里没有"左边距"这一项 —— 拖左外框到底算改第一列列宽
            还是算移动整个元素，一个手柄表达不了。何况那两条边上已经有元素自己的 `w` / `n`
            缩放手柄压着，再放一条就是**两个视觉重复的手柄**。要调第一列 / 第一行，拖第一条
            内部竖线 / 横线即可（那条线动的正是第 1 列的列宽、第 1 行的行高）。
          */}
          {/*
            ⚠️ 条件从 `selected` 扩成 `hoverId === el.id || selected`（2026-09-22）。
            规格 三 要求"鼠标悬停在两条单元格之间的横边框/竖边框线上时，光标变为 ↕/↔"——
            只在选中时才挂手柄的话，用户得先猜"要不要先点一下"。手柄本身只有 7px 宽、
            且自带 `col-resize/row-resize` 光标，悬停时出现不会抢走"点这一格"。
          */}
          {/*
            ⚠️ **尺寸手柄不再要求先"编辑表格"**（2026-10-19 用户要求）：
            「当前表格在画布中，需要点击编辑表格才允许拖动各行各列的宽高，
              改为直接在画布中即可拖动宽高」。
            ⇒ 条件从 `editTableId === el.id` 换成"悬停 or 选中"——与右上角悬浮栏同一口径。
            手柄只有 7px 宽、自带 col/row-resize 光标，压在边框正中，
            不会抢走"点这一格"（那条约束在下面 5070 行左右还写着）。
          */}
          {el.kind === 'table' && (hoverId === el.id || selected) ? (
            <div className="bp-tbl-size">
              {el.colWidthsMm.map((_, i) => {
                const outer = i === el.colWidthsMm.length - 1
                return (
                  <span
                    key={`c${i}`}
                    role="separator"
                    aria-label={`第 ${i + 1} 列右边框，左右拖动调列宽`}
                    title={outer ? `拖动调第 ${i + 1} 列列宽（最外侧边框）` : `拖动调第 ${i + 1} 列列宽`}
                    className="bp-tbl-size__col"
                    style={{ left: `${colEdgeFrac(el.colWidthsMm, i) * 100}%` }}
                    onPointerDown={(ev) => onBorderPointerDown(ev, el, 'col', i)}
                  />
                )
              })}
              {rowEdges.map((top, i) => (
                <span
                  key={`r${i}`}
                  role="separator"
                  aria-label={`第 ${i + 1} 行下边框，上下拖动调行高，双击恢复自适应`}
                  title={`拖动调第 ${i + 1} 行行高；双击恢复「按内容自适应」`}
                  className="bp-tbl-size__row"
                  style={{ top }}
                  onPointerDown={(ev) => onBorderPointerDown(ev, el, 'row', i)}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    onRowBorderReset(el, i)
                  }}
                />
              ))}
              {/*
                ⚠️⚠️ **两条外框手柄放在最后**（2026-10-13，顺序是刻意的）。
                
                用户反馈："表格的**第一行、第一列**无法用鼠标拖动缩放，其他行、其他列倒是正常"。
                探针实测证明**内线是好的**（拖第 1 列右沿、第 1 行下沿都能改）——
                用户拖不动的是**表格的左外框 / 上外框**，那两条边上原本**没有手柄**。
                
                ⚠️ **为什么排最后而不是最前**：`colHandleHit(id, idx)` / `rowHandleHit(id, idx)`
                  这类按**下标**取手柄的代码（e2e、探针）都建立在"第 i 条 = 第 i 个边界"上。
                  插在最前会让下标整体错位、**把既有断言全部改义**。
                  ⇒ 排在末尾：`0..n-1` 仍是各列右边界 / 各行下边界，外框是**追加的**那一条。
                ⚠️ 交叉点上的优先级**不靠顺序、靠 CSS 的 `z-index: 1`**（见 `editor.css` 的 `--start`）：
                  否则上外框横穿每一条列内线，交叉点上会命中列手柄、拖 dy 毫无反应。
                ⚠️ 位置：左外框 `left: 0`、上外框 `top: 0`，**都不加 translate(-50%)** ——
                  这两条边正好压在元素边界上，居中会有一半伸到元素外（能否点到取决于外层裁剪，太脆）。
                
                ⚠️ 语义（与 Excel 一致）：拖左外框 = 改**第 1 列列宽**，且**右边界不动**；
                  拖上外框 = 改**第 1 行行高**，且**下边界不动**。
                  这一点能成立是因为本项目有 **E-45 约束（列宽之和 = 元素总宽）**：
                  "改列宽 + 反向挪 x" 的净效果就是"左边动、右边不动"。推导见
                  `onBorderPointerDown` 里 `originShift` 的注释。
              */}
              <span
                role="separator"
                aria-label="第 1 列左边框（表格左外框），左右拖动调第 1 列列宽"
                title="拖动调第 1 列列宽（表格左外框）"
                className="bp-tbl-size__col bp-tbl-size__col--start"
                onPointerDown={(ev) => onBorderPointerDown(ev, el, 'col', 0, 'start')}
              />
              <span
                role="separator"
                aria-label="第 1 行上边框（表格上外框），上下拖动调第 1 行行高"
                title="拖动调第 1 行行高（表格上外框）"
                className="bp-tbl-size__row bp-tbl-size__row--start"
                onPointerDown={(ev) => onBorderPointerDown(ev, el, 'row', 0, 'start')}
              />
            </div>
          ) : null}
          {isOob ? <span className="bp-el-oob" aria-hidden /> : null}
          {pinned ? (
            <span className="bp-el-pin" aria-hidden>
              已贴版式区上边
            </span>
          ) : null}
          {isOob ? (
            <span className="bp-el-warn" title="超出纸张范围">
              !
            </span>
          ) : null}
          {selected ? (
            <>
              {RESIZE_EDGES.map((c) => (
                <span
                  key={c}
                  role="presentation"
                  className={`bp-handle bp-handle--${c}`}
                  onPointerDown={(ev) => onHandlePointerDown(ev, el, c, band)}
                />
              ))}
            </>
          ) : null}
        </div>
      )
    })

  return (
    <div
      className={['bp-canvas', dropActive ? 'is-drop-active' : ''].filter(Boolean).join(' ')}
      ref={viewportRef}
      /* 右键菜单挂在**画布根节点**（不是纸张）：纸张被 `transform: scale()` 包着，
         `position: fixed` 在 transform 祖先里会相对那个祖先定位 —— 菜单会跑偏。 */
      onContextMenu={onCanvasContextMenu}
    >
      <div
        className="bp-paper-outer"
        style={{ width: pxOf(render.w) * scale, height: pxOf(render.h) * scale }}
      >
        <div
          ref={paperRef}
          // is-element-selected：选中元素时网格再淡一档。网格是**参考线**，正在摆内容时
          // 它不该和内容抢注意力 —— 但默认态也必须能和表格线分开（见 editor.css 的 .bp-grid）。
          className={`bp-paper${selectedId ? ' is-element-selected' : ''}${dropTarget?.kind === 'reject' ? ' is-drop-reject' : ''}`}
          style={
            {
              width: pxOf(render.w),
              height: pxOf(render.h),
              transform: `scale(${scale})`,
              // 给纸张内的标签/手柄一个反向缩放系数：纸张被缩小后它们仍保持可读的视觉尺寸
              '--bp-inv': String(1 / Math.max(scale, 0.05)),
            } as unknown as CSSProperties
          }
          onPointerDown={(e) => {
            // 点空白处取消选中（元素自身的 pointerdown 已经 stopPropagation）
            if (e.target === e.currentTarget) {
              onSelect(null)
              onSelectCell(null, null)
              onSelectNode?.(null)
            }
          }}
        >
          {/* 网格：**一层 CSS 背景**，不是几百个 DOM 节点（一页 A4 / 5mm 就是 40×60 条线）。
              它铺在版心范围内、原点就是版心左上角 —— 元素的 x/y 也正是从这里起算，
              所以"吸附到 5mm 的整数倍"落点必然落在可见的线上，不会出现"吸了但没对齐"。
              线色由 editor.css 的 --pp-grid-line 给（**不是** --paper-line：那是内容线的兜底色，
              和网格共用一个色时画出来一模一样，用户分不开）。也不用 UI 描边令牌：纸永远是白的，
              暗色下 --line 会翻成白色，白纸上画白线等于没画。 */}
          {grid.showGrid ? (
            <div
              className="bp-grid"
              aria-hidden
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top),
                width: pxOf(content.w),
                height: pxOf(content.h),
                backgroundSize: `${pxOf(grid.gridMm)}px ${pxOf(grid.gridMm)}px`,
              }}
            />
          ) : null}

          {/*
            页边距区域：非打印区，用极淡的填充区别于纸张白，让"版心 = 能印出来"自己说话。

            四条带子必须**拼成完整的一圈**：上下两条铺满纸宽（顺带盖住上下两条角），
            左右两条只跨版心高（避开角）。少了这一步，四个角会留下四个白方块，
            用户会问"那四个角是不是能打印"。

            ⚠️ 这条链路上有过一次真事故，写在这里免得被写回去：
            **上边距带原来写成 `top: pxOf(margin.top)`，正确值是 `top: 0`。**
            `margin.top` 是"纸张顶边 → 版心顶边"的距离，不是版心顶边的坐标。于是那条
            带子整个落进版心里、盖在网格最上面 20mm 上：真正的上页边距是白的，而可
            打印区的头 20mm 被涂灰了 —— 和"标出非打印区"这件事**正好反着**。
            四条里只有它错，且错的量恰好等于 `margin.top`，所以肉眼很容易漏掉。

            ⚠️ 第二条：**四条带子不许互相重叠。** 半透明底叠在半透明底上会**加深**
            （alpha 合成不幂等：0.14 盖两遍 ≈ 0.26），角上会冒出四个比边更深的方块。
            所以分工是"上下两条管满宽、左右两条只跨版心高度"，恰好把环铺满且两两不交。
          */}
          <div
            className="bp-margin"
            style={{ left: 0, top: 0, width: pxOf(render.w), height: pxOf(margin.top) }}
          />
          <div
            className="bp-margin"
            style={{
              left: 0,
              top: pxOf(margin.top + content.h),
              width: pxOf(render.w),
              height: pxOf(margin.bottom),
            }}
          >
            {/*
              页边距 = **印不出来**的那一圈（可打印区 = 版心 = 纸张 − 页边距）。
              2026-09-18 用户追问"为什么超过橙线的部分就无法打印了"——
              真正的原因从来不是橙线，而是**这一圈**。它以前只是一块淡色，没有任何文字，
              所以用户只能把"印不出来"归因到唯一看得见的标记（橙线）上。
              宽度不够就干脆不写（≤6mm 塞不下，写了只会糊成一团）。
            */}
            {margin.bottom >= 6 ? (
              <span className="bp-margin__label">
                下页边距 {margin.bottom}mm · 这一圈印不出来（想让它也能印：页边距整档选「整张纸（0）」）
              </span>
            ) : null}
          </div>
          <div
            className="bp-margin"
            style={{
              left: 0,
              top: pxOf(margin.top),
              width: pxOf(margin.left),
              height: pxOf(content.h),
            }}
          />
          <div
            className="bp-margin"
            style={{
              left: pxOf(margin.left + content.w),
              top: pxOf(margin.top),
              width: pxOf(margin.right),
              height: pxOf(content.h),
            }}
          />

          {/*
            ---- 三条分区带（2026-09-22 重做）----

            用户原话："当前的画布不太好区域（区分），**只能靠右侧的属性 tab 去猜**，
            做画布分区可视化：A4 纸上直接画了三条分区带 —— 每页重复区（灰）、循环区（橙色高亮，
            因为现在在循环区）、表尾区（灰），左侧竖排小标签，不用再去右侧 tab 猜。"

            改之前的做法是**只画边界线 + 左页边距里一枚小胶囊**，于是：
              · 三条带里只有"循环区"那条有胶囊，另外两条（表头/表尾）在页面里几乎看不见
                （实测：`?tpl=N` 的模板上 `.bp-band` 只有 1 个）；
              · 而且那两个胶囊的显示条件挂的是"该区有没有元素" —— 空分区恰恰是用户最需要知道
                "这里有个区、可以往里放东西"的时候，却是**什么都不显示**。

            现在每一区都有一条**带内标签条**（real 边界 + 防重叠下推，见 band-bars.ts）
            + 一条**左侧竖排标签**（三条都有，哪怕高度是 0）。
            标签条不铺满整个区（只在顶部 18px），所以**不会盖住正文** —— 这是用户对"纸面涂色"
            最不能接受的一点（历史上因为"底色盖住正文"专门回退过一次）。
          */}
          {bandBars.map((b) => (
            <div
              key={b.key}
              className={`bp-band bp-band--${b.key}${b.key === activeBand ? ' is-active' : ''}${b.shifted ? ' is-shifted' : ''}`}
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top) + b.topPx,
                width: pxOf(content.w),
                height: BAND_BAR_PX,
              }}
            >
              <span className="bp-band__title" title={bandTip(b.key)}>
                <span className="bp-band__dot" aria-hidden />
                {BAND_META[b.key].name} · {BAND_META[b.key].tip}
              </span>
            </div>
          ))}

          {/*
            左侧竖排标签：三条**都要有**（这正是"不用再去右侧 tab 猜"的答案）。
            `writing-mode: vertical-rl` 让文字真正竖排 —— 竖排是这里唯一不挤的排法：
            页边距槽只有 ~30px 宽，横排只能放下三四个字就省略号。
          */}
          {showGutterTags
            ? bandGutters.map((g) => (
                <span
                  key={g.key}
                  className={`bp-band__gutter bp-band__gutter--${g.key}${g.key === activeBand ? ' is-active' : ''}`}
                  /*
                   * ⚠️ `left` 必须自己减去页边距：竖排标签挂的是**纸张**（不是版心），
                   * 所以"贴到版心左边界外侧"要写成 `版心左 - 槽宽`。
                   * 我第一版直接写 `-gutterPx`（照抄旧代码 —— 那时它的父元素是 `.bp-band`，
                   * 就在版心上），结果标签整体跑到纸张左边外面去了（实测：三个竖排标签全不见）。
                   */
                  style={{ left: pxOf(margin.left) - gutterPx, width: gutterPx, top: pxOf(margin.top) + g.topPx }}
                >
                  {/*
                    ⚠️⚠️ 这一对花括号**必须**有：JSX 的**子节点位置**里，以「斜杠星号」开头的
                    块注释不是注释，它就是**字面文本** —— 会被原样渲染到页面上。

                    第一版写成裸块注释（我照抄了"属性区/代码区"的写法），结果整段注释被当成
                    竖排标签的内容画了出来：`.bp-band__gutter` 是 `writing-mode: vertical-rl`
                    的窄条，几十行注释在纸张左侧糊成一大片"乱码墙"。用户原话：
                    「当前画布左侧有一些混乱的文字，这个是什么东西，很影响页面整洁性」。

                    判据（写在这里免得再犯）：块注释在 **属性区**（标签的 `>` 之前）或
                    **代码区**（花括号里面）都合法；只有**子节点位置**必须先包一层花括号。
                  */}
                  <button
                    type="button"
                    className="bp-band__chip"
                    title={`${bandTip(g.key)}（点击定位到该区）`}
                    onClick={() => {
                      const paper = paperRef.current
                      const vp = viewportRef.current
                      if (!paper || !vp) return
                      const delta = paper.getBoundingClientRect().top - vp.getBoundingClientRect().top
                      vp.scrollTo({ top: vp.scrollTop + delta + bandGeoPx[g.key].topPx - 60, behavior: 'smooth' })
                    }}
                  >
                    {BAND_META[g.key].name}
                  </button>
                </span>
              ))
            : null}

          {/*
            ---- 三个分区的**范围框**（2026-09-23 真机反馈第 11 条）--------------------------
            用户原话：「三个分区的范围也不明显，无法一眼看出」。

            原来每个分区只有一个 18px 的细标签条 + 一条分界线 —— 标签条说明"叫什么"，
            但**范围**（这一区从哪到哪）完全看不出来，尤其表头区/表尾区几乎没有高度时。

            ⚠️ 只画**虚线边框、不填底色**：底色铺满整区会压住正文，
               这个项目在这一点上回退过一次（见 .bp-band 的历史注释）。
               虚线框不遮内容，却能一眼看出"这三块"。
            ⚠️ `pointer-events: none`（在 CSS 里）：它是标示层，绝不能吃掉单元格/元素的点击。
          */}
          {(['header', 'loop', 'footer'] as BandKey[]).map((b) => (
            <div
              key={`area-${b}`}
              className={`bp-band__area bp-band__area--${b}${b === activeBand ? ' is-active' : ''}`}
              aria-hidden
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top) + bandGeoPx[b].topPx,
                width: pxOf(content.w),
                height: Math.max(0, bandGeoPx[b].heightPx),
              }}
            />
          ))}

          {/*
            三条带之间的**分界线**（虚线）—— 标签条互相下推之后，"真实边界在哪"只能靠它说。
            loop 那条用橙色：它是"每条记录重复一次"的分水岭，也是用户最常看的一条。
          */}
          {(['loop', 'footer'] as BandKey[]).map((k) => (
            <div
              key={k}
              className={`bp-band__divider${k === 'loop' ? ' is-loop' : ''}`}
              style={{
                top: pxOf(margin.top + (k === 'loop' ? layout.loopTopMm : layout.footerTopMm)),
                left: pxOf(margin.left),
                width: pxOf(content.w),
              }}
            />
          ))}

          {/* 表尾区在打印时是**贴着版心底部**的（render/layout.ts:409-410），
              而画布按"版式区自上而下"的顺序把它画在自己的分界线之下。
              位置对不上就必须说出来 —— 否则用户会以为导出后表尾也在这个高度。
              放在表尾元素**下面**（footerReserveMm 就是这组元素的高度），必然不会压住它们。 */}
          {doc.bands.footer.length > 0 ? (
            <span
              className="bp-band__note"
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top + layout.footerTopMm + footerReserveMm + 1.5),
              }}
            >
              表尾打印时贴版心底部
            </span>
          ) : null}

          {/*
            版心边界线 = **真正印得出来的范围**（纸张减去上下左右页边距）。

            ⚠️ 2026-09-18 真机反馈：用户把**橙色的**左边框当成了打印范围
            （"画布左侧橙色的边框就不再往下蔓延了……元素明明还在画布内，但却无法打印出来"）。
            橙色那个是**循环区**的括弧标记（`.bp-band--loop .bp-band__bracket`），
            它结构上永远到不了版心底边 —— `computeBandLayout` 至少留 40mm 给表尾区。
            两者的关系以前**没有任何文字说明**，所以必然被误读。
            ⇒ 给真正的边界挂一枚常驻标签，直接写在它自己身上。
          */}
          {/*
            页边距丈量线 + 可点击改数值（2026-09-19 用户要求）。

            需求原话："页边距区域用虚线丈量打印区和页面边，显示当前的页边距为多少……
            点击数字后，可以修改四边的页边距，**如果页边距是 0 则不显示这个**。"

            · 红线画在**版心边界**上（= 可打印区的边），标签写在页边距那一侧；
            · 页边距为 0 ⇒ 不渲染（没有"距离"可量，画一条线只会让人以为有边距）；
            · 点击 ⇒ prompt 改这一侧，经 `onSetMargin(side, mm)` 这个**窄接口**回传，
              画布不需要知道 PageSetup 的其余字段。
          */}
          {MARGIN_SIDES.map((side) => {
            const mm = Math.max(0, finite(margin[side], 0))
            if (mm <= 0) return null
            const vertical = side === 'left' || side === 'right'
            const ruleStyle = vertical
              ? {
                  left: pxOf(side === 'left' ? margin.left : margin.left + content.w),
                  top: pxOf(margin.top),
                  height: pxOf(content.h),
                }
              : {
                  top: pxOf(side === 'top' ? margin.top : margin.top + content.h),
                  left: pxOf(margin.left),
                  width: pxOf(content.w),
                }
            /*
             * ⚠️ 真机反馈（2026-09-22）：
             *   · 原来整条**丈量线**都是按钮 ⇒ 在纸上任何地方点一下都会弹改边距；
             *     用户要求「点击『上边距 12mm』这个字体才进入修改边距的状态」⇒ 只有胶囊可点；
             *   · 原来用 `window.prompt` —— 跨源 iframe 里那是**宿主的原生弹窗**（用户截图里
             *     『localhost:5190 上的嵌入式页面显示』），而且阻塞式对话框在 iframe 里并不可靠；
             *   · 现在改成**原地编辑**：胶囊变成输入框（自动全选），回车 / 失焦提交、Esc 取消。
             */
            const editing = editMargin?.side === side
            return (
              <span
                key={side}
                className={`bp-margin-rule bp-margin-rule--${side}`}
                style={ruleStyle}
              >
                {editing ? (
                  <input
                    className="bp-margin-rule__input"
                    aria-label={`${MARGIN_SIDE_CN[side]}边距（毫米）`}
                    value={editMargin.value}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setEditMargin({ side, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitMargin(side, editMargin.value, mm)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditMargin(null)
                      }
                    }}
                    onBlur={() => commitMargin(side, editMargin.value, mm)}
                  />
                ) : (
                  <button
                    type="button"
                    className="bp-margin-rule__chip"
                    title="点击修改这一侧的页边距"
                    aria-label={`修改${MARGIN_SIDE_CN[side]}边距，当前 ${mm} 毫米`}
                    onClick={() => setEditMargin({ side, value: String(mm) })}
                  >
                    {MARGIN_SIDE_CN[side]}边距 {mm}mm
                  </button>
                )}
              </span>
            )
          })}

          <div
            className="bp-content-box"
            style={{
              left: pxOf(margin.left),
              top: pxOf(margin.top),
              width: pxOf(content.w),
              height: pxOf(content.h),
            }}
          >
            <span className="bp-content-box__label">可打印区（虚线内）· 虚线外印不出来</span>
          </div>

          {renderBand('header')}
          {renderBand('loop')}
          {renderBand('footer')}

          {/*
            重叠区高亮（需求 ⑩）。元素之间已经**允许**重叠（需求 ⑨ 取消了拦截），
            所以"哪里叠了"必须画出来 —— 否则两个框叠在一起时，用户只能靠肉眼在密集的
            边框里找那一条缝。判定与坐标全在 mm 空间（见上面的 `overlaps`），
            **mm → px 只在这一行发生**，与全文件的约定一致（页边距同样是这里加回去的）。

            不挂 z-index：它排在所有 `.bp-el` 之后，天然压在未选中的元素之上；
            而选中元素有 `z-index: 2`（会盖住它）—— 这是**故意**的，
            选中态的强调 + 8 个手柄必须压在重叠提示之上，不能被一层底色糊住。
          */}
          {overlaps.map((o, i) => (
            <span
              key={`ov${i}`}
              className="bp-overlap"
              aria-hidden
              style={{
                left: pxOf(margin.left + o.x),
                top: pxOf(margin.top + o.y),
                width: pxOf(o.w),
                height: pxOf(o.h),
              }}
            />
          ))}

          {/*
            智能对齐线：拖动 / 缩放过程中，和别的元素边或中心对齐时画出来的那几根线。

            `mm → px` **只在这一行发生**（`pxOf` 后面才加上页边距）—— 判定层
            （align-guides.ts）整份代码里没有一个 px，这是它的硬约束，不是巧合。
            只画有位置的那一支（`edge` / `center`）；`same-size`（等高 / 等宽）按类型定义
            就没有 `atMm`，它没有"线该画在哪"这回事，硬塞一个坐标只会逼 UI 去猜。
          */}
          {guides.map((g, i) =>
            g.kind === 'same-size' ? null : (
              <span
                key={`${g.axis}-${g.kind}-${g.atMm}-${i}`}
                /* 文档级基准线多挂一个 `is-doc`（画得更实）+ 一枚写清"是哪条基准"的小标签。
                   `edge`/`center`（元素间）保持原样：它们本来就靠"两端对齐"自解释。 */
                className={`bp-guide bp-guide--${g.axis}${g.kind === 'doc' ? ' is-doc' : ''}`}
                aria-hidden
                style={
                  g.axis === 'x'
                    ? { left: pxOf(margin.left + g.atMm), top: pxOf(margin.top), height: pxOf(content.h) }
                    : { top: pxOf(margin.top + g.atMm), left: pxOf(margin.left), width: pxOf(content.w) }
                }
              >
                {g.kind === 'doc' ? <span className="bp-guide__tag">{g.label}</span> : null}
              </span>
            ),
          )}

          {/* 拖拽时的实时反馈。**松手之前**就要看出这一下成不成：
              可放置 → 绿色提示 + 目标格子高亮；会被拒绝 → 红色提示 + 直接写出理由。
              用户反复抱怨"拖了没反应"，所以这里宁可能看到"不行"，也不要安静地弹回去。 */}
          {/* 拖出矩形的预览框（规格 一 后半句）：虚线框，松手就按它的宽高换算行列数 */}
          {dropTarget?.kind === 'rect' ? (
            <span
              className="bp-rect-preview"
              aria-hidden
              style={{
                left: pxOf(margin.left + dropTarget.xMm),
                top: pxOf(margin.top + dropTarget.yMm),
                width: pxOf(Math.max(2, dropTarget.wMm)),
                height: pxOf(Math.max(2, dropTarget.hMm)),
              }}
            />
          ) : null}
          {/*
            ⚠️ 条件从 `dropActive` 扩成 `dropActive || dropTarget?.kind === 'cell'`（2026-09-23 第 4 条）：
            `dropActive` 只有"从左侧面板拖"那条路会置真；拖**画布上已有的元素**时没人置它，
            于是即使我们已经知道"要放进这一格"，这句提示也不会渲染 —— 用户依然不知道落点。
          */}
          {dropActive || dropTarget?.kind === 'cell' ? (
            dropTarget?.kind === 'reject' ? (
              <div className="bp-drop-hint is-reject">{dropTarget.reason}</div>
            ) : dropTarget?.kind === 'cell' ? (
              <div className="bp-drop-hint is-into">松开即放进这个单元格</div>
            ) : (
              <div className="bp-drop-hint">松开即插入到此处</div>
            )
          ) : null}
        </div>
      </div>
      {/*
        拖行高 / 列宽时的**预览线 + 数值浮层**（用户规格 三）。
        坐标是**视口坐标**（`position: fixed`）⇒ 只能挂在**未被 `transform: scale()` 缩放**的
        画布根节点上；挂进纸张里会跟着一起缩放、并整体偏移一个页边距。
      */}
      {/*
        矩形选区的浮动工具条（规格 四）。`position: fixed` + 视口坐标：
        与预览线同理 —— 挂进被缩放的纸张里会跟着缩放、并整体偏一个页边距。
        位置由 `barAt` 在渲染后量出来（见那个 useLayoutEffect），此处只负责画。
      */}
      {cellSel && selRange && barAt && actions ? (
        <CellRangeBar
          cellCount={rangeArea(selRange)}
          /* 与动作层共用一份判据：跨表头 / 跨标题列的合并要提前置灰并说清原因 */
          mergeBlockReason={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            if (!found || found.kind !== 'table') return '找不到这张表'
            return mergeRangeBlockReason(found, selRange)
          })()}
          canSplit={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            if (!found || found.kind !== 'table') return false
            const g = tableGrid(found.rows, found.colWidthsMm.length)[selRange.r1]?.[selRange.c1]
            return !!g && canSplitCell(found, g.cell.id)
          })()}
          allHeader={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            if (!found || found.kind !== 'table') return false
            return found.rows.slice(selRange.r1, selRange.r2 + 1).every((r) => r.isHeader === true)
          })()}
          canDeleteRow={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            return !!found && found.kind === 'table' && found.rows.length > 1
          })()}
          canDeleteCol={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            return !!found && found.kind === 'table' && found.colWidthsMm.length > 1
          })()}
          style={{ left: barAt.left, top: barAt.top }}
          onOp={onRangeOp}
          onClose={() => setCellSel(null)}
        />
      ) : null}
      {/*
        「表格尺寸」浮层（规格 一）。挂在**画布根节点**（视口坐标，`position: fixed`），
        与右键菜单同理：放进被缩放的纸张里会跟着缩放、并偏一个页边距。
        落点直接用元素在纸上的位置换算 —— 表格刚插进来时就在视口里，不需要额外的收边逻辑。
      */}
      {newTableId && onResizeTable
        ? (() => {
            const found = readBand(doc, bandOf(newTableId)).find((e) => e.id === newTableId)
            if (!found || found.kind !== 'table') return null
            const host = paperRef.current?.querySelector<HTMLElement>(`[data-el-id="${newTableId}"]`)
            const box = host?.getBoundingClientRect()
            const style = box
              ? { left: Math.round(Math.min(box.right + 10, window.innerWidth - 190)), top: Math.round(box.top) }
              : { left: 12, top: 12 }
            return (
              <TableSizePanel
                rows={found.rows.length}
                cols={found.colWidthsMm.length}
                /*
                 * 两个开关的**回显**都从文档里读，面板自己不存状态：
                 *   · 行 → `rows[0].isHeader`（结构位，打印层也读它）；
                 *   · 列 → 第一列的样式（本项目"列的标题身份由样式表达"的既有设计，
                 *          见 table-actions 的 setHeaderStylePatch / isFirstColHeaderStyled）。
                 */
                headerRow={found.rows[0]?.isHeader === true}
                headerCol={isFirstColHeaderStyled(found)}
                style={style}
                onResize={(r, c) => onResizeTable(newTableId, r, c)}
                onHeaderRowChange={(on) => {
                  const res = setHeaderRowsPatch(found, { r1: 0, c1: 0, r2: 0, c2: Math.max(0, found.colWidthsMm.length - 1) }, on)
                  if (res) onMerge(newTableId, res.patch)
                }}
                onHeaderColChange={(on) => {
                  /* 走 setHeaderColPatch：它同时改样式与 `headerCol` 位，并且**不动角格**（见那个函数的注释） */
                  const res = setHeaderColPatch(found, on)
                  if (res) onMerge(newTableId, res.patch)
                }}
                onClose={() => onCloseTableSize?.()}
              />
            )
          })()
        : null}
      {childGhost ? (
        childGhost.child && childGhost.wMm != null && childGhost.hMm != null ? (
          /*
           * ⚠️ **拖出格子的那一刻就画"元素本体"**（2026-10-13 用户口径：
           *   「元素**不能闪现出现**，拖动的时候**依然要跟手移动**，用户可以**实时看到元素的状态**，
           *    拖动到单元格外时，**样式应当在拖动过程中就变换**」）。
           *
           * ⚠️ 位置 = **鼠标位置 − 抓取偏移**（与 `takeOutChild` 的落点同一个算法）——
           *   不这么算，元素会在鼠标左上角出现（用户报过"无法判断会出现在哪"）。
           * ⚠️ 尺寸按**画布口径**（mm）：它已经不在格子里了。
           * ⚠️ 用 `renderCellChild` 渲染（与格内同一套内容渲染），
           *   但外壳用**画布样式**（虚线蓝框）⇒ "样式在过程中就变"。
           */
          <span
            className="bp-child-ghost-body"
            style={{
              left: childGhost.x,
              top: childGhost.y,
              /*
               * ⚠️⚠️ **尺寸必须乘 `scale`**（2026-10-13 用户报：
               *   「这个虚线框元素本体**比实际元素小得多**，导致**很难计算偏移量**，
               *     **方向应该是对的**」）。
               *
               * 根因：ghost 是 `position: fixed` ⇒ **不在纸张的 `transform: scale()` 里**
               *   ⇒ 它上面的尺寸**不会跟着画布缩放**，而画布上的元素**会**。
               *   ⚠️ 而且我原来宽用 `px`（`mmToPx`，不含 scale）、高用 `mm`（固定单位）
               *     ⇒ **两根轴的单位口径都不一样** ⇒ 宽高比也是错的。
               * ⇒ 统一：**都换算成 px，并乘 `scale`** ⇒ 与画布上元素的视觉尺寸一致。
               */
              width: `${mmToPx(childGhost.wMm) * scale}px`,
              height: `${mmToPx(childGhost.hMm) * scale}px`,
            }}
          >
            {renderCellChild(childGhost.child, childGhost.wMm)}
          </span>
        ) : (
          <span className="bp-child-ghost" style={{ left: childGhost.x + 12, top: childGhost.y + 12 }}>
            {childGhost.label}
          </span>
        )
      ) : null}
      {/*
        「行高 / 列宽」的输入弹层（2026-10-13 用户需求）。

        ⚠️ 行列号**在这一刻才算**（不在右键那一刻算）：
          弹层开着的这段时间里表格可能已经被改过（面板里每敲一次数字就 patch 一次），
          把 `rowIdx/colIdx` 抓进 state 会拿一个**过期的行号**去改。
          ⇒ 与 `splitAsk` 同一套纪律：**从当前文档重新定位**。

        ⚠️ 列号必须用 `colStart`（摊平后的**网格**列号），不能用 `row.cells` 的数组下标 ——
          span 模型下两者不是一回事（这个坑项目里踩过三次）。
      */}
      {sizeAsk
        ? (() => {
            const t = readBand(doc, bandOf(sizeAsk.tableId)).find((e) => e.id === sizeAsk.tableId)
            if (!t || t.kind !== 'table') return null
            const loc = findCell(t.rows, sizeAsk.cellId)
            if (!loc) return null
            const g = (tableGrid(t.rows, t.colWidthsMm.length)[loc.rowIdx] ?? []).find(
              (x) => x?.cell.id === sizeAsk.cellId,
            )
            if (!g) return null
            const isRow = sizeAsk.kind === 'row'
            return (
              <CellSizeDialog
                kind={sizeAsk.kind}
                indexLabel={String((isRow ? loc.rowIdx : g.colStart) + 1)}
                currentMm={
                  isRow
                    ? typeof t.rows[loc.rowIdx]?.heightMm === 'number'
                      ? (t.rows[loc.rowIdx]?.heightMm as number)
                      : null
                    : (t.colWidthsMm[g.colStart] ?? null)
                }
                onReset={
                  isRow
                    ? () => {
                        const p = setRowHeightPatch(t, loc.rowIdx, undefined)
                        if (p) onMerge(t.id, p)
                        setSizeAsk(null)
                      }
                    : undefined
                }
                onConfirm={(mm) => {
                  const p = isRow
                    ? setRowHeightPatch(t, loc.rowIdx, mm)
                    : setColWidthPatch(t, g.colStart, mm)
                  if (p) onMerge(t.id, p)
                  setSizeAsk(null)
                }}
                onCancel={() => setSizeAsk(null)}
              />
            )
          })()
        : null}
      {/*
        「拆分单元格」的输入弹层（第 7 条）。输入框的**下限**取自目标格自己当前占的行列数 ——
        比它小没有意义（"1 行拆成 1 行"什么都没发生），直接把下限摆进输入框，用户不必先试一次才知道。
      */}
      {splitAsk
        ? (() => {
            const t = readBand(doc, bandOf(splitAsk.tableId)).find((e) => e.id === splitAsk.tableId)
            if (!t || t.kind !== 'table') return null
            const loc = findCell(t.rows, splitAsk.cellId)
            const gc = loc
              ? (tableGrid(t.rows, t.colWidthsMm.length)[loc.rowIdx] ?? []).find((x) => x?.cell.id === splitAsk.cellId)
              : null
            return (
              <SplitCellDialog
                minRows={Math.max(1, gc?.rowSpan ?? 1)}
                minCols={Math.max(1, gc?.colSpan ?? 1)}
                error={splitErr}
                onConfirm={doSplit}
                onCancel={() => {
                  setSplitAsk(null)
                  setSplitErr(null)
                }}
              />
            )
          })()
        : null}
      {sizeGhost ? (
        <>
          <span
            className={`bp-size-ghost bp-size-ghost--${sizeGhost.axis}`}
            style={sizeGhost.axis === 'col' ? { left: sizeGhost.x } : { top: sizeGhost.y }}
            aria-hidden
          />
          <span className="bp-size-ghost__tag" style={{ left: sizeGhost.x, top: sizeGhost.y }}>
            {sizeGhost.label}
          </span>
        </>
      ) : null}
      {ctx && actions ? (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onPick={onCtxPick} onClose={() => setCtx(null)} />
      ) : null}
    </div>
  )
})
