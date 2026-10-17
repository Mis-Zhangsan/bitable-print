/**
 * 「检查」面板（2026-09-18 用户要求新增）。
 *
 * 用户原话：
 * "左侧的工具栏内，增加一栏'检查'，可以显示当前画布上所有的元素、字段，
 *  点击后高亮显示对应元素或者字段，方便用户删除不小心拖进来的元素字段。"
 *
 * ── 与已有两个面板的分工（别混）─────────────────────────────────
 * · `Palette`（字段 / 元素）：**类型调色板** —— 拖一个出来「新增」。它列的是"能加什么"。
 * · `Inspector`（样式）：**选中项的属性** —— 改当前选中的那一个。它只认一个对象。
 * · `InspectPanel`（检查）：**已经放上去的全部** —— 列的是"现在有什么"，用来做清点与清理。
 *
 * 为什么值得单开一栏：画布上元素一多，用户看不见压在底下的、或者拖到边角忘了的；
 * 而删除的唯一入口是"先精确点中它 → 再按删除"。这一栏把"找到它"这一步变成点一下列表。
 *
 * ── 排序口径 ────────────────────────────────────────────────
 * 按**版式区 + y**（画布上从上到下的顺序）。用户眼睛找的是"那块东西在纸上哪个位置"，
 * 不是"我什么时候加的" —— 按加入顺序排会让他每找一个都要扫全表。
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { finite, type AnyElement, type TemplateDoc } from '../../lib/types'
import type { FieldMeta } from '../../lib/data-source'
import { fieldMeta } from '../../lib/field-types'
// `BandKey` / `elementLabel` / `BAND_LABEL` 都在 useEditorState 里（版式区与"元素叫什么"的唯一出处），
// 别在这里重新声明一份 —— 重新声明就会出现"两处定义慢慢长歪"。
//
// ⚠️ 这条**真的发生过**：本文件抄过一份自己的 `BAND_LABEL`，于是 2026-09-22 那次
//    「每页重复区 → 表头区」的改名只改到一半，这一行「节点路径」还写着旧名字。
//    现在改为直接引用（下面 `BAND_LABEL[band]` 用的是同一个来源）。
import { BAND_LABEL, elementLabel, type BandKey } from './useEditorState'
import { IconCaret, IconTrash } from './Icons'
import { getLastRenderStats, subscribeRenderStats } from './render-stats'

export interface InspectPanelProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  /** 当前选中的元素 id（列表里高亮它） */
  selectedId: string | null
  /** 点一行 → 让画布选中它（画布会滚动到可视区并画上选中框） */
  onSelect: (elementId: string) => void
  /** 删除一个元素（误拖进来的那个） */
  onRemove: (elementId: string) => void
  /** ⚠️ **记录数**（2026-10-17 加，用于"预计渲染耗时"的粗估）。不传 ⇒ 按 1 条算 */
  recordCount?: number
}


/**
 * 一个版式区里的元素。
 *
 * 写成三个**显式分支**而不是 `doc.bands[band]`：`bands.loop` 是 `LoopBand`（不是数组），
 * 用 `BandKey` 去索引 `TemplateBands` 取不出统一的类型；而且显式写出来，
 * "循环区的元素挂在 `.elements` 上"这条结构事实就摆在这儿，改坏了也会立刻报错。
 */
/** 毫秒 → 「320 毫秒」/「4.2 秒」。两行耗时用同一套格式化，免得一行秒一行毫秒 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

function bandElements(doc: TemplateDoc, band: BandKey): AnyElement[] {
  if (band === 'header') return doc.bands.header ?? []
  if (band === 'footer') return doc.bands.footer ?? []
  return doc.bands.loop?.elements ?? []
}

/**
 * ⚠️ **数"用户手打的字符"**（2026-10-17 用户要求："统计文本的字符数，**不包括其他字段**"）。
 *
 * 只数 `type === 'text'` 的节点 —— **字段占位符 / 系统变量 / 换行都不算**
 * （它们不是"用户打的字"：字段是数据、换行是排版）。
 * ⚠️ 表格要递归到每格 `nodes`：格子里的手打文字同样是用户输入的。
 * ⚠️ 子元素（图片/附件/码）没有文字 ⇒ 不参与。
 */
/**
 * ⚠️ **统计用的"短名"**（2026-10-17）：与"元素"标签页的叫法一致，**不带内容摘要**。
 *   `elementLabel` 会返回"条形码「未填写内容」"这种长串 —— 统计列表里一行放不下、还会换行。
 */
function kindLabel(el: AnyElement): string {
  switch (el.kind) {
    case 'text': return '文本段落'
    case 'table': return '表格'
    case 'image': return '固定图片'
    case 'hline': return '水平线'
    case 'pagebreak': return '分页符'
    case 'fieldBlock': return '字段块'
    case 'qrcode': return '二维码'
    case 'barcode': return '条形码'
    case 'attach': return '附件'
    default: return '元素'
  }
}

function countManualChars(el: AnyElement): number {
  let total = 0
  const walk = (nodes: ReadonlyArray<{ type: string; text?: string }> | undefined): void => {
    for (const x of nodes ?? []) {
      /*
       * ⚠️ **只数"非空白字符"**（2026-10-17 用户报："明明画布中没有任何一个手打文字，却统计了 22 字"）。
       *   根因：换行/缩进在 `nodes` 里也是 `text` 节点（模板从 Word 导入时尤其多），
       *   按 `length` 全算就凭空多出十几个"字" ✅
       *   ⚠️ 用户心智里的"字数"= **看得见的字**，空格/换行不算。
       */
      if (x.type === 'text' && typeof x.text === 'string') total += x.text.replace(/\s/g, '').length
    }
  }
  if (el.kind === 'text') walk(el.nodes)
  if (el.kind === 'table') {
    for (const r of el.rows) for (const c of r.cells) walk(c.nodes)
  }
  return total
}

/** 该元素引用了哪些字段（去重后的 `{fieldId, fieldName}`）。用于"字段"那一节的清点 */
function fieldRefsOf(el: AnyElement): Array<{ fieldId: string | null; fieldName: string }> {
  const out: Array<{ fieldId: string | null; fieldName: string }> = []
  /*
   * ⚠️⚠️ **不去重**（2026-10-17 用户报："编码我增加了好多个，不止两个"）。
   *
   * 原来这里 `if (out.some(...)) return` —— 同一个元素里"同一个字段出现多次"只算 1。
   *   于是"一个表格里有 20 个 `编码`" ⇒ 检查页也只显示 `×1`（还叠加了"元素数"的语义）。
   * ⇒ 现在**每次出现都记一次** ⇒ `count` 的语义从"几个元素引用它"变成"**一共出现几次**"，
   *   这才是用户看到画布时的心智模型 ✅
   */
  const push = (fieldId: string | null, fieldName: string): void => {
    out.push({ fieldId, fieldName })
  }
  if (el.kind === 'fieldBlock') push(el.fieldId ?? null, el.fieldName ?? '')
  if (el.kind === 'text') {
    for (const n of el.nodes) if (n.type === 'field') push(n.fieldId ?? null, n.fieldName ?? '')
  }
  if (el.kind === 'table') {
    for (const r of el.rows) {
      for (const c of r.cells) {
        for (const n of c.nodes) if (n.type === 'field') push(n.fieldId ?? null, n.fieldName ?? '')
      }
    }
  }
  return out
}

export function InspectPanel({
  doc,
  fields,
  selectedId,
  onSelect,
  onRemove,
  recordCount = 1,
}: InspectPanelProps): ReactNode {
  const knownFieldIds = new Set(fields.map((f) => f.id))
  const bands: BandKey[] = ['header', 'loop', 'footer']

  // 一条记录里，字段可能被多个元素引用 ⇒ 汇总成"字段 → 用它的元素数"
  /**
   * ⚠️ **多存一个 `type`**：分组要用 `fieldMeta(type).label`（与"字段"页同一套类别名）。
   *   `fieldId` 失效时 type 会是 `undefined` ⇒ 归到"未知字段"那组。
   */
  const fieldUsage = new Map<string, { name: string; fieldId: string | null; count: number; type?: number }>()
  const rows: Array<{ el: AnyElement; band: BandKey; label: string }> = []
  let total = 0
  /** ⚠️ **用户手打的字符合计**（2026-10-17 新增，见 countManualChars） */
  let manualChars = 0
  /**
   * ⚠️ **按"元素种类"计数**（2026-10-17 用户要求：像"元素"标签页那样分类统计）。
   *   key 用 `elementLabel(el)` —— 与画布、检查列表**同一套名字**。
   *   ⚠️ **递归进表格**：格内的图片/码/附件也是"画布上的元素"，要计进去。
   */
  const elStats = new Map<string, number>()
  const bumpEl = (label: string): void => {
    elStats.set(label, (elStats.get(label) ?? 0) + 1)
  }
  /** ⚠️ 粗估用：码 / 图 的数量（见文件头的系数说明） */
  let codeCount = 0
  let imgCount = 0

  for (const band of bands) {
    const list = [...bandElements(doc, band)].sort((a, b) => finite(a.y, 0) - finite(b.y, 0))
    for (const el of list) {
      total += 1
      manualChars += countManualChars(el)
      bumpEl(kindLabel(el))
      /* ⚠️ 粗估用：数"码"和"图"（格子里的 `children` 也算 —— 它们同样要生成/解码） */
      if (el.kind === 'qrcode' || el.kind === 'barcode') codeCount += 1
      if (el.kind === 'image' || el.kind === 'attach') imgCount += 1
      for (const ch of (el as { children?: AnyElement[] }).children ?? []) {
        bumpEl(kindLabel(ch))
        if (ch.kind === 'qrcode' || ch.kind === 'barcode') codeCount += 1
        if (ch.kind === 'image' || ch.kind === 'attach') imgCount += 1
      }
      if (el.kind === 'table') {
        for (const r of el.rows) {
          for (const c of r.cells) {
            for (const ch of c.children ?? []) {
              bumpEl(elementLabel(ch))
              if (ch.kind === 'qrcode' || ch.kind === 'barcode') codeCount += 1
              if (ch.kind === 'image' || ch.kind === 'attach') imgCount += 1
            }
          }
        }
      }
      rows.push({ el, band, label: elementLabel(el) })
      for (const ref of fieldRefsOf(el)) {
        const key = ref.fieldId ?? `name:${ref.fieldName}`
        const cur = fieldUsage.get(key)
        if (cur) cur.count += 1
        else {
          const meta = ref.fieldId ? fields.find((f) => f.id === ref.fieldId) : undefined
          fieldUsage.set(key, {
            name: ref.fieldName || '(未命名字段)',
            fieldId: ref.fieldId,
            count: 1,
            type: meta?.type,
          })
        }
      }
    }
  }

  const fieldRows = [...fieldUsage.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  /**
   * ⚠️ **按"字段类别"分组**（2026-10-17 用户要求：参考"字段"页）。
   *   类别名取 `fieldMeta(type).label` —— 与"字段"页**同一个来源**，不另起一套叫法。
   *   ⚠️ `type` 缺失（字段已失效）⇒ 归到「未知字段」。
   *   ⚠️ 组内按名称排（与原来一致），组间按**首次出现**的顺序（Map 的插入序）
   *      —— 不排序是刻意的：用户刚放的字段类别应该排在前面。
   */
  const byKind: Array<[string, typeof fieldRows]> = (() => {
    const m = new Map<string, typeof fieldRows>()
    for (const f of fieldRows) {
      const label = f.type === undefined ? '未知字段' : fieldMeta(f.type).label
      const arr = m.get(label)
      if (arr) arr.push(f)
      else m.set(label, [f])
    }
    return [...m.entries()]
  })()

  /*
   * ⚠️ **粗估耗时**（2026-10-17）：系数见文件头。
   *   一次性开销（建 DOM + 分页）按"元素数 × 2ms"给 —— 它不随记录数线性增长。
   */
  const estimateMs = Math.round(
    total * 2 + recordCount * (total * 0.05 + codeCount * 0.8 + imgCount * 1.5),
  )
  /*
   * 最近一次**真实预览**的耗时（`preview.ts` 渲染完顺手记下来的）。
   * 没预览过 ⇒ null ⇒ 面板显示一句"点一次预览之后会显示实测"。
   */
  const lastStats = useSyncExternalStore(subscribeRenderStats, getLastRenderStats, () => null)

  /** 哪些类别被用户收起了（默认全展开） */
  const [foldedKind, setFoldedKind] = useState<Record<string, boolean>>({})

  return (
    <div className="bp-panel bp-panel--inspect">
      <div className="bp-panel__scroll">
        <section className="bp-group">
          <div className="bp-group__title">
            画布上的元素<span className="bp-panel__count">{total}</span>
            {/*
             * ⚠️ **按元素种类列出数量**（2026-10-17 用户要求："元素中，统计这些元素标签页中的数量"）。
             *   ⚠️ **含格内的图片/码/附件**（它们也是画布上的元素 —— 用户说"不用考虑是否在表格之中"）。
             *   ⚠️ 手打文字按**字符数**列在这里（它是"文本段落"的内容量）。
             */}
            {/*
             * ⚠️ **直接复用"字段页"的 `bp-chip-item`**（2026-10-17 用户要求："直接引用这个风格"）。
             *   它自带 `background: var(--surface-2)` + 圆角 + hover —— 就是那个"灰底"。
             * ⚠️ 我上一版自造的 `.bp-insp-stat` 用了 `--pp-surface-2`，**主题里没这个变量**
             *   ⇒ 背景透明 ⇒ 用户看到的是"并没有灰底" ✅
             */}
            <div className="bp-group__body">
              {[...elStats.entries()].map(([label, cnt]) => (
                <div className="bp-chip-item bp-chip-item--stat" key={label}>
                  <span className="bp-chip-item__name">{label}</span>
                  <b className="bp-chip-item__num">{cnt}</b>
                </div>
              ))}
              {manualChars > 0 ? (
                <div className="bp-chip-item bp-chip-item--stat">
                  <span className="bp-chip-item__name">字符数</span>
                  <b className="bp-chip-item__num">{manualChars}</b>
                </div>
              ) : null}
            </div>
            {/*
             * ⚠️ **加一句解释**（2026-10-17 用户困惑："字段块明明是多维表格带过来的，为什么算元素"）：
             *   **"拖到画布上的字段"** = `fieldBlock` 元素（能独立移动、有自己的尺寸）；
             *   **"格子里的字段"** = 行内节点，跟着文字流走 ⇒ **不在这个列表里**。
             */}
            <span className="bp-panel__note">拖到画布上的东西；格子里的字段不在这里</span>
          </div>
          {/* ⚠️ **明细列表已移除**（2026-10-17 用户要求：
               "移除下面那个「循环区 表格 字段块」之类的内容，不再进行统计"）。
               ⇒ 这里只保留"按种类计数"，不再逐条列元素。 */}
        </section>

        <section className="bp-group">
          <div className="bp-group__title">
            模板用到的字段<span className="bp-panel__count">{fieldRows.length}</span>
          </div>
          {fieldRows.length === 0 ? (
            <p className="bp-panel__foot">这份模板还没有引用任何字段。</p>
          ) : (
            <div className="bp-group__body bp-group__body--rows">
              {/*
               * ⚠️ **按类别分组**（2026-10-17 用户要求：参考"字段"页）。
               *   · 类别名取 `fieldMeta(type).label`（与"字段"页**同一个来源**）；
               *   · **没用到的类别不显示**（`byKind` 只装出现过的）；
               *   · 每组可收纳（`foldedKind`）。
               * ⚠️ 顺序按 `fieldMeta` 里的声明顺序（`KIND_ORDER`），不按数量 ——
               *   这样和"字段"页的视觉顺序一致，用户不用重新建立心智。
               */}
              {byKind.map(([kindLabel, list]) => {
                const open = !foldedKind[kindLabel]
                return (
                  /* ⚠️ **复用"字段页"的分组头**（2026-10-17 用户要求："保持美术风格一致性"） */
                  <section className="bp-group bp-group--sub" key={kindLabel}>
                    <button
                      type="button"
                      className="bp-group__head"
                      aria-expanded={open}
                      onClick={() => setFoldedKind((v) => ({ ...v, [kindLabel]: open }))}
                    >
                      <span className={`bp-group__caret${open ? ' is-open' : ''}`}>
                        <IconCaret size={12} />
                      </span>
                      <span className="bp-group__name">{kindLabel}</span>
                      <span className="bp-group__count">{list.length}</span>
                    </button>
                    {open ? (
                      <div className="bp-insp-kind__body">
                        {list.map((f) => {
                          const invalid = !!f.fieldId && !knownFieldIds.has(f.fieldId)
                          return (
                            <div key={f.fieldId ?? f.name} className="bp-chip-item bp-chip-item--stat">
                              <span className="bp-insp-row__label">
                                {f.name}
                                {invalid ? <span className="bp-insp-row__bad">已失效</span> : null}
                              </span>
                              <span className="bp-insp-row__pos">×{f.count}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </section>
                )
              })}
            </div>
          )}
          <p className="bp-panel__foot">
            字段本身不能在这里删（它属于数据表）；要删除的是用它的那个元素 —— 点上面元素那一行即可定位。
          </p>
          {/* ⚠️ **渲染耗时**（2026-10-17 用户要求："大概评估下打印的时候会渲染多久"）。
              两行一起给：
                · **粗估** —— 系数算的，检查页在预览之前就能给，只能看量级；
                · **实测** —— 最近一次预览真跑了多久（`render-stats.ts` 记的），100% 真实，
                  但用户可能还没预览过 ⇒ 没有就不显示。
              两个数并列，用户自己判断该信哪个 —— 只给粗估会把"约 3 秒"当成承诺。 */}
          <p className="bp-panel__foot bp-panel__foot--stat">
            预计渲染：<b>约 {fmtMs(estimateMs)}</b>
            {recordCount > 1 ? `（${recordCount} 条记录，按系数粗估）` : '（按系数粗估）'}
          </p>
          {lastStats ? (
            <p className="bp-panel__foot bp-panel__foot--stat">
              上次预览实测：<b>{fmtMs(lastStats.ms)}</b>
              {` （${lastStats.records} 条 · ${lastStats.pages} 页，含 DOM 测量）`}
            </p>
          ) : (
            <p className="bp-panel__foot bp-panel__foot--stat">
              点一次「预览」之后，这里会显示<b>真实</b>耗时（含 DOM 测量与分页）
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
