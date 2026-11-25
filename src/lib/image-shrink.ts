/**
 * 把图片压到**字节上限**以内（浏览器环境，依赖 canvas）。
 *
 * 从 `Inspector.tsx` 下沉到这里（2026-10-19）：**上传固定图片**和**Word 导入**都要用，
 * 而导入那条路在 `lib/` 侧、够不到组件里的私有函数。
 *
 * ## 为什么要有它
 *
 * 图片是**以 base64 存进模板 JSON** 的，而整份 JSON 最终写进飞书**一个文本单元格**，
 * 那个单元格的硬上限是 **10 万字、超出静默截断**（见 `template-store.ts` 的
 * `TEMPLATE_CHAR_BUDGET`）。base64 的字符数 ≈ 字节 × 4/3：
 *   300KB ⇒ 约 41 万字（一张图就撑爆 4 倍）；
 *   50KB  ⇒ 约 6.8 万字（能装下，还留得出正文的位置）。
 *
 * ## 策略
 *
 * 先把最长边限到 2400px，再从 JPEG 质量 0.85 往下试；四档都超就继续缩小最长边，最多 6 轮。
 * ⚠️ 一律转成 JPEG ⇒ **透明区会被填成白色**（打印本来就是印在白纸上，这个取舍可接受）。
 */

/**
 * **内嵌模板的单张图片上限 = 50KB**。
 *
 * ⚠️⚠️ 原来是 300KB，2026-10-19 降下来 —— 这是"固定图片保存后消失"的真凶：
 * 图片以 base64 存进模板 JSON、再整份写进飞书**一个文本单元格**，而那个单元格
 * 硬上限 **10 万字、超出静默截断**。base64 字符数 ≈ 字节 × 4/3：
 *   · 300KB ⇒ 约 41 万字 ⇒ 一张图撑爆 4 倍 ⇒ JSON 后半截被砍（图片排在末尾）⇒ 图片消失；
 *   · 50KB  ⇒ 约 6.8 万字 ⇒ 留得出 3 万字给正文与结构。
 *
 * ⚠️ 代价是分辨率下降（50KB JPEG 大约 800×600）。
 *   要高清必须用**附件字段取图**（图存飞书附件、模板只存字段引用），这条路在规划中。
 */
export const EMBED_IMAGE_MAX_BYTES = 50 * 1024

/** 估算 dataURL 的**原始字节数**（去掉 `data:...;base64,` 前缀再按 3/4 反算） */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.round((b64.length * 3) / 4)
}

/** 从 dataURL 里捞出 MIME（`data:image/png;base64,...` ⇒ `image/png`） */
export function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1] : 'image/png'
}

/** dataURL → HTMLImageElement（浏览器）；解析失败返回 null */
function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

/**
 * 压缩：返回新的 dataURL 与实际字节数；压不动（或环境不支持 canvas）返回 `null`。
 *
 * ⚠️ 已经是 dataURL 且**本来就小于上限**时，调用方应该**跳过它**（这里也会原样返回，
 * 但会多一次解码 + 重编码，PNG 的透明通道会白丢）。
 */
export async function shrinkDataUrl(
  dataUrl: string,
  limit: number,
): Promise<{ dataUrl: string; bytes: number } | null> {
  if (typeof document === 'undefined') return null
  const img = await loadImage(dataUrl)
  if (!img || !img.naturalWidth || !img.naturalHeight) return null

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const longest = Math.max(img.naturalWidth, img.naturalHeight)
  let maxEdge = Math.min(2400, longest)
  const PREFIX = 'data:image/jpeg;base64,'

  for (let round = 0; round < 6; round += 1) {
    const scale = Math.min(1, maxEdge / longest)
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    /* 先铺白：JPEG 没有 alpha，不铺的话透明区会变成黑块 */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const out = canvas.toDataURL('image/jpeg', q)
      const bytes = dataUrlBytes(out)
      if (bytes <= limit) return { dataUrl: out, bytes }
    }
    maxEdge = Math.round(maxEdge * 0.7)
  }
  return null
}

/**
 * 生成一张**极小的缩略图**（dataURL），用于"图片已经存到附件"时的**兜底显示**。
 *
 * ## 为什么需要它
 *
 * 附件链路（`fileToken` → 临时 URL）已经跑通，但**任何一环断掉图就空白**
 * （URL 10 分钟过期、网络抖动、记录被复制到别的表……）。留一张缩略图当兜底，
 * 代价是每张图占约 3-5 千字符，而不是原来的 6.8 万 —— 20 张图也塞得进 10 万字。
 *
 * ⚠️ **只在保存时用**：编辑期显示的是原图（URL 或 50KB 压缩版），不能提前变糊。
 * ⚠️ 目标尺寸 96px：打印肯定不够，但"看得出这是一张图"就够了 —— 它的职责只是兜底。
 */
export async function makeThumbDataUrl(dataUrl: string, maxEdge = 96): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const img = await loadImage(dataUrl)
  if (!img || !img.naturalWidth || !img.naturalHeight) return null
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const longest = Math.max(img.naturalWidth, img.naturalHeight)
  const scale = Math.min(1, maxEdge / longest)
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.55)
}
