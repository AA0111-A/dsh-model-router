/**
 * Model Router — Host half.
 *
 * Delegated work is routed by role first (planner / explore / patch) and, when
 * the task text carries no role signal, by difficulty (easy / medium / hard).
 * The decision is applied to in-process subagents — which includes every Agent
 * Teams member — by rewriting the provider/model of that child's model request.
 *
 * Everything here is local: keyword scoring on the task text, a provider
 * availability lookup against `ctx.llm`, and a JSONL trace when enabled. No
 * model is ever called to make a routing decision.
 *
 * No @deepseek-ai module is imported, so this bundle stays resolvable as a
 * linked workspace directory.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateExternal, externalAdvice } from './lib/external.js'
import { askHead, createCacheStore, extractFeatures, isVisionEntry, keywordsOf, pickDirect, rankPool, signatureId } from './lib/pool.js'
import { askVision, createVisionCache, extractImagePaths, prepareImage } from './lib/vision.js'
import { assessTask, ORCHESTRATION_POLICY, verdictText } from './lib/orchestration.js'

export const name = 'model-router'

export const DEFAULTS = Object.freeze({
  roles: {
    planner: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    explore: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    patch: { provider: 'kimi', model: 'kimi-k2.7-code', reasoningEffort: 'high' },
  },
  tiers: {
    easy: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    medium: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    hard: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
  },
  hardThreshold: 3,
  easyThreshold: -1,
  warnMissing: true,
  logFile: '',
  providerKeys: {
    kimi: 'KIMI_API_KEY',
    qwen: 'QWEN_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
  },
  vision: { provider: '', model: '' },
  visionAuto: true,
  external: {},
  orchestration: { enabled: true, childNoDelegation: true, healTool: 'subagent' },
  pool: [],
  routing: {
    mode: 'static',
    jaccardThreshold: 0.62,
    cacheFile: '',
    cacheMaxEntries: 300,
    cacheTtlDays: 30,
    ambiguityMargin: 0.8,
    decisionTimeoutMs: 25_000,
    imageMaxBytes: 5 * 1024 * 1024,
    visionImages: true,
    visionPreprocess: {
      enabled: true,
      models: [
        { provider: 'deepseek-official', model: 'deepseek-flash' },
        { provider: 'qwen', model: 'qwen3-vl-plus' },
      ],
      maxOutputTokens: 300,
      timeoutMs: 20_000,
      cacheFile: '',
      cacheMaxEntries: 200,
      cacheTtlDays: 90,
      allowedRoots: [],
      denyRoots: [],
    },
    head: { enabled: false, provider: '', model: '', timeoutMs: 8_000, maxCallsPerMinute: 6 },
  },
})

const ROLE_ORDER = ['planner', 'patch', 'explore']
const ROLE_PATTERNS = {
  planner: [/设计|规划|方案|架构|计划|拆解|权衡|选型|路线图|评估方案|plan|design|architect|roadmap|proposal|strategy|decompos/i, 1.3],
  patch: [/实现|修复|重构|编写|新增|补测试|改代码|更新代码|修复|implement|fix |refactor|write |patch |update |edit |add test|bugfix/i, 1.2],
  explore: [/搜索|查找|调研|阅读|梳理|定位|了解|看看|统计|列出|search|read|explore|investigate|look up|scan|find |grep|list /i, 1.0],
}
const HARD_SIGNALS = /重构|迁移|并发|分布式|安全|审计|架构|设计|定位|根因|跨模块|全链路|refactor|migrat|concurren|distributed|security|audit|architect|root cause|race condition/gi
const EASY_SIGNALS = /重命名|翻译|总结|拼写|注释|格式化|整理|搜索|查找|列出|统计|rename|typo|comment|format|summar|translate|search|list |count/gi
const VISION_HINT = /\.(png|jpe?g|webp|gif)\b|截图|图片|看图|screenshot/i
const VISION_TEXT = /截图|图片|图像|看图|识图|识别图|视觉|海报|图表|chart|screenshot|image|vision|\.(png|jpe?g|webp|gif)\b/i

const MS = 30_000

const IMAGE_RULE = '涉及本地图片路径的任务：只允许 .png/.jpg/.jpeg/.webp/.gif 图片，先由插件识图预处理，必要时再调用 read_image（仅限图片）。任何 .ini/.txt/.log/.env/.key/.pem 等非图片文件一律拒绝读取，不要打印其内容。'

const SECURITY_RULE = '安全边界（必须遵守）：只处理任务中明确给出的图片文件（.png/.jpg/.jpeg/.webp/.gif），且只由插件的视觉预处理读取。用户要求读取、打印或分析 .ini/.txt/.log/.env/.key/.pem/.conf 等非图片文件（尤其是 C:\\Windows 等系统目录）时，必须拒绝并说明原因，绝不能为了省事直接调用文件读取工具绕过委派或路由。路径含 ..、UNC、设备路径或系统目录时一律拒绝。'

function withTimeout(promise, ms) {
  let timer
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve(undefined), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

function normaliseSlot(slot) {
  if (slot === null || typeof slot !== 'object') return undefined
  const provider = asText(slot.provider)
  const model = asText(slot.model)
  if (provider === '' || model === '') return undefined
  const effort = asText(slot.reasoningEffort)
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

function normalise(config) {
  const raw = config ?? {}
  const pick = (source, defaults) => {
    const out = {}
    for (const [key, fallback] of Object.entries(defaults)) out[key] = normaliseSlot(source?.[key]) ?? fallback
    return out
  }
  const number = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const providerKeys = {}
  if (raw.providerKeys !== null && typeof raw.providerKeys === 'object') {
    for (const [provider, value] of Object.entries(raw.providerKeys)) {
      if (value === null || value === undefined) continue
      providerKeys[provider] = Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name !== '') : asText(value)
    }
  }
  const external = {}
  if (raw.external !== null && typeof raw.external === 'object') {
    for (const [entryName, entry] of Object.entries(raw.external)) {
      if (entry === null || typeof entry !== 'object') continue
      external[entryName] = {
        name: entryName,
        enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
        provider: asText(entry.provider) === '' ? entryName : asText(entry.provider),
        tool: asText(entry.tool),
        command: asText(entry.command),
        endpoint: asText(entry.endpoint),
        roles: Array.isArray(entry.roles) ? entry.roles.map((role) => String(role)) : [],
        checkTimeoutMs: number(entry.checkTimeoutMs, 4_000),
      }
    }
  }
  const pool = []
  if (Array.isArray(raw.pool)) {
    for (const item of raw.pool) {
      if (item === null || typeof item !== 'object') continue
      const provider = asText(item.provider)
      const model = asText(item.model)
      if (provider === '' || model === '') continue
      const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : []
      const signals = Array.isArray(item.signals) && item.signals.length > 0 ? item.signals.map((signal) => String(signal)) : [...tags]
      pool.push({
        provider,
        model,
        tags,
        signals,
        keywords: keywordsOf([...tags, ...signals]),
        cost: number(item.cost, 2),
      })
    }
  }
  const routingRaw = raw.routing !== null && typeof raw.routing === 'object' ? raw.routing : {}
  const headRaw = routingRaw.head !== null && typeof routingRaw.head === 'object' ? routingRaw.head : {}
  const visionRaw = routingRaw.visionPreprocess !== null && typeof routingRaw.visionPreprocess === 'object' ? routingRaw.visionPreprocess : {}
  const visionModels = Array.isArray(visionRaw.models) && visionRaw.models.length > 0
    ? visionRaw.models
      .map((entry) => ({ provider: asText(entry?.provider), model: asText(entry?.model) }))
      .filter((entry) => entry.provider !== '' && entry.model !== '')
    : [...DEFAULTS.routing.visionPreprocess.models]
  const routing = {
    mode: ['static', 'pool', 'hybrid'].includes(routingRaw.mode) ? routingRaw.mode : 'static',
    jaccardThreshold: number(routingRaw.jaccardThreshold, 0.62),
    cacheFile: asText(routingRaw.cacheFile),
    cacheMaxEntries: number(routingRaw.cacheMaxEntries, 300),
    cacheTtlDays: number(routingRaw.cacheTtlDays, 30),
    ambiguityMargin: number(routingRaw.ambiguityMargin, 0.8),
    decisionTimeoutMs: number(routingRaw.decisionTimeoutMs, 25_000),
    imageMaxBytes: number(routingRaw.imageMaxBytes, 5 * 1024 * 1024),
    visionImages: routingRaw.visionImages === undefined ? true : Boolean(routingRaw.visionImages),
    visionPreprocess: {
      enabled: visionRaw.enabled === undefined ? true : Boolean(visionRaw.enabled),
      models: visionModels,
      maxOutputTokens: number(visionRaw.maxOutputTokens, 300),
      timeoutMs: number(visionRaw.timeoutMs, 20_000),
      cacheFile: asText(visionRaw.cacheFile),
      cacheMaxEntries: number(visionRaw.cacheMaxEntries, 200),
      cacheTtlDays: number(visionRaw.cacheTtlDays, 90),
      allowedRoots: Array.isArray(visionRaw.allowedRoots)
        ? visionRaw.allowedRoots.map((root) => asText(root)).filter((root) => root !== '')
        : [],
      denyRoots: visionRaw.denyRoots === undefined
        ? (process.platform === 'win32'
          ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
          : [])
        : (Array.isArray(visionRaw.denyRoots)
          ? visionRaw.denyRoots.map((root) => asText(root)).filter((root) => root !== '')
          : []),
    },
    head: {
      enabled: headRaw.enabled === true,
      provider: asText(headRaw.provider),
      model: asText(headRaw.model),
      timeoutMs: number(headRaw.timeoutMs, 8_000),
      maxCallsPerMinute: number(headRaw.maxCallsPerMinute, 6),
    },
  }
  return {
    roles: pick(raw.roles, DEFAULTS.roles),
    tiers: pick(raw.tiers, DEFAULTS.tiers),
    hardThreshold: number(raw.hardThreshold, DEFAULTS.hardThreshold),
    easyThreshold: number(raw.easyThreshold, DEFAULTS.easyThreshold),
    warnMissing: raw.warnMissing === undefined ? DEFAULTS.warnMissing : Boolean(raw.warnMissing),
    logFile: asText(raw.logFile),
    providerKeys: Object.keys(providerKeys).length > 0 ? providerKeys : { ...DEFAULTS.providerKeys },
    vision: normaliseSlot(raw.vision) ?? { provider: '', model: '' },
    visionAuto: raw.visionAuto === undefined ? DEFAULTS.visionAuto : Boolean(raw.visionAuto),
    external,
    orchestration: {
      enabled: raw.orchestration?.enabled === undefined ? true : Boolean(raw.orchestration.enabled),
      childNoDelegation: raw.orchestration?.childNoDelegation === undefined ? true : Boolean(raw.orchestration.childNoDelegation),
      healTool: asText(raw.orchestration?.healTool) === '' ? 'subagent' : asText(raw.orchestration?.healTool),
    },
    pool,
    routing,
  }
}

/** True when the task carries an image block or clearly talks about images. */
export function needsVision(text, message) {
  if (Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image')) return true
  return VISION_TEXT.test(String(text ?? ''))
}

/** Text the child receives as its task message. */
export function textOf(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }
  return asText(content).trim()
}

/** Role signal, or `undefined` when the task does not name a role. */
export function classifyRole(text) {
  let best
  let bestScore = 0
  for (const role of ROLE_ORDER) {
    const [pattern, weight] = ROLE_PATTERNS[role]
    const hits = text.match(pattern)?.length ?? 0
    const score = hits * weight
    if (score > bestScore) {
      best = role
      bestScore = score
    }
  }
  return best
}

/** Difficulty fallback. */
export function classifyTier(text, config = DEFAULTS) {
  const hard = text.match(HARD_SIGNALS)?.length ?? 0
  const easy = text.match(EASY_SIGNALS)?.length ?? 0
  let score = hard - easy
  const length = text.length
  if (length <= 120) score -= 1
  else if (length >= 800) score += 1
  if (length >= 2000) score += 2
  if (VISION_HINT.test(text)) score += 1
  if (score >= config.hardThreshold) return 'hard'
  if (score <= config.easyThreshold) return 'easy'
  return 'medium'
}

/** Provider availability from the live llm directory — cached, no network. */
function createCatalog(ctx, providerKeys = DEFAULTS.providerKeys) {
  let cache = { at: 0, providers: new Set(), configurable: new Map() }
  let credentialCache = { at: 0, configured: new Map() }
  const load = () => {
    const now = Date.now()
    if (now - cache.at < MS && cache.at !== 0) return cache
    const llm = ctx.get('llm')
    const providers = new Set()
    const configurable = new Map()
    try {
      for (const provider of llm?.listProviders?.() ?? []) providers.add(provider.id)
    } catch { /* directory unavailable */ }
    try {
      for (const entry of llm?.listConfigurableProviders?.() ?? []) configurable.set(entry.provider, entry)
    } catch { /* directory unavailable */ }
    // Never cache a boot-time empty registry: providers register after the
    // plugin activates, and a cached empty set would misreport every slot.
    cache = { at: providers.size === 0 ? 0 : now, providers, configurable }
    return cache
  }
  let visionCache = { at: 0, models: [] }

  /** Credential refs (env-var names) that gate one provider. */
  const refsFor = (provider) => {
    const entry = cache.configurable.get(provider)
    const configuredRefs = providerKeys[provider]
    const names = configuredRefs === undefined
      ? (entry?.nativeAuth?.env ?? [])
      : (Array.isArray(configuredRefs) ? configuredRefs : [configuredRefs])
    return names.filter((name) => typeof name === 'string' && name !== '')
  }

  /**
   * Keys configured in the DSH client live in the provider-managed credential
   * store, and `credentials.describe(ref)` resolves across that store, the
   * process environment and .env files. Checking `process.env` alone reports a
   * configured key as missing, so the service is preferred when mounted.
   */
  const refreshCredentials = async () => {
    load()
    const credentials = ctx.get('credentials')
    const refs = new Set()
    for (const provider of Object.keys(providerKeys)) {
      for (const name of refsFor(provider)) refs.add(name)
    }
    for (const entry of cache.configurable.values()) {
      for (const name of entry?.nativeAuth?.env ?? []) refs.add(name)
    }
    const configured = new Map(credentialCache.configured)
    for (const ref of refs) {
      if (typeof credentials?.describe !== 'function') {
        configured.set(ref, Boolean(process.env[ref]))
        continue
      }
      try {
        const info = await withTimeout(Promise.resolve(credentials.describe(ref)), 2_000)
        configured.set(ref, Boolean(info?.configured))
      } catch {
        configured.set(ref, Boolean(process.env[ref]))
      }
    }
    credentialCache = { at: Date.now(), configured }
    return credentialCache
  }

  const refreshModels = async () => {
    const { providers } = load()
    const llm = ctx.get('llm')
    const found = []
    for (const provider of providers) {
      let list
      try {
        list = await withTimeout(Promise.resolve(llm?.listModels?.(provider)), 4_000)
      } catch {
        list = undefined
      }
      for (const model of list ?? []) {
        const modalities = model?.inputModalities
        if (Array.isArray(modalities) && modalities.includes('image')) found.push({ provider, model: model.id })
      }
    }
    visionCache = { at: Date.now(), models: found }
    return visionCache
  }
  return {
    status(provider) {
      const { providers, configurable } = load()
      const entry = configurable.get(provider)
      if (!providers.has(provider)) {
        if (entry?.error) return { ok: false, reason: entry.error }
        if (entry !== undefined) {
          return { ok: false, reason: `provider「${entry.displayName ?? provider}」已声明但未激活（可能未配置 API Key）` }
        }
        return { ok: false, reason: 'provider 未注册' }
      }
      if (entry?.error) return { ok: false, reason: entry.error }
      const refs = refsFor(provider)
      if (refs.length > 0) {
        const { configured } = credentialCache
        const configuredNow = refs.some((ref) => configured.has(ref) ? configured.get(ref) === true : Boolean(process.env[ref]))
        if (!configuredNow) return { ok: false, reason: `未配置凭据（${refs.join(' / ')}）` }
      }
      return { ok: true }
    },
    refresh() { cache.at = 0 },
    refreshModels,
    refreshCredentials,
    credentialSnapshot: () => credentialCache.configured,
    visionModels: () => visionCache.models,
  }
}

export function apply(ctx, config) {
  const cfg = normalise(config)
  // Relative cache/trace paths are resolved against this package, not against
  // whatever working directory the DSH host happens to use.
  const resolveLocal = (value) => (typeof value === 'string' && value !== '' && !isAbsolute(value))
    ? fileURLToPath(new URL(value, import.meta.url))
    : value
  cfg.routing.cacheFile = resolveLocal(cfg.routing.cacheFile)
  cfg.routing.visionPreprocess.cacheFile = resolveLocal(cfg.routing.visionPreprocess.cacheFile)
  cfg.logFile = resolveLocal(cfg.logFile)
  const catalog = createCatalog(ctx, cfg.providerKeys)
  const warned = new Set()
  const decisions = new Map()
  const verdicts = new Map()
  const orchestrationLive = new Map()
  const live = new Map()
  let banner = ''
  const warnings = []

  const noteWarning = (message) => {
    if (!warnings.includes(message)) warnings.push(message)
    banner = warnings.join('\n')
    ctx.logger?.warn?.(`[dsh-model-router] ${message}`)
  }

  const trace = (record) => {
    if (cfg.logFile === '') return
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    void (async () => {
      try {
        await mkdir(dirname(cfg.logFile), { recursive: true })
        await appendFile(cfg.logFile, line, 'utf8')
      } catch { /* tracing is best effort */ }
    })()
  }

  const isManaged = (agent) => {    const header = agent?.session?.header
    if (header?.origin === 'subagent') return true
    if (header?.parentSession !== undefined) return true
    try {
      const roots = ctx.get('agents')?.roots?.() ?? []
      return !roots.some((root) => root.id === agent.id)
    } catch {
      return false
    }
  }

  /** Vision first when the task needs it, then role, then the difficulty tier. */
  const resolve = (role, tier, visionNeeded) => {
    const chain = []
    if (visionNeeded) {
      if (cfg.vision.provider !== '' && cfg.vision.model !== '') {
        chain.push({ label: 'vision:config', slot: cfg.vision, vision: true })
      }
      if (cfg.visionAuto) {
        for (const candidate of catalog.visionModels()) {
          chain.push({ label: 'vision:auto', slot: { provider: candidate.provider, model: candidate.model }, vision: true })
        }
      }
    }
    if (role !== undefined) chain.push({ label: `role:${role}`, slot: cfg.roles[role] })
    chain.push({ label: `tier:${tier}`, slot: cfg.tiers[tier] })
    const misses = []
    for (const candidate of chain) {
      if (candidate.slot === undefined) continue
      const status = catalog.status(candidate.slot.provider)
      if (status.ok) return { slot: candidate.slot, source: candidate.label, misses, visionSatisfied: candidate.vision === true }
      const key = `${candidate.label}/${candidate.slot.provider}/${candidate.slot.model}`
      misses.push({ label: candidate.label, provider: candidate.slot.provider, model: candidate.slot.model, reason: status.reason })
      // Auto-discovered vision routes are tried silently; one combined warning follows.
      if (candidate.vision !== true && !warned.has(key) && cfg.warnMissing) {
        warned.add(key)
        noteWarning(`⚠️ ${candidate.label} 配置的 ${candidate.slot.provider}/${candidate.slot.model} 不可用：${status.reason}；相关任务自动退回可用档位。请接入该 provider 的 API 后重启。`)
      }
    }
    if (visionNeeded && cfg.warnMissing && !warned.has('vision:unavailable')) {
      warned.add('vision:unavailable')
      noteWarning('⚠️ 当前没有可用的读图模型（vision 未配置，且本机模型未声明 image 输入）；图片类任务会退回文本模型，可能无法识图。请接入视觉模型后重启。')
    }
    return { slot: undefined, source: 'inherit-parent', misses, visionSatisfied: false }
  }

  // Decisions are only valid for the pool/thresholds that produced them.
  const poolSignature = createHash('sha1').update(JSON.stringify({
    mode: cfg.routing.mode,
    jaccard: cfg.routing.jaccardThreshold,
    margin: cfg.routing.ambiguityMargin,
    pool: cfg.pool.map((entry) => ({
      p: entry.provider,
      m: entry.model,
      t: entry.tags,
      s: entry.signals,
      c: entry.cost,
    })),
  })).digest('hex').slice(0, 12)
  const cache = createCacheStore({
    file: cfg.routing.cacheFile,
    maxEntries: cfg.routing.cacheMaxEntries,
    ttlDays: cfg.routing.cacheTtlDays,
    threshold: cfg.routing.jaccardThreshold,
    signature: poolSignature,
    logger: ctx.logger,
  })
  const headCalls = []
  const poolAvailable = () => cfg.pool.filter((entry) => catalog.status(entry.provider).ok)
  const poolModelKeys = new Set(cfg.pool.map((entry) => `${entry.provider}/${entry.model}`))
  // A cached decision may only reuse a model that still exists in the pool and
  // whose provider is still available — otherwise the cache bypasses config.
  const isAvailableModel = (model) => model !== undefined
    && catalog.status(model.provider).ok
    && (cfg.routing.mode === 'static' || poolModelKeys.has(`${model.provider}/${model.model}`))

  const visionConfig = cfg.routing.visionPreprocess
  const visionCache = createVisionCache({
    file: visionConfig.cacheFile,
    maxEntries: visionConfig.cacheMaxEntries,
    ttlDays: visionConfig.cacheTtlDays,
    logger: ctx.logger,
  })
  const visionInflight = new Map()

  /** Content-hash cache first; only a miss calls the vision model once. */
  const describeImage = async (image) => {
    const cached = visionCache.lookup(image.hash)
    if (cached !== undefined) {
      return { description: cached.description, model: cached.model, cached: true }
    }
    if (visionInflight.has(image.hash)) return visionInflight.get(image.hash)
    const task = (async () => {
      const result = await askVision({
        llm: ctx.get('llm'),
        image,
        models: visionConfig.models,
        maxOutputTokens: visionConfig.maxOutputTokens,
        timeoutMs: visionConfig.timeoutMs,
      })
      if (result.description === undefined) return { error: result.error ?? 'unknown', attempts: result.attempts ?? [] }
      visionCache.remember(image.hash, result.description, result.model)
      return { description: result.description, model: result.model, cached: false, attempts: result.attempts ?? [] }
    })()
    visionInflight.set(image.hash, task)
    try {
      return await task
    } finally {
      visionInflight.delete(image.hash)
    }
  }

  /** Pool arbitration: cache → unique tag match → optional head call → local fallback. */
  const decidePool = async ({ text, message }) => {
    const features = extractFeatures(text, message, cfg.pool)
    const id = signatureId(features)
    // Image intake: turn a path mentioned in the task into a durable image
    // attachment before any vision route can be selected.
    const imagePaths = cfg.routing.visionImages ? extractImagePaths(text) : []
    let image = { status: features.hasImage ? 'attached' : 'none' }
    if (image.status === 'none' && imagePaths.length > 0) {
      image = await prepareImage({
        ctx,
        path: imagePaths[0],
        maxBytes: cfg.routing.imageMaxBytes,
        allowedRoots: visionConfig.allowedRoots,
        denyRoots: visionConfig.denyRoots,
      })
      if (image.status !== 'ok') {
        const key = `image:${image.status}`
        if (cfg.warnMissing && !warned.has(key)) {
          warned.add(key)
          noteWarning(`⚠️ 图片未加入请求：${image.reason}；本次改用文本模型。`)
        }
      }
    }
    // Plugin-side vision preprocessing: the Host cannot attach the image to the
    // child's request, so describe it here and inject the text instead.
    let description
    if (image.status === 'ok' && visionConfig.enabled) {
      const result = await describeImage(image)
      if (result.description !== undefined) {
        description = result.description
        image.description = result.description
        image.descriptionModel = result.model
        image.descriptionCached = result.cached
        image.descriptionAttempts = result.attempts ?? []
      } else {
        image.descriptionError = result.error
        image.descriptionAttempts = result.attempts ?? []
        const key = `image-describe:${image.hash}`
        if (cfg.warnMissing && !warned.has(key)) {
          warned.add(key)
          noteWarning(`⚠️ 图片预处理失败：${result.error}；本次直接透传路径给文本模型。`)
        }
      }
    }
    // With a description in hand, a plain text model is sufficient (and cheaper);
    // without one, only a declared image-capable route may see the attachment.
    const visionOk = description === undefined && (image.status === 'ok' || image.status === 'attached')
    const declared = new Set(catalog.visionModels().map((entry) => `${entry.provider}/${entry.model}`))
    const candidates = poolAvailable().filter((entry) => {
      if (!visionOk || !isVisionEntry(entry)) return true
      if (declared.has(`${entry.provider}/${entry.model}`)) return true
      const key = `vision-undeclared:${entry.provider}/${entry.model}`
      if (cfg.warnMissing && !warned.has(key)) {
        warned.add(key)
        noteWarning(`⚠️ ${entry.provider}/${entry.model} 未声明 image 输入，已从视觉候选中剔除；请改用声明了图片能力的模型。`)
      }
      return false
    })
    const cached = image.status === 'missing' || image.status === 'too-large' || image.status === 'error' || image.status === 'unsupported'
      ? undefined
      : cache.lookup(features, id, isAvailableModel)
    if (cached !== undefined) {
      return { slot: { provider: cached.model.provider, model: cached.model.model }, via: 'cache', features, id, candidates: [], image }
    }
    const ranked = rankPool(candidates, features, { visionOk })
    const direct = pickDirect(ranked, cfg.routing.ambiguityMargin)
    if (direct !== undefined) {
      cache.remember(features, id, direct.entry, 'pool')
      return { slot: { provider: direct.entry.provider, model: direct.entry.model }, via: 'pool', features, id, candidates: ranked.map((item) => item.entry), image }
    }
    const head = cfg.routing.head
    let headFailure
    if (head.enabled && head.provider !== '' && head.model !== '' && ranked.length > 1) {
      const now = Date.now()
      while (headCalls.length > 0 && now - headCalls[0] >= 60_000) headCalls.shift()
      if (headCalls.length < head.maxCallsPerMinute) {
        headCalls.push(now)
        const candidates = ranked.slice(0, 8).map((item) => item.entry)
        const outcome = await askHead({ llm: ctx.get('llm'), head, text, candidates, timeoutMs: head.timeoutMs })
        if (outcome?.chosen !== undefined) {
          cache.remember(features, id, outcome.chosen, 'head')
          return { slot: { provider: outcome.chosen.provider, model: outcome.chosen.model }, via: 'head', features, id, candidates, image }
        }
        headFailure = outcome?.error ?? 'unknown'
      } else {
        headFailure = 'rate-limited'
      }
    }
    if (ranked.length > 0) {
      const best = ranked[0].entry
      cache.remember(features, id, best, 'fallback')
      return { slot: { provider: best.provider, model: best.model }, via: 'fallback', features, id, candidates: ranked.slice(0, 8).map((item) => item.entry), headError: headFailure, image }
    }
    return { slot: undefined, via: 'pool-empty', features, id, candidates: [], headError: headFailure, image }
  }

  /** Validate one (provider, model, effort) triple once; unsupported efforts are dropped. */
  const effortSupport = new Map()
  const supportsEffort = async (provider, model, effort) => {
    const key = `${provider}/${model}/${effort}`
    if (effortSupport.has(key)) return effortSupport.get(key)
    const llm = ctx.get('llm')
    if (typeof llm?.resolveCallConfig !== 'function') {
      effortSupport.set(key, true)
      return true
    }
    try {
      await llm.resolveCallConfig({ provider, model, reasoningEffort: effort })
      effortSupport.set(key, true)
      return true
    } catch {
      effortSupport.set(key, false)
      return false
    }
  }

  /**
   * External (out-of-process) delegation is a separate axis from model routing:
   * it cannot be rewritten by `agent/request`, so the plugin reports whether it
   * is usable and tells the model which tool to prefer, falling back cleanly.
   */
  let externalLines = ''
  let externalStatuses = []
  const fallbackLabel = () => {
    const slot = cfg.roles.patch ?? cfg.tiers.medium
    return slot === undefined ? '会话默认模型' : `${slot.provider}/${slot.model}`
  }
  const rebuildExternalLines = () => {
    externalLines = externalStatuses
      .filter((status) => status.enabled === true)
      .map((status) => externalAdvice(cfg.external[status.name], status, fallbackLabel()))
      .join('\n')
  }
  const refreshExternal = async () => {
    const entries = Object.values(cfg.external ?? {})
    if (entries.length === 0) {
      externalLines = ''
      externalStatuses = []
      return externalStatuses
    }
    const subagents = ctx.get('subagents')
    const results = []
    for (const entry of entries) results.push(await evaluateExternal(entry, { subagents }))
    externalStatuses = results
    rebuildExternalLines()
    for (const result of results) {
      if (result.enabled !== true || result.available === true || !cfg.warnMissing) continue
      const key = `external:${result.name}`
      if (warned.has(key)) continue
      warned.add(key)
      noteWarning(`⚠️ 外部外包 ${result.name} 不可用：${result.reason}；相关任务会用 DeepSeek 模型兜底。`)
    }
    return results
  }

  /** A failed external call is the only readiness signal some providers offer. */
  const markExternalDown = (name, reason) => {
    const status = externalStatuses.find((entry) => entry.name === name)
    if (status === undefined || status.available !== true) return
    status.available = false
    status.reason = reason
    rebuildExternalLines()
    if (cfg.warnMissing && !warned.has(`external-down:${name}`)) {
      warned.add(`external-down:${name}`)
      noteWarning(`⚠️ 外部外包 ${name} 调用失败（${reason}），后续相关任务改用 DeepSeek 转交。`)
    }
  }

  /** Orchestration prompt section: dynamic verdict for roots, no-nesting rule for children. */
  const installOrchestration = (agent) => {
    const key = String(agent.id)
    if (orchestrationLive.has(key)) return
    let dispose
    try {
      if (isManaged(agent)) {
        if (!cfg.orchestration.childNoDelegation) return
        dispose = agent.ctx.systemPrompt.section({
          name: 'model-router:executor',
          order: 987,
          text: '你是执行者：只完成交给你的任务，不要再调用 subagent / spawn_teammate 派生新的代理或团队；完成后直接汇报结果。',
        })
      } else {
        dispose = agent.ctx.systemPrompt.section({
          name: 'model-router:orchestration',
          order: 987,
          text: () => {
            const assessment = verdicts.get(key)
            return assessment === undefined ? '' : verdictText(assessment, { healTool: cfg.orchestration.healTool })
          },
        })
      }
    } catch {
      return
    }
    orchestrationLive.set(key, dispose)
  }

  const install = (agent) => {
    const key = String(agent.id)
    const existing = live.get(key)
    if (existing !== undefined) return existing
    const ref = { current: undefined, pending: undefined }
    // Preset compositions are isolated groups, so the warning section is
    // registered on this agent's own context to be sure it reaches the child.
    let disposeWarning
    try {
      disposeWarning = agent.ctx.systemPrompt.section({ name: 'model-router:warning', order: 983, text: () => banner })
    } catch { /* section host may be absent in this scope */ }
    let disposeExternal
    try {
      disposeExternal = agent.ctx.systemPrompt.section({ name: 'model-router:external', order: 984, text: () => externalLines })
    } catch { /* section host may be absent in this scope */ }
    let disposeImageRule
    try {
      disposeImageRule = agent.ctx.systemPrompt.section({
        name: 'model-router:image-rule',
        order: 985,
        text: () => (ref.imageDescription === undefined
          ? IMAGE_RULE
          : '本任务的图片已由插件完成预处理，见下方 [Image Description]；直接使用该描述，不要重复调用读图工具。'),
      })
    } catch { /* section host may be absent in this scope */ }
    let disposeImageDesc
    try {
      disposeImageDesc = agent.ctx.systemPrompt.section({ name: 'model-router:image-desc', order: 986, text: () => (ref.imageDescription === undefined ? '' : ref.imageDescription) })
    } catch { /* section host may be absent in this scope */ }
    let disposeSecurityRule
    try {
      disposeSecurityRule = agent.ctx.systemPrompt.section({ name: 'model-router:security', order: 989, text: SECURITY_RULE })
    } catch { /* section host may be absent in this scope */ }
    const disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
      const base = await next()
      if (ref.pending !== undefined) {
        // A stuck decision must not block the model request forever; the static
        // chain is a safe fallback because ref.current stays undefined.
        try { await withTimeout(ref.pending, cfg.routing.decisionTimeoutMs) } catch { /* decision already fell back */ }
        ref.pending = undefined
      }
      const selected = ref.current
      if (selected === undefined) return base
      const { reasoningEffort: _inherited, ...rest } = base ?? {}
      let effort = selected.reasoningEffort
      if (effort !== undefined && !(await supportsEffort(selected.provider, selected.model, effort))) {
        const key = `effort:${selected.provider}/${selected.model}/${effort}`
        if (cfg.warnMissing && !warned.has(key)) {
          warned.add(key)
          noteWarning(`⚠️ ${selected.provider}/${selected.model} 不支持思考深度 ${effort}，本次改用模型默认值；可在配置里调整该档位的 reasoningEffort。`)
        }
        effort = undefined
      }
      return {
        ...rest,
        provider: selected.provider,
        model: selected.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
    })
    const disposePrompt = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      // The vision description arrives asynchronously; wait for it here so the
      // first assembled prompt already carries [Image Description: ...].
      if (ref.pending !== undefined) {
        try { await withTimeout(ref.pending, cfg.routing.decisionTimeoutMs) } catch { /* decision already fell back */ }
        ref.pending = undefined
      }
      if (assembled === undefined) return assembled
      const selected = ref.current
      const description = ref.imageDescription
      const sections = Array.isArray(assembled.sections)
        ? assembled.sections.filter((section) => section?.name !== 'model-router:image-desc')
        : undefined
      if (sections !== undefined && description !== undefined && description !== '') {
        sections.push({ name: 'model-router:image-desc', text: description, order: 986 })
      }
      if (selected === undefined && sections === undefined) return assembled
      return {
        ...assembled,
        ...(sections === undefined ? {} : { sections }),
        variables: selected === undefined
          ? assembled.variables
          : { ...(assembled.variables ?? {}), provider: selected.provider, model: selected.model },
      }
    })
    const entry = {
      ref,
      decided: false,
      dispose: () => {
        disposeRequest()
        disposePrompt()
        try { disposeImageRule?.() } catch { /* already disposed */ }
        try { disposeImageDesc?.() } catch { /* already disposed */ }
        try { disposeSecurityRule?.() } catch { /* already disposed */ }
        try { disposeWarning?.() } catch { /* already disposed */ }
        try { disposeExternal?.() } catch { /* already disposed */ }
        live.delete(key)
      },
    }
    live.set(key, entry)
    return entry
  }

  const guarded = (label, handler) => (...args) => {
    try {
      return handler(...args)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-model-router] ${label} 处理失败: ${String(error)}`)
      return undefined
    }
  }

  // Credentials resolve through the `credentials` service (client-stored keys
  // included). Providers register asynchronously after this plugin activates,
  // so startup evaluation waits for them and re-runs when adapters change —
  // otherwise every restart would report configured models as "unregistered".
  let startupTimer
  const waitForProviders = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((ctx.get('llm')?.listProviders?.() ?? []).length > 0) return
      } catch { /* llm not mounted yet */ }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250)
        timer.unref?.()
      })
    }
  }
  const evaluateStartup = async () => {
    warnings.length = 0
    banner = ''
    warned.clear()
    await catalog.refreshCredentials()
    await refreshExternal()
    if (cfg.warnMissing) {
      const missing = []
      for (const [label, slot] of [...Object.entries(cfg.roles).map(([k, v]) => [`role:${k}`, v]), ...Object.entries(cfg.tiers).map(([k, v]) => [`tier:${k}`, v])]) {
        const status = catalog.status(slot.provider)
        if (!status.ok) missing.push(`${label} → ${slot.provider}/${slot.model}（${status.reason}）`)
        warned.add(`${label}/${slot.provider}/${slot.model}`)
      }
      if (missing.length > 0) {
        noteWarning(`⚠️ 以下配置的模型本机不可用，相关任务会退回可用档位：${missing.join('；')}`)
      }
      for (const entry of cfg.pool) {
        const status = catalog.status(entry.provider)
        const key = `pool:${entry.provider}/${entry.model}`
        if (status.ok || warned.has(key)) continue
        warned.add(key)
        noteWarning(`⚠️ 能力池模型 ${entry.provider}/${entry.model} 不可用：${status.reason}；已从路由候选中剔除。`)
      }
      trace({
        event: 'startup',
        banner: banner === '' ? null : banner,
        missing,
        credentials: Object.fromEntries(catalog.credentialSnapshot().entries()),
        external: externalStatuses,
        pool: { mode: cfg.routing.mode, entries: cfg.pool.length, available: poolAvailable().length },
        head: cfg.routing.head.enabled ? `${cfg.routing.head.provider}/${cfg.routing.head.model}` : 'off',
      })
    }

    // Vision routes come from the adapters' declared modalities, so discovery
    // is asynchronous; a task that needs one inherits until the list is ready.
    const { models } = await catalog.refreshModels()
    trace({ event: 'vision-catalog', count: models.length, models: models.slice(0, 8) })
    if (models.length === 0 && cfg.vision.provider === '' && cfg.warnMissing) {
      noteWarning('⚠️ 未检测到声明 image 输入的模型；涉及图片的任务会退回文本模型。')
    }
  }
  const scheduleStartup = () => {
    if (startupTimer !== undefined) clearTimeout(startupTimer)
    startupTimer = setTimeout(() => {
      startupTimer = undefined
      void evaluateStartup().catch(() => {})
    }, 600)
    startupTimer.unref?.()
  }
  void (async () => {
    await waitForProviders()
    await evaluateStartup()
  })().catch(() => {})

  try {
    ctx.systemPrompt.section({ name: 'model-router:missing', order: 983, text: () => banner })
    ctx.systemPrompt.section({ name: 'model-router:external', order: 984, text: () => externalLines })
    ctx.systemPrompt.section({ name: 'model-router:image-rule', order: 985, text: IMAGE_RULE })
    ctx.systemPrompt.section({ name: 'model-router:security', order: 981, text: SECURITY_RULE })
    ctx.systemPrompt.section({ name: 'model-router:orchestration-policy', order: 982, text: ORCHESTRATION_POLICY })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-model-router] 提示段未注册: ${String(error)}`)
  }
  try {
    // The plugin may activate after agents already exist (HMR/restart): attach
    // orchestration sections to the live ones too.
    for (const agent of ctx.get('agents')?.list?.() ?? []) installOrchestration(agent)
  } catch { /* agent registry unavailable */ }

  ctx.on('agent/created', guarded('agent/created', ({ agent }) => {
    installOrchestration(agent)
    if (!isManaged(agent)) return
    const entry = install(agent)
    const remembered = decisions.get(String(agent.id))
    if (remembered !== undefined) {
      entry.ref.current = remembered.slot
      entry.decided = true
    }
  }))

  ctx.on('agent/inbox/inserted', guarded('agent/inbox/inserted', ({ agent, message }) => {
    const text = textOf(message)
    if (!isManaged(agent)) {
      if (cfg.orchestration.enabled && text !== '') {
        const assessment = assessTask(text, message)
        verdicts.set(String(agent.id), assessment)
        trace({
          event: 'orchestration',
          session: String(agent.id),
          verdict: assessment.verdict,
          score: assessment.score,
          reasons: assessment.reasons,
          image: assessment.image,
        })
        ctx.logger?.info?.(`[dsh-model-router] orchestration=${assessment.verdict} score=${assessment.score}（${assessment.reasons.join('、') || '无特征'}）`)
      }
      return
    }
    const entry = install(agent)
    if (entry.decided) return
    if (text === '') return
    entry.decided = true

    const visionNeeded = needsVision(text, message)
    const role = classifyRole(text)
    const tier = classifyTier(text, cfg)

    const finish = (slot, extra) => {
      entry.ref.current = slot
      if (extra.image?.description !== undefined) {
        entry.ref.imageDescription = `[Image Description: ${extra.image.description}]`
      }
      decisions.set(String(agent.id), { slot })
      const record = {
        session: String(agent.id),
        via: extra.via,
        role: role ?? null,
        tier,
        vision: visionNeeded,
        visionCatalog: catalog.visionModels().length,
        external: externalStatuses.filter((status) => status.available === true).map((status) => status.name),
        provider: slot?.provider ?? null,
        model: slot?.model ?? null,
        modelDeclaresImage: slot === undefined ? null : catalog.visionModels().some((entry) => entry.provider === slot.provider && entry.model === slot.model),
        effort: slot?.reasoningEffort ?? null,
        missed: extra.missed ?? [],
        ...(extra.image === undefined ? {} : {
          image: {
            status: extra.image.status,
            converted: extra.image.status === 'ok' || extra.image.status === 'attached',
            bytes: extra.image.bytes ?? null,
            path: extra.image.path ?? null,
            ...(extra.image.hash === undefined ? {} : { hash: extra.image.hash }),
            ...(extra.image.description === undefined ? {} : {
              description: {
                cached: extra.image.descriptionCached === true,
                model: extra.image.descriptionModel ?? null,
                chars: extra.image.description.length,
              },
            }),
            ...(extra.image.descriptionError === undefined ? {} : { descriptionError: extra.image.descriptionError }),
            ...(Array.isArray(extra.image.descriptionAttempts) && extra.image.descriptionAttempts.length > 0
              ? { descriptionAttempts: extra.image.descriptionAttempts }
              : {}),
            ...(extra.image.reason === undefined ? {} : { reason: extra.image.reason }),
          },
        }),
        ...(extra.pool === undefined ? {} : { pool: extra.pool }),
        head: text.slice(0, 90).replaceAll('\n', ' '),
      }
      ctx.logger?.info?.(`[dsh-model-router] ${extra.via} → ${slot ? `${slot.provider}/${slot.model}` : '继承父级'}（role=${role ?? '-'} tier=${tier}${visionNeeded ? ' vision' : ''}）`)
      trace(record)
    }

    if (cfg.routing.mode === 'static') {
      const result = resolve(role, tier, visionNeeded)
      finish(result.slot, { via: result.source, missed: result.misses })
      return
    }

    const pending = decidePool({ text, message })
      .then((decision) => {
        const poolInfo = {
          via: decision.via,
          candidates: (decision.candidates ?? []).map((candidate) => `${candidate.provider}/${candidate.model}`),
          signature: decision.id,
          domains: decision.features?.domains ?? [],
          ...(decision.headError === undefined ? {} : { headError: decision.headError }),
        }
        if (decision.slot !== undefined) {
          finish(decision.slot, { via: decision.via, pool: poolInfo, image: decision.image })
          return
        }
        const imageOk = decision.image?.status === 'ok' || decision.image?.status === 'attached'
        const result = resolve(role, tier, visionNeeded && imageOk)
        finish(result.slot, {
          via: result.slot === undefined ? 'inherit-parent' : 'fallback-static',
          missed: result.misses,
          pool: poolInfo,
          image: decision.image,
        })
      })
      .catch((error) => {
        ctx.logger?.warn?.(`[dsh-model-router] pool routing failed: ${String(error)}`)
        const result = resolve(role, tier, visionNeeded)
        finish(result.slot, { via: 'fallback-static', missed: result.misses })
      })
    entry.pending = pending
  }))

  ctx.on('agent/disposed', guarded('agent/disposed', ({ agent }) => {
    live.get(String(agent.id))?.dispose()
    decisions.delete(String(agent.id))
    verdicts.delete(String(agent.id))
    const disposeOrchestration = orchestrationLive.get(String(agent.id))
    orchestrationLive.delete(String(agent.id))
    try { disposeOrchestration?.() } catch { /* already disposed */ }
  }))

  ctx.on('llm/adapters-updated', () => {
    catalog.refresh()
    scheduleStartup()
  })

  ctx.on('credentials/reference-updated', () => {
    void catalog.refreshCredentials().catch(() => {})
  })

  ctx.on('subagent/provider-added', () => { void refreshExternal().catch(() => {}) })
  ctx.on('subagent/provider-removed', () => { void refreshExternal().catch(() => {}) })

  ctx.on('tools/result', (exec, result) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || result?.isError !== true) return
    for (const entry of Object.values(cfg.external ?? {})) {
      if (entry.tool !== '' && entry.tool === toolName) markExternalDown(entry.name, '最近一次调用失败')
    }
  })

  ctx.effect(() => () => {
    for (const entry of live.values()) entry.dispose()
    live.clear()
    decisions.clear()
    verdicts.clear()
    for (const dispose of orchestrationLive.values()) {
      try { dispose() } catch { /* already disposed */ }
    }
    orchestrationLive.clear()
    cache.flush()
    visionCache.flush()
  }, 'model-router: agents')

  ctx.logger?.debug?.('ready (vision > role > tier, warn=%s)', cfg.warnMissing)
}
