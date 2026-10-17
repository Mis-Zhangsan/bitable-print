/**
 * ⚠️ **"整体改样式 ⇒ 覆盖子节点覆写"的唯一实现**（2026-10-17 收敛）。
 *
 * 背景（用户的原话很有价值）：
 *   「为什么会有那么多入口，每个入口的生效还不统一，**是不是重复造轮子了**」
 *   —— **是的**。"改样式"按作用域分了 3 层（节点/单元格/元素），而 **3 个 UI 入口各自实现了一遍**：
 *     · 右侧面板（单元格）→ `Inspector.patchCellStyle`
 *     · 右侧面板（元素）  → `Inspector.patchStyle`
 *     · 画布顶部工具栏    → `Toolbar.applyPatch`（`scope==='cell'`）
 *   ⇒ "清掉子节点覆写"这段逻辑被抄了 3 份 ⇒ 用户改一处、得让我补另外两处，
 *     为此**复测了三轮**（每次都是"那个字段还是粗的/还是 20 号"）。
 *
 * ⇒ 这段逻辑必须**只有一个实现**。三个入口都调它。
 *
 * ⚠️ 细节（都是踩过的）：
 *   · 用**解构删除**，不写 `style: undefined` —— 让"没有覆写"**只有一种形态**
 *     （否则以后判断"有没有覆写"要判两个值，`nodeStyleCount` 那套也会受影响）；
 *   · `br` **没有 `style` 字段** ⇒ 原样返回（写上去会多一个不存在的属性）；
 *   · 本来就没 `style` 的节点 ⇒ **原样返回同一个对象**（保持引用，便于上游做"是否变化"的判断）。
 */
import type { InlineNode } from '../../lib/types'

export function clearNodeStyles(nodes: InlineNode[]): InlineNode[] {
  return nodes.map((n) => {
    if (n.type === 'br') return n
    if (!n.style) return n
    const { style: _drop, ...rest } = n
    void _drop
    return rest as InlineNode
  })
}
