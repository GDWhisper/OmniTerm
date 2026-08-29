#!/usr/bin/env node
/**
 * pty 帧正确性回归 —— 覆盖 `docs/dev/plans/2026-08-28-pty-frame-rle.md` §6
 * 手动回归 4 项中除「浏览器内视觉观感」外的可断言部分。
 *
 * 用途：改动 cell_frame 帧编码（如 P3 移除 cells 路径）后的正确性回归。
 * 直连后端 WS（不经浏览器），自动创建并删除临时 pty 会话。
 *
 * 前置：`./dev.sh start`。跑法：`node scripts/pty-frame-regression.mjs`
 *
 * 七组断言：
 *   T1 滚动历史窗口连续性（相邻 y 恰好错开 1 行 → 不丢行/不错位）
 *   T2 CJK 滚动连续性与行宽一致性（对齐的结构性判据）
 *   T3 emoji / 组合字符：cells 与 runs 解码等价
 *   T4 快速输出（seq 1 20000）滚动窗口内数字连续无跳号
 *   T5 alt-screen 进入/退出（overlay 帧 alt_screen 标记 + 主屏恢复）
 *   T6 TUI 程序（less / top）帧可解析、非空、alt_screen 切换
 *   T7 断线重连补屏（重连首帧 full + 内容含断开前标记行）
 *
 * 三个取样陷阱（改动本脚本前先读，否则会误判为 bug）：
 *   1. `clear` 会连 scrollback 一起清 → `history_size()` 归零，之后请求
 *      y>0 会被服务端钳制到 0，响应帧的 `viewport` ≠ 请求 y，精确匹配
 *      的等待必然超时。需要历史窗口时，先灌满 history 再取样。
 *   2. history 上限 1000 行（`VT_SCROLLBACK_LINES`），样本行数不足时
 *      y=900 之类同样被钳制。样本要 > 1000 行。
 *   3. 命令行本身会被 shell 回显到主屏，含有标记字符串。判定「alt 内容
 *      残留」时必须先剔除回显行，否则必然误报。
 *
 * 依赖：Node ≥ 22（内置 WebSocket / fetch）。
 */
import { readFileSync } from 'node:fs'

function backendPort() {
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    const m = env.match(/^BACKEND_PORT=(\d+)/m)
    if (m) return m[1]
  } catch { /* 回落默认端口 */ }
  return process.env.BACKEND_PORT ?? '9777'
}

const PORT = backendPort()
const BASE = `http://127.0.0.1:${PORT}`
const COLS = 100
const ROWS = 40
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (tag, ok, detail) => {
  results.push({ tag, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${tag}${detail ? ` — ${detail}` : ''}`)
}

// ── 会话与连接 ──
const projects = await (await fetch(`${BASE}/api/v1/projects`)).json()
const sid = await (await fetch(`${BASE}/api/v1/projects/${projects[0].id}/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: `rle-regress-${Date.now()}`,
    workspace_path: projects[0].path,
    runtime_kind: 'pty',
  }),
})).json().then((r) => r.id)
console.log(`session=${sid} (${COLS}x${ROWS}) backend=${BASE}\n`)

/** 建立 WS 视图；`rowEncoding` = null 模拟旧客户端（回落 cells）。 */
async function connect(rowEncoding) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws/terminal/${sid}?cols=${COLS}&rows=${ROWS}`)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })

  /** 收到的全部 text 帧（解析后）。 */
  const frames = []
  const waiters = []
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    if (!ev.data.startsWith('{"t":"cell_frame"')) return
    let f
    try { f = JSON.parse(ev.data) } catch { return }
    frames.push(f)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(f)) {
        waiters[i].resolve(f)
        waiters.splice(i, 1)
      }
    }
  }
  const hello = { t: 'hello', supports_cell_frame: true }
  if (rowEncoding) hello.row_encoding = rowEncoding
  ws.send(JSON.stringify(hello))
  ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }))

  /** 等满足 match 的下一帧；超时 resolve(null)。 */
  const wait = (match, timeoutMs = 3000) =>
    new Promise((resolve) => {
      const w = { match, resolve }
      waiters.push(w)
      setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) { waiters.splice(i, 1); resolve(null) }
      }, timeoutMs)
    })
  const viewport = (y, t = 3000) => {
    ws.send(JSON.stringify({ type: 'viewport_request', y }))
    return wait((f) => f.viewport === y, t)
  }
  /** 清掉已收帧，返回本次之后的取样起点。 */
  const reset = () => { frames.length = 0 }
  return { ws, frames, wait, viewport, reset }
}

// ── 解码：两种行编码 → 行文本 / (字符,sgr) 序列 ──
const rowText = (row) =>
  row.runs
    ? row.runs.filter((_, i) => i % 2 === 1).join('')
    : (row.cells ?? []).filter((c) => !c.skip).map((c) => c.ch).join('')
const rowTrim = (row) => rowText(row).replace(/\s+$/, '')
const rowSeq = (row) =>
  row.runs
    ? row.runs.filter((_, i) => i % 2 === 1).join('').split('').map((ch) => ch)
    : (row.cells ?? []).filter((c) => !c.skip).map((c) => c.ch)
const rowsText = (f) => f.rows.map(rowTrim)

const main = await connect('runs')
const legacy = await connect(null) // cells 编码对照连接
await sleep(1000)
const send = (s) => main.ws.send(new TextEncoder().encode(s))

async function clearAndWait() {
  send('clear\n')
  await sleep(400)
}

// ── T1/T2 滚动连续性：frame(y).rows[i] == frame(y+1).rows[i+1] ──
async function scrollContinuity(label, cmd, ys = [50, 200, 500, 900, 990]) {
  await clearAndWait()
  send(cmd + '\n')
  await sleep(4000)
  let bad = 0
  let checked = 0
  for (const y of ys) {
    const a = await main.viewport(y)
    const b = await main.viewport(y + 1)
    if (!a || !b) { bad++; continue }
    if (a.rows.length !== ROWS || b.rows.length !== ROWS) { bad++; continue }
    for (let i = 0; i + 1 < ROWS; i++) {
      checked++
      if (rowText(a.rows[i]) !== rowText(b.rows[i + 1])) bad++
    }
  }
  check(`滚动连续性 ${label}`, bad === 0, `比对 ${checked} 行，错位 ${bad}`)
}

console.log('[T1] 历史窗口滚动连续性（相邻 y 恰好错开 1 行）')
await scrollContinuity('数字 seq', 'seq 1 3000')
console.log('[T2] CJK 历史窗口滚动连续性与行宽一致性')
await scrollContinuity('CJK 混排', 'for i in $(seq 1 1500); do echo "中文测试 $i ターミナル 滚动压测 嵌入式"; done')
{
  const f = await main.viewport(300)
  const widths = f.rows.map((r) => [...rowText(r)].reduce((w, c) => w + (/[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︰-﹯＀-｠￠-￦　-〿぀-ゟ゠-ヿ一-鿿]/ .test(c) ? 2 : 1), 0))
  const overflow = widths.filter((w) => w > COLS).length
  check('CJK 行显示宽度不超屏宽', overflow === 0, `最宽 ${Math.max(...widths)} / ${COLS} 列`)
}

// ── T3 emoji / 组合字符：cells 与 runs 等价 ──
console.log('[T3] emoji 与组合字符：两种行编码解码等价')
{
  await clearAndWait()
  send('echo "👍🏽 😀 中文 テスト 🎉 e\xcc\x81 combining"\n')
  await sleep(1200)
  // clear 会清 scrollback → history_size 归零，历史窗口 y>0 会被钳到 0，
  // 故此处取 y=0（live 屏）而非历史窗口。
  const a = await main.viewport(0)
  const b = await legacy.viewport(0)
  if (!a || !b) check('emoji 双连接取样', false, '无帧')
  else {
    const ta = rowsText(a).filter((s) => s.includes('😀'))
    const tb = rowsText(b).filter((s) => s.includes('😀'))
    const runsRow = a.rows.find((r) => rowText(r).includes('😀'))
    const cellsRow = b.rows.find((r) => rowText(r).includes('😀'))
    check('emoji 行在两种编码下文本一致',
      ta.length > 0 && JSON.stringify(ta) === JSON.stringify(tb),
      ta[0] ? JSON.stringify(ta[0].slice(0, 40)) : '未取到 emoji 行')
    check('emoji 行 (字符,sgr) 序列等价',
      !!runsRow && !!cellsRow && rowSeq(runsRow).join('') === rowSeq(cellsRow).join(''),
      'skipped 占位在两侧均不产生输出')
  }
}

// ── T4 快速输出不丢行：滚动窗口内数字连续 ──
console.log('[T4] 快速输出 seq 1 20000：滚动窗口内无跳号/错位')
{
  await clearAndWait()
  send('seq 1 20000\n')
  const samples = []
  for (let k = 0; k < 6; k++) {
    await sleep(700)
    const f = await main.viewport(300, 2000)
    if (f) {
      const nums = rowsText(f).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
      let gaps = 0
      for (let i = 0; i + 1 < nums.length; i++) if (nums[i + 1] - nums[i] !== 1) gaps++
      samples.push({ n: nums.length, gaps, head: nums[0], tail: nums.at(-1) })
    }
  }
  await sleep(500)
  send('\x03')
  await sleep(500)
  const sampled = samples.filter((s) => s.n >= ROWS - 2)
  const totalGaps = samples.reduce((a, s) => a + s.gaps, 0)
  check('滚动窗口逐行连续（差恒为 1）', sampled.length > 0 && totalGaps === 0,
    `取样 ${samples.length} 次（满窗 ${sampled.length}），跳号 ${totalGaps}`)
}

// ── T5 alt-screen 进入/退出 ──
console.log('[T5] alt-screen 进入/退出（tput smcup / rmcup）')
{
  await clearAndWait()
  send('echo MAIN-SCREEN-MARK-12345\n')
  await sleep(600)
  main.reset()
  send('tput smcup; echo ALT-SCREEN-CONTENT-678; sleep 2; tput rmcup\n')
  const enter = await main.wait((f) => f.overlay === true && f.alt_screen === true, 4000)
  await sleep(1200)
  const altFrame = await main.viewport(0)
  const exit = await main.wait((f) => f.overlay === true && f.alt_screen === false, 5000)
  await sleep(800)
  const after = await main.viewport(0)
  check('进入 alt-screen 发 overlay 帧 alt_screen=true', !!enter, enter ? 'ok' : '未收到')
  check('退出 alt-screen 发 overlay 帧 alt_screen=false', !!exit, exit ? 'ok' : '未收到')
  const altText = altFrame ? rowsText(altFrame).join('\n') : ''
  const afterText = after ? rowsText(after).join('\n') : ''
  check('alt-screen 期间可见屏为 alt 内容', altText.includes('ALT-SCREEN-CONTENT-678'),
    altText.split('\n').find((l) => l.includes('ALT-SCREEN'))?.trim() ?? '未命中的行')
  check('退出后主屏恢复（含主屏标记行）', afterText.includes('MAIN-SCREEN-MARK-12345'),
    afterText.split('\n').find((l) => l.includes('MAIN-SCREEN-MARK'))?.trim() ?? '未命中的行')
  // 命令行本身会被 shell 回显到主屏（含 ALT 字面量），排除回显行后再判残留
  const visibleAfter = afterText.split('\n').filter((l) => !l.includes('tput')).join('\n')
  check('退出后无 alt 内容残留（排除命令行回显）', !visibleAfter.includes('ALT-SCREEN-CONTENT-678'),
    visibleAfter.includes('ALT-SCREEN-CONTENT-678') ? 'alt 内容仍可见' : 'ok')
}

// ── T6 TUI 程序 ──
console.log('[T6] TUI 程序（less / top）')
try {
  await clearAndWait()
  send('printf "TUI-LESS-LINE-%s\\n" 1 2 3 4 5 > /tmp/.rle-regress-less.txt\n')
  await sleep(400)
  main.reset()
  send('less /tmp/.rle-regress-less.txt\n')
  await sleep(1500)
  const lessFrame = await main.viewport(0)
  const lessText = lessFrame ? rowsText(lessFrame).join('\n') : ''
  check('less 帧可解析且内容非空', !!lessFrame && lessText.trim().length > 0,
    lessText.split('\n').find((l) => l.includes('TUI-LESS-LINE'))?.trim() ?? '未命中')
  send('q')
  await sleep(800)

  main.reset()
  send('top\n')
  await sleep(2500)
  const topFrame = await main.viewport(0)
  const topText = topFrame ? rowsText(topFrame).join('\n') : ''
  check('top 帧可解析且内容非空', !!topFrame && topText.trim().length > 0,
    topText.split('\n').slice(0, 2).join(' / ').slice(0, 60))
  send('q')
  await sleep(800)
} finally {
  send('\x03')
  await sleep(300)
}

// ── T7 断线重连补屏 ──
console.log('[T7] 断线重连补屏')
{
  await clearAndWait()
  send('for i in $(seq 1 60); do echo "RECONNECT-LINE-$i"; done\n')
  await sleep(1500)
  const before = await main.viewport(0)
  const beforeText = before ? rowsText(before).join('\n') : ''
  main.ws.close()
  await sleep(800)

  const re = await connect('runs')
  const first = await re.wait((f) => f.viewport == null && f.full === true, 5000)
  await sleep(600)
  const reFrame = await re.viewport(0)
  const reText = reFrame ? rowsText(reFrame).join('\n') : ''
  check('重连后收到 full 补屏帧', !!first && first.rows.length === ROWS,
    first ? `rows=${first.rows.length} full=${first.full}` : '未收到 full 帧')
  check('重连后可见屏含断开前内容', reText.includes('RECONNECT-LINE-60') || reText.includes('RECONNECT-LINE-59'),
    reText.split('\n').filter((l) => l.includes('RECONNECT-LINE')).at(-1)?.trim() ?? '未命中')
  check('重连前后末行一致', beforeText.split('\n').at(-1) === reText.split('\n').at(-1),
    `before=${JSON.stringify(beforeText.split('\n').at(-1))} after=${JSON.stringify(reText.split('\n').at(-1))}`)
  re.ws.close()
}

legacy.ws.close()
try { main.ws.close() } catch { /* 已关闭 */ }
await fetch(`${BASE}/api/v1/sessions/${sid}`, { method: 'DELETE' })

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
for (const f of failed) console.log(`  ✗ ${f.tag}: ${f.detail}`)
console.log('\n临时会话已删除')
process.exit(failed.length ? 1 : 0)
