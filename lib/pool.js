/**
 * Capability-pool routing: local features, a durable decision cache, and an
 * optional single head-model adjudication.
 *
 * Everything here is pure or file-backed. The only network/model activity is
 * `askHead`, which is called at most once for an ambiguous task and never on a
 * cache hit.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CACHE_VERSION = 1
const CJK = /[\u4e00-\u9fff]/
const STOP = new Set([
  '的', '了', '是', '和', '并', '把', '在', '有', '请', '帮我', '一下', '这个', '那个', '任务', '工作', '使用', '需要',
  '然后', '以及', '一个', '进行', '可以', '我们', '你们', '他们', '不要', '只做', '完成', 'the', 'and', 'for', 'with',
  'this', 'that', 'you', 'your', 'are', 'was', 'will', 'just', 'from', 'into', 'please',
  // Harness boilerplate appended to every child task by the delegation runtime.
  'parent', 'agent', 'id', 'is', 'to', 'send', 'result', 'before', 'finish', 'message', 'send_message', 'lead', 'ok',
  'notify', 'session', 'subagent', 'report', 'reply', 'replyto', 'return', 'after', 'then', 'when', 'done',
  'agent_id', 'self', 'contained', 'shares', 'workspace', 'but', 'does', 'not', 'automatically', 'receive', 'transcript',
  'tool', 'tools', 'output', 'outputs', 'files', 'changes', 'available', 'the', 'and', 'of', 'in', 'on', 'be', 'it',
  'can', 'will', 'should', 'must', 'may', 'you', 'they', 'their', 'its', 'has', 'have', 'had',
])

function isNoise(token) {
  if (STOP.has(token)) return true
  if (/^session-[0-9a-f-]{8,}$/i.test(token)) return true
  if (/^[0-9a-f]{16,}$/i.test(token)) return true
  return false
}

/** Signal words mapped to canonical tags a pool entry may carry. */
const DOMAIN_HINTS = [
  [/截图|图片|图像|看图|识图|视觉|海报|chart|screenshot|image|vision|\.(png|jpe?g|webp|gif)\b/i, '视觉识别'],
  [/图表|表格|曲线|统计图|excel|chart|plot|csv/i, '图表解析'],
  [/整个仓库|整库|全部文件|长文|长文档|全量|通读|whole repo|entire codebase|long document|all files/i, '长文本处理'],
  [/重构|架构|设计|方案|迁移|并发|竞态|根因|复杂|权衡|architect|refactor|migrat|concurren|root cause/i, '复杂逻辑'],
  [/实现|修复|写代码|补测试|编译|报错|bug|implement|fix|refactor|unit test|compile/i, '核心代码编写'],
  [/补全|自动完成|行级|片段|completion|snippet/i, '快速代码补全'],
  [/搜索|查找|整理|重命名|格式化|批量|替换|翻译|统计|列出|search|grep|rename|format|bulk|replace|translate|list /i, '机械执行'],
  [/文档|报告|总结|写作|ppt|readme|report|summary|docs?/i, '文本生成'],
]

const LENGTH_BUCKETS = { short: 1, mid: 2, long: 3 }

function uniq(list) {
  return [...new Set(list)]
}

function bigrams(text) {
  const out = []
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2))
  return out
}

/** Local task signature. Never includes the full prompt text. */
export function extractFeatures(text, message, pool) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  // The delegation runtime appends a session-specific preamble after the task;
  // cut it so two runs of the same task keep the same signature.
  const taskText = raw.split(/your parent agent id is|you are a self-contained|before you finish/i)[0] ?? raw
  const clean = taskText.trim().slice(0, 400)
  const keywords = new Set()
  for (const match of clean.toLowerCase().matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) {
    if (!isNoise(match[0])) keywords.add(match[0])
  }
  for (const run of clean.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (run.length < 2) continue
    for (const gram of bigrams(run)) if (!isNoise(gram)) keywords.add(gram)
  }
  const domains = []
  for (const [pattern, tag] of DOMAIN_HINTS) if (pattern.test(clean)) domains.push(tag)
  const matched = []
  for (const entry of pool) {
    for (const signal of entry.signals) if (clean.includes(signal)) matched.push(signal)
  }
  const length = clean.length
  return {
    keywords: [...keywords].slice(0, 32),
    domains: uniq(domains),
    matched: uniq(matched),
    lengthBucket: length <= 120 ? 'short' : length <= 800 ? 'mid' : 'long',
    hasImage: Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image'),
  }
}

export function signatureId(features) {
  const raw = JSON.stringify({
    k: [...new Set(features.keywords)].sort().slice(0, 40),
    d: [...features.domains].sort(),
    l: features.lengthBucket,
    i: features.hasImage,
  })
  return createHash('sha1').update(raw).digest('hex').slice(0, 16)
}

function jaccard(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const value of left) if (right.has(value)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Keywords for one pool entry, so entry and task share the same token space. */
export function keywordsOf(values) {
  const out = new Set()
  for (const value of values ?? []) {
    const text = String(value ?? '')
    for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) out.add(match[0])
    for (const run of text.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
      for (const gram of bigrams(run)) out.add(gram)
    }
  }
  return [...out]
}

/** Whether a pool entry is meant for image tasks. */
export function isVisionEntry(entry) {
  return (entry?.tags ?? []).some((tag) => ['视觉识别', '图表解析', '视觉', '读图', '图像'].includes(tag))
}

/** Score every available pool entry against the task features. */
export function rankPool(pool, features, options = {}) {
  const visionOk = options.visionOk === true
  const scored = []
  for (const entry of pool) {
    const vision = isVisionEntry(entry)
    // A vision route with no usable image must not be chosen: the model would
    // receive only a path. A prepared image makes one the preferred route.
    if (vision && !visionOk) continue
    let score = 0
    for (const signal of entry.signals) if (features.matched.includes(signal)) score += 2
    for (const tag of entry.tags) if (features.domains.includes(tag)) score += 1.5
    score += jaccard(features.keywords, entry.keywords) * 2
    if (vision && visionOk) score += 2
    score -= entry.cost * 0.05
    if (score > 0) scored.push({ entry, score })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/** Unique high-confidence local winner, else undefined. */
export function pickDirect(ranked, margin = 0.8) {
  if (ranked.length === 0) return undefined
  const [first, second] = ranked
  if (first.score < 1.2) return undefined
  if (second !== undefined && first.score - second.score < margin) return undefined
  return first
}

/** Persistent decision cache with TTL + LRU eviction and atomic writes. */
export function createCacheStore({ file, maxEntries = 300, ttlDays = 30, threshold = 0.62, signature = '', logger }) {
  let entries = []
  let timer
  let dirty = false
  if (typeof file === 'string' && file !== '') {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed?.version === CACHE_VERSION && Array.isArray(parsed.entries)) {
          // A different pool/threshold signature invalidates every entry: a
          // cached decision made under an old configuration must not survive.
          entries = parsed.entries.filter((entry) => entry?.sig === signature)
        }
      }
    } catch {
      logger?.warn?.('[dsh-model-router] routing cache unreadable; starting empty')
    }
  }

  const ttlMs = Math.max(1, Number(ttlDays) || 30) * 86_400_000
  const prune = () => {
    const now = Date.now()
    entries = entries.filter((entry) => now - Number(entry.lastUsedAt ?? 0) < ttlMs)
    if (entries.length > maxEntries) {
      const scored = [...entries].sort((a, b) => {
        const left = Number(a.lastUsedAt ?? 0) + Number(a.hits ?? 0) * 3_600_000
        const right = Number(b.lastUsedAt ?? 0) + Number(b.hits ?? 0) * 3_600_000
        return right - left
      })
      entries = scored.slice(0, Math.max(1, Math.floor(maxEntries * 0.9)))
    }
    return entries.length
  }

  const persist = () => {
    if (typeof file !== 'string' || file === '') return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, sig: signature, entries }, null, 2), { encoding: 'utf8', flag: 'wx' })
        renameSync(temp, file)
      } catch (error) {
        try { unlinkSync(temp) } catch { /* best effort */ }
        throw error
      }
      dirty = false
    } catch {
      logger?.warn?.('[dsh-model-router] routing cache write failed')
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

  const usable = (candidate, isAvailable) => {
    if (candidate === undefined) return undefined
    return isAvailable(candidate.model) ? candidate : undefined
  }


  return {
    lookup(features, id, isAvailable) {
      prune()
      const usable = (entry) => entry !== undefined && entry.sig === signature && isAvailable(entry.model)
      const exact = entries.find((entry) => entry.id === id)
      const exactOverlap = exact === undefined ? 0 : jaccard(features.keywords, exact.features?.keywords ?? [])
      if (exact !== undefined && exactOverlap >= 0.6 && usable(exact)) {
        exact.hits = Number(exact.hits ?? 0) + 1
        exact.lastUsedAt = Date.now()
        schedule()
        return exact
      }
      let best
      for (const entry of entries) {
        if (!usable(entry)) continue
        const score = jaccard(features.keywords, entry.features?.keywords ?? [])
        if (score < threshold) continue
        if (best === undefined || score > best.score) best = { entry, score }
      }
      if (best === undefined) return undefined
      best.entry.hits = Number(best.entry.hits ?? 0) + 1
      best.entry.lastUsedAt = Date.now()
      schedule()
      return best.entry
    },
    remember(features, id, model, source) {
      const record = {
        id,
        sig: signature,
        features: { keywords: features.keywords.slice(0, 40), domains: features.domains, lengthBucket: features.lengthBucket, hasImage: features.hasImage },
        model: { provider: model.provider, model: model.model },
        tags: model.tags ?? [],
        source,
        hits: 1,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      }
      const existing = entries.findIndex((entry) => entry.id === id)
      if (existing >= 0) entries[existing] = record
      else entries.push(record)
      prune()
      schedule()
    },
    flush() {
      if (dirty) persist()
    },
    get size() { return entries.length },
  }
}

/** One-shot adjudication through the head model; at most one call per ambiguity. */
export async function askHead({ llm, head, text, candidates, timeoutMs = 8_000 }) {
  if (candidates.length === 0) return { error: 'no candidates' }
  const list = candidates.slice(0, 8)
    .map((candidate, index) => `${index + 1}. ${candidate.provider}/${candidate.model} — ${candidate.tags.join(' / ')}`)
    .join('\n')
  const prompt = `任务摘要：${String(text ?? '').slice(0, 200)}\n候选模型：\n${list}\n只回复最合适模型的编号（1-${Math.min(candidates.length, 8)}），不要解释。`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let output = ''
  let reasoning = ''
  let failure
  const seen = new Set()
  const consume = async () => {
    let out = ''
    let think = ''
    let fail
    const kinds = new Set()
    try {
      if (typeof llm?.stream !== 'function') throw new Error('llm.stream unavailable')
      for await (const chunk of llm.stream({
        provider: head.provider,
        model: head.model,
        maxTokens: 96,
        temperature: 0,
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })) {
        kinds.add(chunk.type)
        if (chunk.type === 'text-delta') out += chunk.text
        else if (chunk.type === 'reasoning-delta') think += chunk.text
        else if (chunk.type === 'block-end') {
          if (chunk.block?.type === 'text') out += chunk.block.text ?? ''
          else if (chunk.block?.type === 'reasoning') think += chunk.block.text ?? ''
        } else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            fail = `head stream ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown'}`
          }
          break
        }
      }
    } catch (error) {
      fail = error instanceof Error ? error.message : String(error)
    }
    return { out, think, fail, kinds }
  }
  // Abort first, hard deadline second: a provider that ignores `signal` must not
  // stall the decision loop.
  const result = await Promise.race([
    consume(),
    new Promise((resolve) => {
      setTimeout(() => resolve({ out: '', think: '', fail: `head hard timeout ${timeoutMs}ms`, kinds: new Set() }), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  output = result.out
  reasoning = result.think
  failure = result.fail
  for (const kind of result.kinds) seen.add(kind)
  if (failure !== undefined) return { error: failure }
  const source = output.trim() !== '' ? output : reasoning
  if (source.trim() === '') return { error: `empty stream; chunks=${[...seen].join(',') || 'none'}` }
  const numbers = source.match(/\d+/g) ?? []
  const index = Number(numbers[numbers.length - 1])
  if (!Number.isInteger(index) || index < 1 || index > Math.min(candidates.length, 8)) {
    return { error: `unparsed output: ${source.trim().slice(0, 80)}` }
  }
  return { chosen: candidates[index - 1], output: source.trim() }
}
