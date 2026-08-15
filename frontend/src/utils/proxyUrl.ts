/**
 * 本机（localhost）URL → 代理 URL 重写（端口转发反向代理 P3）。
 *
 * 机器 A 的浏览器通过跑在机器 B 上的 OmniTerm 访问 B 的 localhost 服务时，
 * 直接把链接指向 `http://localhost:{port}` 会打到浏览器 A 自己的回环地址。
 * 这里把它重写为 OmniTerm 后端的代理入口，由后端转发到 127.0.0.1:{port}。
 *
 * 两种代理形态：
 * 1. **路径前缀**（默认）：`/proxy/{port}/...` 同源相对路径（见计划 D4）。绝对路径 SPA
 *    （new-api `/assets/*`、`/api/*`）的资源与 API 由**后端响应体重写**兜底——后端对 HTML/JS
 *    响应统一补 `/proxy/{port}` 前缀（见 backend.md「响应体重写与绝对路径 SPA」），
 *    局域网纯 IP 场景开箱即用。
 * 2. **子域名**（配置 `proxyDomain` 后）：`{protocol}//{port}.{domain}:{backendPort}/...`。
 *    浏览器对绝对路径资源的解析天然落到子域名 Host，由后端按 Host 头路由到对应端口
 *    （D1 翻盘，见 plan `2026-08-13-port-forward-proxy.md` 子域名方案）；需可通配符解析的域名。
 *
 * `proxyDomain` 由 App 启动时 fetch `/api/v1/system/info` 的 `proxy_domain` 字段注入
 * （见 `App.tsx`），`null` 表示未启用子域名（回退路径前缀）。
 *
 * 端口范围与后端白名单对齐（3000..=65535）；黑名单（3306 等）与自身端口由后端拒绝
 * （403），前端只做基础范围过滤，避免无意义的 `window.open`。
 *
 * @returns 重写后的代理 URL（路径前缀相对路径或子域名绝对 URL）；非本机 URL 返回 `null`。
 */

let proxyDomain: string | null = null

/** 设置子域名代理 base（如 `omniterm.lan`）。`null` 回退路径前缀代理。 */
export function setProxyDomain(domain: string | null): void {
  proxyDomain = domain
}

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

  if (proxyDomain) {
    // 子域名：继承当前协议（http 部署得 http，https 反代部署得 https，见 §8 多实现兼容）。
    // 端口 = OmniTerm 后端监听端口（dev 前后端分离用注入的 VITE_BACKEND_PORT，生产同源用 location.port）。
    const p = backendPort()
    const portSuffix = p ? `:${p}` : ''
    return `${window.location.protocol}//${n}.${proxyDomain}${portSuffix}${rest ?? '/'}`
  }

  return `/proxy/${n}${rest ?? '/'}`
}

function backendPort(): string {
  if (import.meta.env.PROD) return window.location.port
  return (import.meta.env.VITE_BACKEND_PORT as string | undefined) || window.location.port
}
