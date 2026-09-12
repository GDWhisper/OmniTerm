#!/usr/bin/env node
/**
 * pty 历史视口锚定回归（2026-09-12 有状态锚，取代 09-03 指纹锚定后的探针升级）。
 *
 * 背景：09-03 指纹重定位的验收只用 `seq 1 3000`（全唯一行），周期性内容
 * （空行/框线/分隔线——agent 输出常态）上的棘轮/滑移逃逸了六轮修复
 * （`docs/dev/plans/2026-09-12-pty-viewport-stateful-anchor.md` 根因实证）。
 * 本脚本把五组差分形态固化为回归判据：锚点行选**周期性内容**，连续 8 轮
 * 「burst 输出 → 保锚刷新」，断言——
 *   1. 窗口首行内容保持（内容锚不丢）；
 *   2. 每轮 drift > 0 且各轮 drift 一致（±1）——视口随新增行数前移；
 *      旧行为签名（负 drift = 向 live 棘轮 / 内容滑移）直接 RED；
 *   3. y 轨迹单调不减。
 *
 * drift 基准采用「首轮校准 + 一致性」而非硬编码行数：burst 实际入历史的
 * 行数受 shell 回显/prompt 影响，无法从命令形态精确推算；而「各轮一致 +
 * 内容保持 + 单调」已足以区分正确锚定与棘轮/滑移（后者 drift 为负或内容
 * 前移，见计划证据表）。
 *
 * 运行前置：dev 环境运行中（`./dev.sh status`）；本机直连后端 WS。
 * 临时会话用完即删。
 */
import { readFileSync } from 'node:fs'

function backendPort() {
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    const m = env.match(/^BACKEND_PORT=(\d+)/m)
    if (m) return m[1]
  } catch { /* fallthrough */ }
  return process.env.BACKEND_PORT ?? '9777'
}

const PORT = backendPort()
const BASE = `http://127.0.0.1:${PORT}`
const COLS = 100
const ROWS = 40
const ROUNDS = 8

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rowText(frame, i = 0) {
  const runs = frame.rows?.[i]?.runs ?? []
  let s = ''
  for (let k = 1; k < runs.length; k += 2) s += runs[k]
  return s.trimEnd()
}

async function connect(sid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws/terminal/${sid}?cols=${COLS}&rows=${ROWS}`)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
  const viewportFrames = []
  let hs = 0
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string' || !ev.data.startsWith('{"t":"cell_frame"')) return
    let f
    try { f = JSON.parse(ev.data) } catch { return }
    if (typeof f.history_size === 'number') hs = f.history_size
    if (f.viewport != null) viewportFrames.push({ at: performance.now(), frame: f })
  }
  ws.send(JSON.stringify({ t: 'hello', supports_cell_frame: true }))
  ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }))
  return {
    ws,
    hs: () => hs,
    send(cmd) { ws.send(new TextEncoder().encode(cmd + '\n')) },
    async request(y, refresh, timeoutMs = 2000) {
      const marker = performance.now()
      ws.send(JSON.stringify({ type: 'viewport_request', y, refresh }))
      const t0 = performance.now()
      while (performance.now() - t0 < timeoutMs) {
        const hit = viewportFrames.find((v) => v.at >= marker)
        if (hit) return hit.frame
        await sleep(10)
      }
      return null
    },
  }
}

async function newSession(tag) {
  const projects = await (await fetch(`${BASE}/api/v1/projects`)).json()
  const pid = projects[0].id
  const r = await (await fetch(`${BASE}/api/v1/projects/${pid}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `viewport-anchor-${tag}-${Date.now()}`,
      workspace_path: projects[0].path,
      runtime_kind: 'pty',
    }),
  })).json()
  return r.id
}

async function waitHistorySettled(conn) {
  let last = -1
  let stableSince = performance.now()
  for (;;) {
    await sleep(150)
    const h = conn.hs()
    if (h !== last) { last = h; stableSince = performance.now() }
    if (performance.now() - stableSince > 1200 && h > 0) return h
  }
}

/**
 * 单形态回归：铺历史 → 定位周期性锚点行 → ROUNDS 轮 burst + 保锚刷新。
 * anchorText: 锚点行内容（trim 后精确匹配）；findFrom: 锚点扫描起点 y
 * （数字，或按 settled history_size 推导的函数——唯一内容行须按 hs 反推）。
 */
async function runCase({ tag, prefill, burst, anchorText, findFrom = 500 }) {
  const failures = []
  const sid = await newSession(tag)
  try {
    const conn = await connect(sid)
    await sleep(600)
    conn.send(prefill)
    const hs = await waitHistorySettled(conn)
    await sleep(300)

    // 定位锚点：扫描 y 直到窗口首行为目标周期内容
    const from = typeof findFrom === 'function' ? findFrom(hs) : findFrom
    let anchorY = null
    for (let y = from; y < from + 16 && anchorY == null; y++) {
      const r = await conn.request(y, false)
      if (r && rowText(r, 0) === anchorText) anchorY = r.viewport
    }
    if (anchorY == null) {
      failures.push(`未找到锚点行（${JSON.stringify(anchorText)} @ y ${from}..${from + 15}）`)
      return { tag, failures, ys: [] }
    }

    // ROUNDS 轮：burst → 稳定 → 保锚刷新（refresh=true，y 仅降级回退）
    let curY = anchorY
    let expected = null // 首轮校准的 drift 基准
    const ys = []
    for (let round = 1; round <= ROUNDS; round++) {
      conn.send(burst(round))
      await waitHistorySettled(conn)
      await sleep(250)
      const r = await conn.request(curY, true)
      if (!r) { failures.push(`round ${round}: 刷新无响应`); break }
      const drift = r.viewport - curY
      const top = rowText(r, 0)
      if (top !== anchorText) {
        failures.push(`round ${round}: 窗口首行内容漂移 ${JSON.stringify(top.slice(0, 40))} ≠ 锚点内容`)
      }
      if (drift <= 0) {
        failures.push(`round ${round}: drift=${drift} ≤ 0（向 live 棘轮/滑移签名）`)
      }
      if (expected == null) {
        expected = drift
      } else if (Math.abs(drift - expected) > 1) {
        failures.push(`round ${round}: drift=${drift} 偏离基准 ${expected}±1`)
      }
      ys.push(r.viewport)
      curY = r.viewport
    }
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] < ys[i - 1]) failures.push(`y 轨迹递减：${ys[i - 1]} → ${ys[i]}`)
    }
    conn.ws.close()
    return { tag, failures, ys }
  } finally {
    await fetch(`${BASE}/api/v1/sessions/${sid}`, { method: 'DELETE' })
  }
}

// ── 五组差分形态（2026-09-12 计划证据表的固化）──
const CASES = [
  {
    tag: 'unique',
    // 唯一内容：传输/钳制/锚通道健康性的对照（旧行为也应通过）。
    // 命令回显/prompt 占历史头部几行，"payload line 400" 的绝对索引 ≈ 402，
    // 扫描起点按 settled hs 反推（y = hs − 410 向上覆盖）。
    prefill: 'for i in $(seq 1 800); do echo "payload line $i"; done',
    burst: (r) => `echo "u${r}-a"; echo "u${r}-b"; echo "u${r}-c"`,
    anchorText: 'payload line 400',
    findFrom: (hs) => hs - 410,
  },
  {
    tag: 'blank-p3',
    // 空行周期 3（旧指纹机制 RED：−1/轮）
    prefill: 'for i in $(seq 1 300); do echo "p$i"; echo; echo; done',
    burst: (r) => `echo; echo "b${r}"; echo`,
    anchorText: '',
  },
  {
    tag: 'sep-p11-with-copies',
    // 分隔线周期 11，burst 内再现副本（旧指纹机制 RED：−5/轮）
    prefill:
      'for i in $(seq 1 500); do echo "payload line $i"; if (( i % 10 == 0 )); then echo "----------------"; fi; done',
    burst: (r) => `echo "live-${r}-a"; echo "----------------"; echo; echo "live-${r}-b"`,
    anchorText: '----------------',
  },
  {
    tag: 'sep-p11-no-copies',
    // 同上但 burst 不含分隔线：历史自身周期性即足以触发（旧指纹机制 RED）
    prefill:
      'for i in $(seq 1 500); do echo "payload line $i"; if (( i % 10 == 0 )); then echo "----------------"; fi; done',
    burst: (r) => `echo "quiet-${r}-a"; echo "quiet-${r}-b"; echo "quiet-${r}-c"; echo "quiet-${r}-d"`,
    anchorText: '----------------',
  },
  {
    tag: 'blank-p2',
    // 空行周期 2（旧指纹机制 RED：窗口内容全速滑移）
    prefill: 'for i in $(seq 1 300); do echo "q$i"; echo; done',
    burst: (r) => `echo; echo "c${r}"`,
    anchorText: '',
  },
]

// ── main ──
try {
  await fetch(`${BASE}/api/v1/projects`, { signal: AbortSignal.timeout(3000) })
} catch {
  console.error(`后端不可达（${BASE}）——先 ./dev.sh start`)
  process.exit(1)
}

let failed = false
for (const c of CASES) {
  const { tag, failures, ys } = await runCase(c)
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
  if (failures.length > 0) failed = true
  console.log(`[${verdict}] ${tag}  y 轨迹: ${ys.join(' → ') || '(中断)'}`)
  for (const f of failures) console.log(`       - ${f}`)
}

console.log(failed ? '\n回归失败' : '\n全部通过')
process.exit(failed ? 1 : 0)
