/**
 * Local image intake and plugin-side vision preprocessing.
 *
 * The Host cannot inject an image block into a child's model request (verified:
 * `agent/pre-step` replacement is not applied and injected image blocks never
 * reach the model), so the plugin describes the image itself via
 * `ctx.llm.stream` and injects the text. Descriptions are cached by file content
 * hash, so the same image is billed once.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const IMAGE_EXT = new Set(Object.keys(MEDIA_TYPES))
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const MAX_SCAN = 100_000
const MAX_PATH_LENGTH = 4096
const PATH_PATTERN = /(?:[A-Za-z]:\\|\/)[^\n"'<>|?*\r]{1,240}?\.(?:png|jpe?g|webp|gif)\b/gi
const CACHE_VERSION = 1

/** Absolute-looking image paths mentioned in the task text (deduplicated). */
export function extractImagePaths(text) {
  const source = String(text ?? '').slice(0, MAX_SCAN)
  const found = source.match(PATH_PATTERN) ?? []
  const seen = new Set()
  const paths = []
  for (const candidate of found) {
    const cleaned = candidate.replace(/[),.;:]+$/, '').trim()
    if (cleaned === '' || seen.has(cleaned)) continue
    seen.add(cleaned)
    paths.push(cleaned)
    if (paths.length >= 5) break
  }
  return paths
}

export function hashBytes(data) {
  return createHash('md5').update(data).digest('hex')
}

/**
 * Verify the bytes really are the image format the extension claims. An
 * attacker can rename `secret.ini` to `secret.png`; the extension whitelist
 * alone would then read it. Content sniffing makes that fail closed.
 */
export function sniffImageMediaType(data) {
  if (!(data instanceof Uint8Array) || data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

async function insideAny(roots, target) {
  if (roots.length === 0) return false
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  for (const root of roots) {
    let rootReal
    try {
      rootReal = await realpath(root)
    } catch {
      rootReal = resolve(root)
    }
    const rel = relative(normalize(rootReal), normalize(target))
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
  }
  return false
}

/**
 * Validate a task-supplied image path before any filesystem access.
 *
 * Defense in depth against a hostile task text: only absolute local paths,
 * no `..` segments, no UNC/device/ADS forms, no control characters, only image
 * extensions, system directories denied by default, and (when `allowedRoots` is
 * configured) the real path must stay inside those roots even after symlinks.
 */
export async function sanitizeImagePath(raw, { allowedRoots = [], denyRoots = [] } = {}) {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (input === '' || input.length > MAX_PATH_LENGTH) {
    return { ok: false, status: 'blocked', reason: '路径为空或过长' }
  }
  if (CONTROL_CHARS.test(input)) return { ok: false, status: 'blocked', reason: '路径包含控制字符' }
  if (input.startsWith('\\\\')) return { ok: false, status: 'blocked', reason: '不允许 UNC 或设备路径' }
  if (!/^[A-Za-z]:[\\/]/.test(input) && !input.startsWith('/')) {
    return { ok: false, status: 'blocked', reason: '只允许绝对路径' }
  }
  // Reject alternate data streams: a colon is only valid as the drive colon.
  if (input.indexOf(':', 2) !== -1) return { ok: false, status: 'blocked', reason: '不允许备用数据流路径' }
  const segments = input.split(/[\\/]+/).slice(1)
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, status: 'blocked', reason: '不允许路径穿越' }
  }
  const declaredExt = extname(input).toLowerCase()
  if (!IMAGE_EXT.has(declaredExt)) {
    return { ok: false, status: 'unsupported', reason: `不支持的图片扩展名：${declaredExt || '(none)'}` }
  }
  let real
  try {
    real = await realpath(input)
  } catch (error) {
    return { ok: false, status: 'missing', reason: `文件不存在或不可读（${error?.code ?? 'error'}）` }
  }
  if (!isAbsolute(real)) return { ok: false, status: 'blocked', reason: '解析后的路径不是绝对路径' }
  const realExt = extname(real).toLowerCase()
  if (!IMAGE_EXT.has(realExt)) return { ok: false, status: 'unsupported', reason: '解析后的文件不是受支持的图片格式' }
  // System directories are denied unless an explicit allowedRoot opts in.
  if (await insideAny(denyRoots, real) && !(await insideAny(allowedRoots, real))) {
    return { ok: false, status: 'blocked', reason: '拒绝访问系统目录' }
  }
  if (allowedRoots.length > 0 && !(await insideAny(allowedRoots, real))) {
    return { ok: false, status: 'blocked', reason: '图片不在允许的目录内' }
  }
  return { ok: true, path: real, mediaType: MEDIA_TYPES[realExt] }
}

/**
 * Load one image, hash it, and publish it as an attachment.
 *
 * @returns {Promise<
 *   | { status: 'ok'; path: string; bytes: number; mediaType: string; hash: string; ref: unknown }
 *   | { status: 'missing' | 'too-large' | 'unsupported' | 'blocked' | 'error'; path: string; bytes?: number; reason: string }
 * >}
 */
export async function prepareImage({ ctx, path, maxBytes = 5 * 1024 * 1024, allowedRoots = [], denyRoots = [] }) {
  const safe = await sanitizeImagePath(path, { allowedRoots, denyRoots })
  if (!safe.ok) return { status: safe.status, path, reason: safe.reason }
  const file = safe.path
  const mediaType = safe.mediaType
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'missing', path: file, reason: `文件不存在或不可读（${error?.code ?? 'error'}）` }
  }
  if (!info.isFile()) return { status: 'missing', path: file, reason: '路径不是文件' }
  if (info.size > maxBytes) {
    return { status: 'too-large', path: file, bytes: info.size, reason: `图片 ${info.size} 字节，超过上限 ${maxBytes} 字节` }
  }
  let data
  try {
    data = new Uint8Array(await readFile(file))
  } catch (error) {
    return { status: 'missing', path: file, bytes: info.size, reason: `读取失败（${error?.code ?? 'error'}）` }
  }
  // Fail closed on extension spoofing: the bytes must match the declared type.
  if (sniffImageMediaType(data) !== mediaType) {
    return { status: 'blocked', path: file, bytes: data.byteLength, reason: '文件内容不是声明的图片格式，拒绝读取' }
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return { status: 'error', path: file, bytes: info.size, reason: 'attachments 服务不可用' }
  // Respect the deployment's own image policy before attempting a save.
  const limit = attachments.imageLimits?.maxImageBytes
  if (typeof limit === 'number' && limit > 0 && data.byteLength > limit) {
    return { status: 'too-large', path: file, bytes: data.byteLength, reason: `超过 DSH 附件上限 ${limit} 字节` }
  }
  try {
    const ref = await attachments.saveImage({ data, mediaType, name: basename(file) })
    return { status: 'ok', path: file, bytes: data.byteLength, mediaType, hash: hashBytes(data), ref }
  } catch (error) {
    return { status: 'error', path: file, bytes: data.byteLength, reason: error instanceof Error ? error.message : String(error) }
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
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2), { encoding: 'utf8', flag: 'wx' })
        renameSync(temp, file)
      } catch (error) {
        try { unlinkSync(temp) } catch { /* best effort */ }
        throw error
      }
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
