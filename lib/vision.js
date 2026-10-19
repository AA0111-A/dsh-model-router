/**
 * Local image intake and plugin-side vision preprocessing.
 *
 * The Host cannot inject an image block into a child's model request (verified:
 * `agent/pre-step` replacement is not applied and injected image blocks never
 * reach the model), so the plugin describes the image itself via
 * `ctx.llm.stream` and injects the text. Descriptions are cached by file content
 * hash, so the same image is billed once.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PATH_PATTERN = /(?:[A-Za-z]:\\|\/)[^\n"'<>|?*\r]*?\.(?:png|jpe?g|webp|gif)\b/gi
const CACHE_VERSION = 1

/** Absolute-looking image paths mentioned in the task text (deduplicated). */
export function extractImagePaths(text) {
  const found = String(text ?? '').match(PATH_PATTERN) ?? []
  const seen = new Set()
  const paths = []
  for (const candidate of found) {
    const cleaned = candidate.replace(/[),.;:]+$/, '').trim()
    if (cleaned === '' || seen.has(cleaned)) continue
    seen.add(cleaned)
    paths.push(cleaned)
  }
  return paths
}

export function hashBytes(data) {
  return createHash('md5').update(data).digest('hex')
}

/**
 * Load one image, hash it, and publish it as an attachment.
 *
 * @returns {Promise<
 *   | { status: 'ok'; path: string; bytes: number; mediaType: string; hash: string; ref: unknown }
 *   | { status: 'missing' | 'too-large' | 'unsupported' | 'error'; path: string; bytes?: number; reason: string }
 * >}
 */
export async function prepareImage({ ctx, path, maxBytes = 5 * 1024 * 1024 }) {
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()]
  if (mediaType === undefined) {
    return { status: 'unsupported', path, reason: `不支持的图片扩展名：${extname(path) || '(none)'}` }
  }
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return { status: 'missing', path, reason: `文件不存在或不可读（${error?.code ?? 'error'}）` }
  }
  if (!info.isFile()) return { status: 'missing', path, reason: '路径不是文件' }
  if (info.size > maxBytes) {
    return { status: 'too-large', path, bytes: info.size, reason: `图片 ${info.size} 字节，超过上限 ${maxBytes} 字节` }
  }
  let data
  try {
    data = new Uint8Array(await readFile(path))
  } catch (error) {
    return { status: 'missing', path, bytes: info.size, reason: `读取失败（${error?.code ?? 'error'}）` }
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return { status: 'error', path, bytes: info.size, reason: 'attachments 服务不可用' }
  // Respect the deployment's own image policy before attempting a save.
  const limit = attachments.imageLimits?.maxImageBytes
  if (typeof limit === 'number' && limit > 0 && data.byteLength > limit) {
    return { status: 'too-large', path, bytes: data.byteLength, reason: `超过 DSH 附件上限 ${limit} 字节` }
  }
  try {
    const ref = await attachments.saveImage({ data, mediaType, name: basename(path) })
    return { status: 'ok', path, bytes: data.byteLength, mediaType, hash: hashBytes(data), ref }
  } catch (error) {
    return { status: 'error', path, bytes: data.byteLength, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Content-addressed description cache: same file bytes => same description. */
export function createVisionCache({ file, maxEntries = 200, ttlDays = 90, logger }) {
  let entries = {}
  let timer
  let dirty = false
  if (typeof file === 'string' && file !== '') {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed?.version === CACHE_VERSION && parsed.entries !== null && typeof parsed.entries === 'object') entries = parsed.entries
      }
    } catch {
      logger?.warn?.('[dsh-model-router] vision cache unreadable; starting empty')
    }
  }
  const ttlMs = Math.max(1, Number(ttlDays) || 90) * 86_400_000
  const prune = () => {
    const now = Date.now()
    const kept = {}
    for (const [hash, entry] of Object.entries(entries)) {
      if (now - Number(entry.createdAt ?? 0) < ttlMs) kept[hash] = entry
    }
    entries = kept
    const hashes = Object.keys(entries)
    if (hashes.length > maxEntries) {
      hashes
        .sort((a, b) => Number(entries[a].createdAt ?? 0) + Number(entries[a].hits ?? 0) * 3_600_000
          - Number(entries[b].createdAt ?? 0) - Number(entries[b].hits ?? 0) * 3_600_000)
        .slice(0, hashes.length - Math.floor(maxEntries * 0.9))
        .forEach((hash) => { delete entries[hash] })
    }
    return Object.keys(entries).length
  }
  const persist = () => {
    if (typeof file !== 'string' || file === '') return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2), 'utf8')
      renameSync(temp, file)
      dirty = false
    } catch {
      logger?.warn?.('[dsh-model-router] vision cache write failed')
    }
  }
  const schedule = () => {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (dirty) persist()
    }, 500)
    timer.unref?.()
  }
  return {
    lookup(hash) {
      prune()
      const entry = entries[hash]
      if (entry === undefined) return undefined
      entry.hits = Number(entry.hits ?? 0) + 1
      entry.lastUsedAt = Date.now()
      schedule()
      return entry
    },
    remember(hash, description, model) {
      entries[hash] = { description, model, hits: 1, createdAt: Date.now(), lastUsedAt: Date.now() }
      prune()
      schedule()
      return entries[hash]
    },
    flush() {
      if (dirty) persist()
    },
    get size() { return Object.keys(entries).length },
  }
}

/**
 * A description that only complains about missing pixels is not a description;
 * caching it would poison the content cache for future tasks.
 */
export function looksLikeRefusal(text) {
  const value = String(text ?? '')
  if (value.trim() === '') return true
  const refusal = /无法(查看|分析|识别|看到)|未提供(实际)?图像|没有(收到|提供|附带)(任何)?(图像|图片)|仅(附带|提供|看到)了?[^，。]{0,12}(哈希|hash)|cannot (view|see|analyze)|unable to (view|see|analyze)|no image (was )?(provided|attached)|only (a )?hash/i
  return refusal.test(value)
}

/**
 * Ask a vision model to describe one stored image. Models are tried in order and
 * the first usable description wins; refusals count as failures.
 */
export async function askVision({ llm, image, models, maxOutputTokens = 300, timeoutMs = 20_000 }) {
  if (typeof llm?.stream !== 'function' || image?.ref === undefined) {
    return { error: 'llm.stream 或图片附件不可用', attempts: [] }
  }
  const prompt = '请用中文客观描述这张图片：界面或画面布局、可见文字、数据或图表、关键细节。不要臆测看不到的内容，200 字以内。'
  let lastError = 'no model'
  const attempts = []
  for (const candidate of models) {
    const label = `${candidate.provider}/${candidate.model}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let output = ''
    let failure
    const consume = async () => {
      let out = ''
      let fail
      try {
        for await (const chunk of llm.stream({
          provider: candidate.provider,
          model: candidate.model,
          maxTokens: maxOutputTokens,
          temperature: 0,
          signal: controller.signal,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image', attachment: image.ref },
            ],
          }],
        })) {
          if (chunk.type === 'text-delta') out += chunk.text
          else if (chunk.type === 'block-end' && chunk.block?.type === 'text') out += chunk.block.text ?? ''
          else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              fail = `${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown'}`
            }
            break
          }
        }
      } catch (error) {
        fail = error instanceof Error ? error.message : String(error)
      }
      return { out, fail }
    }
    // The abort signal only helps providers that honor it; race a hard deadline
    // so a stuck stream can never stall routing.
    const result = await Promise.race([
      consume(),
      new Promise((resolve) => {
        setTimeout(() => resolve({ out: '', fail: `hard timeout ${timeoutMs}ms` }), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    output = result.out
    failure = result.fail
    if (failure === undefined && output.trim() !== '' && !looksLikeRefusal(output)) {
      return { description: output.trim(), model: label, attempts }
    }
    lastError = failure ?? (looksLikeRefusal(output) ? '模型返回拒答（未收到图片）' : 'empty description')
    attempts.push({ model: label, error: lastError })
  }
  return { error: lastError, attempts }
}
