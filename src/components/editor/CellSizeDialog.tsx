/**
 * 「行高 / 列宽」的输入弹层（2026-10-13 用户需求）。
 *
 * 用户原话：「**单元格右键属性无法修改行高、列宽数据，增加该功能**」。
 *
 * 三条设计约定（**刻意与 `SplitCellDialog` 对齐**，两处行为要一致）：
 *  ① **上下限来自动作层**（`MIN_ROW_MM` / `MIN_COL_MM`）——这里不重写一份判据，
 *     否则会出现"弹层说能设、点了设不了"。
 *  ② **单位是 mm**：与右侧面板「第 N 列」输入框**同一个口径**。
 *     ⚠️ 不提供 px 档：面板也没有，两处读数不一致比"少一个单位"更坏
 *     （本项目在"格内子元素 w 用百分比还是 mm"上已经吃过这个亏）。
 *  ③ **行高多一个第三态**（恢复自适应）：`TableRow.heightMm` 缺席 = "由内容撑开"。
 *     拖边框能回到这个状态（拖过下限 / 双击），弹层也得给一条**明确**的路 ——
 *     否则"我把行高设成 20 了，怎么变回自动？"在弹层里无解。
 *
 * ⚠️ 视觉沿用 `bp-confirm-backdrop` / `bp-merge-confirm` 那套类名，
 *    保证"编辑器里的确认层长得都一样"。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MIN_COL_MM, MIN_ROW_MM } from './table-actions'

export interface CellSizeDialogProps {
  /** 改的是行高还是列宽 */
  kind: 'row' | 'col'
  /** 第几行 / 第几列（1 基，只用于文案） */
  indexLabel: string
  /** 当前值（mm）；行高可能缺席（自适应）⇒ 传 null */
  currentMm: number | null
  /** 行高才给：恢复"按内容自适应" */
  onReset?: () => void
  onConfirm(mm: number): void
  onCancel(): void
}

export function CellSizeDialog({
  kind,
  indexLabel,
  currentMm,
  onReset,
  onConfirm,
  onCancel,
}: CellSizeDialogProps): ReactNode {
  const isRow = kind === 'row'
  const unit = isRow ? '行高' : '列宽'
  const lo = isRow ? MIN_ROW_MM : MIN_COL_MM
  const hi = 500
  /*
   * 初值：优先用当前值；行高是自适应（null）时给一个**具体的起点**（18mm）
   * —— 留空会让用户不知道"不填"是什么意思。
   */
  const [v, setV] = useState(() => String(Math.round((currentMm ?? 18) * 10) / 10))

  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      /* 与 Popover / MergeConfirm / SplitCellDialog 同一口径：捕获阶段拦掉，
         否则编辑器的 Esc（取消选中）会一起触发 */
      e.stopPropagation()
      cancelRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const num = (raw: string): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return lo
    return Math.round(Math.min(Math.max(n, lo), hi) * 10) / 10
  }

  return createPortal(
    <div
      className="bp-confirm-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="bp-merge-confirm" role="dialog" aria-modal="true" aria-label={`${unit}设置`}>
        <p className="bp-merge-confirm__title">{unit}设置</p>
        <p className="bp-merge-confirm__text">
          第 {indexLabel} {isRow ? '行' : '列'}的{unit}
          {currentMm === null ? '（当前：按内容自适应）' : `（当前：${Math.round(currentMm * 10) / 10}mm）`}
        </p>
        <div className="bp-tsp__row">
          <span className="bp-tsp__label">
            {unit}(mm)
          </span>
          <div className="bp-tsp__ctrl">
            <button
              type="button"
              className="bp-tsp__btn"
              aria-label={`减小${unit}`}
              onClick={() => setV(String(Math.max(lo, Math.round((num(v) - 1) * 10) / 10)))}
            >
              −
            </button>
            <input
              className="bp-splitcell__input"
              type="text"
              inputMode="decimal"
              role="spinbutton"
              aria-label={`${unit}（毫米）`}
              aria-valuemin={lo}
              aria-valuemax={hi}
              aria-valuenow={num(v)}
              value={v}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onConfirm(num(v))
                }
              }}
            />
            <button
              type="button"
              className="bp-tsp__btn"
              aria-label={`增大${unit}`}
              onClick={() => setV(String(Math.min(hi, Math.round((num(v) + 1) * 10) / 10)))}
            >
              +
            </button>
          </div>
        </div>
        {/*
          行高专属：恢复"按内容自适应"。
          ⚠️ 只在**行高**上出现 —— 列宽没有"自适应"这个态（列宽恒是显式值）。
        */}
        {isRow && onReset ? (
          <p className="bp-merge-confirm__text">
            <button type="button" className="bp-btn" aria-label="恢复按内容自适应" onClick={onReset}>
              恢复「按内容自适应」
            </button>
          </p>
        ) : null}
        <div className="bp-btnrow bp-merge-confirm__btns">
          <button type="button" className="bp-btn" aria-label={`取消设置${unit}`} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="bp-btn bp-btn--primary"
            aria-label={`确认设置${unit}`}
            onClick={() => onConfirm(num(v))}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
