/**
 * 右抽屉：页面属性 / 元素属性。
 *
 * 分支规则：未选中任何元素 → 页面属性（PRD F2-25）；选中元素 → 按 kind 分支。
 *
 * 关于"默认字体 / 默认字号"：TemplateDoc 里没有这两个字段（契约归 lib/types.ts 所有，不改），
 * 而 PRD F2-25 又要求页面属性里有它们。折中做法是把它们当作**编辑器的本地偏好**存在 EditorShell，
 * 只影响"之后插入的新元素"的初始样式，不写入模板 JSON —— 这样既不污染契约，
 * 也符合 F2-28"不做样式集/主题级继承"的定调。
 */

import { useMemo, useRef, useState } from 'react'
import type { FieldMeta } from '../../lib/data-source'
import { fieldMeta } from '../../lib/field-types'
import {
  DEFAULT_PRINT_TIME_FORMAT,
  DEFAULT_TODAY_FORMAT,
  GRID_STEPS_MM,
  MARGIN_PRESETS,
  PAPER_MM,
  PAPER_PRESETS,
  TIME_FORMAT_PRESETS,
  finite,
  imageFillModeOf,
  imageFillPatch,
  pageRenderSize,
  type Align,
  type AnyElement,
  type AttachmentPrintConfig,
  type CodeSource,
  type ImageFill,
  type InlineNode,
  type MarginMm,
  type PageSetup,
  type PaperKey,
  type TableCell,
  type TableElement,
  type TemplateDoc,
  type TextStyle,
} from '../../lib/types'
import type { BandKey, BandLayout, CellLocation, NodeRef } from './useEditorState'
/* 选完本地图片后把浏览器全屏要回来（系统文件对话框会让窗口失焦、全屏被浏览器收掉） */
import { enterFullscreen } from '../../lib/fullscreen'
/* 文件选择走**单例**：面板里那个 input 会随布局档切换被重挂换掉 ⇒ change 落空（见该文件注释） */
import { pickFile } from '../../lib/file-pick'
import {
  BAND_HINT,
  DEFAULT_CODE_BG,
  DEFAULT_CODE_FG,
  SYSVAR_LABEL,
  cellLabel,
  codeSourceLabel,
  elementHeightMm,
  findCell,
  gridOptions,
  isSysVarNode,
  nodeAtRef,
  nodeKindLabel,
  nodeStyleCount,
  nodeStyleOf,
  nodesToText,
  textToNodes,
  updateCell,
} from './useEditorState'
// 格内子元素的尺寸口径（`w` = 占格宽百分比、`h` = 盒高）与百分比下限 —— 见 types.ts 第 ④ 条
import { MIN_CELL_CHILD_PCT, childHeightMm, childWidthPct } from './cell-child'
import { childOffsetXPct, childOffsetYMm } from '../../lib/cell-geometry'
import {
  CapsuleSelect,
  SWATCHES,
  ColorInput,
  Field,
  FieldPicker,
  Num,
  Section,
  Seg,
  Switch,
  UnderlineDashBtn,
  underlineDashToggle,
  underlineSolidToggle,
  type CapsuleOption,
} from './Controls'
import { clearNodeStyles } from './clear-node-styles'
import { EMBED_IMAGE_MAX_BYTES, shrinkDataUrl } from '../../lib/image-shrink'
import { templateImageFileName, uploadTemplateImageFiles } from '../../lib/template-images'
import { IconBack, IconMerge, IconMinus, IconPlus, IconSplit, IconTrash, IconWarning } from './Icons'
import { isCode128Encodable } from '../../render/code-elements'
// `round1` 的规范实现（B 批收口：此前全项目 5 份副本、且不是同一种行为，见 round.ts 的文件头）
import { round1 } from './round'
// 表格动作的规范实现（B 批提升：原来这些动作各自关在本文件的组件闭包里，
// 顶栏的表格工具条是这些闭包的**兄弟**，够不到 —— 不提升就会各写一套。见 table-actions.ts 的文件头）
import {
  MIN_COL_MM,
  MIN_ROW_MM,
  addColPatch,
  addRowPatch,
  applySplitCell,
  canSplitCell,
  delColPatch,
  delRowPatch,
  setColWidthPatch,
  setRowHeightPatch,
  setTablePaddingPatch,
  tableGrid,
  cellWidthMm,
} from './table-actions'

/** 单元格底纹的默认值。属于**内容色**（会打印出来），不随暗色主题翻，故写死 */
const DEFAULT_CELL_BG = '#ffffff'

/** 字色色板。右侧面板与顶栏工具栏共用同一份，免得同一个颜色在两处叫不同的名字 */
export const TEXT_SWATCHES = SWATCHES

/** 字体候选。右侧面板与顶栏工具栏共用 */
export const FONT_OPTIONS = [
  { value: 'system', label: '系统默认', hint: '跟随飞书客户端的中文字体栈' },
  { value: 'serif', label: '宋体 / 衬线' },
  { value: 'mono', label: '等宽' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimSun', label: '宋体' },
  { value: 'SimHei', label: '黑体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'DengXian', label: '等线' },
]

/**
 * 纸张预设直接由 PAPER_PRESETS 摊平，不再手写一份 —— 两边各写一份的结果
 * 一定是"加了新纸型但下拉里没有"。
 * group 让弹层里出现「标准纸张 / 标签·面单」两个分组标题：
 * 标签纸的边距习惯（常常是 0）和 A4 完全不同，混在一个列表里必选错。
 */
export const PAPER_OPTIONS: CapsuleOption<PaperKey>[] = PAPER_PRESETS.map((p) => ({
  value: p.key,
  label: p.label,
  hint: p.wMm && p.hMm ? `${p.wMm} × ${p.hMm} mm` : '手动输入宽高',
  group: p.group,
}))

const GRID_OPTIONS: CapsuleOption<string>[] = GRID_STEPS_MM.map((v) => ({
  value: String(v),
  label: `${v} mm`,
  hint: v <= 1 ? '最细，适合标签纸' : v >= 10 ? '最粗，适合粗排' : undefined,
}))

export interface InspectorProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  layout: BandLayout
  selected: AnyElement | null
  selectedBand: BandKey | null
  selectedCellId: string | null
  /**
   * 选中格内子元素时给出它所在的格子（否则 null）。
   *
   * 面板据此**换一套尺寸控件**（格内元素没有 X/Y、`w` 是百分比、`h` 是盒高，
   * 见 types.ts 的 TableCell.children 第 ④ 条）。判据只有这一个来源 ——
   * 面板里**不要**再去判 id 前缀，两处判据一定会有一天不一致。
   */
  selectedInCell?: { tableId: string; cellId: string } | null
  /** 节点级选中：字段占位符 / 系统变量 / 文字片段本身 */
  selectedNode?: NodeRef | null
  /**
   * ⚠️ **换绑行内字段节点**（2026-10-17）：顶部标题的下拉选择器用。
   * 系统变量不走这里（它们没有"绑定字段"的概念）。
   */
  onNodeField?(fieldId: string, fieldName: string): void
  /**
   * ⚠️ **行内字段节点的"自动换行"开关**（2026-10-17 用户要求：
   *   「有些字段值特别长，增加**是否自动换行**的功能」）。
   */
  onNodeWrap?(wrap: boolean): void
  defaultTextStyle: TextStyle
  onPageSetup(patch: Partial<PageSetup>): void
  /**
   * 改**表头区高度**（= `bands.loop.offsetMm`，0 = 不要表头区）。
   *
   * 它不是 `pageSetup` 的字段（属于版式区），所以单开一个回调 —— 混进 pageSetup
   * 会造出第二个存放位置（见 `EditorApi.setLoopOffset` 的注释）。
   */
  onSetLoopOffset?(mm: number): void
  /**
   * 表头区 / 表尾区是否**参与打印**（2026-09-23 第二次反馈：「在侧边属性中选择开启或者关闭」）。
   * 关掉只影响打印与预览 —— 画布上元素照旧显示、照旧可编辑。
   */
  onSetBandEnabled?(band: 'header' | 'footer', on: boolean): void
  onDefaultTextStyle(patch: Partial<TextStyle>): void
  onMerge(id: string, patch: Partial<AnyElement>, mergeKey?: string): void
  onRemove(id: string): void
  onSetBand(id: string, band: BandKey): void
  onSelectCell(elementId: string | null, cellId: string | null): void
  /**
   * 请求合并（右合并 / 下合并）。
   *
   * 面板**不自己合并**：合并会整个丢掉被并进来那一格的内容，必须先过确认层，
   * 而确认层要能在顶栏工具条与右侧面板之间共用，所以它连同 `pending` 一起提升到了
   * `EditorShell`（弹层见 `MergeConfirm.tsx`）。这里只上报"哪一格的哪一边"。
   */
  onAskMerge(elementId: string, cellId: string, dir: 'right' | 'down'): void
  /**
   * ⚠️ **打开"行高 / 列宽"对话框**（2026-10-17 用户要求：单元格面板里也要能设）。
   *   实现方（`EditorShell`）转给 `CanvasHandle.askCellSize` —— **对话框只有一份**。
   */
  onAskCellSize?(tableId: string, cellId: string, kind: 'row' | 'col'): void
  /** 改**这一处节点自己**的样式覆写；值为 undefined 表示清掉该项覆写 */
  onNodeStyle?(patch: TextStyle, mergeKey?: string): void
  /** 清掉这一处节点的全部样式覆写 */
  onClearNodeStyle?(): void
  /**
   * 改这一处节点的**非样式**属性：系统变量的时间格式 / 是否显示总页数。
   * 与 onNodeStyle 分开是故意的：那不是"样式覆写"，不该被「清除覆写」清掉。
   */
  onNodeProps?(patch: { format?: string; hideTotal?: boolean }): void
  /** 退回上一层（取消节点选中） */
  onSelectNode?(sel: NodeRef | null): void
  onNotice(message: string): void
}

export function Inspector(props: InspectorProps) {
  const { selected, selectedCellId, selectedNode } = props
  // 层级：节点 > 单元格 > 元素 > 页面。
  // 选中表格里某个单元格时，用户的心理对象是"这个格子"，此时还把所有控件都摊成表格级的
  // （行列增删、列宽……）就是他报的"点字段还是显示表格属性"那个问题。
  const cellScope = !!selected && selected.kind === 'table' && !!selectedCellId
  /**
   * 节点那一层只在"它真的属于当前选中的元素/格子"时才认。
   * 否则用户点了别的元素，面板还停在上一处字段上 —— 改的不是他看见的东西，这是最难查的一类错。
   * 定位失效（元素/格子被删、下标越界）同样自动退回上一层，不必在每条删除路径上清状态。
   */
  const node =
    selected && selectedNode && selectedNode.elementId === selected.id && (selectedNode.cellId ?? null) === (selectedCellId ?? null)
      ? nodeAtRef(props.doc, selectedNode)
      : null
  return (
    <div className="bp-panel bp-panel--inspector">
      <div className="bp-panel__scroll">
        {!selected ? (
          <PagePanel {...props} />
        ) : node && selectedNode ? (
          /*
           * ⚠️⚠️ **只显示"这一处"的面板，不再叠单元格面板**（2026-10-17 用户要求：
           *   「选中格内的基础元素后，**会同时默认选中了该单元格**，右侧属性中**也会带单元格的相关设置**；
           *     参考格内**二维码、条形码、图片、附件**的选择逻辑 —— 选中后**只显示该元素的属性设置**，
           *     只有选中**单元格空白处**，才会显示该单元格的属性设置」）。
           *
           * ⚠️ 这里**推翻了 2026-09-22 的一次设计**：当时是"节点面板**不替代**单元格面板、而是叠在上面"，
           *   理由是不想让「单元格内容」输入框消失。
           *   ⇒ 那个理由**在"格内子元素"（图片/附件/码）上从来不成立** ——
           *     它们选中时本来就只有元素面板。**两种选中态的面板结构不一致，这才是"混乱"的来源。**
           *   ⇒ 现在统一成"**选中谁就只显示谁**"：
           *     · 点字段/系统变量 ⇒ 只显示"这一处的样式"；
           *     · 点格子空白处（`onClick` 落到 `<td>`）⇒ 只显示"这一格"。
           *   ⚠️ 想改回车里的文字：点格子的**空白处**即可（不需要先"退出"节点）。
           */
          <NodePanel {...props} selectedNode={selectedNode} node={node} />
        ) : cellScope && selected.kind === 'table' ? (
          <CellPanel {...props} element={selected} band={props.selectedBand ?? 'loop'} />
        ) : (
          <ElementPanel {...props} element={selected} band={props.selectedBand ?? 'loop'} />
        )}
      </div>
    </div>
  )
}

// ============================================================
// 行内节点属性（字段占位符 / 系统变量 / 文字片段自己的样式）
// ============================================================

/**
 * 这一层的存在理由：`InlineField.style` 是**节点级覆写**，只影响那一处的值；
 * 而文本元素 / 单元格的 `style` 是元素级的。用户的抱怨是"似乎无法对字段内容进行字体的设置" ——
 * 他要改的正是这一层。所以除了给出控件，还必须把"你现在改的是哪一层"写在脸上。
 */
function NodePanel(props: InspectorProps & { selectedNode: NodeRef; node: InlineNode }) {
  const { node, selectedNode, selected } = props
  const s = nodeStyleOf(node)
  const overrides = nodeStyleCount(node)
  // 覆写之上是"外层"：文本元素自己 / 表格里那一格自己的样式。写清楚继承来源，用户才知道去哪改整体
  const inCell = !!selectedNode.cellId
  const outerName = inCell ? '这个单元格' : '整个元素'
  const outerStyle: TextStyle = inCell && selected?.kind === 'table'
    ? (findCell(selected.rows, selectedNode.cellId as string)?.cell.style ?? {})
    : (selected?.style ?? {})
  const effFont = s.fontFamily ?? outerStyle.fontFamily ?? 'system'
  const effSize = finite(s.fontSizePt, finite(outerStyle.fontSizePt, 10.5))

  const patch = (p: TextStyle, key?: string): void => props.onNodeStyle?.(p, key)

  return (
    <>
      {/*
       * ⚠️⚠️ **顶部 = 可换绑的字段选择器**（2026-10-17 用户要求：
       *   「参考附件那个样式：**顶部元素名称**；与附件不同的是，
       *     **普通字段的顶部名称可以下拉更换**（换成其它字段，**除附件**）」）。
       *
       * ⚠️ 只有 `field` 节点能换 —— 系统变量（页码/总页数…）没有"绑定字段"这个概念。
       * ⚠️ 原来这里是一条标题 + 三段说明（"这一处的样式 / 正在改… / 只影响…"），
       *   占 5 行却只传达一件事 ⇒ 按"紧凑"的要求**压成一行**：
       *   标题本身就是选择器，右边一个灰字说明"只影响这一处"。
       */}
      <div className="bp-panel__title bp-panel__title--picker">
        <div className="bp-nodepick">
          {node.type === 'field' ? (
            <FieldPicker
              value={node.fieldId}
              fallbackName={node.fieldName}
              /* ⚠️ **排除附件字段**（用户明确："换成其它字段，**除附件**"）——
                 附件在格内是"附件块"（`attach`），拿着一个附件字段的行内占位符没有意义。
                 ⚠️ 要在**传进 `fieldOptions` 之前**过滤：它返回的选项里没有 `type` 字段。 */
              options={fieldOptions(props.fields.filter((f) => f.type !== 17))}
              ariaLabel="更换这一处绑定的字段"
              allowEmpty={false}
              onChange={(id, name) => {
                if (!id) return
                props.onNodeField?.(id, name)
              }}
            />
          ) : (
            <b>{nodeKindLabel(node)}</b>
          )}
          <span className="bp-nodepick__hint">只影响这一处</span>
        </div>
      </div>

      <Section title="这一处的字体">
        <Field label="字体" hint={`「跟随外层」= 用${outerName}的字体（当前 ${effFont}）`}>
          <CapsuleSelect
            value={s.fontFamily ?? ''}
            options={[{ value: '', label: '跟随外层' }, ...FONT_OPTIONS]}
            onChange={(v) => patch({ fontFamily: v || undefined })}
            ariaLabel="这一处的字体"
          />
        </Field>
        <Field label="字号" hint={`留空跟随外层；${outerName}当前 ${effSize}pt`}>
          <Num
            value={effSize}
            min={2}
            max={72}
            step={0.5}
            suffix="pt"
            ariaLabel="这一处的字号"
            onChange={(v) => patch({ fontSizePt: v }, 'fs')}
          />
        </Field>
        {/*
         * ⚠️⚠️ **字色单独一行**（2026-10-17 用户要求：'把颜色设置**单独弄一行**'）。
         *
         * 上一版把它和"字号"并排放（`bp-grid2--tight` 里 `auto minmax(0,1fr)`）——
         * 结果"字色"那一列**被压到几乎没有宽度**，色板整个看不见了（用户截图里
         * "字号 13.5 pt 字色"后面是空的）✅
         * ⇒ 独占一行后色板有整行宽（10×15 + 9×3 ≈ 177px），也符合"横向一排"的要求。
         */}
        <Field label="字色" hint="只改这一处的颜色；清掉覆写即跟随外层">
          <ColorInput
            value={s.color ?? outerStyle.color ?? '#1f2329'}
            swatches={TEXT_SWATCHES}
            ariaLabel="这一处的字色"
            onChange={(v) => patch({ color: v })}
          />
        </Field>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="这一处的字形">
            <button
              type="button"
              className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`}
              aria-pressed={!!s.bold}
              title="加粗（只作用这一处）"
              onClick={() => patch({ bold: s.bold ? undefined : true })}
            >
              B
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`}
              aria-pressed={!!s.italic}
              title="斜体（只作用这一处）"
              onClick={() => patch({ italic: s.italic ? undefined : true })}
            >
              I
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`}
              aria-pressed={!!s.underline}
              title="下划线（只作用这一处）"
              onClick={() => patch(underlineSolidToggle(s))}
            >
              U
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--strike${s.strike ? ' is-on' : ''}`}
              aria-pressed={!!s.strike}
              title="删除线（只作用这一处）"
              onClick={() => patch({ strike: s.strike ? undefined : true })}
            >
              S
            </button>
            <UnderlineDashBtn
              style={s}
              hint="只作用这一处"
              onToggle={() => patch(underlineDashToggle(s))}
            />
          </div>
        </Field>
      </Section>

      {/*
        系统变量**自己**的属性（不是样式）：时间类变量的显示格式、合并形态要不要带「共 N 页」。
        为什么只在这一层给入口：它们是 `InlineSysVar` 上的字段，一个占位符一份，
        和"这一处的字体"处在同一层。放到元素面板上会变成"改了整段所有变量"，
        放到页面设置里更不对（那是纸张的事）。
        渲染层早已支持（render/types.ts 的 InlineSysVar + render/html.ts 的 resolveSysVar），
        缺的只是这个入口 —— 用户报的正是"界面上找不到地方设"。
      */}
      {isSysVarNode(node) ? (
        <Section title="这一处的内容">
          {node.key === 'pageOfTotal' ? (
            <Field label="总页数" hint="关掉就只输出「第 X 页」，不再带「共 N 页」">
              <Switch
                checked={node.hideTotal !== true}
                ariaLabel="显示总页数"
                onChange={(v) => props.onNodeProps?.({ hideTotal: v ? undefined : true })}
              />
            </Field>
          ) : null}
          {node.key === 'today' || node.key === 'printTime' ? (
            <Field
              label="时间格式"
              hint={`留空用这个变量自己的默认格式（${
                node.key === 'today' ? DEFAULT_TODAY_FORMAT : DEFAULT_PRINT_TIME_FORMAT
              }）`}
            >
              <CapsuleSelect
                value={node.format ?? ''}
                options={[
                  { value: '', label: '默认' },
                  ...TIME_FORMAT_PRESETS.map((p) => ({ value: p.value, label: p.label })),
                ]}
                onChange={(v) => props.onNodeProps?.({ format: v || undefined })}
                ariaLabel="这一处的时间格式"
              />
            </Field>
          ) : null}
          {node.key === 'pageOfTotal' || node.key === 'today' || node.key === 'printTime' ? null : (
            <p className="bp-hint">
              「{SYSVAR_LABEL[node.key]}」没有额外参数，取的就是它在渲染时的值；要调它的样子用上面的字体。
            </p>
          )}
        </Section>
      ) : null}

      <Section title="层级">
        <p className="bp-hint">
          这一层的样式只盖在它自己身上，现在有 {overrides} 项覆写。要改{outerName}的字体，点「改{outerName}」，
          或用顶栏右侧的目标切换。
        </p>
        <div className="bp-btnrow">
          <button
            type="button"
            className="bp-btn bp-btn--sm"
            aria-label={`退回上一层，改${outerName}`}
            onClick={() => props.onSelectNode?.(null)}
          >
            改{outerName}
          </button>
          <button
            type="button"
            className="bp-btn bp-btn--sm bp-btn--danger"
            aria-label="清除这一处的样式覆写"
            disabled={overrides === 0}
            title="把这一处设过的字体、字号、字形、颜色全部清掉，回到跟随外层"
            onClick={() => props.onClearNodeStyle?.()}
          >
            <IconTrash size={13} /> 清除覆写
          </button>
        </div>
        {overrides === 0 ? <p className="bp-hint">这一处还没有任何覆写，当前完全跟随{outerName}。</p> : null}
      </Section>
    </>
  )
}

// ============================================================
// 页面属性
// ============================================================

/**
 * 页面属性。
 *
 * 这里**导出**不是为了让别人调用它，而是为了让顶栏「页面设置」弹层能渲染**同一份**内容
 * （用户要求："页面的相关设置也放在这个按钮内"）。抄一份到顶栏 = 以后加一个页面字段，
 * 两个入口里只有一个有 —— 这正是"同一个规则两处各写一套"的老毛病。
 */
export function PagePanel({ doc, layout, defaultTextStyle, onPageSetup, onDefaultTextStyle, onSetLoopOffset, onSetBandEnabled }: InspectorProps) {
  const ps = doc.pageSetup
  const render = pageRenderSize(ps)
  const grid = gridOptions(ps)
  // 边距上限：保证版心至少还剩 10mm，否则会出现"版心宽度为负"（E-20）
  const maxMargin = Math.max(0, Math.min(render.w, render.h) / 2 - 5)
  const marginOverflow = ps.margin.top > maxMargin || ps.margin.bottom > maxMargin || ps.margin.left > maxMargin || ps.margin.right > maxMargin
  /**
   * 四边一致时返回那个值，否则 `null`（自定义）。
   * 快捷档要用它**回显当前档** —— 否则胶囊永远显示第一个选项（"整张纸"），
   * 用户会以为"我现在就是整张纸"，而实际边距是 20mm。
   */
  const uniformMargin: number | null = (() => {
    const m = ps.margin
    return m.top === m.right && m.right === m.bottom && m.bottom === m.left ? m.top : null
  })()
  /** 上/下、左/右 是否联动（连续镜像编辑，比"点一次四边相同"更好用） */
  const [linkV, setLinkV] = useState(false)
  const [linkH, setLinkH] = useState(false)

  // 非自定义纸张时，真实尺寸以 PAPER_MM 为准（pageRenderSize 也是这么算的）。
  // 直接读 ps.widthMm 会显示上一次自定义留下的旧值，和纸面不符。
  const presetMm = ps.paper === 'custom' ? null : PAPER_MM[ps.paper]
  const curW = presetMm ? presetMm.w : ps.widthMm
  const curH = presetMm ? presetMm.h : ps.heightMm

  const setPaper = (paper: PaperKey): void => {
    if (paper === 'custom') {
      onPageSetup({ paper })
      return
    }
    const mm = PAPER_MM[paper]
    onPageSetup({ paper, widthMm: mm.w, heightMm: mm.h })
  }

  /**
   * 直接改宽/高。
   * 手改了尺寸就自动落到"自定义"：留着 A4 的标签却按 200mm 出图，是更难排查的错。
   * 改回与预设一致的值时也顺手切回该预设，用户不用去下拉里再选一次。
   */
  const setDim = (key: 'w' | 'h', v: number): void => {
    const widthMm = key === 'w' ? v : curW
    const heightMm = key === 'h' ? v : curH
    const match = PAPER_PRESETS.find(
      (p) => p.key !== 'custom' && p.wMm === widthMm && p.hMm === heightMm,
    )
    onPageSetup({ widthMm, heightMm, paper: match ? match.key : 'custom' })
  }

  const setMargin = (key: keyof MarginMm, v: number): void => {
    const next: MarginMm = { ...ps.margin, [key]: v }
    if (linkV && (key === 'top' || key === 'bottom')) {
      next.top = v
      next.bottom = v
    }
    if (linkH && (key === 'left' || key === 'right')) {
      next.left = v
      next.right = v
    }
    onPageSetup({ margin: next })
  }

  const sameAll = (): void => {
    const v = ps.margin.top
    onPageSetup({ margin: { top: v, right: v, bottom: v, left: v } })
    setLinkV(true)
    setLinkH(true)
  }

  return (
    <>
      <div className="bp-panel__title">页面属性</div>

      <Section title="纸张">
        <Field label="尺寸">
          <CapsuleSelect value={ps.paper} options={PAPER_OPTIONS} onChange={setPaper} ariaLabel="纸张尺寸" />
        </Field>
        <div className="bp-grid2">
          <Field label="宽" hint="成品纸张的宽（mm）。改这里会自动切到自定义尺寸">
            <Num value={curW} min={10} max={1000} step={1} suffix="mm" ariaLabel="纸张宽度" onChange={(v) => setDim('w', v)} />
          </Field>
          <Field label="高" hint="成品纸张的高（mm）。横向时这两个值会自动对调显示">
            <Num value={curH} min={10} max={1000} step={1} suffix="mm" ariaLabel="纸张高度" onChange={(v) => setDim('h', v)} />
          </Field>
        </div>
        <Field label="方向">
          <Seg
            value={ps.orientation}
            ariaLabel="纸张方向"
            onChange={(v) => onPageSetup({ orientation: v })}
            options={[
              { value: 'portrait', label: '纵向' },
              { value: 'landscape', label: '横向' },
            ]}
          />
        </Field>
        <p className="bp-hint">
          成品尺寸 {round1(render.w)}×{round1(render.h)}mm · 版心 {round1(layout.contentWMm)}×{round1(layout.contentHMm)}mm
          {ps.paper === 'custom' ? ' · 自定义尺寸' : ''}
        </p>
      </Section>

      <Section title="网格与吸附">
        <Field label="网格间距">
          <CapsuleSelect
            value={String(grid.gridMm)}
            options={GRID_OPTIONS}
            onChange={(v) => onPageSetup({ gridMm: Number(v) })}
            ariaLabel="网格间距"
          />
        </Field>
        <Field label="显示网格" inline>
          <Switch checked={grid.showGrid} ariaLabel="显示网格" onChange={(v) => onPageSetup({ showGrid: v })} />
        </Field>
        <Field label="吸附到网格" inline>
          <Switch checked={grid.snapToGrid} ariaLabel="拖拽时吸附到网格" onChange={(v) => onPageSetup({ snapToGrid: v })} />
        </Field>
        <p className="bp-hint">
          拖动与缩放都会吸附到网格；按住 Alt 拖动可临时不吸附。X / Y / 宽 / 高 输入框的上下箭头也按这个步长走。
        </p>
        {/*
          「允许拖出页面」（2026-09-23 真机反馈第 10 条）。
          用户要求这个开关落在**页面属性 + 画布右键菜单**两处；这里是与网格/吸附同类的"编辑辅助"，放这一节最合适。
        */}
        <Field label="允许拖出页面" inline>
          <Switch
            checked={doc.pageSetup.allowOutOfPage === true}
            ariaLabel="允许拖出页面"
            onChange={(v) => onPageSetup({ allowOutOfPage: v })}
          />
        </Field>
        <p className="bp-hint">
          {doc.pageSetup.allowOutOfPage === true
            ? '现在可以把元素拖到纸张外（越界会被检查条点名，打印时印不出来）。'
            : '现在元素会被夹在版心内 —— 拖到边缘就停住，避免不小心把内容拖到纸外。'}
        </p>
      </Section>

      {/*
        ---- 分区（2026-09-23 真机反馈第 2 条）------------------------------------------
        用户原话：「当前表头区、循环区、表尾区的默认大小是多少？表头区改为可以删除或者增加，
        在页面属性中设置」。

        三个区的**大小口径**在这里一次说清（也顺便标出各自可调的入口）：
          · 表头区 = 这个输入框（`bands.loop.offsetMm`）；0 = 不要表头区；
          · 循环区 = 表头区之下、表尾区之上的**剩余空间**（不用填，自动）；
          · 表尾区 = 它自己内容的高度，**打印时贴版心底部**（元素越多，它往上长得越多）。
      */}
      {onSetLoopOffset ? (
        <Section title="分区">
          <Field label="表头区高度" hint="mm；0 = 不要表头区">
            <Num
              value={finite(doc.bands.loop.offsetMm, 0)}
              min={0}
              max={Math.max(0, Math.round(layout.contentHMm / 2))}
              step={1}
              suffix="mm"
              ariaLabel="表头区高度"
              onChange={(v) => onSetLoopOffset(v)}
            />
          </Field>
          {onSetBandEnabled ? (
            <>
              <Field label="表头区" hint="关掉后该区元素不参与打印（画布上仍然可以编辑）">
                <Switch
                  checked={doc.bands.headerEnabled !== false}
                  ariaLabel="表头区参与打印"
                  onChange={(v) => onSetBandEnabled('header', v)}
                />
              </Field>
              <Field label="表尾区" hint="关掉后该区元素不参与打印（画布上仍然可以编辑）">
                <Switch
                  checked={doc.bands.footerEnabled !== false}
                  ariaLabel="表尾区参与打印"
                  onChange={(v) => onSetBandEnabled('footer', v)}
                />
              </Field>
            </>
          ) : null}
          <p className="bp-hint">
            循环区自动从表头区下面开始（高度自动）；<b>表头区与表尾区都每页重复</b>（相当于 Word 的页眉 / 页脚）。
            三个分区的范围在画布上都有虚线框；表头区里的元素出不了这个高度，所以拖它不会推动别的分区。
          </p>
        </Section>
      ) : null}

      <Section title="页边距">
        {/*
          快捷档（2026-09-18 用户提问后补）：
          "打印范围应该强制和纸张大小一致，纸张大小设置多少，打印范围就是多少才对。"
          —— 可打印范围 = 版心 = 纸张 − 页边距，所以"整张纸"就是**四个边距都设 0**。
          以前只有四个数字框，没人会想到这条等价关系 ⇒ 直接把档位摆出来。
        */}
        <Field label="整档">
          <CapsuleSelect
            value={String(uniformMargin ?? 'custom')}
            options={MARGIN_PRESETS.map((p) => ({ value: String(p.mm), label: p.label, hint: p.hint }))}
            onChange={(v) => {
              const mm = Number(v)
              onPageSetup({ margin: { top: mm, right: mm, bottom: mm, left: mm } })
            }}
            ariaLabel="页边距快捷档"
          />
        </Field>
        {uniformMargin === null && (
          <p className="bp-hint">当前四边不一致（自定义）。选上面任意一档会四边一起改。</p>
        )}
        <div className="bp-grid2">
          <Field label="上">
            <Num value={ps.margin.top} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="上边距" onChange={(v) => setMargin('top', v)} />
          </Field>
          <Field label="下">
            <Num value={ps.margin.bottom} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="下边距" onChange={(v) => setMargin('bottom', v)} />
          </Field>
          <Field label="左">
            <Num value={ps.margin.left} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="左边距" onChange={(v) => setMargin('left', v)} />
          </Field>
          <Field label="右">
            <Num value={ps.margin.right} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="右边距" onChange={(v) => setMargin('right', v)} />
          </Field>
        </div>
        <div className="bp-btnrow" role="group" aria-label="页边距联动">
          <button
            type="button"
            className={`bp-minibtn${linkV ? ' is-on' : ''}`}
            aria-pressed={linkV}
            title="开启后，改上边距会同步改下边距（反之亦然）"
            onClick={() => setLinkV((v) => !v)}
          >
            上下联动
          </button>
          <button
            type="button"
            className={`bp-minibtn${linkH ? ' is-on' : ''}`}
            aria-pressed={linkH}
            title="开启后，改左边距会同步改右边距（反之亦然）"
            onClick={() => setLinkH((v) => !v)}
          >
            左右联动
          </button>
          <button type="button" className="bp-minibtn" title="把上边距的值应用到四边" onClick={sameAll}>
            四边相同
          </button>
        </div>
        {marginOverflow ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 页边距超出纸张尺寸，已自动收窄
          </p>
        ) : null}
        <div className="bp-grid2">
          <Field label="页眉距边">
            <Num value={ps.headerMm} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="页眉距上边缘" onChange={(v) => onPageSetup({ headerMm: v })} />
          </Field>
          <Field label="页脚距边">
            <Num value={ps.footerMm} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="页脚距下边缘" onChange={(v) => onPageSetup({ footerMm: v })} />
          </Field>
        </div>
        <p className="bp-hint">v1 不渲染页眉页脚内容，仅保留距边距离供参考</p>
      </Section>

      <Section title="默认字体（影响之后插入的元素）">
        <Field label="字体">
          <CapsuleSelect
            value={defaultTextStyle.fontFamily ?? 'system'}
            options={FONT_OPTIONS}
            onChange={(v) => onDefaultTextStyle({ fontFamily: v })}
            ariaLabel="默认字体"
          />
        </Field>
        <Field label="字号">
          <Num
            value={finite(defaultTextStyle.fontSizePt, 10.5)}
            min={8}
            max={72}
            step={0.5}
            suffix="pt"
            ariaLabel="默认字号"
            onChange={(v) => onDefaultTextStyle({ fontSizePt: v })}
          />
        </Field>
        <Field label="颜色">
          <ColorInput
            value={defaultTextStyle.color ?? '#1f2329'}
            swatches={TEXT_SWATCHES}
            ariaLabel="默认字色"
            onChange={(v) => onDefaultTextStyle({ color: v })}
          />
        </Field>
      </Section>

      <div className="bp-note">
        <p>没有选中元素时这里是页面属性。选中画布上的元素即可编辑它的样式与内容。</p>
      </div>
    </>
  )
}

// ============================================================
// 元素属性
// ============================================================

function ElementPanel(props: InspectorProps & { element: AnyElement; band: BandKey }) {
  const { element, band } = props
  const inCell = props.selectedInCell ?? null
  /*
   * ⚠️ **尺寸（mm）+ 锁比例**（2026-10-15 统一）。
   *
   * · `sz` = 当前实际尺寸（mm）与"可调上限"（= 内容区宽/高），由**模块级纯函数**
   *   `childSizeMm` 算 —— **附件面板（AttachAttrs）用的是同一个**，口径只此一处
   *   （这块已经因为"两处各写一份"翻车多次）。
   * · `lockRatio` 是**面板级偏好**（不进模板）：用户要的是"调一个、另一个跟着变"的手感。
   */
  const sz = childSizeMm(props.doc, inCell, element)
  /*
   * ⚠️ **"原图"模式下尺寸不由用户定**（2026-10-15 用户报："点击原图后，尺寸也没有自动恢复"）。
   * 附件看 `sizeMode === 'original'`；图片/二维码/条形码看 `fit === 'natural'`
   *   （等于 `h:'auto'`，按图片原始比例撑高）。
   * ⇒ 那时「尺寸」框**禁用**并给出说明 ——
   *   留一个"能改但没用"的输入框是最坏的做法（这几天的老坑）。
   */
  const isOriginalMode =
    element.kind === 'attach'
      ? element.config.sizeMode === 'original'
      : (element as { fit?: string }).fit === 'natural'
  const [lockRatio, setLockRatio] = useState(false)
  /** ⚠️ 写回"宽"：格内要**反算成百分比**（`w = mm ÷ 内容区宽 × 100`）并按内容区夹紧 */
  const setWMm = (v: number, key: string): void => {
    /*
     * ⚠️⚠️ **"改尺寸 ⇒ 归自由"必须和尺寸写进同一次 `onMerge`**（2026-10-15 修）。
     *
     * 原来写成两次调用（`setFreeMode(key)` + `onMerge(..., key)`）——
     * **同一个 `mergeKey` 写两次，前一次会被后一次覆盖** ⇒ `sizeMode` 根本没落库
     *   ⇒ 用户实测「**附件没有自动跳到自由**」（而图片不用写 `sizeMode`、靠 `h` 反推，
     *     所以它"看起来生效了" —— 这个差异正好指认了根因）。
     */
    const freePatch =
      element.kind === 'attach' && element.config.sizeMode !== 'fixedBox'
        ? { config: { ...element.config, sizeMode: 'fixedBox' as const } }
        : null
    if (inCell) {
      const pct = Math.max(MIN_CELL_CHILD_PCT, Math.min(100, (v / Math.max(1, sz.capW)) * 100))
      props.onMerge(element.id, { w: Math.round(pct * 10) / 10, ...freePatch }, key)
    } else {
      props.onMerge(element.id, { w: Math.round(v * 10) / 10, ...freePatch }, key)
    }
  }
  /** ⚠️ 写回"高"：格内按内容区高夹紧（用户要求"达到就不可再往上调整"）*/
  const setHMm = (v: number, key: string): void => {
    /*
     * ⚠️⚠️ **"改尺寸 ⇒ 归自由"必须和尺寸写进同一次 `onMerge`**（2026-10-15 修）。
     *
     * 原来写成两次调用（`setFreeMode(key)` + `onMerge(..., key)`）——
     * **同一个 `mergeKey` 写两次，前一次会被后一次覆盖** ⇒ `sizeMode` 根本没落库
     *   ⇒ 用户实测「**附件没有自动跳到自由**」（而图片不用写 `sizeMode`、靠 `h` 反推，
     *     所以它"看起来生效了" —— 这个差异正好指认了根因）。
     */
    const freePatch =
      element.kind === 'attach' && element.config.sizeMode !== 'fixedBox'
        ? { config: { ...element.config, sizeMode: 'fixedBox' as const } }
        : null
    const next = Math.max(1, Math.min(inCell ? sz.capH : 2000, v))
    props.onMerge(element.id, { h: Math.round(next * 10) / 10, ...freePatch }, key)
  }
  /** 格内元素的水平预设档位反查（给 Seg 高亮用）。反查而不是另存一份 —— 见 `cellPos` 的口径注释。 */
  const xPresetOf = (el: { w?: number | string; cellPos?: { xPct?: number } }): string => {
    const x = childOffsetXPct(el)
    const w = childWidthPct(el)
    if (x <= 0.5) return 'left'
    if (Math.abs(x - Math.max(0, (100 - w) / 2)) <= 0.5) return 'center'
    if (Math.abs(x - Math.max(0, 100 - w)) <= 0.5) return 'right'
    return ''
  }
  const grid = gridOptions(props.doc.pageSetup)
  /**
   * 数值输入的步长跟着网格走：吸附开着时，按一次上下箭头正好走一格，
   * 于是"用键盘微调"和"用鼠标拖"得到的是同一套坐标，不会互相打架。
   */
  const step = grid.snapToGrid ? grid.gridMm : 1
  return (
    <>
      <div className="bp-elbar">
        <span className="bp-elbar__name">{KIND_LABEL[element.kind]}</span>
        <button
          type="button"
          className="bp-iconbtn bp-iconbtn--danger"
          aria-label="删除该元素"
          title="删除（Delete）"
          onClick={() => props.onRemove(element.id)}
        >
          <IconTrash size={14} />
        </button>
      </div>

      {inCell ? (
        /*
         * ⚠️ **两个 `<Section>` 必须包在 Fragment 里**：JSX 的三元分支只允许**一个**根节点。
         *    这个分支原来是单一 `<Section>`（合法），加了「位置」之后就成了两个兄弟。
         * ⚠️ 报错极具误导性：`'(' expected`（指向一个看起来完全正常的位置），
         *    因为解析器以为 `? (` 里的表达式还没结束。
         */
        <>
        {/* 在格子里时，位置与尺寸**整套换掉**，不是禁用：禁用能让用户看出"为什么不能改"，
           但这里不是"不能改"，而是"可改的东西不一样"——格内元素的宽是百分比、没有 X/Y。
           摆一个灰掉的 mm 输入框反而在教他错的口径。
           ⚠️ 注释必须包在花括号里；这里已经是**子节点位置**，
              裸的块注释会被当**文本渲染**出来（用户截图报的就是这个）。
              ⚠️ 注释正文里也**不能出现**结束符号那两个字符，否则会提前闭合本注释。 */}
        <Section title="尺寸">
          {/*
            ⚠️ **统一的「宽 × 高（mm）+ 锁比例」**（2026-10-15 用户要求：尺寸区的第一行）。
            · **格内**：`w` 是"占内容区宽的百分比" ⇒ 这里**换算成 mm** 显示/输入，
              写回时**反算**（`w = mm ÷ 内容区宽 × 100`），并按内容区**夹紧**。
            · **顶层**：`w`/`h` 本来就是 mm，直接用。
            · **锁比例**：改一个、另一个按当前比例跟着变（面板级偏好，**不进模板**）。
            ⚠️ 用户口径：「调整的时候，如果是在单元格内，则需要考虑**是否超出单元格的边界**，
               **达到就不可再往上调整**」⇒ `max` 就是内容区宽/高。
            ⚠️ 换算逻辑走模块级纯函数 `childSizeMm` —— **附件面板用的是同一个**，不许各写一份。
          */}
          <Field
            label="尺寸"
            hint={
              isOriginalMode
                ? '「原图」模式：尺寸由图片本身决定，这个框不参与渲染'
                : '宽 × 高（mm）；锁上比例后，改一个另一个跟着变'
            }
          >
            <div className="bp-size-row">
              <Num
                value={sz.w}
                disabled={isOriginalMode}
                min={1}
                max={sz.capW}
                step={1}
                ariaLabel="元素宽度"
                onChange={(v) => {
                  const before = sz.w
                  setWMm(v, `cw:${element.id}`)
                  if (lockRatio && before > 0 && sz.h > 0) setHMm((sz.h * v) / before, `ch:${element.id}`)
                }}
              />
              <button
                type="button"
                className={`bp-lock${lockRatio ? ' is-on' : ''}`}
                aria-label={lockRatio ? '解锁比例' : '锁定比例'}
                title={lockRatio ? '已锁定比例' : '锁定宽高比例'}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setLockRatio((v) => !v)}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d={
                      lockRatio
                        ? 'M4 7V5a4 4 0 0 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z'
                        : 'M4 6a4 4 0 0 1 7.9-.7 1 1 0 1 1-2 .3A2 2 0 1 0 6 6v1h6.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4V6Z'
                    }
                    fill="currentColor"
                  />
                </svg>
              </button>
              <Num
                value={sz.h}
                disabled={isOriginalMode}
                min={1}
                max={sz.capH}
                step={1}
                ariaLabel="元素高度"
                onChange={(v) => {
                  const before = sz.h
                  setHMm(v, `ch:${element.id}`)
                  if (lockRatio && before > 0 && sz.w > 0) setWMm((sz.w * v) / before, `cw:${element.id}`)
                }}
              />
              <span className="bp-size-mm">mm</span>
            </div>
          </Field>
          <p className="bp-hint">
            格内元素跟着文字流排，位置由单元格决定；宽高都可以直接改（会自动换算成"占格宽"）。
          </p>
          {element.kind === 'qrcode' || element.kind === 'barcode' ? (
            <p className="bp-hint">码会<b>等比缩放</b>到你给的这个框里，不会拉伸或裁剪 —— 变形的二维码是扫不出来的。</p>
          ) : null}
        </Section>

        {/* ⚠️ **位置**（2026-10-13 用户需求：「可以手动拖动调整位置，也可以**预设位置**」）。
            ⚠️ 水平有 3 档预设（左/中/右 = 可算：右 = 100−占格宽、中 = (100−占格宽)/2）；
               垂直只给 mm 数值 —— 格子高度是**自适应**的（内容撑开），"垂直居中"没有分母。
               ⇒ 与其给一个会算错的按钮，不如只给数值（这是**如实告知**，不是功能缺失）。
            ⚠️ 三档与数值框写的是**同一个字段** `cellPos.xPct`：档位是快捷方式、数值是微调，一个真相源。 */}
        <Section title="位置">
          {/*
            ⚠️⚠️ **「对齐」补上**（2026-10-15 用户指出）：
              「当前**只有附件的侧边属性中有对齐的选项**，图片、二维码、条形码**没有对齐的选项，
               只有位置** —— 位置和对齐**都是左、中、右**，你看下是不是搞混了」。
            ⇒ 用户说得对，这**是两个字段**：
              · **位置** = `cellPos.xPct`（**直接写死**偏移量，拖动就是在改它）
              · **对齐** = `align`（**没有手动偏移时**决定落点；`childBoxLeftPct` 的第二参数）
            ⇒ 附件的「对齐」写的是 `config.align`；**图片/二维码/条形码的元素级 `align`
              在类型里早就有（`CellChildAlign`）、拖动也会自动写，但面板上一直没有入口**。
            ⚠️ 两者是**同一个视觉概念的两条路径**，所以并排放、标签都叫"左/中/右"（与附件一致）。
          */}
          <Field label="对齐" hint="未手动偏移时的落位方向（拖过位置后以位置为准）">
            <Seg
              value={
                (element.kind === 'attach'
                  ? element.config.align
                  : (element as { align?: 'left' | 'center' | 'right' }).align) ?? 'left'
              }
              ariaLabel="对齐方式"
              onChange={(v) => {
                const a = v as 'left' | 'center' | 'right'
                if (element.kind === 'attach') {
                  props.onMerge(element.id, { config: { ...element.config, align: a } }, `ca:${element.id}`)
                } else {
                  props.onMerge(element.id, { align: a } as unknown as Partial<AnyElement>, `ca:${element.id}`)
                }
              }}
              options={[
                { value: 'left', label: '左' },
                { value: 'center', label: '中' },
                { value: 'right', label: '右' },
              ]}
            />
          </Field>
          {/*
            ⚠️ **这个 Seg 原来是"裸的"（没有标签）** ⇒ 与上面的「对齐」**并排两组左中右**，
               用户完全分不清哪个是哪个（2026-10-15 用户报："对齐那里，有两组左中右，用户很难区分"）。
            ⇒ 包上 `Field` 给它一个明确的名字，并把两者的**语义差别**写进 hint：
               · 「对齐」= **默认落位方向**（**拖过位置之后它就失效了**）
               · 「快速摆位」= **一键写死位置**（直接改 `cellPos.xPct`，会盖过对齐）
          */}
          <Field
            label="快速摆位"
            hint="一键把元素摆到左/中/右；这是直接写死位置，会盖过上面的「对齐」"
          >
          <Seg
            value={xPresetOf(element)}
            ariaLabel="水平位置预设"
            onChange={(v) => {
              const w = childWidthPct(element)
              const xPct =
                v === 'left' ? 0 : v === 'right' ? Math.max(0, 100 - w) : Math.max(0, (100 - w) / 2)
              props.onMerge(element.id, { cellPos: { xPct, yMm: childOffsetYMm(element) } }, `cpos:${element.id}`)
            }}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
          />
          </Field>
          <div className="bp-grid2">
            {/*
              ⚠️⚠️ **"左偏移"改用 mm**（2026-10-15 用户提问："为什么左偏移和上偏移单位不一样"）。

              **为什么会不一样（如实说明）**：
                · `cellPos.xPct` 的原生单位是**百分比**（占内容区宽）—— 横向**有分母**（列宽已知）；
                · `cellPos.yMm` 的原生单位是 **mm** —— 纵向**可能没有分母**
                  （行高是自适应的，`heightMm` 缺席时由内容撑开，"占内容区高百分之几"算不出来）。
              ⇒ 这个不对称是**历史设计**，也**正是前几天"四边对齐"反复修不好的根源之一**
                （两根轴的单位不同 ⇒ 钳制/换算各写一套）。

              **本次改动**：**只在面板这一层统一成 mm**（模型不动 ⇒ 不影响已有模板与渲染）。
                `xMm = xPct% × 内容区宽`；写回时反算 `xPct = xMm ÷ 内容区宽 × 100`。
              ⚠️ 内容区宽来自 `sz.capW`（与「尺寸」区、拖动钳制、打印**同一个来源**）。
            */}
            <Field label="左偏移" hint="距内容区左边（mm），0 = 贴左">
              <Num
                value={Math.round((childOffsetXPct(element) / 100) * sz.capW * 10) / 10}
                min={0}
                /* ⚠️ 上限 = 内容区宽 − 元素宽（`x + w ≤ 内容区宽`）—— 与拖动、缩放的钳制**同一口径**。
                   ⚠️ 属性区里只能写普通块注释，**不能**写花括号注释（写在属性之间会语法错）。 */
                max={Math.max(0, Math.round((sz.capW - sz.w) * 10) / 10)}
                step={1}
                suffix="mm"
                ariaLabel="左偏移（mm）"
                onChange={(v) => {
                  const pct = sz.capW > 0 ? Math.max(0, Math.min(100, (v / sz.capW) * 100)) : 0
                  props.onMerge(
                    element.id,
                    { cellPos: { xPct: Math.round(pct * 10) / 10, yMm: childOffsetYMm(element) } },
                    `cposx:${element.id}`,
                  )
                }}
              />
            </Field>
            <Field label="上偏移" hint="mm，0 = 贴顶">
              <Num
                value={childOffsetYMm(element)}
                /* ⚠️ 下限 **0**（内容区顶部）：写 −10 会让元素跑进单元格内边距里、被外层的裁切切掉。
                   贴不紧上边框是**内边距**造成的 —— 那是单元格的正常留白，不是 bug。 */
                min={0}
                max={200}
                step={1}
                suffix="mm"
                ariaLabel="上偏移（毫米）"
                onChange={(v) =>
                  props.onMerge(element.id, { cellPos: { xPct: childOffsetXPct(element), yMm: v } }, `cposy:${element.id}`)
                }
              />
            </Field>
          </div>
        </Section>
        </>
      ) : (
        <>
          {/* 这个标签**不缩短**：已有的断言（editor-interaction 第 [1] 节）是靠面板可见文字里
              有没有「所属版式区」来判断"面板切到了元素属性层"的，改成「版式区」会把那条判据弄丢。
              它 5 个字放不进 56px 的标签列，就让它换两行 —— 换行不丢字，省略号才丢字。 */}
          <Field label="所属版式区">
            <Seg
              value={band}
              ariaLabel="所属版式区"
              onChange={(v) => props.onSetBand(element.id, v)}
              options={[
                { value: 'header', label: '表头区', title: BAND_HINT.header },
                { value: 'loop', label: '循环区', title: BAND_HINT.loop },
                { value: 'footer', label: '表尾区', title: BAND_HINT.footer },
              ]}
            />
          </Field>

          <Section title="位置与尺寸">
            <div className="bp-grid2">
              <Field label="X">
                <Num value={finite(element.x, 0)} min={0} max={Math.max(0, props.layout.contentWMm)} step={step} suffix="mm" ariaLabel="水平位置" onChange={(v) => props.onMerge(element.id, { x: v }, `posx:${element.id}`)} />
              </Field>
              <Field label="Y">
                <Num value={finite(element.y, 0)} min={0} max={Math.max(0, props.layout.contentHMm)} step={step} suffix="mm" ariaLabel="垂直位置" onChange={(v) => props.onMerge(element.id, { y: v }, `posy:${element.id}`)} />
              </Field>
              <Field label="宽">
                <Num value={finite(element.w, 20)} min={4} max={Math.max(4, props.layout.contentWMm * 2)} step={step} suffix="mm" ariaLabel="宽度" onChange={(v) => props.onMerge(element.id, { w: v }, `w:${element.id}`)} />
              </Field>
              <Field label="高">
                <Num
                  value={element.h === 'auto' ? round1(elementHeightMm(element)) : finite(element.h, 20)}
                  min={1}
                  max={800}
                  step={step}
                  suffix="mm"
                  ariaLabel="高度"
                  onChange={(v) => props.onMerge(element.id, { h: v }, `h:${element.id}`)}
                />
              </Field>
            </div>
            <Field label="高度模式" hint="自动 = 高度由内容测量决定（循环区内有效）；固定 = 用手填的值">
              <Seg
                value={element.h === 'auto' ? 'auto' : 'fixed'}
                ariaLabel="高度模式"
                onChange={(v) =>
                  // 切回固定值时用当前估算高度打底，而不是硬塞一个 20 —— 否则一切换高度就跳一下
                  props.onMerge(element.id, { h: v === 'auto' ? 'auto' : round1(elementHeightMm(element)) }, `hmode:${element.id}`)
                }
                options={[
                  { value: 'fixed', label: '固定值' },
                  { value: 'auto', label: '自动' },
                ]}
              />
            </Field>
            <p className="bp-hint">输入框上下箭头按网格 {grid.gridMm}mm 步进{grid.snapToGrid ? '' : '（当前已关闭吸附）'}。</p>
          </Section>
        </>
      )}

      {element.kind === 'text' ? <TextAttrs {...props} element={element} /> : null}
      {element.kind === 'table' ? <TableAttrs {...props} element={element} /> : null}
      {element.kind === 'attach' ? <AttachAttrs {...props} element={element} /> : null}
      {element.kind === 'fieldBlock' ? <FieldBlockAttrs {...props} element={element} /> : null}
      {element.kind === 'image' ? <ImageAttrs {...props} element={element} /> : null}
      {element.kind === 'hline' ? <HLineAttrs {...props} element={element} /> : null}
      {element.kind === 'qrcode' || element.kind === 'barcode' ? <CodeAttrs {...props} element={element} /> : null}
      {element.kind === 'pagebreak' ? (
        <p className="bp-hint">分页符不可编辑内容与尺寸，导出时会在该位置强制另起一页。</p>
      ) : null}
    </>
  )
}

const KIND_LABEL: Record<AnyElement['kind'], string> = {
  text: '文本段落',
  table: '表格',
  image: '固定图片',
  attach: '附件字段块',
  fieldBlock: '字段块',
  hline: '水平线',
  pagebreak: '分页符',
  qrcode: '二维码',
  barcode: '条形码',
}

// ---- 文本 ----

function TextAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'text' }> }) {
  const { element } = props
  const s = element.style ?? {}
  const text = useMemo(() => nodesToText(element.nodes), [element.nodes])
  // 文本输入走 800ms 合并（F2-04）：连着敲字只产生一步撤销
  const mergeKey = `text:${element.id}`

  /**
   * ⚠️⚠️ **整体修改 ⇒ 覆盖子节点样式**（2026-10-17 用户选 B，与 `patchCellStyle` 同一条纪律）：
   *   「整体修改单元格内的字体、样式、大小等属性时，**直接覆盖子节点的所有样式**，
   *     此时再点击单个字段进行样式的修改，**依旧正常生效**，**后面的修改总是覆盖前面的**」。
   *
   * 用户实测反馈（选 B 之后仍有问题）：「我给格内某一个字段加粗，再选中单元格对所有元素加粗
   *   —— 生效；**再取消加粗，最开始那个字段还是粗的**；字号同理」。
   * ⇒ 说明**元素级这条**（`patchStyle`）也必须清 —— 它同样"作用于整个元素"。
   * ⚠️ 只有带 `nodes` 的元素（文本/表格）才需要清；其它 kind 原样走。
   */
  const patchStyle = (patch: TextStyle, key?: string): void => {
    const src = (element as { nodes?: InlineNode[] }).nodes
    /* ⚠️ **唯一实现**：`clearNodeStyles`（2026-10-17 收敛，别再各自抄一遍） */
    const nodes = Array.isArray(src) ? clearNodeStyles(src) : null
    props.onMerge(
      element.id,
      { style: { ...s, ...patch }, ...(nodes ? { nodes } : null) },
      key,
    )
  }

  return (
    <>
      <Section title="内容">
        <textarea
          className="bp-textarea"
          value={text}
          rows={3}
          aria-label="文本内容"
          placeholder="输入文字；${字段名} 会变成字段占位符"
          onChange={(e) => props.onMerge(element.id, { nodes: textToNodes(e.target.value, props.fields, element.nodes) }, mergeKey)}
        />
        {/* 文本里出现反斜杠转义时才解释一句：否则用户会以为是自己手滑打错了。
            提示文案必须用字符串字面量包住——JSX 文本里的 `{` 会被当成表达式容器。 */}
        {(text.includes('\\${') || text.includes('\\【')) && (
          <p className="bp-hint">
            {'带反斜杠的 \\${…} 与 \\【…】 表示按普通文字原样输出（Word 导入时选了「忽略」的占位符、正文里本就写着的「【页码】」字样都会变成这样）；删掉反斜杠即可重新变回活的字段占位符 / 系统变量。'}
          </p>
        )}
        <Field label="插入占位符">
          <FieldPicker
            value={null}
            options={fieldOptions(props.fields)}
            ariaLabel="插入字段占位符"
            allowEmpty={false}
            onChange={(id, name) => {
              if (!id) return
              props.onMerge(element.id, { nodes: [...element.nodes, { type: 'field', fieldId: id, fieldName: name }] })
            }}
          />
        </Field>
      </Section>

      <Section title="字体">
        <Field label="字体">
          <CapsuleSelect value={s.fontFamily ?? 'system'} options={FONT_OPTIONS} onChange={(v) => patchStyle({ fontFamily: v })} ariaLabel="字体" />
        </Field>
        <div className="bp-grid2">
          <Field label="字号">
            <Num value={finite(s.fontSizePt, 10.5)} min={8} max={72} step={0.5} suffix="pt" ariaLabel="字号" onChange={(v) => patchStyle({ fontSizePt: v }, `fs:${element.id}`)} />
          </Field>
          <Field label="行距">
            <Num value={finite(s.lineHeight, 1.5)} min={1} max={3} step={0.05} suffix="倍" ariaLabel="倍数行距" onChange={(v) => patchStyle({ lineHeight: v, lineHeightPt: undefined }, `lh:${element.id}`)} />
          </Field>
          <Field label="固定行距">
            <Num value={finite(s.lineHeightPt, 0)} min={0} max={80} step={0.5} suffix="pt" ariaLabel="固定行距" onChange={(v) => patchStyle(v > 0 ? { lineHeightPt: v } : { lineHeightPt: undefined }, `lhp:${element.id}`)} />
          </Field>
          <Field label="首行缩进" hint="字距缩进（首行）">
            <Num value={finite(s.indentFirstLineMm, 0)} min={0} max={40} step={1} suffix="mm" ariaLabel="首行缩进" onChange={(v) => patchStyle({ indentFirstLineMm: v }, `ind:${element.id}`)} />
          </Field>
          <Field label="段前">
            <Num value={finite(s.spaceBeforePt, 0)} min={0} max={60} step={0.5} suffix="pt" ariaLabel="段前间距" onChange={(v) => patchStyle({ spaceBeforePt: v }, `sb:${element.id}`)} />
          </Field>
          <Field label="段后">
            <Num value={finite(s.spaceAfterPt, 0)} min={0} max={60} step={0.5} suffix="pt" ariaLabel="段后间距" onChange={(v) => patchStyle({ spaceAfterPt: v }, `sa:${element.id}`)} />
          </Field>
        </div>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="字形">
            <button type="button" className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`} aria-pressed={!!s.bold} onClick={() => patchStyle({ bold: !s.bold })} title="加粗">
              B
            </button>
            <button type="button" className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`} aria-pressed={!!s.italic} onClick={() => patchStyle({ italic: !s.italic })} title="斜体">
              I
            </button>
            <button type="button" className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`} aria-pressed={!!s.underline} onClick={() => patchStyle(underlineSolidToggle(s))} title="下划线">
              U
            </button>
            <button type="button" className={`bp-tgl bp-tgl--strike${s.strike ? ' is-on' : ''}`} aria-pressed={!!s.strike} onClick={() => patchStyle({ strike: !s.strike })} title="删除线">
              S
            </button>
            <UnderlineDashBtn style={s} onToggle={() => patchStyle(underlineDashToggle(s))} />
          </div>
        </Field>
        <Field label="字色">
          <ColorInput value={s.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="字体颜色" onChange={(v) => patchStyle({ color: v })} />
        </Field>
        <Field label="底纹">
          <ColorInput value={s.background ?? '#ffffff'} ariaLabel="背景色" onChange={(v) => patchStyle({ background: v })} />
        </Field>
        <Field label="对齐">
          <Seg
            value={(s.align ?? 'left') as Align}
            ariaLabel="水平对齐"
            onChange={(v) => patchStyle({ align: v })}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
              { value: 'justify', label: '两端' },
            ]}
          />
        </Field>
        <Field label="垂直对齐">
          <Seg
            value={(s.vAlign ?? 'top') as 'top' | 'middle' | 'bottom'}
            ariaLabel="垂直对齐"
            onChange={(v) => patchStyle({ vAlign: v })}
            options={[
              { value: 'top', label: '顶' },
              { value: 'middle', label: '中' },
              { value: 'bottom', label: '底' },
            ]}
          />
        </Field>
      </Section>
    </>
  )
}

// ---- 表格 ----

function TableAttrs(props: InspectorProps & { element: TableElement }) {
  const { element } = props
  const cols = element.colWidthsMm.length
  /**
   * 有没有"标题行 / 标题列"。
   *
   * 第 8 条（2026-09-23）：「增加一个功能，设置了标题行或者列后，允许设置标题行或列跨页重新打印……
   * 该功能仅在设置了标题行或者列后才可以勾选」。渲染层的 `tableRepeatHeader`（`render/html.ts`）
   * 内部本来就有 `hasHeader && repeatHeader !== false` 这条闸门，这里只是让 **UI 也如实反映**它 ——
   * 不然就是一个"勾了但打印出来没变化"的控件。
   */
  const hasHeaderAxis = element.rows[0]?.isHeader === true || element.headerCol === true

  /*
   * 「多条记录排进同一张表」的判据必须与渲染层（`render/pipeline.ts` 的 `mergedLoopTableOf`）
   * 是**同一把尺子**。
   *
   * ⚠️ 2026-09-23 第二次反馈第 7 条**砍掉了"循环区恰好一个元素"这条限制**。
   * 那条限制的后果很隐蔽：表格下方一放东西，开关就变灰，用户既改不了、也看不出为什么，
   * 于是把现象归因成「标题行没起作用」（他原话是"不论是否设置了标题行，只要表格下方无元素
   * 就是台账、有元素就是一份份"—— 其实跟标题行毫无关系）。
   *
   * 现在只剩两条：**这张表在循环区里** + 循环区里**没有第二张也开了该选项的表**。
   */
  const loopEls = props.doc.bands.loop?.elements ?? []
  const inLoop = loopEls.some((el) => el.id === element.id)
  const otherDeclared = loopEls.some(
    (el) => el.id !== element.id && el.kind === 'table' && el.rowsFromRecords === true,
  )
  const rowsFromRecordsOk = inLoop && !otherDeclared
  const rowsFromRecordsWhy = inLoop
    ? '循环区里已经有另一张表格开启了这一项 —— 两张表同时按记录铺行，无法确定先后'
    : '这张表不在循环区里，多记录铺行只在循环区生效'

  // ---- 结构动作：一律**薄转发**到 `./table-actions`（纯函数层）----
  // 为什么不再留在这里：顶栏的表格工具条是本组件的**兄弟**，够不到这里的闭包。
  // 不先提升，工具条那边顺手就会再写一套 —— 这个项目在"同一个逻辑两处各写一套"
  // 上已经栽过三次。动作层返回 `null` 的语义是"这一下不该发生"，与按钮禁用同一把尺子。
  const addRow = (): void => {
    props.onMerge(element.id, addRowPatch(element).patch)
  }
  const delRow = (): void => {
    const r = delRowPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }
  const addCol = (): void => {
    const r = addColPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }
  const delCol = (): void => {
    const r = delColPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }

  const setColWidth = (i: number, v: number): void => {
    const p = setColWidthPatch(element, i, v)
    if (p) props.onMerge(element.id, p, `colw:${element.id}:${i}`)
  }

  const totalColW = element.colWidthsMm.reduce((a, b) => a + b, 0)
  const overflow = totalColW > props.layout.contentWMm + 0.5

  return (
    <>
      {/*
        ⚠️ **面板重排（2026-10-19 用户：「有些功能不够直观且混乱」）**。
        原顺序是「结构（含表头/连续打印）→ 单元格 → 边框 → 列宽与行高」，
        问题有三个：
          ① 行高列宽在最后一节，离"增删行列"隔了两屏，而它们明明是同一件事；
          ② "表头行 / 表头重复 / 连续打印" 三个开关和一段 5 行的说明挤在一起；
          ③ 表格的「高度模式：自动」与行高的「填 0 = 自适应」两套说法并存，容易混。
        ⇒ 按"用户改这张表时会想什么"重排：
           行与列（结构与尺寸在一起）→ 表头 → 多记录连续打印 → 单元格 → 边框。
      */}
      <Section title="行与列">
        {overflow ? (
          <p className="bp-alert bp-alert--warn">
            <IconWarning size={13} /> 列宽合计 {round1(totalColW)}mm 超过版心 {round1(props.layout.contentWMm)}mm，打印时将按比例压缩
          </p>
        ) : null}
        <div className="bp-btnrow" role="group" aria-label="行列增删">
          <button type="button" className="bp-minibtn" onClick={addRow} aria-label="增加一行">
            <IconPlus size={13} /> 行
          </button>
          <button type="button" className="bp-minibtn" onClick={delRow} disabled={element.rows.length <= 1} aria-label="减少一行">
            <IconMinus size={13} /> 行
          </button>
          <button type="button" className="bp-minibtn" onClick={addCol} disabled={cols >= 12} aria-label="增加一列">
            <IconPlus size={13} /> 列
          </button>
          <button type="button" className="bp-minibtn" onClick={delCol} disabled={cols <= 1} aria-label="减少一列">
            <IconMinus size={13} /> 列
          </button>
        </div>
        <p className="bp-hint">
          当前 {element.rows.length} 行 × {cols} 列
        </p>

        <p className="bp-subhead">列宽</p>
        <div className="bp-grid2">
          {element.colWidthsMm.map((cw, i) => (
            <Field key={i} label={`第 ${i + 1} 列`}>
              <Num
                value={cw}
                /* 下限只有 1mm —— 列变窄时元素按占格宽百分比自动跟着变窄 */
                min={MIN_COL_MM}
                max={400}
                step={1}
                suffix="mm"
                ariaLabel={`第 ${i + 1} 列宽`}
                onChange={(v) => setColWidth(i, v)}
              />
            </Field>
          ))}
        </div>

        <p className="bp-subhead">行高</p>
        <div className="bp-grid2">
          {element.rows.map((r, i) => (
            <Field key={r.id} label={`第 ${i + 1} 行`}>
              <Num
                value={finite(r.heightMm, 0)}
                /* 下限只有 1mm；0 仍然显示为"自动"。装不下时元素等比缩小 */
                min={MIN_ROW_MM}
                max={300}
                step={1}
                suffix="mm"
                ariaLabel={`第 ${i + 1} 行高`}
                onChange={(v) =>
                  props.onMerge(
                    element.id,
                    { rows: element.rows.map((row, ri) => (ri === i ? { ...row, heightMm: v > 0 ? v : undefined } : row)) },
                    `rh:${element.id}:${i}`,
                  )
                }
              />
            </Field>
          ))}
        </div>
        {/*
          ⚠️ 这两条是**同一件事**的两个说法，必须放在一起讲清楚（原来分散在两节里）：
            · 行高的绝对下限是 1mm（不再有"拖到 0 变自适应"那种读数骗人的行为）；
            · "按内容自适应"的入口是**双击那一行的下边框**（`onRowBorderReset`），
              以及把行高值清成 0 再失焦。
        */}
        <p className="bp-hint">
          最小 1mm。行高装不下格内元素时，元素会跟着等比缩小。想回到「按内容自适应」，双击那一行的下边框。
        </p>
      </Section>

      <Section title="表头">
        <Field label="表头行" hint="首行作为表头：加粗居中，打印时每页重复">
          <Switch
            checked={!!element.rows[0]?.isHeader}
            ariaLabel="首行作为表头"
            onChange={(v) =>
              props.onMerge(element.id, { rows: element.rows.map((r, i) => (i === 0 ? { ...r, isHeader: v } : r)) })
            }
          />
        </Field>
        <Field label="表头重复" hint="表头行每页重复打印（需要先打开「表头行」或「表头列」）">
          <Switch
            checked={!!element.repeatHeader}
            ariaLabel="表头每页重复"
            disabled={!hasHeaderAxis}
            onChange={(v) => props.onMerge(element.id, { repeatHeader: v })}
          />
        </Field>
      </Section>

      <Section title="多记录连续打印">
        <Field label="连续打印" hint="多条记录排进同一张表：各条记录各占一行、表头只出一次">
          <Switch
            checked={!!element.rowsFromRecords}
            ariaLabel="连续打印"
            disabled={!rowsFromRecordsOk}
            onChange={(v) => props.onMerge(element.id, { rowsFromRecords: v })}
          />
        </Field>
        {rowsFromRecordsOk ? (
          /* ⚠️ 长说明收进 `<details>`：原来它是常显的 5 行正文，把整块面板顶得很高 */
          <details className="bp-detail">
            <summary>这个开关具体怎么工作</summary>
            <p className="bp-hint">
              各条记录各占一行、表头只出一次。导出时按记录铺开；画布上仍按模板原样显示。
              {loopEls.length > 1
                ? '⚠️ 循环区里表格之外的其它元素只会按第一条记录渲染一次（排在表格下方）；想让它们每条记录都重复，请把那些元素移到「表尾区」。'
                : ''}
            </p>
          </details>
        ) : (
          <p className="bp-hint">开关不生效：{rowsFromRecordsWhy}</p>
        )}
      </Section>

      <Section title="单元格">
        {/*
          ⚠️ 这段是**用户点名要的说明**（2026-10-19）：
          「提示用户[内边距]作用于该表的所有单元格，如果需要改动某个单元格的内边距，
            让用户点击某个单元格后，在右侧属性的单元格样式中修改」。
          措辞按"先说我管什么、再说想单独改去哪"的顺序 —— 比原来那句罗列型的说明更好用。
        */}
        <p className="bp-hint">
          下面的「内边距」作用于<strong>整张表的所有单元格</strong>。
          只想改某一格：在画布上点它 → 右侧面板会切到「单元格样式」→ 在那里改内边距
          （它会覆盖表格的这个默认值；之后你再改表格的内边距，该格会被重新覆盖）。
        </p>
        <Field
          label="内边距"
          hint="作用于整张表；改了之后会**覆盖**所有单元格各自设过的内边距（谁后设谁赢）"
        >
          <Num
            value={finite(element.cellPaddingMm, 1.5)}
            min={0}
            max={12}
            step={0.5}
            suffix="mm"
            ariaLabel="表格默认单元格内边距"
            /* ⚠️ 走 `setTablePaddingPatch`：写整表值 + **清掉所有单元格的覆写** */
            onChange={(v) => props.onMerge(element.id, setTablePaddingPatch(element, v), `cpad:${element.id}`)}
          />
        </Field>
      </Section>

      <Section title="边框">
        <Field label="框线">
          <Seg
            value={element.border.mode}
            ariaLabel="表格边框模式"
            onChange={(v) => props.onMerge(element.id, { border: { ...element.border, mode: v } })}
            options={[
              { value: 'none', label: '无' },
              { value: 'all', label: '全框线' },
              { value: 'outer', label: '仅外框' },
              { value: 'horizontal', label: '仅横线' },
            ]}
          />
        </Field>
        {/* 线宽与线色**不并排**：排成两列时每个控件只剩 ~58px，
            10 个色块（需要 ~167px）会被挤成一竖条 —— 用户原话是"线色的色板挤成一竖条、
            与线宽不在一个视觉行上"。改成各自占一行后，色板一行放得下全部 10 个。 */}
        <Field label="线宽">
          <Num
            value={finite(element.border.widthPt, 0.75)}
            min={0.25}
            max={3}
            step={0.25}
            suffix="pt"
            ariaLabel="框线宽度"
            onChange={(v) => props.onMerge(element.id, { border: { ...element.border, widthPt: v } }, `bw:${element.id}`)}
          />
        </Field>
        <Field label="线色">
          <ColorInput value={element.border.color} ariaLabel="框线颜色" onChange={(v) => props.onMerge(element.id, { border: { ...element.border, color: v } })} />
        </Field>
      </Section>
    </>
  )
}

// ---- 单元格（表格的第二级） ----
//
// 为什么要有这一级：用户点进表格里的某个格子时，他要改的是"这个格子"——
// 内容、这个格子里的字段、这个格子的内边距。此时还把行列增删 / 列宽 / 表头行全摊在面板上，
// 就是他反馈的"点字段还是显示表格属性"。整表面板仍然完整保留，靠面包屑 / Esc 回去。

/**
 * ⚠️ **格内元素 / 顶层元素的"实际尺寸（mm）"与"可调上限"**（2026-10-15 三模式重构）。
 *
 * 为什么要有这个纯函数：
 *  · **格内**的 `w` 是"**占内容区宽的百分比**" ⇒ 想在面板上显示/输入 mm，
 *    必须**先拿到这一格的"内容区宽"**；而面板只拿到 `{tableId, cellId}`。
 *    ⇒ 这里**遍历 doc 找 table**，再用 `cellWidthMm()`（**画布/打印共用同一个函数**）。
 *  · **顶层**的 `w`/`h` 本来就是 mm，直接用。
 *  · **上限**（用户要求："达到就不可再往上调整"）= 内容区宽/高（格内）或 2000（顶层）。
 *  · ⚠️ 内容区 = `尺寸 − 2×内边距`（实测 `box-sizing: border-box`）。
 *
 * ⚠️ 抽成纯函数、**不写进任一组件** —— 附件面板（`AttachAttrs`）和格内元素面板
 *   （`ElementPanel`）都要用同一套口径（这一块已经因为"两处各写一份"翻车多次）。
 */
function childSizeMm(
  doc: TemplateDoc,
  inCell: { tableId: string; cellId: string } | null,
  element: { w?: number | string; h?: number | string; cellPos?: { yMm?: number } },
): { w: number; h: number; capW: number; capH: number } {
  /* ⚠️ `w` 的模型类型是 `number | string`（旧模板里可能存成字符串）⇒ 先归一 */
  const wNum = typeof element.w === 'number' ? element.w : Number(element.w) || 0
  if (!inCell) {
    return {
      w: round1(wNum),
      h: round1(childHeightMm(element as never) ?? 0),
      capW: 2000,
      capH: 2000,
    }
  }
  const lists = [doc.bands.header, doc.bands.loop.elements, doc.bands.footer]
  for (const list of lists) {
    for (const el of list) {
      if (el.kind !== 'table') continue
      const row = el.rows.find((r) => r.cells.some((c) => c.id === inCell.cellId))
      if (!row) continue
      const cell = row.cells.find((c) => c.id === inCell.cellId)
      const padMm = finite(cell?.paddingMm, finite(el.cellPaddingMm, 1.5))
      const cw = Math.max(1, cellWidthMm(el, inCell.cellId) - 2 * padMm)
      const ch = typeof row.heightMm === 'number' && row.heightMm > 0 ? row.heightMm - 2 * padMm : 2000
      return {
        w: round1((childWidthPct(element as never) / 100) * cw),
        h: round1(childHeightMm(element as never) ?? 0),
        capW: round1(cw),
        capH: round1(ch),
      }
    }
  }
  return { w: 0, h: 0, capW: 2000, capH: 2000 }
}

function CellPanel(props: InspectorProps & { element: TableElement; band: BandKey }) {
  const { element } = props
  /**
   * ⚠️ **正在拖的是第几个字段**（2026-10-17 用户要求："已插入字段可以拖动排序"）。
   * ⚠️ 必须放在下面的 `if (!loc) return` **之前** —— Hook 不能条件调用。
   */
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  /** ⚠️ **拖动经过的是第几行**（"预落点"提示用，见下方注释） */
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const loc = findCell(element.rows, props.selectedCellId)

  // 选中的单元格可能刚被"合并/减少一列"吃掉了：这种情况退回整表面板，
  // 而不是让面板停在一个已经不存在的对象上（会渲染出一堆 undefined）
  if (!loc) return <ElementPanel {...props} element={element} band={props.band} />

  const cell = loc.cell
  const text = nodesToText(cell.nodes)
  const backToTable = (): void => props.onSelectCell(element.id, null)
  const patchCell = (patch: Partial<TableCell>, key?: string): void =>
    props.onMerge(element.id, { rows: updateCell(element.rows, cell.id, patch) }, key)

  /** 单元格里的字段占位符。（增删改都在这一个列表里完成） */
  const fieldNodes = cell.nodes
    .map((n, idx) => ({ n, idx }))
    .filter((x): x is { n: Extract<InlineNode, { type: 'field' }>; idx: number } => x.n.type === 'field')

  const replaceNode = (idx: number, next: InlineNode): void =>
    patchCell({ nodes: cell.nodes.map((n, i) => (i === idx ? next : n)) })

  /**
   * 合并 / 拆分**一律薄转发**到 `./table-actions`（纯函数层），本组件不再自己算。
   *
   * 三个理由：
   *   ① 顶栏的表格工具条也要合并 / 拆分，而它是本组件的**兄弟** —— 动作留在闭包里
   *      就只剩"再写一套"一条路（这个项目在"同一逻辑两处各写一套"上栽过三次）；
   *   ② 确认层要**结构上绕不过去**：`applyMergeRight/Down` 强制接收 `decide`，
   *      被并掉的那一格非空时不问过它就不产生补丁 —— 不是靠调用方"记得问"；
   *   ③ 判据因此能进 Node 套件（`table-actions` 只依赖类型与纯函数）。
   *
   * `decide` 返回 false 的语义是"这一下先别做，等用户在确认层点头"；
   * 攒住这次操作的 `pending` 已经提升到 `EditorShell`（见 `MergeConfirm.tsx`）。
   */
  const mergeRight = (): void => props.onAskMerge(element.id, cell.id, 'right')
  const mergeDown = (): void => props.onAskMerge(element.id, cell.id, 'down')
  const splitCell = (): void => {
    const r = applySplitCell(element, cell.id)
    if (r) props.onMerge(element.id, r.patch)
  }

  const cs = cell.style ?? {}
  /*
   * ⚠️ **行高 / 列宽 的当前值**（2026-10-17 面板内直接输入用）。
   * ⚠️ 列号必须从 `tableGrid` 取 `colStart` —— 数组下标 ≠ 网格列号（跨列合并会错位）。
   * ⚠️ 行高可能是 `undefined`（自适应）⇒ 用 `null` 表示"没设过"，`Num` 里显示 0。
   */
  const gridRow = tableGrid(element.rows, element.colWidthsMm.length)[loc.rowIdx] ?? []
  const colStart = gridRow.find((x) => x?.cell.id === cell.id)?.colStart ?? 0
  const rowHeightMm =
    typeof element.rows[loc.rowIdx]?.heightMm === 'number' ? (element.rows[loc.rowIdx]?.heightMm as number) : null
  const colWidthMm = typeof element.colWidthsMm[colStart] === 'number' ? element.colWidthsMm[colStart] : null
  /**
   * ⚠️⚠️ **整体修改 ⇒ 覆盖子节点的所有样式**（2026-10-17 用户选 B：
   *   「整体修改单元格内的字体、样式、大小等属性时，**直接覆盖子节点的所有样式**，
   *     此时再点击单个字段进行样式的修改，**依旧正常生效**，**后面的修改总是覆盖前面的**」）。
   *
   * 语义：这一格是"**整体刷子**"—— 改一次就把格内所有行内字段/文字统一成新样式
   *   （清掉它们各自的 `style` 覆写）。
   *   · 之后**单独点某个字段**改样式 ⇒ 写在**那个节点**的 `style` 上 ⇒ 依旧生效；
   *   · 再次"整体改" ⇒ **又全部覆盖** ⇒ 符合"后面的覆盖前面的"。
   * ⚠️ 只动 `nodes`（行内字段/系统变量/文字片段），**不动 `children`**
   *   （图片/附件/码有自己的面板，且它们的"字体样式"语义不同）。
   * ⚠️ `br` 没有 style 字段，原样保留（否则类型上会多一个 `style: undefined`）。
   */
  const patchCellStyle = (patch: TextStyle, key?: string): void => {
    const cur = cell.nodes ?? []
    /* ⚠️ **唯一实现**：`clearNodeStyles`（2026-10-17 收敛） */
    const nodes = clearNodeStyles(cur)
    /*
     * ⚠️⚠️ **无条件把 `nodes` 带上**（2026-10-17 第二轮修）。
     *
     * 第一版写的是 `...(nodesChanged ? { nodes } : null)` —— 看着更"省"，
     * 但用户实测**整体改样式时子节点的覆写根本没被清**（"该字段不受任何影响"）。
     * 这里不去赌"判断为什么算错"：**总是写一份 `nodes`** 是最确定的。
     *   · 没有任何节点带 `style` 时，`nodes` 与原数组**内容相同** ⇒ 多一次"同值写入"，无害；
     *   · 有覆写时 ⇒ 一定被清掉。
     * ⚠️ 参照 `applyNodeStyle` 那条"别为了省一次写而让行为不确定"的教训。
     */
    patchCell({ style: { ...cs, ...patch }, nodes }, key)
  }
  const canSplit = canSplitCell(element, cell.id)

  return (
    <>
      <div className="bp-elbar">
        <div className="bp-crumb">
          <button type="button" className="bp-crumb__link" title="返回整张表格（Esc）" onClick={backToTable}>
            {KIND_LABEL.table}
          </button>
          <span className="bp-crumb__sep" aria-hidden>
            ›
          </span>
          <span className="bp-crumb__cur">{cellLabel(loc)}</span>
        </div>
        <button
          type="button"
          className="bp-iconbtn"
          aria-label="返回整表"
          title="返回整表（Esc）"
          onClick={backToTable}
        >
          <IconBack size={14} />
        </button>
      </div>

      <Field label="所在单元格" hint="内容与字段都是这一格的，不会影响别的单元格">
        <span className="bp-hint">{cellLabel(loc)} · 跨 {Math.max(1, finite(cell.colspan, 1))} 列 / 跨 {Math.max(1, finite(cell.rowspan, 1))} 行</span>
      </Field>

      <Section title="单元格内容">
        <textarea
          className="bp-textarea"
          value={text}
          rows={3}
          aria-label="单元格内容"
          placeholder="输入文字；${字段名} 会变成字段占位符"
          onChange={(e) => patchCell({ nodes: textToNodes(e.target.value, props.fields, cell.nodes) }, `celltext:${cell.id}`)}
        />


        {/*
         * ⚠️ **"已插入的字段"合并进本节**（2026-10-17 用户要求：两处都能加字段，看着重复）。
         *   上面是文本框（改整段文字）、这里是"逐字段改绑/清除" —— 同一件事的两个粒度。
         */}
        {/*
         * ⚠️ **"已插入的字段" + 右侧 `+`**（2026-10-17 用户要求：
         *   「能不能把 `+` 图标放在 "已插入字段" 后面」）。
         *   `+` 用 `margin-left:auto` 贴右，行高与标题一致。
         */}
        <div className="bp-fieldlist__head">
          <span className="bp-hint">已插入的字段（可拖动排序、逐个改绑或清除）：</span>
          <button
            type="button"
            className="bp-fieldlist__add"
            aria-label="在末尾插入一个字段"
            title="在末尾插入一个字段（再自己选具体字段）"
            onClick={() =>
              patchCell({
                nodes: [...cell.nodes, { type: 'field', fieldId: null, fieldName: '未绑定字段' }],
              })
            }
          >
            +
          </button>
        </div>
        {fieldNodes.length === 0 ? (
          <p className="bp-hint">
            这一格还没有字段占位符。上面「插入占位符」可以把字段放进来（打印时按每条记录取不同的值）。
          </p>
        ) : (
          fieldNodes.map(({ n, idx }) => (
            <div
              className={`bp-fieldref${dragIdx === idx ? ' is-dragging' : ''}${
                overIdx === idx && dragIdx !== null && dragIdx !== idx ? ' is-over' : ''
              }`}
              key={`${n.fieldName}:${idx}`}
              /*
               * ⚠️ **拖动换位**（2026-10-17）：拖起记下标，放下时把节点 `splice` 到目标位置。
               *   `onDragOver` 必须 `preventDefault` —— 否则浏览器认定"这里不能放"。
               *   `draggable` 放在整行上（不是手柄）：行高足够，拖起来够稳。
               */
              draggable
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(ev) => {
                ev.preventDefault()
                /* ⚠️ 记录"预落点"：拖动经过哪一行，就把它标成"松手会插在它上面" */
                if (overIdx !== idx) setOverIdx(idx)
              }}
              onDragLeave={() => setOverIdx((v) => (v === idx ? null : v))}
              onDrop={() => {
                if (dragIdx === null || dragIdx === idx) return
                const arr = cell.nodes.slice()
                const [moved] = arr.splice(dragIdx, 1)
                if (!moved) return
                arr.splice(idx, 0, moved)
                patchCell({ nodes: arr })
                setDragIdx(null)
                setOverIdx(null)
              }}
              onDragEnd={() => {
                setDragIdx(null)
                setOverIdx(null)
              }}
              title="按住可拖动，调整字段在单元格里的先后顺序"
            >
              {/*
               * ⚠️ **可拖图示**（2026-10-17 用户要求："字段前面加个类似 = 的图标，让用户知道可以拖动"）。
               *   用六点 `⠿`（U+283F）—— 这是"可拖动列表项"的通用符号，比 `=` 更不容易被读成"等号"。
               *   ⚠️ `aria-hidden`：它是纯视觉提示，读屏时由父级的 title 说明"按住可拖动"。
               */}
              <span className="bp-fieldref__grip" aria-hidden>
                ⠿
              </span>
              <div className="bp-fieldref__pick">
                <FieldPicker
                  value={n.fieldId}
                  fallbackName={n.fieldName}
                  options={fieldOptions(props.fields)}
                  ariaLabel={`改绑第 ${idx + 1} 个占位符`}
                  onChange={(id, name) => replaceNode(idx, { ...n, fieldId: id, fieldName: name })}
                />
              </div>
              <button
                type="button"
                className="bp-iconbtn bp-iconbtn--danger"
                aria-label="清除这个字段占位符"
                title="清除绑定，原地留下纯文本"
                onClick={() => replaceNode(idx, { type: 'text', text: n.fieldName })}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))
        )}

        {fieldNodes.some((x) => !x.n.fieldId) ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 这一格有未绑定的字段占位符，打印时会输出空白
          </p>
        ) : null}
      </Section>



      <Section title="单元格样式">
        <Field label="内边距" hint="只作用于这一格；之后若改了表格的内边距，这一格会被覆盖（谁后设谁赢）">
          <Num
            value={finite(cell.paddingMm, finite(element.cellPaddingMm, 1.5))}
            min={0}
            max={12}
            step={0.5}
            suffix="mm"
            ariaLabel="单元格内边距"
            onChange={(v) => patchCell({ paddingMm: v }, `pad:${cell.id}`)}
          />
        </Field>
        {/*
         * ⚠️⚠️ **行高 / 列宽：面板内直接输入**（2026-10-17 用户第二次要求：
         *   「点行高和列宽会**弹出一个窗口**让它输入，我想要的是**直接在右侧属性面板输入值**，
         *     **实时显示在画布中**，类似内边距那样」）。
         *
         * ⇒ **算法不重写**：仍用 `table-actions` 的 `setRowHeightPatch` / `setColWidthPatch`
         *   （与右键菜单、与"整表面板"的列宽**同一套**）；只是把入口从对话框换成 `Num`，
         *   `onChange` 直接 `onMerge` ⇒ 画布实时更新。
         * ⚠️ 行号/列号要从**网格**算（`tableGrid`）：数组下标 ≠ 网格列号（合并单元格会错位），
         *   这一条与 `Canvas` 里那个对话框**同一口径**。
         */}
        {/*
         * ⚠️⚠️ **改成"各占一行"**（2026-10-17 用户报：
         *   「输入框有点小，**会被上下调节按钮震荡**；**列宽和后面的输入框间隔太远**，
         *     和前面行高的单位**靠得太近**」）。
         *
         * 根因：`bp-grid2` 两列，每列只有半行宽 ⇒ `Num` 的数字框被右侧上下箭头挤到极小，
         *   而"mm"后缀 + 下一个标签（"列宽"）在同一行里只能硬挤 ⇒ 间距关系全乱。
         * ⇒ 一行一个，宽度充足，标签/输入框/单位的间距回到 `.bp-field` 的默认节奏。
         */}
        <Field label="行高" hint="这一行的行高；留空 = 按内容自适应">
            <Num
              value={rowHeightMm === null ? 0 : rowHeightMm}
              min={2}
              max={400}
              step={0.5}
              suffix="mm"
              ariaLabel="这一行的行高"
              onChange={(v) => {
                const patch = setRowHeightPatch(element, loc.rowIdx, v)
                if (patch) props.onMerge(element.id, patch, `rowh:${element.id}:${loc.rowIdx}`)
              }}
            />
          </Field>
        <Field label="列宽" hint="这一列的列宽">
            <Num
              value={colWidthMm === null ? 0 : colWidthMm}
              min={2}
              max={400}
              step={0.5}
              suffix="mm"
              ariaLabel="这一列的列宽"
              onChange={(v) => {
                const patch = setColWidthPatch(element, colStart, v)
                if (patch) props.onMerge(element.id, patch, `colw:${element.id}:${colStart}`)
              }}
            />
        </Field>
        <Field label="底纹">
          <ColorInput value={cs.background ?? DEFAULT_CELL_BG} ariaLabel="单元格底纹" onChange={(v) => patchCellStyle({ background: v }, `cellbg:${cell.id}`)} />
        </Field>
        <Field label="水平对齐">
          <Seg
            value={(cs.align ?? 'left') as Align}
            ariaLabel="单元格水平对齐"
            onChange={(v) => patchCellStyle({ align: v })}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
          />
        </Field>
        <Field label="垂直对齐">
          <Seg
            value={(cs.vAlign ?? 'top') as 'top' | 'middle' | 'bottom'}
            ariaLabel="单元格垂直对齐"
            onChange={(v) => patchCellStyle({ vAlign: v })}
            options={[
              { value: 'top', label: '顶' },
              { value: 'middle', label: '中' },
              { value: 'bottom', label: '底' },
            ]}
          />
        </Field>
        <Field label="字号">
          <Num value={finite(cs.fontSizePt, 10.5)} min={2} max={72} step={0.5} suffix="pt" ariaLabel="单元格字号" onChange={(v) => patchCellStyle({ fontSizePt: v }, `cellfs:${cell.id}`)} />
        </Field>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="单元格字形">
            <button type="button" className={`bp-tgl bp-tgl--bold${cs.bold ? ' is-on' : ''}`} aria-pressed={!!cs.bold} title="加粗" onClick={() => patchCellStyle({ bold: !cs.bold })}>
              B
            </button>
            <button type="button" className={`bp-tgl bp-tgl--italic${cs.italic ? ' is-on' : ''}`} aria-pressed={!!cs.italic} title="斜体" onClick={() => patchCellStyle({ italic: !cs.italic })}>
              I
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--under${cs.underline ? ' is-on' : ''}`}
              aria-pressed={!!cs.underline}
              title="下划线"
              onClick={() => patchCellStyle(underlineSolidToggle(cs))}
            >
              U
            </button>
            {/* ⚠️ 单元格面板原来**没有删除线**（2026-10-17 用户报：顶栏有、这里没有） */}
            <button
              type="button"
              className={`bp-tgl bp-tgl--strike${cs.strike ? ' is-on' : ''}`}
              aria-pressed={!!cs.strike}
              title="删除线"
              onClick={() => patchCellStyle({ strike: !cs.strike })}
            >
              S
            </button>
            <UnderlineDashBtn
              style={cs}
              hint="整格"
              onToggle={() => patchCellStyle(underlineDashToggle(cs))}
            />
          </div>
        </Field>
        {/* ⚠️ **字色紧跟字号/字形**（2026-10-17 重排）：它俩才是"同一类"，原来被挤到最后 ✅ */}
        <Field label="字色">
          <ColorInput value={cs.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="单元格字色" onChange={(v) => patchCellStyle({ color: v })} />
        </Field>
        {/*
         * ⚠️⚠️ **两个"格子级"开关**（2026-10-17 用户要求：
         *   「**自动换行的开关放在字段属性中不太合适，放在单元格的属性中**，
         *     额外再增加一个**单元格自适应宽高**的开关」）。
         *
         * · **自动换行**：关 ⇒ 不换行、超出的**直接裁切**（不撑格子）；
         * · **自适应宽高**：开 ⇒ 格子跟着内容长；关 ⇒ 严格按设定尺寸、超出裁切。
         * ⚠️ 两个都是**格子级**语义 —— 同一格里的多个字段/文字**共用**这一份设置。
         */}

      </Section>

      {/*
       * ⚠️ **"行为开关"独立成一节**（2026-10-17 重排）：
       *   自动换行 / 自适应宽高 决定的是"**格子怎么长**"，不是"字长什么样" ——
       *   混在"单元格样式"里会让用户以为它们只影响字体 ✅
       *   ``：这是"偶尔才调"的设置，默认收起，减少面板长度。
       */}
      <Section title="格内行为">
        {/* ⚠️ 两个开关**并排一行**（2026-10-17 用户要求：它们是一对行为开关，竖着占太长的版面） */}
        {/*
         * ⚠️ **两个开关：标签与开关同行（`inline`）+ 紧凑列间距**（2026-10-17 用户指正：
         *   「既然文字会换行，那就把**按钮或者两个功能的间距稍微缩短**一些不就好了」）。
         *
         * 根因：`Field` 默认是**标签在上、控件在下** ⇒ 两列各半行宽，
         *   「自适应宽高」四个字在那一列里放不下，只能折成"自适应宽 / 高" ✅
         * ⇒ `inline` 让标签和开关并排（省一整行的高度，也把宽度让给标签）。
         */}
        <div className="bp-grid2 bp-grid2--tight">
          <Field inline label="自动换行" hint="关：不换行、超出直接裁切">
            <Switch
              checked={cell.wrap !== false}
              onChange={(v) => patchCell({ wrap: v }, `cellwrap:${cell.id}`)}
              ariaLabel="这一格是否自动换行"
            />
          </Field>
          <Field inline label="自适应宽高" hint="开：格子跟着内容变大；关：按设定尺寸、放不下的直接裁掉">
            <Switch
              checked={cell.autoSize === true}
              onChange={(v) => patchCell({ autoSize: v }, `cellsize:${cell.id}`)}
              ariaLabel="内容能不能把这格撑大"
            />
          </Field>
        </div>
      </Section>

      {/*
        ⛔ 这里原来有一节「表格边框」（框线 / 线宽 / 线色，``）。
        **已移除**（2026-09-18 用户按 Excel 逻辑指出）：

        用户原话："我任意选择一个单元格，**编辑的边框线竟然是对整个表格生效**……
        单个单元格没有内框，只有用户手动拖选了多个单元格或者整表，才会有合并、内框线的选项。"

        那节自己的 hint 就写着"框线属于整张表格，这里改了所有单元格一起变" ——
        **等于把整表控件摆进了单格面板**，用户当然会以为"我改的是这一格"。
        ⇒ 框线只保留在**整表面板**（`边框` / `表格边框` 两节都在那边），
          单格面板只留"这一格自己的"东西。
      */}
      <p className="bp-hint">
        框线和整表结构（行 / 列 / 列宽 / 表头）请点下面「返回整表」后修改 —— 单格面板只放这一格自己的设置。
      </p>

      <div className="bp-btnrow">
        <button type="button" className="bp-minibtn" onClick={backToTable}>
          ← 返回整表（可改行列 / 列宽 / 表头 / 框线）
        </button>
      </div>
    </>
  )
}

// ---- 附件块（PRD F4.2 / F4.3 全套配置） ----

function AttachAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'attach' }> }) {
  const { element } = props
  /* ⚠️ **尺寸（mm）+ 锁比例**（2026-10-15 三模式重构）—— 见 `childSizeMm` 的注释。
     锁比例是**面板级偏好**（不进模板），所以只放在组件 state 里。 */
  const inCell = props.selectedInCell ?? null
  const sz = childSizeMm(props.doc, inCell, element)
  const [lockRatio, setLockRatio] = useState(false)
  /* ⚠️ 提到 `setWMm`/`setHMm` **之前**：它们要用 `cfg` 组 `freePatch`（见下） */
  const cfg = element.config
  const patch = (p: Partial<AttachmentPrintConfig>, key?: string): void =>
    props.onMerge(element.id, { config: { ...cfg, ...p } }, key)
  /**
   * ⚠️⚠️ **"改尺寸 ⇒ 归自由"必须和尺寸写进同一次 `onMerge`**（2026-10-15 修）。
   *
   * 原来写成两次调用（`setFreeMode(key)` + `onMerge(..., key)`）——
   * **同一个 `mergeKey` 写两次，前一次会被后一次覆盖** ⇒ `sizeMode` 根本没落库
   *   ⇒ 用户实测「**附件没有自动跳到自由**」。
   *   （而图片不用写 `sizeMode`、靠 `h` 是不是具体值反推 ⇒ 它"看起来生效了"，
   *     这个差异正好指认了根因。）
   */
  const freePatch =
    cfg.sizeMode !== 'fixedBox' ? { config: { ...cfg, sizeMode: 'fixedBox' as const } } : null
  /** ⚠️ 写回"宽"：格内要**反算成百分比**（`w = mm ÷ 内容区宽 × 100`）并按内容区夹紧 */
  const setWMm = (v: number, key: string): void => {
    if (inCell) {
      const pct = Math.max(MIN_CELL_CHILD_PCT, Math.min(100, (v / Math.max(1, sz.capW)) * 100))
      props.onMerge(element.id, { w: Math.round(pct * 10) / 10, ...freePatch }, key)
    } else {
      props.onMerge(element.id, { w: Math.round(v * 10) / 10, ...freePatch }, key)
    }
  }
  /** ⚠️ 写回"高"：格内按内容区高夹紧（用户要求"达到就不可再往上调整"）*/
  const setHMm = (v: number, key: string): void => {
    const next = Math.max(1, Math.min(inCell ? sz.capH : 2000, v))
    props.onMerge(element.id, { h: Math.round(next * 10) / 10, ...freePatch }, key)
  }

  return (
    <>
      <Section title="绑定字段">
        <FieldPicker
          value={element.fieldId}
          fallbackName={element.fieldName}
          options={fieldOptions(props.fields)}
          ariaLabel="更换附件字段"
          onChange={(id, name) => props.onMerge(element.id, { fieldId: id, fieldName: name })}
        />
        {!element.fieldId ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 尚未绑定附件字段，打印时将输出空白
          </p>
        ) : null}
      </Section>

      <Section title="打印策略">
        <Field label="附件处理">
          <Seg
            value={cfg.mode}
            ariaLabel="附件打印策略"
            onChange={(v) => patch({ mode: v })}
            options={[
              { value: 'none', label: '不打印', title: '画布显示 [不打印附件]，渲染为空' },
              { value: 'imageOnly', label: '仅图片', title: '只渲染图片类附件，非图片静默跳过' },
              {
                value: 'nameOnly',
                label: '仅名称',
                title: '一行一个文件名，不嵌图、不下载 —— 适合只想要一张"附件清单"',
              },
              { value: 'all', label: '全部', title: '图片按图片渲染，非图片按文件名文本渲染' },
            ]}
          />
        </Field>
        {/*
          「显示文件名」只对**会画图**的两档有意义：
          仅名称档本来就全是文件名（无需再叠一层），不打印档什么都没有。
          以前这里无条件显示，会让"仅名称"档出现一个点了没反应的开关。
        */}
        <Field label="显示文件名" inline hint={cfg.mode === 'nameOnly' ? '「仅名称」档已经是文件名，这项不用开' : undefined}>
          <Switch
            checked={!!cfg.showFileName}
            ariaLabel="在图片下方显示文件名"
            onChange={(v) => patch({ showFileName: v })}
          />
        </Field>
        {cfg.showFileName ? (
          <Field label="含扩展名" inline hint="文件名含扩展名">
            <Switch checked={!!cfg.fileNameWithExt} ariaLabel="文件名是否含扩展名" onChange={(v) => patch({ fileNameWithExt: v })} />
          </Field>
        ) : null}
        <Field label="仅导出文件名" hint="只导出文件名（不嵌图）：大表 / 弱网时的逃生舱，跳过全部图片下载">
          <Switch checked={!!cfg.textOnlyFallback} ariaLabel="只导出文件名不嵌图" onChange={(v) => patch({ textOnlyFallback: v })} />
        </Field>
      </Section>

      {/*
        ⚠️ **这里的名字与折叠态**（2026-10-15 用户报"还是有两个尺寸"）：
        它的 `尺寸` 那一行已经挪到上面的「尺寸」区（`ElementPanel`，所有格内元素共用），
        这里装的是**打印行为**（尺寸模式 / 自适应 / 只打印第一张 / 排列方式 / 每行张数 / 间距）
        ⇒ 改名叫 **「打印与排列」** 并**默认收起**（用户原话："当前的功能太多了……可以优化下排版"）。
        ⚠️ 只改标题与折叠态，**不动任何字段与回调**。
      */}
      {/*
        ⚠️ **拆成两个区**（2026-10-15 用户要求"尺寸——位置——高级"的布局）：
        这个区里其实混了两类东西 ——
          · **常用**：尺寸模式 / 填充（不该埋在收起的区里）
          · **细节**：自适应 / 只打印第一张 / 排列方式 / 每行张数 / 间距（收起合理）
        ⇒ 前者留在这里（**默认展开**），后者拆到下面的「打印与排列」（默认收起）。
        ⚠️ 只挪了一个 `</Section>` + 一个 `<Section>`，**没有搬任何字段**。
      */}
      <Section title="尺寸与填充">
        {/*
          ⚠️ **第一行：实际尺寸（宽 × 高，mm）**（2026-10-15 用户要求）。
          · **格内**：`w` 是"占内容区宽的百分比" ⇒ 这里**换算成 mm** 显示/输入，
            写回时**反算**（`w = mm ÷ 内容区宽 × 100`），并按内容区**夹紧**。
          · **顶层**：`w`/`h` 本来就是 mm，直接用。
          · **锁比例**：改一个、另一个按当前比例跟着变（面板级偏好，**不进模板**）。
          ⚠️ 用户口径：「调整的时候，如果是在单元格内，则需要考虑**是否超出单元格的边界**，
             **达到就不可再往上调整**」⇒ `max` 就是内容区宽/高（高度见 `setHMm` 的夹紧）。
        */}
        {/*
          ⚠️ **只在"非格内"时显示这一行**（2026-10-15 去重）。
          格内附件由上面的「尺寸」区（`ElementPanel`，与所有格内元素共用）负责；
          这里再放一份就是**同一页两套尺寸**（用户报"属性面板杂乱得很"）。
        */}
        {!inCell ? (
          <Field label="尺寸" hint="宽 × 高（mm）；锁上比例后，改一个另一个跟着变">
          <div className="bp-size-row">
            <Num
              value={sz.w}
              disabled={cfg.sizeMode === 'original'}
              min={1}
              max={inCell ? sz.capW : 2000}
              step={1}
              ariaLabel="元素宽度"
              onChange={(v) => {
                const before = sz.w
                setWMm(v, `cw:${element.id}`)
                /* ⚠️ 锁比例：用**改动前**的宽高算比例，否则会自己追自己 */
                if (lockRatio && before > 0 && sz.h > 0) setHMm((sz.h * v) / before, `ch:${element.id}`)
              }}
            />
            <button
              type="button"
              className={`bp-lock${lockRatio ? ' is-on' : ''}`}
              aria-label={lockRatio ? '解锁比例' : '锁定比例'}
              title={lockRatio ? '已锁定比例（改一个、另一个跟着变）' : '锁定宽高比例'}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setLockRatio((v) => !v)}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d={
                    lockRatio
                      ? 'M4 7V5a4 4 0 0 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z'
                      : 'M4 6a4 4 0 0 1 7.9-.7 1 1 0 1 1-2 .3A2 2 0 1 0 6 6v1h6.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4V6Z'
                  }
                  fill="currentColor"
                />
              </svg>
            </button>
            <Num
              value={sz.h}
              disabled={cfg.sizeMode === 'original'}
              min={1}
              max={inCell ? sz.capH : 2000}
              step={1}
              ariaLabel="元素高度"
              onChange={(v) => {
                const before = sz.h
                setHMm(v, `ch:${element.id}`)
                if (lockRatio && before > 0 && sz.w > 0) setWMm((sz.w * v) / before, `cw:${element.id}`)
              }}
            />
            <span className="bp-size-mm">mm</span>
          </div>
        </Field>
        ) : null}
        {/*
          ⚠️⚠️ **三模式**（2026-10-15 用户定案，原话照抄在下面注释里）。

          用户口径：
            1、**原图**：图片按正常尺寸渲染，图片多大就渲染多大，**打印和预览时会把单元格撑大**。
            2、**适配**：严格限制在单元格内、**不会撑大单元格**，单元格多大就渲染多大；
               分三档填充（留白 / 变形填充 / 裁切填充）。
            3、**自由**：**拖动过大小**才归入自由；同样限制在单元格内、不撑大；
               在**附件选区（绿框）**内渲染；用户拉多大就渲染多大；也有三档填充。
               ⚠️ **只拖位置不归自由。**

          ⚠️ **实现上不动类型**：`AttachmentSizeMode` 仍是 4 值，面板**只暴露 3 档**：
             · 原图 ⇒ `original`
             · 适配 ⇒ `fitCell`
             · 自由 ⇒ `fixedBox`（尺寸由「宽/高」决定）
           存量模板里的 `fixedHeight` **仍然能读**（显示为"自由"），但面板不再单独给了 ——
           它只是"自由"的一个特例（用户只定了一维）。⇒ **老模板不会坏**。
        */}
{/*
  ⚠️ **「尺寸模式」已废弃**（2026-10-15 用户定案）：
  「不再需要原图、适配、自由选项，**直接按照选区大小去渲染**，
   渲染方式还是留白、变形、裁切，让用户自己去调整选区大小就行」。
  ⇒ 尺寸永远等于"选区"；**用下面的「填充」决定图怎么装进去**。
  ⚠️ 字段 `sizeMode` 仍保留在类型里（老模板能读、不会崩），只是不再暴露。
*/}
        {/* ⚠️ **填充三档**：只在"适配"和"自由"下有意义（原图模式尺寸由图片本身决定，没有"框"可填） */}
        {cfg.sizeMode !== 'original' ? (
          <Field label="填充" hint="留白=整图可见；变形=拉伸铺满（会变形，适合证件照位）；裁切=等比放大后裁掉超出部分">
            <Seg
              value={cfg.fit ?? 'contain'}
              ariaLabel="图片填充方式"
              onChange={(v) => patch({ fit: v })}
              options={[
                { value: 'contain', label: '留白' },
                { value: 'fill', label: '变形' },
                { value: 'cover', label: '裁切' },
              ]}
            />
          </Field>
        ) : null}
        {/*
          ⚠️ **存量兼容**：老模板里的 `fixedHeight` 仍然可读、也仍然生效，
             但面板不再单独给一档（它归在"自由"里）。这里保留它的输入框，
             否则用户切到那种模板时会看不到任何尺寸输入框。
        */}
        {cfg.sizeMode === 'fixedHeight' ? (
          <Field label="固定高度" hint="旧模板的字段，等价于「自由」里只定高度">
            <Num value={finite(cfg.fixedHeightMm, 30)} min={5} max={200} step={1} suffix="mm" ariaLabel="图片固定高度" onChange={(v) => patch({ fixedHeightMm: v }, `fh:${element.id}`)} />
          </Field>
        ) : null}
        {/*
          固定宽高：框就是**上方「宽」「高」那两项**，这里只决定"图片怎么放进这个框"。
          ⚠️ 只有这一个模式会真正按框写死高度（见 Canvas 与 render/html.ts 的 PIC_LIKE 分支）；
          其它模式仍是"高度只作下限"，因为内容（原图比例）才是尺寸的来源。
        */}
        {/*
          ⚠️ **这里原来还有一个"图片适配"Seg**（留白/变形填充/裁切填充）——
             2026-10-15 三模式重构后它与上面那个**共用的「填充」**完全重复 ⇒ **已删**。
             只保留这句说明（内容对"自由"模式仍然适用）。
        */}
        {cfg.sizeMode === 'fixedBox' ? (
          <p className="bp-hint">
            「自由」模式：框的大小就是上面的「宽」「高」（也可直接拖画布上的手柄）。
            三种填充都会把图片严格限制在框内：留白＝整图可见；变形＝拉伸铺满（适合证件照位）；裁切＝等比放大后裁掉超出部分。
          </p>
        ) : null}
        <p className="bp-hint">所有模式都严格等比缩放，不会拉伸变形；超出容器时按较小比例缩。</p>
      </Section>
      {/* ⚠️ **打印细节**（默认收起）—— 上面「尺寸与填充」是常用项，这两类分开摆 */}
      <Section title="打印与排列">
        <Field label="自适应单元格" inline>
          <Switch checked={!!cfg.fitCell} ariaLabel="自适应单元格大小" onChange={(v) => patch({ fitCell: v })} />
        </Field>
        {/*
          ⚠️ **这里原来有一个「对齐」**（写 `config.align`）—— 2026-10-15 去重时删掉：
          格内元素的「位置」区（`ElementPanel`）里**已经有一个对齐**，两者语义相同
          （附件写 `config.align`、其余写元素级 `align`，面板里那个是**统一的入口**）。
          留两个只会让用户疑惑"改哪个才算"。
        */}
        {/* ⚠️ **只打印第一张**（2026-10-14 用户要求）——
            附件字段里常有正反面多张，但有些单据位只放得下一张。 */}
        <Field label="只打印第一张" hint="附件里有多张时只输出第一张（按附件字段里的顺序）">
          <Switch
            /* ⚠️ **默认开**（2026-10-15：用户要求只打印第一张设为默认勾选）——
               所以判据是 `!== false`：`undefined`（老模板/从没设过）也显示为勾选，
               显式关掉才不勾。⚠️ 必须与 `render/html.ts` 里的判定**逐字一致**，
               否则会出现面板看着关了、打印却只出一张。 */
            checked={cfg.onlyFirst !== false}
            ariaLabel="只打印第一张附件图片"
            onChange={(v) => patch({ onlyFirst: v })}
          />
        </Field>
        <Field label="排列方式">
          <Seg
            value={cfg.flow}
            ariaLabel="多张图片排列方式"
            onChange={(v) => patch({ flow: v })}
            options={[
              { value: 'inline', label: '并排', title: '在容器宽度内依次排列，放不下自动换行' },
              { value: 'wrap', label: '换行', title: '每张图片独占一行' },
            ]}
          />
        </Field>
        <Field label="每行张数" hint="每行最多张数；留 0 表示按容器宽度自动计算">
          <Num
            value={finite(cfg.maxPerRow, 0)}
            min={0}
            max={8}
            step={1}
            suffix="张"
            ariaLabel="每行最多图片数"
            onChange={(v) => patch({ maxPerRow: v > 0 ? Math.round(v) : null }, `mpr:${element.id}`)}
          />
        </Field>
        <div className="bp-grid2">
          <Field label="水平间距">
            <Num value={finite(cfg.gapXMm, 2)} min={0} max={30} step={0.5} suffix="mm" ariaLabel="图片水平间距" onChange={(v) => patch({ gapXMm: v }, `gx:${element.id}`)} />
          </Field>
          <Field label="垂直间距">
            <Num value={finite(cfg.gapYMm, 2)} min={0} max={30} step={0.5} suffix="mm" ariaLabel="图片垂直间距" onChange={(v) => patch({ gapYMm: v }, `gy:${element.id}`)} />
          </Field>
        </div>
      </Section>

      <Section title="保护与限制">
        <Field label="单张上限" hint="单张图片体积上限">
          <Num value={finite(cfg.maxFileSizeMb, 10)} min={1} max={100} step={1} suffix="MB" ariaLabel="单张图片体积上限" onChange={(v) => patch({ maxFileSizeMb: v }, `mfs:${element.id}`)} />
        </Field>
        <Field label="最小 DPI">
          <Num value={finite(cfg.minDpi, 150)} min={72} max={600} step={10} suffix="dpi" ariaLabel="最小清晰度 DPI" onChange={(v) => patch({ minDpi: v }, `dpi:${element.id}`)} />
        </Field>
        <p className="bp-hint">低于该 DPI 时预览会给出清晰的黄色提示，但不阻止打印。</p>
      </Section>
    </>
  )
}

// ---- 字段块 ----

function FieldBlockAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'fieldBlock' }> }) {
  const { element } = props
  const s = element.style ?? {}
  return (
    <Section title="绑定字段">
      <FieldPicker
        value={element.fieldId}
        fallbackName={element.fieldName}
        options={fieldOptions(props.fields)}
        ariaLabel="更换绑定字段"
        onChange={(id, name) => props.onMerge(element.id, { fieldId: id, fieldName: name })}
      />
      {!element.fieldId ? (
        <p className="bp-alert bp-alert--danger">
          <IconWarning size={13} /> 尚未绑定字段，打印时输出为空
        </p>
      ) : null}
      <div className="bp-grid2">
        <Field label="前缀">
          <input
            className="bp-input"
            value={element.prefix ?? ''}
            aria-label="字段前缀"
            placeholder="如 金额：¥"
            onChange={(e) => props.onMerge(element.id, { prefix: e.target.value }, `pre:${element.id}`)}
          />
        </Field>
        <Field label="后缀">
          <input
            className="bp-input"
            value={element.suffix ?? ''}
            aria-label="字段后缀"
            placeholder="如 元"
            onChange={(e) => props.onMerge(element.id, { suffix: e.target.value }, `suf:${element.id}`)}
          />
        </Field>
      </div>
      <Field label="字号">
        <Num
          value={finite(s.fontSizePt, 10.5)}
          min={8}
          max={72}
          step={0.5}
          suffix="pt"
          ariaLabel="字段块字号"
          onChange={(v) => props.onMerge(element.id, { style: { ...s, fontSizePt: v } }, `fs:${element.id}`)}
        />
      </Field>
      <Field label="字形">
        <div className="bp-btnrow" role="group" aria-label="字段块字形">
          <button type="button" className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`} aria-pressed={!!s.bold} onClick={() => props.onMerge(element.id, { style: { ...s, bold: !s.bold } })}>
            B
          </button>
          <button type="button" className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`} aria-pressed={!!s.italic} onClick={() => props.onMerge(element.id, { style: { ...s, italic: !s.italic } })}>
            I
          </button>
          <button type="button" className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`} aria-pressed={!!s.underline} onClick={() => props.onMerge(element.id, { style: { ...s, ...underlineSolidToggle(s) } })}>
            U
          </button>
          <button type="button" className={`bp-tgl bp-tgl--strike${s.strike ? ' is-on' : ''}`} aria-pressed={!!s.strike} onClick={() => props.onMerge(element.id, { style: { ...s, strike: !s.strike } })}>
            S
          </button>
          <UnderlineDashBtn
            style={s}
            onToggle={() => props.onMerge(element.id, { style: { ...s, ...underlineDashToggle(s) } })}
          />
        </div>
      </Field>
      <Field label="字色">
        <ColorInput value={s.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="字段块字体颜色" onChange={(v) => props.onMerge(element.id, { style: { ...s, color: v } })} />
      </Field>
      <Field label="对齐">
        <Seg
          value={(s.align ?? 'left') as Align}
          ariaLabel="字段块对齐"
          onChange={(v) => props.onMerge(element.id, { style: { ...s, align: v } })}
          options={[
            { value: 'left', label: '左' },
            { value: 'center', label: '中' },
            { value: 'right', label: '右' },
          ]}
        />
      </Field>
    </Section>
  )
}

// ---- 图片 ----

/* ⚠️ 压缩实现已下沉到 `lib/image-shrink.ts`（Word 导入那条路也要用，见那里的文件头） */

function ImageAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'image' }> }) {
  const { element } = props
  /** 打开系统文件选择器之前是不是浏览器全屏（选完要还回来，见按钮 onClick） */
  const wasFullscreenRef = useRef(false)

  const pick = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      props.onNotice('请选择图片文件（png / jpeg / gif / webp / svg）')
      return
    }
    /*
     * ⚠️ 超限**不再拒绝**，改成自动压缩（见 shrinkToLimit 的文件头注释）。
     * 这里只记一下"要不要压"，真正的压缩在图片解码之后（需要 naturalWidth/Height）。
     */
    const needShrink = file.size > EMBED_IMAGE_MAX_BYTES
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      if (!url) return
      // 按原图比例换算 mm 尺寸，宽度不超过版心（F2-10）
      const img = new Image()
      img.onload = () => {
        const maxW = props.layout.contentWMm
        const natural = img.naturalWidth / Math.max(img.naturalHeight, 1)
        let w = maxW
        let h = maxW / Math.max(natural, 0.01)
        if (h > props.layout.contentHMm) {
          h = props.layout.contentHMm
          w = h * natural
        }
        /*
         * ⚠️ 格内子元素不能走"按原图比例换算 mm"这条路（见 types.ts 第 ④ 条）：
         * 它的 `w` 是百分比、`h` 是盒高。把 180(mm) 写进去 ⇒ 读成 180% 夹回 100%、
         * 高度被定成一个 100mm 的盒子 —— 用户只想**换张图**，尺寸却自己变了。
         * 和"放进格子"同一个默认口径：撑满格宽、高度由内容决定。
         */
        /*
         * ⚠️ **优先把图传到飞书附件**（2026-10-19）：
         * 模板 JSON 要塞进**一个文本单元格**（上限 10 万字、超出静默截断），
         * 图片以 base64 内联时一张 300KB 的图就有 41 万字。走 token 之后模板只剩几十字节，
         * 而且**打印用的是原图**（不再压到 50KB）。
         * ⚠️ 上传不可用/失败 ⇒ **自动降级**为内联 base64（宁可占体积，也不能让用户的图丢）。
         */
        const commit = (
          patch: { dataUrl?: string; fileToken?: string; fileMeta?: { name: string; size: number; type: string } },
          note?: string,
        ): void => {
          props.onMerge(
            element.id,
            props.selectedInCell
              ? { ...patch, w: 100, h: 'auto' }
              : { ...patch, w: round1(w), h: round1(h) },
          )
          if (note) props.onNotice(note)
        }
        const kb = Math.round(file.size / 1024)
        void uploadTemplateImageFiles([file]).then(async (uploaded) => {
          const info = uploaded[0]
          const token = info?.token
          if (token) {
            /*
             * ⚠️⚠️ **必须同时写一份 dataUrl**（2026-10-19 用户实测：
             *   「提示已存到飞书附件，但画布中提示还没有选择图片」）。
             *
             * 根因：`batchUploadFile` 只是把文件传到云空间，**还没写进任何记录的附件字段**，
             * 所以在"保存 → 重新打开"之前 `getAttachmentUrls` 拿不到 URL。
             * 只写 token 的话，画布和打印都**没有任何可显示的东西**。
             * ⇒ 压缩一份留在元素里当"编辑期显示副本"；保存时
             *   `stripInlineImagesForSave` 会把它剥掉（有 token 的才剥），模板不会变大。
             */
            const preview = needShrink ? await shrinkDataUrl(url, EMBED_IMAGE_MAX_BYTES) : null
            commit(
              {
                fileToken: token,
                /* 写附件字段要完整对象 ⇒ 元信息一起存进元素（见 ImageElement.fileMeta） */
                /*
                 * ⚠️ 附件名必须**唯一**：它是"重新打开时把图对回元素"的兜底键
                 * （token 可能被飞书重写，见 `imgSrcOf` 的注释）。用元素 id 保证唯一。
                 */
                fileMeta: {
                  /* 带扩展名：飞书靠后缀判断附件类型，裸名会"无法查看" */
                  name: templateImageFileName(element.id, info?.type || file.type),
                  size: info?.size ?? file.size,
                  type: info?.type || file.type || 'image/jpeg',
                },
                dataUrl: preview?.dataUrl ?? url,
              },
              `图片 ${kb}KB 已存到飞书附件（模板里只留引用，保存后打印用原图）`,
            )
            return
          }
          /* ---- 降级：内联 base64（老路径） ---- */
          if (!needShrink) {
            commit({ dataUrl: url })
            return
          }
          const shrunk = await shrinkDataUrl(url, EMBED_IMAGE_MAX_BYTES)
          if (!shrunk) {
            props.onNotice(
              `图片 ${kb}KB，上传到附件失败、压缩也失败；请先手动压到 ${Math.round(EMBED_IMAGE_MAX_BYTES / 1024)}KB 以内再试`,
            )
            return
          }
          commit(
            { dataUrl: shrunk.dataUrl },
            `图片 ${kb}KB（上传附件失败，已内联压缩到 ${Math.round(shrunk.bytes / 1024)}KB）`,
          )
        })
      }
      img.onerror = () => props.onMerge(element.id, { dataUrl: url })
      img.src = url
    }
    reader.readAsDataURL(file)
  }

  return (
    <Section title="图片">
      {element.dataUrl ? (
        <img className="bp-img-preview" src={element.dataUrl} alt="已插入的图片" />
      ) : (
        <p className="bp-alert bp-alert--warn">
          <IconWarning size={13} /> 还没有选择图片
        </p>
      )}
      <button
        type="button"
        className="bp-btn"
        onClick={() => {
          /*
           * 先记住"打开选择器之前是不是浏览器全屏"：系统文件选择器会让窗口失焦 ⇒
           * 浏览器**自动退出全屏** ⇒ 编辑器会缩回侧边栏布局（浏览器行为，改不了）。
           * 选完文件再把全屏要回来（那一下仍算用户手势，能过 requestFullscreen 的激活要求）。
           */
          wasFullscreenRef.current = !!document.fullscreenElement
          void pickFile('image/png,image/jpeg,image/gif,image/webp,image/svg+xml').then((file) => {
            if (file) pick(file)
            if (wasFullscreenRef.current && !document.fullscreenElement) {
              wasFullscreenRef.current = false
              void enterFullscreen()
            }
          })
        }}
      >
        {element.dataUrl ? '更换图片' : '选择图片'}
      </button>
      <p className="bp-hint">图片以 base64 内嵌进模板，单张上限 300KB；超出请先压缩。</p>
      {/*
        ---- 填充方式：规格 七 要求**四种**（铺满变形 / 保持比例留白 / 原尺寸 / 自动裁剪）----
        ⚠️ 这里原来只有两档（完整显示 / 裁剪填满）。现在四档的**翻译**交给 `imageFillPatch/ModeOf`
        （在 `types.ts`，画布与打印读的是同一份）：
          · 铺满变形 ⇒ `fit:'fill'`（新增的取值，渲染端 `object-fit:fill`）
          · 原尺寸   ⇒ `h:'auto'`（渲染端 `height:auto`，按图片原始比例撑高）
        ⚠️ 传 `element.h` 进去不能省：**从"原尺寸"切走时**必须把高度从 `'auto'` 改回具体值，
           否则读回来还是"原尺寸"，用户会觉得"点了没反应"（见那个函数的注释）。
      */}
      {/*
        ⚠️⚠️ **三模式 + 三档填充**（2026-10-15 用户要求："图片、二维码、条形码、附件
          **都按照一个逻辑**修改，其他元素也可以参考同样的逻辑"）。

        原来这里是**一个 4 档的「填充方式」**（铺满变形/完整显示/原尺寸/裁剪填满）——
        它把两件事混在了一起：
          · **"尺寸由谁决定"**（原图 / 适配 / 自由）—— 三种**模式**
          · **"图怎么放进框里"**（留白 / 变形 / 裁切）—— 三档**填充**
        ⇒ 拆成两个 Seg，**与附件面板完全同构**。

        ⚠️ **图片没有 `sizeMode` 字段**（那是附件专属）⇒ 模式**从现有字段反推**：
          · `fit === 'natural'`（= `h:'auto'`）⇒ **原图**
          · `w`/`h` 都是具体值（用户给过尺寸）⇒ **自由**
          · 其余 ⇒ **适配**
        ⚠️ 写回仍走 `imageFillPatch`（**画布与打印读的是同一份**）——
          它负责"从原图切走时把 `h` 从 `'auto'` 改回具体值"这个易错点。
      */}
{/*
  ⚠️ **「尺寸模式」已废弃**（2026-10-15 用户定案）：
  「不再需要原图、适配、自由选项，**直接按照选区大小去渲染**，
   渲染方式还是留白、变形、裁切，让用户自己去调整选区大小就行」。
  ⇒ 尺寸永远等于"选区"；**用下面的「填充」决定图怎么装进去**。
  ⚠️ 字段 `sizeMode` 仍保留在类型里（老模板能读、不会崩），只是不再暴露。
*/}
      {imageFillModeOf(element, 'image') !== 'natural' ? (
        <Field label="填充" hint="留白=整图可见；变形=拉伸铺满（适合证件照位）；裁切=等比放大后裁掉超出部分">
          <Seg
            value={imageFillModeOf(element, 'image')}
            ariaLabel="图片填充方式"
            onChange={(v) => props.onMerge(element.id, imageFillPatch(v as ImageFill, 'image', element.h))}
            options={[
              { value: 'contain', label: '留白' },
              { value: 'fill', label: '变形' },
              { value: 'cover', label: '裁切' },
            ]}
          />
        </Field>
      ) : null}
    </Section>
  )
}

// ---- 二维码 / 条形码 ----

function CodeAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'qrcode' | 'barcode' }> }) {
  const { element } = props
  const src = element.source
  const isQr = element.kind === 'qrcode'
  const setSource = (next: CodeSource): void => props.onMerge(element.id, { source: next })

  const unbound = src.kind === 'field' && !src.fieldId
  const emptyStatic = src.kind === 'static' && !src.value.trim()
  // 条形码（Code 128 / Code Set B）只认 ASCII 32–126。中文内容渲染库会返回空串，
  // 与其让用户对着一个空白框猜，不如在这里直接说清楚。
  const badBarcode = !isQr && src.kind === 'static' && src.value.trim() !== '' && !isCode128Encodable(src.value)

  return (
    <>
      <Section title="数值来源">
        <Field label="来源">
          <Seg
            value={src.kind}
            ariaLabel="码的数值来源"
            onChange={(v) => {
              if (v === src.kind) return
              // 换来源时清空另一侧的内容：留着上一次的字段名/固定值，
              // 会出现"从字段取值"却显示着上次那个网址的迷惑状态
              setSource(v === 'field' ? { kind: 'field', fieldId: null, fieldName: '' } : { kind: 'static', value: '' })
            }}
            options={[
              { value: 'field', label: '从字段取值', title: '每条记录一个码：产品追溯码、批次码' },
              { value: 'static', label: '手动输入', title: '全篇同一个码：固定网址、设备铭牌' },
            ]}
          />
        </Field>

        {src.kind === 'field' ? (
          <>
            <Field label="字段">
              <FieldPicker
                value={src.fieldId}
                fallbackName={src.fieldName}
                options={fieldOptions(props.fields)}
                ariaLabel="选择二维码 / 条形码取值的字段"
                onChange={(id, name) => setSource({ kind: 'field', fieldId: id, fieldName: name })}
              />
            </Field>
            {unbound ? (
              <p className="bp-alert bp-alert--danger">
                <IconWarning size={13} /> 尚未绑定字段，打印时会输出空白
              </p>
            ) : (
              <p className="bp-hint">画布上显示的是占位框，真实内容在打印时按每条记录逐条生成。</p>
            )}
          </>
        ) : (
          <>
            <Field label="内容">
              <input
                className="bp-input"
                value={src.value}
                aria-label="码的固定内容"
                placeholder={isQr ? '如 https://example.com 或 SN-0001' : '如 SN-2026-0001'}
                onChange={(e) => setSource({ kind: 'static', value: e.target.value })}
              />
            </Field>
            {emptyStatic ? (
              <p className="bp-alert bp-alert--warn">
                <IconWarning size={13} /> 还没有内容，画布上是空的
              </p>
            ) : null}
            {badBarcode ? (
              <p className="bp-alert bp-alert--danger">
                <IconWarning size={13} /> 条形码只支持数字、字母与常用符号，中文等内容生成不出码
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section title={isQr ? '二维码参数' : '条形码参数'}>
        {isQr ? (
          <Field label="纠错等级" hint="等级越高越抗污损，码也更密。L≈7% M≈15% Q≈25% H≈30%">
            <Seg
              value={element.ecLevel ?? 'M'}
              ariaLabel="二维码纠错等级"
              onChange={(v) => props.onMerge(element.id, { ecLevel: v })}
              options={[
                { value: 'L', label: 'L', title: '约 7% 容错，码最疏' },
                { value: 'M', label: 'M', title: '约 15% 容错（默认）' },
                { value: 'Q', label: 'Q', title: '约 25% 容错' },
                { value: 'H', label: 'H', title: '约 30% 容错，标签易磨损时用' },
              ]}
            />
          </Field>
        ) : (
          <p className="bp-hint">v1 固定使用 Code 128（覆盖全部 ASCII 字符，不需要校验位数）。</p>
        )}
        <Field label="显示原文" inline>
          <Switch
            checked={!!element.showText}
            ariaLabel="在码下方显示原文"
            onChange={(v) => props.onMerge(element.id, { showText: v })}
          />
        </Field>
        {isQr ? <p className="bp-hint">原文显示在码的下方，便于人工核对。</p> : null}
      </Section>

      <Section title="颜色">
        <Field label="前景">
          <ColorInput
            value={element.foreground ?? DEFAULT_CODE_FG}
            ariaLabel="码的前景色"
            onChange={(v) => props.onMerge(element.id, { foreground: v })}
          />
        </Field>
        <Field label="背景">
          <ColorInput
            value={element.background ?? DEFAULT_CODE_BG}
            ariaLabel="码的背景色"
            onChange={(v) => props.onMerge(element.id, { background: v })}
          />
        </Field>
        <p className="bp-hint">前景与背景反色、或对比度太低时扫码器会读不出来，浅底深码最稳。</p>
      </Section>

      <p className="bp-hint">元素当前的取值：{codeSourceLabel(src)}</p>
    </>
  )
}

// ---- 水平线 ----

function HLineAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'hline' }> }) {
  const { element } = props
  const s = element.style ?? {}
  return (
    <Section title="线条">
      <Field label="线宽">
        <Num value={finite(element.thicknessPt, 0.75)} min={0.25} max={3} step={0.25} suffix="pt" ariaLabel="水平线宽度" onChange={(v) => props.onMerge(element.id, { thicknessPt: v }, `lt:${element.id}`)} />
      </Field>
      <Field label="线色">
        <ColorInput value={element.color} ariaLabel="水平线颜色" onChange={(v) => props.onMerge(element.id, { color: v })} />
      </Field>
      <div className="bp-grid2">
        <Field label="左缩进">
          <Num value={finite(s.indentLeftMm, 0)} min={0} max={100} step={1} suffix="mm" ariaLabel="水平线左缩进" onChange={(v) => props.onMerge(element.id, { style: { ...s, indentLeftMm: v } }, `li:${element.id}`)} />
        </Field>
        <Field label="右缩进">
          <Num value={finite(s.indentRightMm, 0)} min={0} max={100} step={1} suffix="mm" ariaLabel="水平线右缩进" onChange={(v) => props.onMerge(element.id, { style: { ...s, indentRightMm: v } }, `ri:${element.id}`)} />
        </Field>
      </div>
      <p className="bp-hint">宽度由元素的"宽"决定，缩进是在这个宽度内再向内收。</p>
    </Section>
  )
}

// ============================================================

function fieldOptions(fields: FieldMeta[]) {
  return fields.map((f) => {
    const meta = fieldMeta(f.type)
    return {
      id: f.id,
      name: f.name,
      tint: meta.tint,
      blocked: meta.capability === 'none',
      group: meta.label,
      note: meta.note,
    }
  })
}
