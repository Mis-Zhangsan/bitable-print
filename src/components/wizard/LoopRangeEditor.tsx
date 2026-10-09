/**
 * 手动圈定循环区（PRD **F3-12b**，2026-10-02 接线）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *
 * Word 模板导入靠"扫循环标签"来切版式区（表头区 / 循环区 / 表尾区）。
 * 但**官方标签语法至今没拿到真实样例** —— `loop.ts` 里那套规则是按经验猜的，
 * 猜不中就识别不出循环区，而循环区识别错的后果是**整份模板整片错位**
 * （所有记录挤在表头里、或表尾跟着每条记录重复）。
 *
 * 在此之前，用户遇到这种情况**没有任何补救手段** —— 只能放弃这个模板。
 *
 * ── 实现取向：列块 + 点选，而不是可视化拖框 ──────────────────────────────
 *
 * `rebuildWithMatches` 要的 `loopRanges` 是**块的起止索引**（`IRLoopRange.startBlock/endBlock`），
 * 所以真正的选择粒度就是"块"。据此有两种做法：
 *   · 在还原后的版面上**拖框圈选** —— 直观，但要另做一套版面预览与命中测试；
 *   · **把块列出来，点选起点和终点** —— 直接对应数据结构，不会选错粒度。
 *
 * 选后者：**用户真正需要的是"从哪一段到哪一段"这个语义**，
 * 而"哪一段"用文字预览比用版面位置更好认（版面里两块可能长得一样）。
 *
 * ⚠️ 本组件是纯受控展示层：**只负责产出 `{startBlock, endBlock, name}`**，
 *    真正重算模板由调用方交给 `makeManualLoop` + `rebuildWithMatches({loopRanges})`（那里是纯函数）。
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { IRBlock, IRDoc } from '../../import/ir'

/**
 * 块的可读预览。
 *
 * ⚠️ 只有段落有文本（`IRParagraph.text`）；表格/不支持的块给一句形态说明 ——
 *    **不能返回空串**：列表里几行空白，用户根本分不清哪行是哪个块，
 *    而"选错块"在这里的代价是整份模板错位。
 */
function blockPreview(b: IRBlock): string {
  if (b.kind === 'paragraph') {
    const t = b.text.trim()
    if (t) return t.length > 60 ? `${t.slice(0, 60)}…` : t
    return '（空段落）'
  }
  if (b.kind === 'table') {
    const rows = b.rows.length
    const cols = b.colWidthsMm.length
    return `表格 ${rows} 行 × ${cols} 列`
  }
  return '（不支持的内容，导入时已忽略）'
}

/** 块的类型标签（给列表左侧的窄标签用） */
function blockKindLabel(b: IRBlock): string {
  return b.kind === 'paragraph' ? '段落' : b.kind === 'table' ? '表格' : '其他'
}

export interface LoopRangeEditorProps {
  ir: IRDoc
  /**
   * 用户点了「应用」。
   * ⚠️ 索引是**闭区间**（与 `IRLoopRange` 一致）：起止都算在内。
   */
  onApply(range: { startBlock: number; endBlock: number; name?: string }): void
}

export function LoopRangeEditor({ ir, onApply }: LoopRangeEditorProps): ReactNode {
  const [start, setStart] = useState<number | null>(null)
  const [end, setEnd] = useState<number | null>(null)
  const [name, setName] = useState('')

  /** 已被**自动识别**的块区间集合 —— 列表里标出来，让用户知道哪些不用管 */
  const detected = useMemo(() => {
    const marks = new Map<number, 'start' | 'end' | 'in'>()
    for (const r of ir.loop?.ranges ?? []) {
      marks.set(r.startBlock, 'start')
      marks.set(r.endBlock, 'end')
      for (let i = r.startBlock + 1; i < r.endBlock; i += 1) {
        if (!marks.has(i)) marks.set(i, 'in')
      }
    }
    return marks
  }, [ir.loop])

  /**
   * 选块。交互刻意做成"**先点起点、再点终点**"的两步式（而不是两个下拉框）：
   * 用户是顺着文档往下看的，看到起点点一下、看到终点再点一下，
   * 比"先在 A 下拉里找起点、再去 B 下拉里找终点"少一次回头。
   * ⚠️ 再点一次同一个块 = 取消（误点要能撤销，否则只能从头来）。
   */
  const pick = (idx: number): void => {
    if (start === null || (start !== null && end !== null)) {
      setStart(idx)
      setEnd(null)
      return
    }
    if (idx === start) {
      setStart(null)
      return
    }
    /* 终点必须在起点之后：反着选就让起点跟过去，而不是给一句"不能这样选"的报错 */
    if (idx < start) {
      setStart(idx)
      return
    }
    setEnd(idx)
  }

  const ready = start !== null && end !== null && end > start

  return (
    <div className="wiz-loop">
      <p className="wiz-hint">
        循环区是<b>每条记录重复</b>的那一段。自动识别不准时，在下面点一下<b>起点</b>、再点一下<b>终点</b>
        （都是段落/表格左侧的编号），然后应用。
      </p>

      <div className="wiz-loop-list" role="listbox" aria-label="文档内容块">
        {ir.blocks.map((b, idx) => {
          const isStart = start === idx
          const isEnd = end === idx
          const inRange = start !== null && end !== null && idx > start && idx < end
          const auto = detected.get(idx)
          return (
            <button
              type="button"
              key={idx}
              role="option"
              aria-selected={isStart || isEnd}
              className={
                'wiz-loop-row' +
                (isStart ? ' is-start' : '') +
                (isEnd ? ' is-end' : '') +
                (inRange ? ' is-in' : '')
              }
              onClick={() => pick(idx)}
              title={blockPreview(b)}
            >
              <span className="wiz-loop-idx">{idx}</span>
              <span className="wiz-loop-kind">{blockKindLabel(b)}</span>
              <span className="wiz-loop-text">{blockPreview(b)}</span>
              {auto ? (
                <span className="wiz-loop-auto" title="已被自动识别为循环区的一部分">
                  {auto === 'start' ? '循环起点' : auto === 'end' ? '循环终点' : '循环内'}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="wiz-loop-foot">
        <span className="wiz-loop-picked">
          {start === null ? (
            '还没选起点'
          ) : end === null ? (
            <>
              起点 <strong>#{start}</strong>，再点一下终点
            </>
          ) : (
            <>
              已选 <strong>#{start}</strong> – <strong>#{end}</strong>（共 {end - start + 1} 块）
            </>
          )}
        </span>
        <label className="wiz-loop-name">
          <span>集合名</span>
          <input
            type="text"
            value={name}
            placeholder="可留空"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="app-btn sm primary"
          disabled={!ready}
          onClick={() => {
            if (start === null || end === null) return
            const n = name.trim()
            onApply({ startBlock: start, endBlock: end, ...(n ? { name: n } : {}) })
          }}
        >
          应用为循环区
        </button>
      </div>
    </div>
  )
}
