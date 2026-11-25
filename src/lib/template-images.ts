/**
 * 模板里的**图片**：遍历、压缩、体积明细。
 *
 * ## 为什么需要这一层
 *
 * 图片以 base64 存在模板 JSON 里，而整份 JSON 要写进飞书**一个文本单元格**
 * （硬上限 10 万字、超出静默截断，见 `template-store.ts` 的 `TEMPLATE_CHAR_BUDGET`）。
 * 所以任何"往模板里塞图"的入口（手动上传、Word 导入）都必须先压到预算以内。
 *
 * ## 遍历范围
 *
 * 不只是顶层元素：**表格单元格里的 `children`** 也是图片的家（`TableCell.children`）。
 * Word 导入的图有可能落在格子里，漏了那条路就会"明明压过还是超限"。
 */
import type { AnyElement, TableElement, TemplateDoc } from './types'
import type { UploadedImageInfo } from './data-source'
import { dataUrlBytes, makeThumbDataUrl, shrinkDataUrl } from './image-shrink'

type ImageEl = Extract<AnyElement, { kind: 'image' }>

/** 模板里的**所有**图片元素（含表格格内的子元素） */
export function docImageElements(doc: TemplateDoc): ImageEl[] {
  const out: ImageEl[] = []
  const visit = (els: readonly AnyElement[] | undefined): void => {
    for (const el of els ?? []) {
      if (el.kind === 'image') {
        out.push(el)
        continue
      }
      if (el.kind === 'table') {
        for (const row of (el as TableElement).rows) {
          for (const cell of row.cells) {
            visit(cell.children as AnyElement[] | undefined)
          }
        }
      }
    }
  }
  visit(doc.bands.header)
  visit(doc.bands.loop?.elements)
  visit(doc.bands.footer)
  return out
}

export interface ShrinkImagesResult {
  /** 压缩前后**图片占用的字符数**（估算值，用于给用户看"省了多少"） */
  beforeChars: number
  afterChars: number
  /** 真的被压过的张数 */
  shrunk: number
  /** 压不动（解码失败 / 环境不支持 canvas）的张数 */
  failed: number
}

/**
 * 把模板里**所有超过 `limitBytes` 的图片**压到上限以内（就地把 `dataUrl` 换成新的）。
 *
 * ⚠️ **本来就小于上限的图片一律跳过**：重编码会丢 PNG 的透明通道，也白费时间。
 * ⚠️ 就地改传入的 `doc`（调用方应当先 `cloneDoc`）；返回的是统计信息，不是新文档。
 */
export async function shrinkDocImages(doc: TemplateDoc, limitBytes: number): Promise<ShrinkImagesResult> {
  const images = docImageElements(doc)
  const res: ShrinkImagesResult = { beforeChars: 0, afterChars: 0, shrunk: 0, failed: 0 }
  for (const img of images) {
    const before = typeof img.dataUrl === 'string' ? img.dataUrl.length : 0
    res.beforeChars += before
    /*
     * ⚠️ **已经有 `fileToken` 的跳过**（2026-10-19）：它的图在飞书附件里，
     * `dataUrl` 只是编辑期的显示副本、保存时会被剥掉 —— 压它纯属浪费时间和画质。
     */
    if (img.fileToken) {
      res.afterChars += before
      continue
    }
    if (!img.dataUrl || dataUrlBytes(img.dataUrl) <= limitBytes) {
      res.afterChars += before
      continue
    }
    const shrunk = await shrinkDataUrl(img.dataUrl, limitBytes)
    if (!shrunk) {
      res.failed += 1
      res.afterChars += before
      continue
    }
    img.dataUrl = shrunk.dataUrl
    res.shrunk += 1
    res.afterChars += shrunk.dataUrl.length
  }
  return res
}

export interface DocSizeBreakdown {
  /** JSON 字符数（= 飞书单元格要吃掉的字数） */
  chars: number
  /** 图片张数 */
  imageCount: number
  /** 图片 dataUrl 一共占了多少字符 */
  imageChars: number
  /** 除图片以外的部分（正文 / 结构） */
  textChars: number
}

/**
 * 体积明细 —— 给"超限报错"用。
 *
 * 用户原话（2026-10-19）：「只说 X 千字超了，用户不知道该删哪个」。
 * 把"文字占多少 / 图片占多少"拆开说，用户才知道该砍图还是砍正文。
 */
export function docSizeBreakdown(doc: TemplateDoc): DocSizeBreakdown {
  const text = JSON.stringify(doc)
  let imageChars = 0
  let imageCount = 0
  for (const img of docImageElements(doc)) {
    if (typeof img.dataUrl !== 'string' || img.dataUrl === '') continue
    imageCount += 1
    imageChars += img.dataUrl.length
  }
  return {
    chars: text.length,
    imageCount,
    imageChars,
    /* 差值可能为负吗？不会：dataUrl 是 JSON 的子串。负数兜 0 只是防御 */
    textChars: Math.max(0, text.length - imageChars),
  }
}

/** 把字符数说成人话（`12_345` ⇒ `1.2 万字`） */
export function formatChars(chars: number): string {
  if (chars < 10_000) return `${chars} 字`
  return `${(chars / 10_000).toFixed(1)} 万字`
}

/**
 * 模板图片在**附件字段里的文件名**。
 *
 * ⚠️⚠️ **必须带扩展名**（2026-10-19 用户实测："图片格式貌似不对，无法查看"）：
 * 飞书靠**文件名后缀**判断附件类型、生成预览 —— 写 `tplimg-abc123` 这种裸名，
 * 记录能存进去但**打不开**。
 * ⚠️ 同时它还是"重新打开时把图对回元素"的兜底键（token 可能被飞书重写），
 * 所以**保存和读取必须用同一个函数**，别各写一份拼字符串。
 */
export function templateImageFileName(elementId: string, mime?: string): string {
  const t = (mime ?? '').toLowerCase()
  const ext =
    t === 'image/png'
      ? 'png'
      : t === 'image/gif'
        ? 'gif'
        : t === 'image/webp'
          ? 'webp'
          : t === 'image/svg+xml'
            ? 'svg'
            : t === 'image/bmp'
              ? 'bmp'
              : 'jpg'
  return `tplimg-${elementId}.${ext}`
}

// ============================================================
// 上传器注册（服务定位器）
// ============================================================

/**
 * 模板图片的**上传入口**。
 *
 * ⚠️ 为什么用"注册"而不是把 `store` 一层层传下去：选图的入口在 `Inspector`（很深的叶子组件），
 *    而 `store` 只存在于向导那一边。为了一个上传能力把 `store` 穿过 6 层 props，
 *    换来的只是"依赖更显式"这一条 —— 而这条链路里每一层都不关心图片。
 *    ⇒ 在这里放一个**唯一**的注册点，`useWizardState` 初始化时注册一次。
 *
 * ⚠️ 没注册（比如 mock 环境 / 单测）⇒ 返回空数组 ⇒ 调用方**自动降级**为 base64 存图。
 */
let uploader: ((files: File[]) => Promise<UploadedImageInfo[]>) | null = null

export function registerTemplateImageUploader(fn: ((files: File[]) => Promise<UploadedImageInfo[]>) | null): void {
  uploader = fn
}

/** 上传固定图片，返回**完整信息**（失败 / 未注册时返回空数组，调用方应退回 base64） */
export async function uploadTemplateImageFiles(files: File[]): Promise<UploadedImageInfo[]> {
  if (!uploader || files.length === 0) return []
  try {
    return await uploader(files)
  } catch {
    return []
  }
}

/**
 * **保存前把"已经有附件 token"的图片的 `dataUrl` 剥掉**。
 *
 * ## 为什么要有这一步
 *
 * 编辑期图片元素同时带着两样东西：
 *   · `fileToken` —— 图片本体在飞书附件里（原图）；
 *   · `dataUrl`   —— 压缩过的内联副本，**只用来在编辑期显示**。
 *
 * 为什么编辑期不能只靠 token：刚上传的图还没写进任何记录的附件字段
 * （`batchUploadFile` 只负责传到云空间），所以在"保存并重新打开"之前**拿不到 URL**。
 *
 * 保存时把 `dataUrl` 剥掉，模板 JSON 里就只剩几十字节的 token ⇒ 彻底不受
 * 飞书 10 万字单元格上限的约束。重新打开时由 `template-image-store` 换回原图 URL。
 *
 * ⚠️ **只剥有 token 的**：没有 token 的（上传失败降级的）必须留着，否则图就没了。
 * ⚠️ 就地修改传入的 doc（调用方应当传一份 clone）。
 */
export function stripInlineImagesForSave(doc: TemplateDoc): void {
  for (const img of docImageElements(doc)) {
    if (typeof img.fileToken === 'string' && img.fileToken !== '') delete img.dataUrl
  }
}

/**
 * 把模板里的**内联图片**（`dataUrl`）批量上传到飞书附件，并给元素写上 `fileToken`。
 *
 * 用在 **Word 导入**这条路上：导入出来的图是 Word 里的原图（base64），
 * 不转成附件的话模板 JSON 必然撑爆 10 万字。
 *
 * ⚠️ **`dataUrl` 必须保留**：刚上传的图还没写进任何记录的附件字段，
 *    拿不到访问 URL ⇒ 编辑器里要靠这份压缩副本显示。
 *    真正剥掉是在保存时（`stripInlineImagesForSave`）。
 * ⚠️ 单张失败不影响其它张（返回成功数）；失败的保持内联，不会丢图。
 */
export async function uploadInlineImages(doc: TemplateDoc): Promise<{ uploaded: number; failed: number }> {
  const targets = docImageElements(doc).filter((i) => !i.fileToken && i.dataUrl)
  if (targets.length === 0) return { uploaded: 0, failed: 0 }

  const files: File[] = []
  const owners: ImageEl[] = []
  for (const img of targets) {
    /* eslint-disable no-await-in-loop */
    try {
      const url = img.dataUrl as string
      const blob = await (await fetch(url)).blob()
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : 'jpg'
      /* ⚠️ 文件名用元素 id + **扩展名**（见 templateImageFileName 的注释） */
      files.push(new File([blob], templateImageFileName(img.id, blob.type), { type: blob.type || 'image/jpeg' }))
      owners.push(img)
    } catch {
      /* 解不开这张就跳过，后面按 failed 计数 */
    }
  }
  if (files.length === 0) return { uploaded: 0, failed: targets.length }

  const uploaded = await uploadTemplateImageFiles(files)
  let ok = 0
  owners.forEach((img, i) => {
    const up = uploaded[i]
    if (up && typeof up.token === 'string' && up.token !== '') {
      img.fileToken = up.token
      /* ⚠️ 元信息必须一起留下：写附件字段要完整对象，见 ImageElement.fileMeta 的注释 */
      /* 与上传时同一个函数：保存和读取必须用同一个名字 */
      img.fileMeta = { name: templateImageFileName(img.id, up.type), size: up.size, type: up.type }
      ok += 1
    }
  })
  return { uploaded: ok, failed: targets.length - ok }
}

/**
 * **保存前瘦身**：把"已经存到附件"的图片的 `dataUrl` 换成**极小缩略图**。
 *
 * 与 `stripInlineImagesForSave`（直接删）的区别：删了之后万一附件 URL 取不到就是**空白**；
 * 换成缩略图则至少还能看见一张糊图，而且每张只占 3-5 千字符（20 张也能进 10 万字）。
 *
 * ⚠️ **只处理有 `fileToken` 的**：没传上去的（降级内联）必须保留完整压缩图，否则就真丢了。
 * ⚠️ 就地改传入的 `doc`（调用方应传 clone —— 编辑器里的那份要保持原图显示）。
 * ⚠️ 非浏览器环境（Node 单测）没有 canvas ⇒ 退回"直接删"（同 strip）。
 */
export async function slimDocImagesForSave(doc: TemplateDoc): Promise<{ slimmed: number; removed: number }> {
  let slimmed = 0
  let removed = 0
  for (const img of docImageElements(doc)) {
    if (typeof img.fileToken !== 'string' || img.fileToken === '') continue
    if (!img.dataUrl) continue
    const thumb = await makeThumbDataUrl(img.dataUrl)
    if (thumb) {
      img.dataUrl = thumb
      slimmed += 1
    } else {
      delete img.dataUrl
      removed += 1
    }
  }
  return { slimmed, removed }
}
