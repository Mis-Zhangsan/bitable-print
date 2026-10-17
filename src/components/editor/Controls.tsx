/**
 * 属性面板用的表单原子组件。
 *
 * 两条硬约束（PRD F7-03 / F7-04）在这里落地：
 * 1) 类型选择器（纸张、字体、绑定字段）**不能**做成"胶囊 + 下拉框并列显示同一份文字"。
 *    这里统一为"胶囊本身就是按钮"：点开原地弹出胶囊菜单（role=listbox + role=option + aria-selected），
 *    展开时三角指示符旋转 180°。
 * 2) 所有弹出层走 Popover（fixed + 视口收边 + 不透明背景 + z-index ≥ 200）。
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TextStyle } from '../../lib/types'
import { Popover } from './Popover'
import { IconCaret } from './Icons'

// ============================================================
// 布局
// ============================================================

export function Field({
  label,
  hint,
  children,
  inline,
}: {
  label: string
  hint?: string
  children: ReactNode
  /** 标签与控件同行（用于开关、紧凑数值） */
  inline?: boolean
}) {
  return (
    <div className={`bp-field${inline ? ' bp-field--inline' : ''}`}>
      <span className="bp-field__label" title={hint}>
        {label}
      </span>
      <div className="bp-field__body">{children}</div>
    </div>
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  /**
   * ⚠️ **标题右侧的操作区**（2026-10-17 用户要求："插入字段改成右上角 + 图标"）。
   *
   * ⚠️ 必须放在 `<button>` **外面** —— 标题本身是 `<button>`，里面再塞 `<button>` 是非法 HTML
   *   （浏览器会把内层按钮"提"出来、行为也诡异）。
   */
  action?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="bp-sec">
      <button type="button" className="bp-sec__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`bp-sec__caret${open ? ' is-open' : ''}`}>
          <IconCaret size={12} />
        </span>
        <span className="bp-sec__title">{title}</span>
      </button>
      {action ? <div className="bp-sec__action">{action}</div> : null}
      {open ? <div className="bp-sec__body">{children}</div> : null}
    </section>
  )
}

// ============================================================
// 分段控件
// ============================================================

export interface SegOption<T extends string> {
  value: T
  label: string
  title?: string
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: T
  options: SegOption<T>[]
  onChange(v: T): void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <div className="bp-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title ?? o.label}
            disabled={disabled}
            className={`bp-seg__item${active ? ' is-active' : ''}`}
            onClick={() => {
              if (!active) onChange(o.value)
            }}
          >
            <span className="bp-seg__text">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ============================================================
// 数值输入
// ============================================================

export function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  ariaLabel,
  /** 输入过程中的合并 key，让连续敲数字只产生一步撤销 */
  onLiveChange,
  /** ⚠️ 禁用（如"原图"模式下尺寸由图片本身决定，这个框不参与渲染）*/
  disabled = false,
}: {
  value: number
  onChange(v: number): void
  min: number
  max: number
  step?: number
  suffix?: string
  ariaLabel: string
  /** 存在时每次按键都回调（用于即时预览），onChange 仍只在确认时触发 */
  onLiveChange?(v: number): void
  disabled?: boolean
}) {
  const [text, setText] = useState(() => String(normalize(value)))
  /*
   * ⚠️ **"正在输入"标记**（2026-10-15）。
   *
   * 用户报：「填写内边距时，**填完后必须要点击右侧属性的空白区才会保存**，
   *   如果此时点击画布，那么更改就会撤销；改为**只要输入了数字，点击任意区域都保存**」。
   *
   * 根因：提交只在 `onBlur` 里做 ⇒ 点画布时 `blur` 的场景不稳定（画布会 preventDefault），
   *   而重渲染又把 `text` 同步回**旧值** ⇒ 用户看到"更改被撤销"。
   * ⇒ 改成 **onChange 即时提交**（见下面）。
   * ⚠️ 但"即时提交"会踩另一个坑：用户输入 `1.` 时，`value` 变成 1 ⇒
   *   下面的 `useEffect` 会把 `text` 回写成 `"1"` ⇒ **小数点被打断、`1.5` 根本输不进去**。
   * ⇒ 用这个 ref：**聚焦期间不回写**（只有"外部值变化"才需要同步）。
   */
  const focusedRef = useRef(false)

  // 外部值变化（拖动改尺寸等）要同步回输入框
  useEffect(() => {
    if (focusedRef.current) return // ⚠️ 用户正在输入 ⇒ 不回写，否则打断 "1." 这种中间态
    setText(String(normalize(value)))
  }, [value])

  const clamp = (n: number): number => Math.min(Math.max(n, min), max)
  const commit = (raw: string): void => {
    const t = raw.trim()
    if (t === '') {
      setText(String(normalize(value)))
      return
    }
    const n = Number(t)
    if (!Number.isFinite(n)) {
      setText(String(normalize(value)))
      return
    }
    const c = clamp(n)
    setText(String(normalize(c)))
    if (c !== value) onChange(c)
  }

  return (
    /*
     * ⚠️⚠️ **单位（suffix）必须画在输入框「外面」**（2026-10-15 用户要求，原话：
     *   「**左偏移、上偏移为什么两个的单位不一样，有点奇怪，建议把单位放在框外，
     *    不然看不清输入框内的数字**」）。
     *
     * 原来 suffix 在 `.bp-num` 这个**带边框的盒子内部** ⇒ 挤占输入区、数字看不清。
     * ⇒ 外面再包一层 `bp-num-wrap`：内层仍是原来的"带框输入区"，suffix 挂在外层右侧。
     * ⚠️ **在组件内部改** ⇒ 全部调用点（几十处 `suffix="mm"` / `suffix="%"` …）**一个字都不用动**。
     */
    <div className={`bp-num-wrap${disabled ? ' is-disabled' : ''}`}>
      <div className="bp-num">
        {/* 用 text + inputMode 而不是 type=number：number 输入框会把 "1." 这种中间态
            判为非法值并清空，用户根本没法输入 0.25 / 10.5 这类小数 */}
        <input
          className="bp-num__input"
          type="text"
          inputMode="decimal"
          value={text}
          aria-label={ariaLabel}
          disabled={disabled}
          onFocus={() => {
            focusedRef.current = true
          }}
          onChange={(e) => {
            const raw = e.target.value
            setText(raw)
            const n = Number(raw)
            if (raw.trim() === '' || !Number.isFinite(n)) return
            /*
             * ⚠️⚠️ **即时提交**（2026-10-15 用户要求："只要输入了数字，点击任意区域都保存"）。
             *
             * 原来只更新本地 `text`、靠 `onBlur` 提交 ⇒ 点画布时不一定触发 blur、
             *   而且重渲染会把 `text` 拉回旧值 ⇒ 用户看到"更改被撤销"。
             * ⇒ 现在**每次键入就把合法值提交上去**（配合上面的 `focusedRef`：聚焦期间不回写）。
             * ⚠️ 提交失败（非法/空）时**不动 value**，用户继续输入即可。
             */
            const c = clamp(n)
            if (c !== value) onChange(c)
            if (onLiveChange) onLiveChange(c)
          }}
          onBlur={(e) => {
            focusedRef.current = false
            commit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setText(String(normalize(value)))
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              const dir = e.key === 'ArrowUp' ? 1 : -1
              e.preventDefault()
              commit(String(normalize(clamp(value + dir * step))))
            }
          }}
        />
        {/*
          ⚠️ **上下调节按钮**（2026-10-15 用户要求："数字输入框增加上下调节的按钮"）。
          ⚠️ 不用 `type="number"` 的原生 spinner —— 它会把 `1.` 这种中间态判为非法并清空
             （见上面注释），所以自己画两个小三角。
          ⚠️ `tabIndex={-1}`：不要抢走键盘焦点（否则用户按 ↑↓ 会跑到按钮上）。
        */}
        <span className="bp-num__spin">
          <button
            type="button"
            className="bp-num__btn"
            tabIndex={-1}
            aria-label={`增大${ariaLabel}`}
            onPointerDown={(e) => {
              e.preventDefault()
              commit(String(normalize(clamp(value + step))))
            }}
          >
            ▲
          </button>
          <button
            type="button"
            className="bp-num__btn"
            tabIndex={-1}
            aria-label={`减小${ariaLabel}`}
            onPointerDown={(e) => {
              e.preventDefault()
              commit(String(normalize(clamp(value - step))))
            }}
          >
            ▼
          </button>
        </span>
      </div>
      {suffix ? <span className="bp-num__suffix">{suffix}</span> : null}
    </div>
  )
}

function normalize(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

// ============================================================
// 开关
// ============================================================

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onChange(v: boolean): void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`bp-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="bp-switch__knob" />
    </button>
  )
}

// ============================================================
// 颜色
// ============================================================

/** 主题色板：这些是"内容色"（会打印出来），不属于插件 UI 主题，因此允许写死 */
/**
 * ⚠️ **全项目唯一的色板**（2026-10-17 统一）。
 *
 * 用户要求：「颜色**参考二维码中的排列方式，横向一排** …… **不要重复造轮子，能复用的就复用**」。
 * 原来这里有 `SWATCHES`（10 色）和 `TEXT_SWATCHES`（7 色）两份，文字类都在用后者
 * ⇒ 同一个面板里「字体颜色」和「二维码前景」长得不一样，用户看着乱。
 * ⇒ 现在**只留这一份**，文字 / 单元格 / 字段块 / 码全部引用它。
 * ⚠️ 顺序照二维码那排：黑 → 灰阶 → 红橙黄 → 绿 → 蓝 → 紫。
 */
export const SWATCHES = ['#1f2329', '#646a73', '#8f959e', '#f54a45', '#ff8800', '#ffc60a', '#34c724', '#1d9e75', '#3370ff', '#7f77dd']
/** ⚠️ 兼容旧引用（2026-10-17）：**指向同一份 SWATCHES** —— 不要再各写一份。 */
const TEXT_SWATCHES = SWATCHES

export function ColorInput({
  value,
  onChange,
  ariaLabel,
  swatches = SWATCHES,
}: {
  value: string
  onChange(v: string): void
  ariaLabel: string
  swatches?: string[]
}) {
  return (
    <div className="bp-color">
      <input
        className="bp-color__native"
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1f2329'}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="bp-color__swatches" role="group" aria-label={`${ariaLabel}·色板`}>
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            className={`bp-color__dot${c.toLowerCase() === value.toLowerCase() ? ' is-active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={c}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  )
}

// ============================================================
// 胶囊选择器（"胶囊即按钮"）
// ============================================================

export interface CapsuleOption<T extends string> {
  value: T
  label: string
  hint?: string
  /**
   * 分组标题（可选）。按 options 的顺序，**相邻且同组**的选项会自动合并到一个标题下；
   * 用于纸张预设这种"两类用途完全不同、混在一起必选错"的长列表。
   */
  group?: string
}

export function CapsuleSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  disabled,
  width = 200,
}: {
  value: T
  options: CapsuleOption<T>[]
  onChange(v: T): void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  /** 弹出菜单的期望宽度（px），窄屏会自动收窄 */
  width?: number
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Popover
      role="listbox"
      ariaLabel={ariaLabel}
      matchTriggerWidth
      width={width}
      renderTrigger={({ open, toggle, buttonRef }) => (
        <button
          ref={buttonRef}
          type="button"
          className={`bp-picker${open ? ' is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={toggle}
        >
          <span className={`bp-picker__label${current ? '' : ' is-empty'}`}>{current ? current.label : placeholder}</span>
          <span className={`bp-picker__caret${open ? ' is-open' : ''}`}>
            <IconCaret size={12} />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <ul className="bp-picker__list">
          {options.map((o, i) => {
            const active = o.value === value
            // 只在"组变了"的地方插一个标题，同组连续项共用一个（PAPER_PRESETS 就是这么排的）
            const showGroup = !!o.group && o.group !== options[i - 1]?.group
            return (
              <Fragment key={o.value}>
                {showGroup ? (
                  <li className="bp-picker__group" aria-hidden>
                    {o.group}
                  </li>
                ) : null}
                <li className="bp-picker__opt-wrap">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`bp-picker__opt${active ? ' is-active' : ''}`}
                    title={o.hint ?? o.label}
                    onClick={() => {
                      onChange(o.value)
                      close()
                    }}
                  >
                    <span className="bp-picker__opt-label">{o.label}</span>
                    {active ? <span className="bp-picker__tick" aria-hidden /> : null}
                  </button>
                </li>
              </Fragment>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}

// ============================================================
// 绑定字段选择器（带类型色块与搜索）
// ============================================================

export interface FieldPickerProps {
  /** 传入 fieldId，null 表示未绑定 */
  value: string | null
  /** 展示用的字段名（未绑定时用于回显历史名） */
  fallbackName?: string
  options: { id: string; name: string; tint: string; blocked?: boolean; group?: string; note?: string }[]
  onChange(id: string | null, name: string): void
  ariaLabel: string
  /** 允许"不绑定"选项 */
  allowEmpty?: boolean
}

export function FieldPicker({ value, fallbackName, options, onChange, ariaLabel, allowEmpty = true }: FieldPickerProps) {
  const [kw, setKw] = useState('')
  const current = options.find((o) => o.id === value)
  const filtered = kw.trim() ? options.filter((o) => o.name.toLowerCase().includes(kw.trim().toLowerCase())) : options

  return (
    <Popover
      role="dialog"
      ariaLabel={ariaLabel}
      matchTriggerWidth
      width={260}
      renderTrigger={({ open, toggle, buttonRef }) => (
        <button
          ref={buttonRef}
          type="button"
          className={`bp-picker${open ? ' is-open' : ''}${current ? '' : ' is-warn'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {current ? <span className="bp-chip-item__dot" style={{ background: current.tint }} aria-hidden /> : null}
          <span className={`bp-picker__label${current ? '' : ' is-empty'}`}>
            {current ? current.name : fallbackName ? `⚠ ${fallbackName}` : '未绑定字段'}
          </span>
          <span className={`bp-picker__caret${open ? ' is-open' : ''}`}>
            <IconCaret size={12} />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <div className="bp-fieldpicker">
          {options.length > 8 ? (
            <input
              className="bp-fieldpicker__search"
              value={kw}
              placeholder="搜索字段"
              aria-label="搜索字段"
              onChange={(e) => setKw(e.target.value)}
            />
          ) : null}
          <ul className="bp-picker__list bp-fieldpicker__list" role="listbox" aria-label={ariaLabel}>
            {allowEmpty ? (
              <li className="bp-picker__opt-wrap">
                <button
                  type="button"
                  role="option"
                  aria-selected={value === null}
                  className={`bp-picker__opt${value === null ? ' is-active' : ''}`}
                  onClick={() => {
                    onChange(null, fallbackName ?? '')
                    close()
                  }}
                >
                  <span className="bp-picker__opt-label">不绑定（纯文本）</span>
                </button>
              </li>
            ) : null}
            {filtered.map((o) => (
              <li key={o.id} className="bp-picker__opt-wrap">
                <button
                  type="button"
                  role="option"
                  aria-selected={o.id === value}
                  className={`bp-picker__opt${o.id === value ? ' is-active' : ''}${o.blocked ? ' is-blocked' : ''}`}
                  title={o.note ?? o.name}
                  onClick={() => {
                    onChange(o.id, o.name)
                    close()
                  }}
                >
                  <span className="bp-chip-item__dot" style={{ background: o.tint }} aria-hidden />
                  <span className="bp-picker__opt-label">{o.name}</span>
                  {o.group ? <span className="bp-picker__opt-tag">{o.group}</span> : null}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? <li className="bp-picker__empty">没有匹配的字段</li> : null}
          </ul>
        </div>
      )}
    </Popover>
  )
}

// ============================================================
// 字形：下划虚线
// ============================================================

/**
 * 「下划虚线」的开关值（各面板共用，保证四处口径一致）。
 *
 * 已经是虚线 ⇒ 关掉（`underline` 与 `underlineStyle` 一起清，不留半截状态）；
 * 否则 ⇒ 开成虚线。
 */
export function underlineDashToggle(
  s: TextStyle | undefined,
): { underline?: boolean; underlineStyle?: 'dashed' } {
  const on = s?.underline === true && s?.underlineStyle === 'dashed'
  return on ? { underline: undefined, underlineStyle: undefined } : { underline: true, underlineStyle: 'dashed' }
}

/**
 * 「下划虚线」按钮（2026-10-17 用户要求：所有字形区域都要有这个样式）。
 *
 * 为什么**单独一个按钮**、而不是把 U 做成"无 → 实线 → 虚线"三态循环：
 * U 回答的是"**要不要**下划线"，这个按钮回答的是"下划线**长什么样**"。
 * 点 U 仍然得到实线（老习惯一个字都不变），想要填空线（`经办人：_ _ _ _`）再点这个。
 *
 * 按钮里的 `U` 自己带一条虚线（CSS `.bp-deco-dash`），和旁边那条实线的 U 一眼能分开。
 */
export function UnderlineDashBtn({
  style,
  onToggle,
  hint,
}: {
  style?: TextStyle
  onToggle: () => void
  /** 追加在 title 末尾的说明（各面板语汇不同，例如「只作用这一处」） */
  hint?: string
}) {
  const on = style?.underline === true && style?.underlineStyle === 'dashed'
  return (
    <button
      type="button"
      className={`bp-tgl bp-tgl--underdash${on ? ' is-on' : ''}`}
      aria-label="下划虚线"
      aria-pressed={on}
      title={`下划虚线${hint ? `（${hint}）` : ''} —— 拼填空线用，例如「经办人：_ _ _ _」`}
      onClick={onToggle}
    >
      <span className="bp-deco-dash">U</span>
    </button>
  )
}

/**
 * 「下划线（实线）」的开关值。
 *
 * ⚠️ 开的时候要**显式**写 `underlineStyle: undefined`：用户上次可能开的是虚线，
 * 只写 `underline: true` 会沿用上次的线型 ⇒ "点 U 得到虚线"，非常费解。
 * 想用虚线请走 `underlineDashToggle`。
 */
export function underlineSolidToggle(
  s: TextStyle | undefined,
): { underline?: boolean; underlineStyle?: undefined } {
  return s?.underline
    ? { underline: undefined, underlineStyle: undefined }
    : { underline: true, underlineStyle: undefined }
}
