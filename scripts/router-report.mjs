#!/usr/bin/env node
/**
 * dsh-model-router 巡检报告：把 router-trace.jsonl 汇总成一页结论。
 *
 * 设计原则：
 * - 只读，不改任何缓存或配置；
 * - 零依赖，node scripts/router-report.mjs 直接跑；
 * - 输出一份紧凑的 Markdown（默认写 reports/）和一段 --json，供 agent 读取，
 *   避免 agent 直接吞 135 行以上的原始 trace。
 *
 * 用法：
 *   node scripts/router-report.mjs                 # 近 7 天，写报告并打印摘要
 *   node scripts/router-report.mjs --hours 24      # 只统计最近一天
 *   node scripts/router-report.mjs --json          # 只打印机器可读摘要
 *   node scripts/router-report.mjs --file x.jsonl  # 指定 trace
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const MODEL_ROUTER_DIR = join(pkgRoot, '.model-router')

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1 || process.argv[index + 1] === undefined) return fallback
  return process.argv[index + 1]
}

const traceFile = resolve(argValue('--file', join(MODEL_ROUTER_DIR, 'router-trace.jsonl')))
const hours = Number(argValue('--hours', '168'))
const asJson = process.argv.includes('--json')
const outDir = resolve(argValue('--out', join(pkgRoot, 'reports')))
const limit = Number(argValue('--limit', '10'))

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const pct = (part, total) => (total === 0 ? null : round((part / total) * 100, 1))

const humanMs = (value) => {
  if (value === null || value === undefined) return '-'
  if (value < 1000) return `${value} ms`
  if (value < 60_000) return `${round(value / 1000)} s`
  return `${round(value / 60_000)} min`
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

const p95 = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

const short = (value, length = 48) => {
  const text = String(value ?? '').replaceAll('\n', ' ').trim()
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

const shortSession = (value) => String(value ?? '').replace(/^session-/, '').slice(0, 8)

if (!existsSync(traceFile)) {
  console.error(`trace 不存在：${traceFile}`)
  console.error('插件还没写过 trace（logFile 为空，或还没有路由过任务）。')
  process.exit(2)
}

const raw = readFileSync(traceFile, 'utf8').split('\n')
let malformed = 0
const events = []
for (const line of raw) {
  const text = line.trim()
  if (text === '') continue
  try {
    const record = JSON.parse(text)
    if (record !== null && typeof record === 'object') events.push(record)
  } catch {
    malformed += 1
  }
}

const cutoff = Date.now() - Math.max(1, hours) * 3_600_000
const inWindow = (record) => {
  const at = Date.parse(String(record?.at ?? ''))
  return Number.isFinite(at) && at >= cutoff
}
const windowed = events.filter(inWindow)

// 决策记录没有 `event` 字段；outcome 也带 via，必须按 event 区分。
const decisions = windowed.filter((record) => typeof record.via === 'string' && record.event === undefined)
const outcomes = windowed.filter((record) => record.event === 'outcome')
const orchestration = windowed.filter((record) => record.event === 'orchestration')

// 每个 outcome 配对同 session 最近一次决策。
const decisionBySession = new Map()
for (const decision of decisions) {
  const session = String(decision.session ?? '')
  if (session === '') continue
  const previous = decisionBySession.get(session)
  if (previous === undefined || Date.parse(String(decision.at)) >= Date.parse(String(previous.at))) {
    decisionBySession.set(session, decision)
  }
}

const joined = []
for (const outcome of outcomes) {
  const decision = decisionBySession.get(String(outcome.session ?? ''))
  joined.push({
    outcome,
    decision,
    provider: decision?.provider ?? null,
    model: decision?.model ?? null,
    via: decision?.via ?? outcome.via ?? null,
    stopReason: String(outcome.stopReason ?? 'unknown'),
    durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : null,
    requests: Number.isFinite(outcome.requests) ? outcome.requests : null,
  })
}

const byVia = {}
for (const decision of decisions) byVia[decision.via] = (byVia[decision.via] ?? 0) + 1

const byStop = {}
for (const row of joined) byStop[row.stopReason] = (byStop[row.stopReason] ?? 0) + 1

const failures = joined.filter((row) => ['error', 'refusal', 'aborted', 'max-tokens'].includes(row.stopReason)).length
const success = joined.filter((row) => row.stopReason === 'completed').length

const byModel = new Map()
for (const row of joined) {
  const key = `${row.provider ?? '?'}/${row.model ?? '?'}`
  const entry = byModel.get(key) ?? { calls: 0, success: 0, failure: 0, durations: [], via: {} }
  entry.calls += 1
  if (row.stopReason === 'completed') entry.success += 1
  else entry.failure += 1
  if (row.durationMs !== null) entry.durations.push(row.durationMs)
  entry.via[row.via ?? '?'] = (entry.via[row.via ?? '?'] ?? 0) + 1
  byModel.set(key, entry)
}

// 决策层面的模型分布：和结果层分开看，才知道"选了谁"和"跑得怎么样"。
const byDecisionModel = new Map()
for (const decision of decisions) {
  const key = `${decision.provider ?? '?'}/${decision.model ?? '?'}`
  const entry = byDecisionModel.get(key) ?? { decisions: 0, via: {} }
  entry.decisions += 1
  entry.via[decision.via ?? '?'] = (entry.via[decision.via ?? '?'] ?? 0) + 1
  byDecisionModel.set(key, entry)
}

const cacheHits = byVia.cache ?? 0
const fallbacks = Object.entries(byVia)
  .filter(([via]) => via.startsWith('fallback'))
  .reduce((total, [, count]) => total + count, 0)
const headCalls = byVia.head ?? 0
const headErrors = decisions.filter((decision) => decision.pool?.headError !== undefined).length

const verdicts = {}
for (const record of orchestration) verdicts[record.verdict ?? 'unknown'] = (verdicts[record.verdict ?? 'unknown'] ?? 0) + 1

const routingCache = readJson(join(MODEL_ROUTER_DIR, 'routing_cache.json'))
const visionCache = readJson(join(MODEL_ROUTER_DIR, 'vision_cache.json'))
const routingEntries = Array.isArray(routingCache?.entries) ? routingCache.entries : []
const visionEntries = visionCache?.entries !== null && typeof visionCache?.entries === 'object'
  ? Object.keys(visionCache.entries ?? {}).length
  : 0
const oldestCacheAgeDays = routingEntries.length === 0
  ? null
  : round(Math.max(...routingEntries.map((entry) => Date.now() - Number(entry.createdAt ?? Date.now()))) / 86_400_000, 1)

const anomalies = []
// 小样本不比比例：几条任务说明不了命中率或兜底率，避免每天误报。
if (decisions.length >= 5 && pct(cacheHits, decisions.length) !== null && pct(cacheHits, decisions.length) < 10) {
  anomalies.push(`缓存命中率 ${pct(cacheHits, decisions.length)}%（低于 10%）：重复任务没被复用，检查签名/阈值或任务是否真的多样。`)
}
if (decisions.length >= 5 && pct(fallbacks, decisions.length) >= 20) {
  anomalies.push(`兜底率 ${pct(fallbacks, decisions.length)}%：能力池里可能缺少可用模型，或 provider 掉线。`)
}
if (headErrors > 0) anomalies.push(`头领裁决失败 ${headErrors} 次：检查头领模型的可用性/超时。`)
if (joined.length >= 3 && pct(failures, joined.length) >= 20) {
  anomalies.push(`子代理失败/中止率 ${pct(failures, joined.length)}%：按模型分布看是否集中在某个便宜模型上。`)
}
if (decisions.length - joined.length >= 3) {
  anomalies.push(`${decisions.length - joined.length} 次决策没有收到结果事件：任务可能还在跑，或为外部 provider（不参与路由）。`)
}

const recent = [...decisions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)

const summary = {
  generatedAt: new Date().toISOString(),
  windowHours: hours,
  trace: traceFile,
  decisions: decisions.length,
  malformedLines: malformed,
  via: byVia,
  cacheHitRate: pct(cacheHits, decisions.length),
  fallbackRate: pct(fallbacks, decisions.length),
  head: { calls: headCalls, errors: headErrors },
  orchestration: verdicts,
  outcomes: {
    total: joined.length,
    stopReason: byStop,
    successRate: pct(success, joined.length),
    failureRate: pct(failures, joined.length),
    medianDurationMs: median(joined.map((row) => row.durationMs).filter((value) => value !== null)),
    p95DurationMs: p95(joined.map((row) => row.durationMs).filter((value) => value !== null)),
  },
  models: [...byModel.entries()]
    .map(([key, entry]) => ({
      model: key,
      calls: entry.calls,
      success: entry.success,
      failure: entry.failure,
      medianDurationMs: median(entry.durations),
      via: entry.via,
    }))
    .sort((a, b) => b.calls - a.calls),
  decisionsByModel: [...byDecisionModel.entries()]
    .map(([model, entry]) => ({ model, decisions: entry.decisions, via: entry.via }))
    .sort((a, b) => b.decisions - a.decisions),
  cache: {
    routingEntries: routingEntries.length,
    visionEntries,
    oldestEntryAgeDays: oldestCacheAgeDays,
  },
  anomalies,
  recent: recent.map((decision) => ({
    at: decision.at,
    session: shortSession(decision.session),
    via: decision.via,
    model: `${decision.provider ?? '?'}/${decision.model ?? '?'}`,
    task: short(decision.head, 40),
  })),
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const line = (label, value) => `| ${label} | ${value} |`
const modelsRows = summary.models
  .map((entry) => `| ${entry.model} | ${entry.calls} | ${entry.success} | ${entry.failure} | ${humanMs(entry.medianDurationMs)} | ${Object.entries(entry.via).map(([via, count]) => `${via}:${count}`).join(' / ')} |`)
  .join('\n')
const decisionRows = summary.decisionsByModel
  .map((entry) => `| ${entry.model} | ${entry.decisions} | ${Object.entries(entry.via).map(([via, count]) => `${via}:${count}`).join(' / ')} |`)
  .join('\n')
const recentRows = recent
  .map((decision) => `| ${new Date(decision.at).toLocaleTimeString('zh-CN', { hour12: false })} | ${shortSession(decision.session)} | ${decision.via} | ${decision.provider ?? '?'}/${decision.model ?? '?'} | ${short(decision.head, 36)} |`)
  .join('\n')

const markdown = `# 路由巡检报告

生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}（近 ${hours} 小时）

## 概览

| 项 | 值 |
| --- | --- |
| 子代理决策 | ${summary.decisions} |
| 缓存命中率 | ${summary.cacheHitRate ?? '-'}% |
| 兜底率 | ${summary.fallbackRate ?? '-'}% |
| 头领调用 / 失败 | ${headCalls} / ${headErrors} |
| 有结果的任务 | ${joined.length} |
| 成功率 / 失败率 | ${summary.outcomes.successRate ?? '-'}% / ${summary.outcomes.failureRate ?? '-'}% |
| 中位耗时 | ${humanMs(summary.outcomes.medianDurationMs)} |

## 编排判定（是否外包）

${Object.entries(verdicts).map(([verdict, count]) => `- ${verdict}: ${count}`).join('\n') || '- 无记录'}

## 结果分布

${Object.entries(byStop).map(([reason, count]) => `- ${reason}: ${count}`).join('\n') || '- 无结果事件（检查 DSH 版本或任务是否仍在运行）'}

## 决策分布（按模型）

| 模型 | 决策数 | via |
| --- | --- | --- |
${decisionRows || '| - | - | - |'}

## 结果（按模型）

| 模型 | 次数 | 成功 | 失败 | 中位耗时 | via |
| --- | --- | --- | --- | --- | --- |
${modelsRows || '| - | - | - | - | - | - |'}

## 最近决策

| 时间 | 会话 | via | 模型 | 任务 |
| --- | --- | --- | --- | --- |
${recentRows || '| - | - | - | - | - |'}

## 缓存

- 路由缓存条目：${routingEntries.length}
- 视觉缓存条目：${visionEntries}
- 最老条目：${oldestCacheAgeDays ?? '-'} 天

## 异常提示

${anomalies.length > 0 ? anomalies.map((item) => `- ${item}`).join('\n') : '- 无'}

> 解析失败行：${malformed}（trace 边写边读时末尾可能有不完整行，属正常）
`

mkdirSync(outDir, { recursive: true })
const stamp = new Date()
const fileName = `router-report-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}.md`
const reportPath = join(outDir, fileName)
writeFileSync(reportPath, markdown, 'utf8')
writeFileSync(join(outDir, 'latest.md'), markdown, 'utf8')

console.log(`报告：${reportPath}`)
console.log(`决策 ${summary.decisions} 次 · 缓存命中 ${summary.cacheHitRate ?? '-'}% · 兜底 ${summary.fallbackRate ?? '-'}% · 成功率 ${summary.outcomes.successRate ?? '-'}%`)
if (anomalies.length > 0) {
  console.log('异常：')
  for (const item of anomalies) console.log(`  - ${item}`)
}
