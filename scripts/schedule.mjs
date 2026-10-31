#!/usr/bin/env node
// schedule.mjs —— 轻量定时任务调度器（无第三方依赖）
//
// 支持两种模式:
//   node scripts/schedule.mjs                 # 常驻：按 cron 定时执行「抓取 → 分析」
//   node scripts/schedule.mjs --once           # 立即执行一次后退出（便于 CI / 手动补跑）
//   node scripts/schedule.mjs --cron "0 */2 * * *"   # 自定义 cron（默认每 2 小时）
//
// 设计要点:
//   - 自实现的 5 段 cron 解析（分 时 日 月 周），支持 * , - / 四种语法
//   - 串行执行，前一次未结束不会叠加；失败后按指数退避重试（最多 3 次）
//   - 全流程日志写入 data/scheduler.log，并保留最近 500 行

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_PATH = resolve(ROOT, 'data/scheduler.log')
const STATE_PATH = resolve(ROOT, 'data/scheduler-state.json')

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const once = args.includes('--once')
const cronExpr = getArg('cron', process.env.SCHEDULE_CRON || '0 */2 * * *')

// ---------- cron 解析 ----------
function parseField(field, min, max) {
  const values = new Set()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error(`非法步长: ${part}`)

    let start
    let end
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      start = a
      end = b
    } else {
      start = Number(rangePart)
      end = stepPart ? max : start
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`非法区间: ${part}`)
    if (start < min || end > max) throw new Error(`超出范围 [${min},${max}]: ${part}`)

    for (let v = start; v <= end; v += step) values.add(v)
  }
  return values
}

function parseCron(expr) {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron 需要 5 段，收到 ${fields.length} 段: "${expr}"`)
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6),
    expr,
  }
}

function matches(cron, date) {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.dayOfMonth.has(date.getDate()) &&
    cron.month.has(date.getMonth() + 1) &&
    cron.dayOfWeek.has(date.getDay())
  )
}

// ---------- 日志 ----------
function log(level, message) {
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${message}`
  console.log(line)
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, line + '\n', 'utf8')
    const lines = readFileSync(LOG_PATH, 'utf8').split('\n')
    if (lines.length > 520) {
      writeFileSync(LOG_PATH, lines.slice(-500).join('\n'), 'utf8')
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function readState() {
  if (!existsSync(STATE_PATH)) return { runs: 0, failures: 0, lastRunAt: null, lastError: null }
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { runs: 0, failures: 0, lastRunAt: null, lastError: null }
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
}

// ---------- 子进程执行 ----------
function runNode(script, extraArgs = []) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [resolve(ROOT, script), ...extraArgs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('close', (code) => resolvePromise({ code, out: out.trim() }))
    child.on('error', (err) => resolvePromise({ code: -1, out: String(err) }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runCycle(trigger) {
  const state = readState()
  log('INFO', `开始执行（触发方式: ${trigger}）`)
  const startedAt = Date.now()

  let attempt = 0
  let lastResult = null
  while (attempt < 3) {
    attempt += 1
    const fetchRes = await runNode('scripts/fetch-trending.mjs', ['--append'])
    if (fetchRes.code === 0) {
      const analyzeRes = await runNode('scripts/analyze.mjs')
      if (analyzeRes.code === 0) {
        lastResult = { ok: true, fetch: fetchRes.out, analyze: analyzeRes.out }
        break
      }
      lastResult = { ok: false, stage: 'analyze', out: analyzeRes.out }
    } else {
      lastResult = { ok: false, stage: 'fetch', out: fetchRes.out }
    }
    if (attempt < 3) {
      const backoff = 2000 * attempt
      log('WARN', `第 ${attempt} 次执行失败（${lastResult.stage}），${backoff}ms 后重试: ${lastResult.out.slice(0, 300)}`)
      await sleep(backoff)
    }
  }

  const durationMs = Date.now() - startedAt
  state.runs += 1
  state.lastRunAt = new Date().toISOString()
  state.lastDurationMs = durationMs

  if (lastResult?.ok) {
    log('INFO', `执行成功，用时 ${durationMs}ms`)
    state.lastError = null
    state.lastSuccessAt = state.lastRunAt
    writeState(state)
    return true
  }

  state.failures += 1
  state.lastError = `${lastResult?.stage}: ${(lastResult?.out ?? '').slice(0, 500)}`
  log('ERROR', `执行失败（重试 3 次后放弃）: ${state.lastError}`)
  writeState(state)
  return false
}

// ---------- 入口 ----------
async function main() {
  if (once) {
    const ok = await runCycle('--once')
    process.exit(ok ? 0 : 1)
  }

  let cron
  try {
    cron = parseCron(cronExpr)
  } catch (err) {
    log('ERROR', `cron 表达式非法: ${err.message}`)
    process.exit(2)
  }

  log('INFO', `调度器启动，cron="${cron.expr}"，每分钟检查一次（Ctrl+C 退出）`)
  writeState({ ...readState(), running: true, startedAt: new Date().toISOString(), cron: cron.expr })

  let running = false
  let lastMinuteKey = ''

  const tick = async () => {
    const now = new Date()
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
    if (minuteKey === lastMinuteKey) return
    if (!matches(cron, now)) return
    lastMinuteKey = minuteKey
    if (running) {
      log('WARN', '上一次任务仍在执行，跳过本次触发')
      return
    }
    running = true
    try {
      await runCycle(`cron ${cron.expr}`)
    } finally {
      running = false
    }
  }

  // 对齐到整分
  const msToNextMinute = 60000 - (Date.now() % 60000)
  setTimeout(() => {
    tick()
    setInterval(tick, 60000)
  }, msToNextMinute)

  process.on('SIGINT', () => {
    log('INFO', '收到 SIGINT，调度器退出')
    writeState({ ...readState(), running: false })
    process.exit(0)
  })
}

main().catch((err) => {
  log('ERROR', `调度器异常退出: ${err.message}`)
  process.exit(1)
})
