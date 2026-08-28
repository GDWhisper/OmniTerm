#!/usr/bin/env node
/**
 * pty 历史视口帧探针 —— 量「单帧体积 / 请求→响应耗时 / 瘦身收益 / 无损性」。
 *
 * 用途：为 pty 移动端滚动改造（`docs/dev/plans/backlog/pty-mobile-termux-feel.md`
 * §3.2）提供决策数据，并验收 `docs/dev/plans/2026-08-28-pty-frame-rle.md`。
 * 直连后端 WS（不经浏览器、不经前端），自动创建并删除临时 pty 会话。
 *
 * 前置：`./dev.sh start`（后端已运行）。跑法：`node scripts/pty-viewport-probe.mjs`
 *
 * 四组测量：
 *   [A] 串行往返 —— 纯净 RTT 与单帧体积
 *   [B] 16ms 间隔连发（模拟 60fps 滑动，不等响应）—— 吞吐与丢请求情况
 *   [C] 帧体积 vs 滚动步长 —— 验证「滚 1 行也传整屏」
 *   [D] 按内容类型的瘦身收益与无损性
 *
 * [A][B][C] 只开一条主连接（编码由 `ROW_ENCODING` 指定，默认 runs）；[D] 对
 * **同一会话**另开一个用另一种编码的连接，同一 y 各取一帧做交叉比对 —— 行
 * 编码是连接级协商的结果，故两个连接可同时存在且互不干扰，无损性由此成为
 * 实测而非估算。
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
/**
 * 主连接的行编码（`ROW_ENCODING=cells` 跑旧格式对照）。
 *
 * [A][B][C] 只开一条连接：两条连接共享同一个 Node 事件循环，另一条持续收
 * 30fps 实时帧会把本组的尾延迟抬高一个量级。要测另一种编码就重跑一次
 * （`ROW_ENCODING=cells node scripts/pty-viewport-probe.mjs`）。
 */
const ROW_ENCODING = process.env.ROW_ENCODING === 'cells' ? null : 'runs'

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

/**
 * 建立到该会话的一个 WS 视图。`rowEncoding` 为 hello 协商的行编码
 * （`null` = 不声明，服务端回落 cells —— 模拟旧客户端）。
 */
async function connect(rowEncoding) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws/terminal/${sid}?cols=${COLS}&rows=${ROWS}`)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })

  const viewportFrames = []
  /**
   * 是否保留帧原文。仅 [D] 组（跨格式交叉比对）需要 raw；[A][B][C] 只统计
   * 体积与延迟。开着会累积数 MB 字符串，触发 V8 GC 停顿并污染 RTT 测量
   * （实测：30fps 实时帧下 [A] 的尾延迟有 ~7% 落在 47ms，全是这里的 GC）。
   */
  const state = { keepRaw: false }
  /** 等待特定 y 的响应帧（事件驱动，避免轮询误差污染 RTT 测量）。 */
  const waiters = []
  let liveFrames = 0
  let liveBytes = 0
  let dbg = 0
  ws.onmessage = (ev) => {
    if (DEBUG && dbg++ < 12) {
      const s = typeof ev.data === 'string' ? ev.data.slice(0, 220) : `<bin ${ev.data.size ?? ev.data.byteLength}B>`
      console.log(`  [msg${dbg}] ${typeof ev.data} ${s}`)
    }
    if (typeof ev.data !== 'string') return
    // 廉价预筛：帧体积已降到 KB 级，但对每个到达帧（含 30fps 实时帧）做完整
    // JSON.parse 会在 Node 主线程上制造抖动，污染 RTT 测量。`t` 是 CellFrame
    // 的首个序列化字段（serde 按声明顺序），前缀匹配即可跳过无关帧。
    if (!ev.data.startsWith('{"t":"cell_frame"')) return
    let f
    try { f = JSON.parse(ev.data) } catch { return }
    if (f.viewport != null) {
      const frame = {
        y: f.viewport,
        size: ev.data.length,
        at: performance.now(),
        raw: state.keepRaw ? ev.data : null,
      }
      viewportFrames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].y === frame.y) {
          waiters[i].resolve(frame)
          waiters.splice(i, 1)
        }
      }
    } else { liveFrames++; liveBytes += ev.data.length }
  }

  // cell_frame 能力握手：不发则 raw 直通，viewport_request 为 no-op
  const hello = { t: 'hello', supports_cell_frame: true }
  if (rowEncoding) hello.row_encoding = rowEncoding
  ws.send(JSON.stringify(hello))
  ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }))

  /** 等该 y 的响应帧；超时 resolve(null)。 */
  const waitViewport = (y, timeoutMs = 3000) =>
    new Promise((resolve) => {
      const w = { y, resolve }
      waiters.push(w)
      setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) {
          waiters.splice(i, 1)
          resolve(null)
        }
      }, timeoutMs)
    })

  return { ws, viewportFrames, waitViewport, state, liveStats: () => ({ liveFrames, liveBytes }) }
}

const main = await connect(ROW_ENCODING)
await sleep(800)
// 造历史：3000 行输出填满后端 grid scrollback（1000 行）
main.ws.send(new TextEncoder().encode('seq 1 3000\n'))
await sleep(2500)
main.viewportFrames.length = 0
const liveBefore = main.liveStats()

// ── A：串行往返（事件驱动计时，无轮询误差）──
async function measureRtt(conn, n = 40) {
  const rtts = []
  const sizes = []
  for (let i = 0; i < n; i++) {
    const y = 100 + i * 7
    const t0 = performance.now()
    conn.ws.send(JSON.stringify({ type: 'viewport_request', y }))
    const hit = await conn.waitViewport(y)
    if (hit) {
      rtts.push(hit.at - t0)
      sizes.push(hit.size)
    }
  }
  return { rtts, sizes }
}
const mainRtt = await measureRtt(main)
const rtts = mainRtt.rtts
const sizes = mainRtt.sizes

// ── B：16ms 间隔连发，不等响应 ──
main.viewportFrames.length = 0
const sent = []
for (let i = 0; i < 60; i++) {
  const y = 200 + i * 5
  sent.push(y)
  main.ws.send(JSON.stringify({ type: 'viewport_request', y }))
  await sleep(16)
}
await sleep(500)
const gotYs = main.viewportFrames.map((f) => f.y)

// ── C：帧体积 vs 滚动步长 ──
main.viewportFrames.length = 0
const steps = [['Δy=1', 300], ['Δy=1（再滚 1 行）', 301], ['Δy=40（整屏）', 341]]
const sample = []
for (const [tag, y] of steps) {
  main.ws.send(JSON.stringify({ type: 'viewport_request', y }))
  await sleep(250)
  const f = main.viewportFrames.filter((v) => v.y === y).pop()
  if (f) sample.push([tag, f.size])
}

// ── D：按内容类型的瘦身收益 + 无损性（cells / runs 双连接交叉比对）──
const CASES = [
  ['数字 seq（高重复）', 'seq 1 2000'],
  ['彩色 ls（中重复）', 'ls --color=always -la /usr/bin | head -1500'],
  ['源码 cat（低重复）', `for i in 1 2 3; do cat ${SOURCE_SAMPLE}; done`],
  // 直接发 UTF-8 字节，不经 shell 的 \u 转义（pty shell 未必支持 printf \u）。
  // 行数须 > y+rows（340），否则 y 被后端钳制、帧不满屏，收益会被低估。
  ['CJK 混排（宽字符）', 'for i in $(seq 1 400); do echo "中文测试 $i ターミナル 滚动压测"; done'],
]

/** 请求一个历史窗口帧并等其响应。 */
async function requestViewport(conn, y) {
  conn.ws.send(JSON.stringify({ type: 'viewport_request', y }))
  return conn.waitViewport(y, 2000)
}

/**
 * 无损性判据：逐行比对两种编码解码出的「字符 → 该字符生效时 sgr」序列。
 *
 * 不等价于比对输出字节串 —— runs 会省掉冗余的样式切换，字节不等却渲染等价。
 * 这里直接比对 (char, sgr) 序列，绕开 ANSI 渲染，等价于渲染等价。
 */
function crossEquiv(cellsFrame, runsFrame) {
  if (cellsFrame.rows.length !== runsFrame.rows.length) return '行数不等'
  for (let i = 0; i < cellsFrame.rows.length; i++) {
    if (seqCells(cellsFrame.rows[i].cells) !== seqRuns(runsFrame.rows[i].runs)) return `FAIL@行${i}`
  }
  return 'PASS'
}
function seqCells(cells) {
  const out = []
  // skip = 宽字符占位：渲染时被跳过，两种编码下都不产生输出
  for (const c of cells ?? []) if (!c.skip) out.push(c.ch, c.sgr ?? '')
  return out.join(' ')
}
function seqRuns(runs) {
  const out = []
  for (let i = 0; i + 1 < (runs ?? []).length; i += 2) {
    for (const ch of runs[i + 1]) out.push(ch, runs[i])
  }
  return out.join(' ')
}

// [D] 需要帧原文做交叉比对；[A][B][C] 已跑完，此处才打开。
// 对照连接（另一种行编码）也延到此处建立，避免它在 [A] 期间干扰 RTT 测量。
const other = await connect(ROW_ENCODING === null ? 'runs' : null)
await sleep(800)
main.state.keepRaw = true
other.state.keepRaw = true
const comp = []
for (const [label, cmd] of CASES) {
  main.ws.send(new TextEncoder().encode('clear\n'))
  await sleep(400)
  main.ws.send(new TextEncoder().encode(cmd + '\n'))
  await sleep(3000)
  // 同一 grid、同一 y：两个连接的取样间隔内 shell 已空闲，grid 不变
  const mainFrame = await requestViewport(main, 300)
  const otherFrame = await requestViewport(other, 300)
  if (!mainFrame || !otherFrame) { comp.push([label, 0, 0, 0, '无帧']); continue }
  const [cellsFrame, runsFrame] =
    ROW_ENCODING === null ? [mainFrame, otherFrame] : [otherFrame, mainFrame]
  const gz = zlib.gzipSync(Buffer.from(runsFrame.raw)).length
  comp.push([
    label,
    cellsFrame.size,
    runsFrame.size,
    gz,
    crossEquiv(JSON.parse(cellsFrame.raw), JSON.parse(runsFrame.raw)),
  ])
}

const liveAfter = main.liveStats()
// 标出最慢样本：均值会掩盖尾延迟，而滚动卡顿正来自尾部的偶发长帧。
const describeRtt = (m) => {
  const slowest = m.rtts.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3)
  console.log(
    `    RTT ${fmt(m.rtts)}  帧 ${(pct(m.sizes, 0.5) / 1024).toFixed(1)} KB`
    + `  最慢: ${slowest.map(([i, v]) => `#${i}=${v.toFixed(0)}ms`).join(' ')}`,
  )
}
console.log(`\n[A] 串行往返 n=${rtts.length}/40（行编码=${ROW_ENCODING ?? 'cells'}）`)
describeRtt(mainRtt)
console.log(`\n[B] 每 16ms 一个请求（模拟滑动 1 秒）`)
console.log(`    发出 ${sent.length}  收到 viewport 帧 ${gotYs.length}  丢失/未响应 ${sent.length - gotYs.length}`)
console.log(`    首/末响应 y = ${gotYs[0]} / ${gotYs.at(-1)}（请求区间 ${sent[0]}..${sent.at(-1)}）`)
console.log(`\n[C] 帧体积与滚动步长的关系（同一 ${COLS}×${ROWS} 窗口）`)
for (const [tag, size] of sample) console.log(`    ${tag}: ${(size / 1024).toFixed(1)} KB`)
console.log(`\n[D] 单帧瘦身收益 + 无损性（${COLS}×${ROWS}，实测 cells → runs 双连接对照）`)
for (const [label, cellsSize, runsSize, gz, eq] of comp) {
  console.log(
    `    ${label}: cells ${(cellsSize / 1024).toFixed(1)} KB → runs ${(runsSize / 1024).toFixed(1)} KB (${(cellsSize / runsSize).toFixed(1)}×)`
    + ` | runs+gzip ${(gz / 1024).toFixed(2)} KB (${(cellsSize / gz).toFixed(0)}×)  无损=${eq}`,
  )
}
const liveFrames = liveAfter.liveFrames - liveBefore.liveFrames
const liveBytes = liveAfter.liveBytes - liveBefore.liveBytes
console.log(`\n[对照] 期间实时帧 ${liveFrames} 帧，共 ${(liveBytes / 1024).toFixed(1)} KB（diff 帧，平均 ${(liveBytes / Math.max(1, liveFrames)).toFixed(0)} B）`)

main.ws.close()
if (other) other.ws.close()
await fetch(`${BASE}/api/v1/sessions/${sid}`, { method: 'DELETE' })
console.log('\n临时会话已删除')
