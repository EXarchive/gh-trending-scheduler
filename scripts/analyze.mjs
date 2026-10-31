#!/usr/bin/env node
// analyze.mjs —— 对快照做统计分析，产出 report/data.json 供静态报告页渲染
//
// 用法: node scripts/analyze.mjs [--in data/snapshot.json] [--out report/data.json]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}

function countBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item) || 'Unknown'
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

const snapshotPath = resolve(ROOT, getArg('in', 'data/snapshot.json'))
const outPath = resolve(ROOT, getArg('out', 'report/data.json'))

const snapshot = readJson(snapshotPath, null)
if (!snapshot) {
  console.error(`[analyze] 找不到快照: ${snapshotPath}，请先运行 npm run fetch`)
  process.exit(1)
}

const items = snapshot.items ?? []
const stars = items.map((r) => r.stars)

const byLanguage = countBy(items, (r) => r.language)
const byOwner = countBy(items.filter((r) => r.owner), (r) => r.owner)

const topByStars = [...items].sort((a, b) => b.stars - a.stars).slice(0, 10)
const topByVelocity = [...items].sort((a, b) => b.starsPerDay - a.starsPerDay).slice(0, 10)

const topicCount = new Map()
for (const repo of items) {
  for (const topic of repo.topics ?? []) {
    topicCount.set(topic, (topicCount.get(topic) ?? 0) + 1)
  }
}
const topTopics = [...topicCount.entries()]
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 15)

// 历史趋势：从 history.jsonl 里取同一仓库的 star 变化
const historyPath = resolve(ROOT, 'data/history.jsonl')
const history = []
if (existsSync(historyPath)) {
  for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      history.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }
}

const trend = []
if (history.length >= 2) {
  const first = history[0]
  const last = history[history.length - 1]
  const lastMap = new Map(last.repos.map((r) => [r.fullName, r.stars]))
  for (const repo of first.repos) {
    const now = lastMap.get(repo.fullName)
    if (now === undefined) continue
    trend.push({ fullName: repo.fullName, from: repo.stars, to: now, delta: now - repo.stars })
  }
  trend.sort((a, b) => b.delta - a.delta)
}

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    fetchedAt: snapshot.fetchedAt,
    windowDays: snapshot.windowDays,
    since: snapshot.since,
    repoCount: items.length,
    totalCount: snapshot.totalCount,
  },
  summary: {
    totalStars: stars.reduce((a, b) => a + b, 0),
    medianStars: percentile(stars, 50),
    p90Stars: percentile(stars, 90),
    maxStars: stars.length ? Math.max(...stars) : 0,
    languageCount: byLanguage.length,
    avgStarsPerDay:
      items.length > 0
        ? Math.round((items.reduce((a, b) => a + b.starsPerDay, 0) / items.length) * 10) / 10
        : 0,
  },
  byLanguage: byLanguage.slice(0, 12),
  topOwners: byOwner.slice(0, 8),
  topTopics,
  topByStars: topByStars.map((r) => ({
    fullName: r.fullName,
    stars: r.stars,
    language: r.language,
    description: r.description,
    htmlUrl: r.htmlUrl,
  })),
  topByVelocity: topByVelocity.map((r) => ({
    fullName: r.fullName,
    starsPerDay: r.starsPerDay,
    stars: r.stars,
    ageDays: r.ageDays,
    language: r.language,
    htmlUrl: r.htmlUrl,
  })),
  trend: trend.slice(0, 10),
  historyPoints: history.length,
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
console.log(`[analyze] 已生成 ${outPath}`)
console.log(
  `[analyze] ${report.source.repoCount} 个仓库 / 语言 ${report.summary.languageCount} 种 / 中位 star ${report.summary.medianStars}`,
)
