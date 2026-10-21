/**
 * Local orchestration triage: decide whether a user-facing task should be
 * delegated to a subagent before the model starts working on it.
 *
 * Pure heuristics on the incoming message — no model call. The result is a short
 * prompt section so the main agent sees a verdict it can act on immediately.
 */

// Bounded character classes keep every scan linear even on hostile megabyte-sized
// prompts; the input is additionally capped in assessTask.
const IMAGE_PATH = /[A-Za-z]:\\[^\n"'<>|?*]{1,240}?\.(?:png|jpe?g|webp|gif)\b/gi
const CODE_PATH = /[A-Za-z]:\\[^\n"'<>|?*]{1,240}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|md|json|yml|yaml|toml|sql|sh|ps1)\b/gi
const STACK = /Traceback|Stack trace|at [^\n]{0,200}\(\d{1,6}:\d{1,6}\)|Exception|Error:|panic:|报错堆栈|错误日志|调用栈/i
const COMPLEX = /重构|迁移|架构|并发|分布式|性能优化|安全审计|根因|跨模块|全链路|refactor|migrat|architect|concurren|audit|deadlock|race condition/i
const RESEARCH = /调研|查一下|搜索|资料|论文|对比|最新|研究|research|look up|survey|compare/i
const BUILD = /实现|编写|修复|补测试|开发|改造|新增|添加|升级|接入|implement|build|fix|refactor|add |create /i
const WRITE_VERB = /写|撰写/i
const CODING_NOUN = /页面|接口|函数|脚本|模块|组件|服务|数据库|表单|登录|路由|前端|后端|命令行|代码|class|method|api|endpoint|cli|schema|migration|unit test|测试用例|bug/i
const MAX_SCAN = 20_000

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
  const images = clean.match(IMAGE_PATH) ?? []
  if (images.length > 0) add(3, '图片路径')
  const files = clean.match(CODE_PATH) ?? []
  if (files.length >= 3) add(2, '多文件')
  else if (files.length >= 1) add(1, '涉及文件')
  if (COMPLEX.test(clean)) add(2, '复杂工程')
  if (RESEARCH.test(clean)) add(1, '检索调研')

  const codingNoun = CODING_NOUN.test(clean)
  const build = BUILD.test(clean) || (WRITE_VERB.test(clean) && codingNoun)
  const coding = build || codingNoun
  if (build) add(1, '实现类')
  // "实现一个登录页面" is short but real coding work: never classify it as light.
  if (build && codingNoun) add(1, '代码实体')
  if (build && (length > 80 || files.length > 0 || (clean.match(/```/g) ?? []).length >= 2)) add(1, '编码工作量')

  const hasImage = Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image')
  if (hasImage) add(2, '携带图片')

  const image = images.length > 0 || hasImage
  const trivial = length <= 160 && score === 0 && !STACK.test(clean) && !COMPLEX.test(clean)
  if (trivial) return { verdict: 'light', score, reasons, image, coding }
  if (score >= 3) return { verdict: 'heavy', score, reasons, image, coding }
  return { verdict: 'normal', score, reasons, image, coding }
}

/** The verdict line injected into the main agent's prompt. */
export function verdictText(assessment, options = {}) {
  const healer = options.healTool ?? 'subagent'
  if (assessment?.verdict === 'heavy') {
    return [
      '[自动编排判定] 重活 —— 你必须先派生一个子代理去执行，不要自己硬扛。',
      `理由：${assessment.reasons.join('、') || '任务体量较大'}。`,
      `做法：调用 ${healer}（图片/视觉任务也用它，插件已开启识图预处理；代码类可优先 subagent_codex（若外部可用）），把完整任务与验收标准交给它。`,
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
      `做法：调用 ${healer}（代码类可优先 subagent_codex，若外部可用），把完整任务与验收标准交给它。`,
      '委派提示里必须写明：「你是执行者，只完成本任务，不要再派生任何子代理或队友」；你只做拆解、验收与汇总。',
    ].join('\n')
  }
  return [
    '[自动编排判定] 中等任务 —— 可以先自己做；',
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
