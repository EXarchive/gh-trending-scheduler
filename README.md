# GitHub 热门仓库抓取与分析（定时任务）

一个无第三方依赖的定时任务项目：按 cron 周期抓取 GitHub 近期最受关注的开源仓库，做统计分析，并生成一个可视化报告页。

用于回答「最近一周/两周里，社区真正在关注什么」。

## 能力

| 环节 | 脚本 | 说明 |
|------|------|------|
| 抓取 | `scripts/fetch-trending.mjs` | 调 GitHub REST API `search/repositories`，取 `created:>=N天前` 且按 star 排序的仓库；归一化后写 `data/snapshot.json`，可选追加 `data/history.jsonl` 形成时间序列 |
| 分析 | `scripts/analyze.mjs` | 统计总量 / 中位与 P90 star / 语言分布 / 组织分布 / 标签热度 / 涨星速度 Top10 / 跨快照 star 增量，输出 `report/data.json` |
| 调度 | `scripts/schedule.mjs` | 自实现 5 段 cron 解析（`* , - /`），每分钟对齐检查；串行执行、避免叠加，失败指数退避重试 3 次，日志滚动保留 500 行 |
| 报告 | `report/index.html` + `scripts/serve-report.mjs` | 纯静态页面读取 `data.json` 渲染卡片、条形图与表格；自带极简静态服务器 |

## 快速开始

```bash
# 立刻跑一轮（抓取 → 分析），适合验证或 CI 补跑
npm run run

# 常驻调度：默认每 2 小时一次
npm start

# 自定义 cron（分 时 日 月 周）
node scripts/schedule.mjs --cron "0 */6 * * *"

# 预览报告
npm run report      # http://127.0.0.1:8123/index.html
```

抓取速率更高可设置令牌（未设置时走匿名配额，每小时 60 次）：

```bash
export GITHUB_TOKEN=ghp_xxx      # PowerShell: $env:GITHUB_TOKEN="ghp_xxx"
```

## 目录结构

```
gh-trending-scheduler/
├─ package.json
├─ scripts/
│  ├─ fetch-trending.mjs   # 抓取 + 归一化 + 快照落盘
│  ├─ analyze.mjs          # 统计分析与报告数据生成
│  ├─ schedule.mjs         # cron 调度器（重试 / 日志 / 状态）
│  └─ serve-report.mjs     # 报告静态服务器
├─ report/
│  ├─ index.html           # 报告页
│  └─ data.json            # analyze 产物（运行时生成）
└─ data/
   ├─ snapshot.json        # 最新快照
   ├─ history.jsonl        # 每次抓取追加一行，用于趋势
   ├─ scheduler.log        # 调度日志（滚动 500 行）
   └─ scheduler-state.json # 运行次数 / 失败次数 / 最后错误
```

## 调度器设计要点

- **不叠加**：上一轮未结束时本次触发直接跳过并记 WARN，避免长任务堆积。
- **对齐整分**：启动后先等到下一个整分再开始检查，避免 59 秒后立刻触发一分钟内的第二次。
- **幂等去重**：同一分钟内只判断一次（`lastMinuteKey`），手抖或时钟回拨都不会重复执行。
- **失败隔离**：抓取与分析分阶段记日志，重试时按 2s / 4s 退避；连续失败保留 `lastError` 到状态文件，便于事后排查。
- **状态可观测**：`data/scheduler-state.json` 里有 `runs / failures / lastRunAt / lastSuccessAt / lastDurationMs`。

## 实测

一次完整执行（--once）耗时约 1.7s，抓取 30 个仓库、统计 12 种语言；报告页零 console 错误。
