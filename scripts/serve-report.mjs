#!/usr/bin/env node
// serve-report.mjs —— 极简静态服务器，用于本地预览 report/ 下的报告页
// 用法: node scripts/serve-report.mjs [--port 8123]

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg >= 0 && args[portArg + 1] ? Number(args[portArg + 1]) : 8123

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'

    const safePath = normalize(join(ROOT, 'report', pathname))
    if (!safePath.startsWith(join(ROOT, 'report'))) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const body = await readFile(safePath)
    res.writeHead(200, {
      'content-type': MIME[extname(safePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] 报告已就绪: http://127.0.0.1:${PORT}/index.html`)
})
