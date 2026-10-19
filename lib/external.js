/**
 * External (out-of-process) delegation availability.
 *
 * External subagent providers — `codex`, `claude-code`, `acp` — are not model
 * routes: the Harness starts them as separate child processes through a tool
 * such as `subagent_codex`. Routing therefore cannot rewrite them; it can only
 * report whether one is usable so the agent prefers it for the matching roles
 * and falls back to a model when it is not.
 */
import { spawn } from 'node:child_process'

/** Probe one executable with `--version`; resolves instead of throwing. */
export function probeCommand(command, timeoutMs = 4_000) {  return new Promise((resolve) => {
    if (typeof command !== 'string' || command.trim() === '') {
      resolve({ ok: false, reason: '未配置 command' })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { child?.kill() } catch { /* already gone */ }
      resolve(result)
    }
    let child
    try {
      child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      resolve({ ok: false, reason: `无法启动（${error?.code ?? error?.message ?? 'unknown'}）` })
      return
    }
    child.once('error', (error) => finish({ ok: false, reason: `不可执行（${error?.code ?? 'error'}）` }))
    child.once('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: `--version 退出码 ${code}` }))
    setTimeout(() => finish({ ok: false, reason: `探测超时（${timeoutMs}ms）` }), timeoutMs).unref?.()
  })
}

/**
 * Probe an HTTP endpoint (typically a local relay the external CLI is pointed
 * at). A live relay answers 4xx for an unauthenticated GET, which still proves
 * the socket is served; connection failures and 5xx do not.
 */
export function probeEndpoint(url, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `端点探测超时（${timeoutMs}ms）` }), timeoutMs)
    timer.unref?.()
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
      .then((response) => {
        clearTimeout(timer)
        finish(response.status >= 500
          ? { ok: false, reason: `HTTP ${response.status}` }
          : { ok: true, status: response.status })
      })
      .catch((error) => {
        clearTimeout(timer)
        finish({ ok: false, reason: `端点不可达（${error?.cause?.code ?? error?.message ?? 'error'}）` })
      })
  })
}

/**
 * Resolve one external entry against the live subagent registry and an optional
 * CLI probe. `provider` presence is the primary signal; a configured `command`
 * is probed too, because a registered provider whose executable is missing
 * fails only when it is first started.
 */
export async function evaluateExternal(entry, context) {
  const name = String(entry?.name ?? 'external')
  if (entry?.enabled !== true) return { name, enabled: false, available: false, reason: '未启用' }
  const provider = String(entry?.provider ?? name)
  let registered = false
  try {
    registered = Boolean(context.subagents?.getProvider?.(provider))
      || (context.subagents?.list?.() ?? []).includes(provider)
  } catch {
    registered = false
  }
  if (!registered) {
    return { name, enabled: true, provider, available: false, registered: false, reason: `provider「${provider}」未注册` }
  }
  const endpoint = typeof entry?.endpoint === 'string' ? entry.endpoint.trim() : ''
  if (endpoint !== '') {
    const limit = Number(entry?.checkTimeoutMs) > 0 ? Math.min(Number(entry.checkTimeoutMs), 5_000) : 3_000
    const probe = await probeEndpoint(endpoint, limit)
    if (!probe.ok) {
      return { name, enabled: true, provider, available: false, registered: true, reason: `中转端点不可达（${endpoint}：${probe.reason}）` }
    }
  }
  const command = typeof entry?.command === 'string' ? entry.command.trim() : ''
  if (command !== '') {
    const probe = await probeCommand(command, Number(entry?.checkTimeoutMs) > 0 ? Number(entry.checkTimeoutMs) : 4_000)
    if (!probe.ok) {
      return { name, enabled: true, provider, available: false, registered: true, reason: `CLI「${command}」${probe.reason}` }
    }
    return { name, enabled: true, provider, available: true, registered: true, command }
  }
  return { name, enabled: true, provider, available: true, registered: true }
}

/** One line the model sees: what is outsourced, where, and what to do instead. */
export function externalAdvice(entry, status, fallback) {
  const tool = String(entry?.tool ?? '')
  const roles = Array.isArray(entry?.roles) && entry.roles.length > 0 ? entry.roles.join(' / ') : '编码'
  const label = String(status?.name ?? 'external')
  if (status?.available === true) {
    return `外部外包可用：${label}（工具 ${tool}）。${roles} 类工作优先委派给它；若调用报错或长时间无输出，立即改用 subagent + DeepSeek 模型（${fallback}）继续，并提醒用户 ${label} 当前不可用。本插件的模型路由只作用于 DeepSeek 子代理，不影响它。`
  }
  return `外部外包不可用：${label}（${status?.reason ?? '未知原因'}）。${roles} 类工作继续走 DeepSeek 模型（${fallback}），不要尝试调用 ${tool || '该工具'}。`
}
