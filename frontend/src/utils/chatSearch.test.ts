import { describe, it, expect } from 'vitest'
import { splitSnippet } from './chatSearch'

/**
 * 命中词高亮切段（F06）。
 *
 * 切段用正则而不是「小写化后按字节找」——大小写折叠可能改变字符串长度
 * （'İ'.toLowerCase() 长度为 2），按字节找会错位；关键词里的正则元字符必须转义。
 */
describe('splitSnippet', () => {
  it('把命中词切成独立段', () => {
    const segs = splitSnippet('前面有上下文后面也有上下文', ['上下文'])
    expect(segs).toEqual([
      { text: '前面有', hit: false },
      { text: '上下文', hit: true },
      { text: '后面也有', hit: false },
      { text: '上下文', hit: true },
    ])
  })

  it('大小写不敏感命中，但保留原文大小写', () => {
    const segs = splitSnippet('Hello Context', ['context'])
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['Context'])
  })

  it('无命中时整段返回（非命中）', () => {
    expect(splitSnippet('完全无关', ['上下文'])).toEqual([{ text: '完全无关', hit: false }])
  })

  it('关键词里的正则元字符不当语法处理', () => {
    const segs = splitSnippet('完成 100% 与 a_b', ['100%', 'a_b'])
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['100%', 'a_b'])
  })

  it('空关键词列表不做高亮', () => {
    expect(splitSnippet('任意文本', [])).toEqual([{ text: '任意文本', hit: false }])
  })
})
