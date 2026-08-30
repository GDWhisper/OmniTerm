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
 *   [D] 按内容类型的帧体积与 runs 结构自洽性
 *
 * [A][B][C] 只开一条连接：两条连接共享同一个 Node 事件循环，另一条持续收
 * 30fps 实时帧会把本组的尾延迟抬高一个量级（要对照别的配置就重跑一次）。
 *
 * 无损性不在此验证：cell_frame 只有 runs 一种行编码（`2026-08-28-pty-frame-rle.md`
 * D4 移除了 cells），交叉比对的对象改为后端单测里的 grid 遍历、前端单测里
 * 的逐字符渲染，以及 `pty-frame-regression.mjs` T3 的 pty 原始字节流。
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

/** 建立到该会话的一个 cell_frame WS 视图。 */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws/terminal/${sid}?cols=${COLS}&rows=${ROWS}`)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })

  const viewportFrames = []
  /**
   * 是否保留帧原文。仅 [D] 组（runs 结构与体积分析）需要 raw；[A][B][C] 只
   * 统计体积与延迟。开着会累积数 MB 字符串，触发 V8 GC 停顿并污染 RTT 测量
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
  ws.send(JSON.stringify({ t: 'hello', supports_cell_frame: true }))
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

const main = await connect()
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

// ── D：按内容类型的帧体积 + runs 结构自洽性 ──
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
 * runs 结构自洽判据：每行的 runs 必须是成对的 (sgr, text)，且 text 段非空。
 *
 * 空 text 段意味着编码时把宽字符占位 cell 也切成了 run（D5 回归）——占位
 * cell 不产生渲染输出，混进来会让同 sgr 的相邻字符被切开。
 */
function structureOf(frame) {
  for (const [i, row] of frame.rows.entries()) {
    const runs = row.runs ?? []
    if (runs.length % 2 !== 0) return `行${i} runs 长度为奇数(${runs.length})`
    for (let k = 0; k < runs.length; k += 2) {
      if (typeof runs[k] !== 'string' || typeof runs[k + 1] !== 'string') {
        return `行${i} 第${k / 2} 个 run 字段非字符串`
      }
      if (runs[k + 1].length === 0) return `行${i} 第${k / 2} 个 run 的 text 为空`
    }
  }
  return 'PASS'
}

// [D] 需要帧原文做结构分析；[A][B][C] 已跑完，此处才打开。
main.state.keepRaw = true
const comp = []
for (const [label, cmd] of CASES) {
  main.ws.send(new TextEncoder().encode('clear\n'))
  await sleep(400)
  main.ws.send(new TextEncoder().encode(cmd + '\n'))
  await sleep(3000)
  const frame = await requestViewport(main, 300)
  if (!frame) { comp.push([label, 0, 0, '无帧']); continue }
  const gz = zlib.gzipSync(Buffer.from(frame.raw)).length
  comp.push([label, frame.size, gz, structureOf(JSON.parse(frame.raw))])
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
console.log(`\n[A] 串行往返 n=${rtts.length}/40（runs 行编码）`)
describeRtt(mainRtt)
console.log(`\n[B] 每 16ms 一个请求（模拟滑动 1 秒）`)
console.log(`    发出 ${sent.length}  收到 viewport 帧 ${gotYs.length}  丢失/未响应 ${sent.length - gotYs.length}`)
console.log(`    首/末响应 y = ${gotYs[0]} / ${gotYs.at(-1)}（请求区间 ${sent[0]}..${sent.at(-1)}）`)
console.log(`\n[C] 帧体积与滚动步长的关系（同一 ${COLS}×${ROWS} 窗口）`)
for (const [tag, size] of sample) console.log(`    ${tag}: ${(size / 1024).toFixed(1)} KB`)
console.log(`\n[D] 按内容类型的帧体积（${COLS}×${ROWS}，runs 行编码）`)
for (const [label, size, gz, structure] of comp) {
  console.log(
    `    ${label}: runs ${(size / 1024).toFixed(1)} KB`
    + ` | runs+gzip ${(gz / 1024).toFixed(2)} KB (${(size / gz).toFixed(1)}×)  结构=${structure}`,
  )
}
const liveFrames = liveAfter.liveFrames - liveBefore.liveFrames
const liveBytes = liveAfter.liveBytes - liveBefore.liveBytes
console.log(`\n[对照] 期间实时帧 ${liveFrames} 帧，共 ${(liveBytes / 1024).toFixed(1)} KB（diff 帧，平均 ${(liveBytes / Math.max(1, liveFrames)).toFixed(0)} B）`)

main.ws.close()
await fetch(`${BASE}/api/v1/sessions/${sid}`, { method: 'DELETE' })
console.log('\n临时会话已删除')
