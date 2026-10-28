/**
 * Local orchestration triage: decide whether a user-facing task should be
 * delegated to a subagent before the model starts working on it.
 *
 * Pure heuristics on the incoming message — no model call. The result is a short
 * prompt section so the main agent sees a verdict it can act on immediately.
 */

// Bounded character classes keep every scan linear even on hostile megabyte-sized
// prompts; the input is additionally capped in assessTask.
// Regex sources are kept as strings and compiled per call: module-level /g
// patterns share a mutable lastIndex across agents, a latent hazard if anyone
// ever switches these scans from `.match` to `.test/.exec`.
const IMAGE_PATH_SRC = String.raw`[A-Za-z]:\\[^\n"'<>|?*]{1,240}?\.(?:png|jpe?g|webp|gif)\b`
const CODE_PATH_SRC = String.raw`[A-Za-z]:\\[^\n"'<>|?*]{1,240}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|md|json|yml|yaml|toml|sql|sh|ps1)\b`
const CODE_FILE_REL_SRC = String.raw`(?:[\w.-]{1,80}[\\/]){0,8}[\w.-]{1,120}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|md|json|yml|yaml|toml|sql|sh|ps1)\b`
// Documents the user attached (@file references included): reading them is
// real work, and several attachments usually mean parallel subagents.
const DOC_PATH_SRC = String.raw`[^\n"'<>|?*]{1,200}\.(?:pdf|pptx?|docx?|xlsx?|csv|rtf|epub)\b`
const scanAll = (source, text) => String(text ?? '').match(new RegExp(source, 'gi')) ?? []
const ANALYSIS = /审查|审计|排查|定位|分析|检查|评估|review|audit|investigate|diagnose|analy[sz]e/i
const RISK = /并发|竞态|内存泄漏|死锁|安全|漏洞|性能|根因|风险|race|deadlock|leak|vulnerab|performance/i
const STACK = /Traceback|Stack trace|at [^\n]{0,200}\(\d{1,6}:\d{1,6}\)|Exception|Error:|panic:|报错堆栈|错误日志|调用栈/i
const COMPLEX = /重构|迁移|架构|并发|分布式|性能优化|安全审计|根因|跨模块|全链路|refactor|migrat|architect|concurren|audit|deadlock|race condition/i
const RESEARCH = /调研|查一下|搜索|资料|论文|对比|最新|研究|research|look up|survey|compare/i
const BUILD = /实现|编写|修复|补测试|开发|改造|新增|添加|升级|接入|implement|build|fix|refactor|add |create /i
const WRITE_VERB = /写|撰写/i
const CODING_NOUN = /页面|接口|函数|脚本|模块|组件|服务|数据库|表单|登录|路由|前端|后端|命令行|代码|class|method|api|endpoint|cli|schema|migration|unit test|测试用例|bug/i
// Explicit low-effort intent. These tasks should still be correct, but the
// cheapest capable model is enough — never burn a Pro call on a placeholder.
const CHEAP_INTENT = /凑数|凑合|随便|敷衍|草稿|占位|不用太|别花太多|别太认真|简单弄|能交就行|能用就行|低投入|套模板|快速弄|快速生成|尽量快|最短时间|不要求质量|低质量/i
const MAX_SCAN = 20_000

export const isCheapTask = (text) => CHEAP_INTENT.test(String(text ?? '').slice(0, MAX_SCAN))

export function assessTask(text, message) {
  const clean = String(text ?? '').slice(0, MAX_SCAN)
  const reasons = []
  let score = 0
  const add = (points, why) => {
    score += points
    reasons.push(why)
  }

  const length = clean.length
  if (length > 1200) add(3, '超长指令')
  else if (length > 400) add(2, '长指令')
  else if (length > 160) add(1, '中等长度')

  if ((clean.match(/```/g) ?? []).length >= 2) add(2, '含代码块')
  if (STACK.test(clean)) add(2, '含报错/堆栈')
  const images = scanAll(IMAGE_PATH_SRC, clean)
  if (images.length > 0) add(3, '图片路径')
  const files = scanAll(CODE_PATH_SRC, clean)
  const relFiles = scanAll(CODE_FILE_REL_SRC, clean)
  const fileTotal = files.length + relFiles.length
  if (fileTotal >= 3) add(2, '多文件')
  else if (fileTotal >= 1) add(1, '涉及文件')
  const docs = [...new Set(scanAll(DOC_PATH_SRC, clean).map((path) => path.toLowerCase()))]
  if (docs.length >= 3) add(3, `多附件×${docs.length}`)
  else if (docs.length >= 1) add(2, '附件')
  if (COMPLEX.test(clean)) add(2, '复杂工程')
  if (ANALYSIS.test(clean)) add(1, '审查/排查')
  if (ANALYSIS.test(clean) && fileTotal >= 2) add(1, '审查工作量')
  if (RISK.test(clean) && !COMPLEX.test(clean)) add(2, '风险信号')
  if (RESEARCH.test(clean)) add(1, '检索调研')

  const codingNoun = CODING_NOUN.test(clean)
  const build = BUILD.test(clean) || (WRITE_VERB.test(clean) && codingNoun)
  const coding = build || (ANALYSIS.test(clean) && (fileTotal > 0 || codingNoun))
  if (build) add(1, '实现类')
  // "实现一个登录页面" is short but real coding work: never classify it as light.
  if (build && codingNoun) add(1, '代码实体')
  if (build && (length > 80 || files.length > 0 || (clean.match(/```/g) ?? []).length >= 2)) add(1, '编码工作量')

  const hasImage = Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image')
  if (hasImage) add(2, '携带图片')

  const image = images.length > 0 || hasImage
  const cheap = isCheapTask(clean)
  const trivial = length <= 160 && score === 0 && !STACK.test(clean) && !COMPLEX.test(clean)
  const attachments = docs.length
  const base = { score, reasons, image, coding, attachments, cheap }
  if (trivial) return { verdict: 'light', ...base }
  if (score >= 3) return { verdict: 'heavy', ...base }
  return { verdict: 'normal', ...base }
}

/** The verdict line injected into the main agent's prompt. */
export function verdictText(assessment, options = {}) {
  const healer = options.healTool ?? 'subagent'
  if (assessment?.verdict === 'heavy') {
    const parallel = (assessment.attachments ?? 0) >= 2
      ? [`素材有 ${assessment.attachments} 个附件：按附件拆分给多个子代理并行处理（每个 PDF/PPT 一个），再由你汇总；不要串行读。`]
      : []
    const cheap = assessment.cheap === true
      ? ['这是低投入任务（凑数/占位/套模板）：只要结果能用即可，不要在质量打磨上花时间，也不要动用 Pro；委派时把「凑数任务，用最便宜模型」写进提示。']
      : []
    return [
      '[自动编排判定] 重活 —— 你必须先派生一个子代理去执行，不要自己硬扛。',
      `理由：${assessment.reasons.join('、') || '任务体量较大'}。`,
      ...cheap,
      `做法：调用 ${healer}（图片/视觉任务也用它，插件已开启识图预处理；代码类可优先 subagent_codex（若外部可用）），把完整任务与验收标准交给它。`,
      ...parallel,
      '委派提示里必须写明：「你是执行者，只完成本任务，不要再派生任何子代理或队友」。',
      '子代理跑完后由你汇总、校验并回复用户。',
    ].join('\n')
  }
  if (assessment?.verdict === 'light') {
    return '[自动编排判定] 轻量任务 —— 直接回答，不要派生子代理，避免空转开销。'
  }
  if (assessment?.coding === true) {
    return [
      '[自动编排判定] 编码任务 —— 除非只是单行/单文件小改动，否则先派 subagent 执行，不要自己从头写。',
      ...(assessment.cheap === true ? ['这是低投入任务：用最便宜模型，委派提示里写明「凑数任务，用最便宜模型」。'] : []),
      `做法：调用 ${healer}（代码类可优先 subagent_codex，若外部可用），把完整任务与验收标准交给它。`,
      '委派提示里必须写明：「你是执行者，只完成本任务，不要再派生任何子代理或队友」；你只做拆解、验收与汇总。',
    ].join('\n')
  }
  return [
    '[自动编排判定] 中等任务 —— 可以先自己做；',
    ...(assessment?.cheap === true ? ['这是低投入任务：直接自己用最便宜的方式做完，不要动用 Pro。'] : []),
    '若需要跨多文件反复修改、长时间检索或运行测试，改用 subagent 委派，并注明「不要再派生」。',
  ].join('\n')
}

/** Long-lived policy the main agent should always see. */
export const ORCHESTRATION_POLICY = [
  '多智能体编排规范：',
  '1) 重活（长指令、代码块、报错堆栈、图片、多文件、复杂工程、资料调研）先派生子代理，自己只做拆解、验收与汇总。',
  '2) 轻活（闲聊、单行改动、简单问答）直接回答，不派生子代理。',
  '3) 每次委派的提示最后必须加：「你是执行者，只完成本任务，不要再派生任何子代理或队友」。',
  '4) 子代理负责执行，不再展开团队；需要多角色时由你一次性拆分。',
].join('\n')
