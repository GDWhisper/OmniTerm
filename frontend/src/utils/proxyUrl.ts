/**
 * 本机（localhost）URL → `/proxy/{port}/...` 重写（端口转发反向代理 P3）。
 *
 * 机器 A 的浏览器通过跑在机器 B 上的 OmniTerm 访问 B 的 localhost 服务时，
 * 直接把链接指向 `http://localhost:{port}` 会打到浏览器 A 自己的回环地址。
 * 这里把它重写为 OmniTerm 后端的 `/proxy/{port}/`（同源相对路径，见计划 D4），
 * 由后端转发到 127.0.0.1:{port}。
 *
 * 端口范围与后端白名单对齐（3000..=65535）；黑名单（3306 等）与自身端口
 * 由后端拒绝（403），前端只做基础范围过滤，避免无意义的 `window.open`。
 *
 * @returns 重写后的 `/proxy/{port}/...` 相对 URL；非本机 URL 返回 `null`。
 */
export function rewriteLocalUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url) return null

  // 带 scheme：http(s)://localhost:port/... | 127.0.0.1 | 0.0.0.0
  const withScheme = /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})([/?#].*)?$/i.exec(
    url,
  )
  if (withScheme) {
    return buildProxy(withScheme[3], withScheme[4])
  }

  // 无 scheme：localhost:port/...（终端输出常见裸 hostname:port）
  const bare = /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})([/?#].*)?$/i.exec(url)
  if (bare) {
    return buildProxy(bare[2], bare[3])
  }

  return null
}

function buildProxy(port: string, rest: string | undefined): string | null {
  const n = Number(port)
  // 与后端 ALLOWED_PORT_RANGE 对齐；黑名单/自身端口交给后端 403 兜底。
  if (n < 3000 || n > 65535) return null
  return `/proxy/${n}${rest ?? '/'}`
}
