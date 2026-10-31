#!/usr/bin/env node
// fetch-trending.mjs —— 抓取 GitHub 热门仓库（按最近 7 天新建 + star 数排序）
// 走官方 REST API，无需第三方依赖；可用 GITHUB_TOKEN 提高速率上限。
//
// 用法:
//   node scripts/fetch-trending.mjs [--days 7] [--limit 30] [--out data/snapshot.json]
//   node scripts/fetch-trending.mjs --append   # 追加到 data/history.jsonl，用于趋势分析

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const days = Number(getArg('days', '7'))
const limit = Math.min(100, Number(getArg('limit', '30')))
const outPath = resolve(ROOT, getArg('out', 'data/snapshot.json'))
const append = args.includes('--append')

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

function sinceISO(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

async function ghFetch(path, params) {
  const url = new URL(`https://api.github.com${path}`)
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v))
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gh-trending-scheduler',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`)
  }
  return res.json()
}

function normalize(item) {
  return {
    id: item.id,
    fullName: item.full_name,
    name: item.name,
    owner: item.owner?.login ?? '',
    ownerAvatar: item.owner?.avatar_url ?? '',
    htmlUrl: item.html_url,
    description: item.description ?? '',
    language: item.language ?? 'Unknown',
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    openIssues: item.open_issues_count ?? 0,
    topics: item.topics ?? [],
    createdAt: item.created_at,
    pushedAt: item.pushed_at,
    ageDays: Math.max(
      0,
      Math.round((Date.now() - new Date(item.created_at).getTime()) / (24 * 3600 * 1000)),
    ),
    starsPerDay: 0,
  }
}

async function main() {
  const since = sinceISO(days)
  console.log(`[fetch] 抓取 ${since} 之后创建、按 star 排序的前 ${limit} 个仓库…`)

  // created:>=日期 + sort=stars 即为「近期新增且最受关注」的口径
  const data = await ghFetch('/search/repositories', {
    q: `created:>=${since}`,
    sort: 'stars',
    order: 'desc',
    per_page: limit,
  })

  const items = (data.items ?? []).map(normalize)
  items.forEach((repo) => {
    repo.starsPerDay = repo.ageDays > 0 ? Math.round((repo.stars / repo.ageDays) * 10) / 10 : repo.stars
  })

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    windowDays: days,
    since,
    totalCount: data.total_count ?? items.length,
    items,
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`[fetch] 已写入 ${outPath}（${items.length} 个仓库）`)

  if (append) {
    const historyPath = resolve(ROOT, 'data/history.jsonl')
    const line = JSON.stringify({
      fetchedAt: snapshot.fetchedAt,
      windowDays: days,
      repos: items.map((r) => ({ fullName: r.fullName, stars: r.stars, language: r.language })),
    })
    appendFileSync(historyPath, line + '\n', 'utf8')
    const lines = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).length
    console.log(`[fetch] 已追加历史快照 ${historyPath}（共 ${lines} 条）`)
  }

  return snapshot
}

if (process.argv[1] && process.argv[1].endsWith('fetch-trending.mjs')) {
  main().catch((err) => {
    console.error('[fetch] 失败:', err.message)
    process.exit(1)
  })
}

export { main as fetchTrending, normalize }
