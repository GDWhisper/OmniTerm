#!/usr/bin/env node
/**
 * pty 历史视口帧探针 —— 量「单帧体积 / 请求→响应耗时 / 瘦身收益」。
 *
 * 用途：为 pty 移动端滚动改造（`docs/dev/plans/backlog/pty-mobile-termux-feel.md`
 * §3.2）提供决策数据。直连后端 WS（不经浏览器、不经前端），自动创建并删除
 * 临时 pty 会话。
 *
 * 前置：`./dev.sh start`（后端已运行）。跑法：`node scripts/pty-viewport-probe.mjs`
 *
 * 四组测量：
 *   [A] 串行往返 —— 纯净 RTT 与单帧体积
 *   [B] 16ms 间隔连发（模拟 60fps 滑动，不等响应）—— 吞吐与丢请求情况
 *   [C] 帧体积 vs 滚动步长 —— 验证「滚 1 行也传整屏」
 *   [D] 按内容类型的 gzip / RLE 瘦身收益
 *
 * 依赖：Node ≥ 22（内置 WebSocket / fetch）。`DEBUG=1` 可打印前若干条原始消息。
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

/** 后端端口取自 .env.local（AGENTS：端口不硬编码）。 */
function backendPort() {
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    const m = env.match(/^BACKEND_PORT=(\d+)/m)
    if (m) return m[1]
  } catch {
    /* .env.local 缺失时回落到默认端口 */
  }
  return process.env.BACKEND_PORT ?? '9777'
}

const PORT = backendPort()
const BASE = `http://127.0.0.1:${PORT}`
const COLS = 100
const ROWS = 40
/** [D] 低重复内容样本：默认本仓库源码，可经 argv[2] 覆盖。 */
const SOURCE_SAMPLE = process.argv[2] ?? new URL('../src/main.rs', import.meta.url).pathname
const DEBUG = process.env.DEBUG === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]
const fmt = (a) => (a.length ? `p50=${pct(a, 0.5).toFixed(2)} p95=${pct(a, 0.95).toFixed(2)} max=${Math.max(...a).toFixed(2)}` : 'n/a')

const projects = await (await fetch(`${BASE}/api/v1/projects`)).json()
const pid = projects[0].id
const sid = await (await fetch(`${BASE}/api/v1/projects/${pid}/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: `probe-${Date.now()}`,
    workspace_path: projects[0].path,
    runtime_kind: 'pty',
  }),
})).json().then((r) => r.id)
console.log(`session=${sid} (${COLS}x${ROWS}) backend=${BASE}`)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws/terminal/${sid}?cols=${COLS}&rows=${ROWS}`)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })

const viewportFrames = []
let liveFrames = 0
let liveBytes = 0
let dbg = 0
ws.onmessage = (ev) => {
  if (DEBUG && dbg++ < 12) {
    const s = typeof ev.data === 'string' ? ev.data.slice(0, 220) : `<bin ${ev.data.size ?? ev.data.byteLength}B>`
    console.log(`  [msg${dbg}] ${typeof ev.data} ${s}`)
  }
  if (typeof ev.data !== 'string') return
  let f
  try { f = JSON.parse(ev.data) } catch { return }
  if (f.t !== 'cell_frame') return
  if (f.viewport != null) viewportFrames.push({ y: f.viewport, size: ev.data.length, at: performance.now(), raw: ev.data })
  else { liveFrames++; liveBytes += ev.data.length }
}

// cell_frame 能力握手：不发则 raw 直通，viewport_request 为 no-op
ws.send(JSON.stringify({ t: 'hello', supports_cell_frame: true }))
ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }))
await sleep(800)
// 造历史：3000 行输出填满后端 grid scrollback（1000 行）
ws.send(new TextEncoder().encode('seq 1 3000\n'))
await sleep(2500)
viewportFrames.length = 0
liveFrames = 0
liveBytes = 0

// ── A：串行往返 ──
const rtts = []
const sizes = []
for (let i = 0; i < 20; i++) {
  const y = 100 + i * 7
  const t0 = performance.now()
  ws.send(JSON.stringify({ type: 'viewport_request', y }))
  while (performance.now() - t0 < 3000) {
    const hit = viewportFrames.find((f) => f.y === y)
    if (hit) { rtts.push(hit.at - t0); sizes.push(hit.size); break }
    await sleep(1)
  }
}

// ── B：16ms 间隔连发，不等响应 ──
viewportFrames.length = 0
const sent = []
for (let i = 0; i < 60; i++) {
  const y = 200 + i * 5
  sent.push(y)
  ws.send(JSON.stringify({ type: 'viewport_request', y }))
  await sleep(16)
}
await sleep(500)
const gotYs = viewportFrames.map((f) => f.y)

// ── C：帧体积 vs 滚动步长 ──
viewportFrames.length = 0
const steps = [['Δy=1', 300], ['Δy=1（再滚 1 行）', 301], ['Δy=40（整屏）', 341]]
const sample = []
for (const [tag, y] of steps) {
  ws.send(JSON.stringify({ type: 'viewport_request', y }))
  await sleep(250)
  const f = viewportFrames.filter((v) => v.y === y).pop()
  if (f) sample.push([tag, f.size])
}

// ── D：按内容类型的瘦身收益 ──
const CASES = [
  ['数字 seq（高重复）', 'seq 1 2000'],
  ['彩色 ls（中重复）', 'ls --color=always -la /usr/bin | head -1500'],
  ['源码 cat（低重复）', `for i in 1 2 3; do cat ${SOURCE_SAMPLE}; done`],
]
const comp = []
for (const [label, cmd] of CASES) {
  ws.send(new TextEncoder().encode('clear\n'))
  await sleep(400)
  ws.send(new TextEncoder().encode(cmd + '\n'))
  await sleep(3000)
  viewportFrames.length = 0
  ws.send(JSON.stringify({ type: 'viewport_request', y: 300 }))
  await sleep(400)
  const f = viewportFrames.filter((v) => v.y === 300).pop()
  if (!f) { comp.push([label, 0, 0, 0]); continue }
  const gz = zlib.gzipSync(Buffer.from(f.raw)).length
  comp.push([label, f.size, gz, rleSize(JSON.parse(f.raw))])
}

/** RLE 协议瘦身体积估算：行内按 sgr 合并连续同样式字符后重新序列化。 */
function rleSize(frame) {
  let total = 200 // 帧头 + cursor 等固定字段的近似开销
  for (const row of frame.rows) {
    let s = ''
    let cur = null
    let run = ''
    for (const c of row.cells) {
      if (c.skip) continue
      const sgr = c.sgr ?? ''
      if (cur === null) { cur = sgr; run = c.ch } else if (sgr === cur) run += c.ch
      else { s += `${JSON.stringify(cur)},${JSON.stringify(run)},`; cur = sgr; run = c.ch }
    }
    if (cur !== null) s += `${JSON.stringify(cur)},${JSON.stringify(run)}`
    total += s.length + 2
  }
  return total
}

console.log(`\n[A] 串行往返 n=${rtts.length}/20`)
console.log(`    RTT(ms)   ${fmt(rtts)}`)
console.log(`    帧体积(B) ${fmt(sizes)}  ≈${(pct(sizes, 0.5) / 1024).toFixed(1)} KB`)
console.log(`\n[B] 每 16ms 一个请求（模拟滑动 1 秒）`)
console.log(`    发出 ${sent.length}  收到 viewport 帧 ${gotYs.length}  丢失/未响应 ${sent.length - gotYs.length}`)
console.log(`    首/末响应 y = ${gotYs[0]} / ${gotYs.at(-1)}（请求区间 ${sent[0]}..${sent.at(-1)}）`)
console.log(`\n[C] 帧体积与滚动步长的关系（同一 ${COLS}×${ROWS} 窗口）`)
for (const [tag, size] of sample) console.log(`    ${tag}: ${(size / 1024).toFixed(1)} KB`)
console.log(`\n[D] 单帧瘦身收益（${COLS}×${ROWS}，按内容类型）`)
for (const [label, raw, gz, rle] of comp) {
  console.log(
    `    ${label}: 原始 ${(raw / 1024).toFixed(1)} KB → gzip ${(gz / 1024).toFixed(2)} KB (${(raw / gz).toFixed(0)}×)`
    + ` | RLE ${(rle / 1024).toFixed(1)} KB (${(raw / rle).toFixed(1)}×)`,
  )
}
console.log(`\n[对照] 期间实时帧 ${liveFrames} 帧，共 ${(liveBytes / 1024).toFixed(1)} KB（diff 帧，平均 ${(liveBytes / Math.max(1, liveFrames)).toFixed(0)} B）`)

ws.close()
await fetch(`${BASE}/api/v1/sessions/${sid}`, { method: 'DELETE' })
console.log('\n临时会话已删除')
