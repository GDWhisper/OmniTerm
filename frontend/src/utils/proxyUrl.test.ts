import { describe, it, expect } from 'vitest'
import { rewriteLocalUrl } from './proxyUrl'

describe('rewriteLocalUrl', () => {
  it('重写 http://localhost:port 为 /proxy/{port}/', () => {
    expect(rewriteLocalUrl('http://localhost:3000')).toBe('/proxy/3000/')
    expect(rewriteLocalUrl('http://localhost:3000/')).toBe('/proxy/3000/')
  })

  it('重写 http://127.0.0.1:port 与 0.0.0.0', () => {
    expect(rewriteLocalUrl('http://127.0.0.1:5173')).toBe('/proxy/5173/')
    expect(rewriteLocalUrl('http://0.0.0.0:8000')).toBe('/proxy/8000/')
  })

  it('保留剩余路径与 query', () => {
    expect(rewriteLocalUrl('http://localhost:3000/a/b?x=1')).toBe('/proxy/3000/a/b?x=1')
    expect(rewriteLocalUrl('https://localhost:3000/api')).toBe('/proxy/3000/api')
  })

  it('重写无 scheme 的裸 hostname:port', () => {
    expect(rewriteLocalUrl('localhost:3000')).toBe('/proxy/3000/')
    expect(rewriteLocalUrl('127.0.0.1:8080/foo')).toBe('/proxy/8080/foo')
  })

  it('非本机 URL 返回 null', () => {
    expect(rewriteLocalUrl('http://example.com:3000')).toBeNull()
    expect(rewriteLocalUrl('https://google.com')).toBeNull()
    expect(rewriteLocalUrl('http://192.168.1.1:3000')).toBeNull()
  })

  it('端口低于 3000 或高于 65535 返回 null（与后端白名单对齐）', () => {
    expect(rewriteLocalUrl('http://localhost:80')).toBeNull()
    expect(rewriteLocalUrl('http://localhost:2999')).toBeNull()
    expect(rewriteLocalUrl('http://localhost:99999')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(rewriteLocalUrl('')).toBeNull()
    expect(rewriteLocalUrl('   ')).toBeNull()
  })
})
