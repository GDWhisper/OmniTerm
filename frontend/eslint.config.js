import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// 本地规则：禁止在 JS/TS 里写死字体栈字面量。
// 字体栈必须在 utils/fonts.ts 统一定义（READER_FONT / PIXEL_FONT / LOGO_FONT），
// 或通过 CSS 变量 var(--reader-font) / var(--mono) 引用，避免栈漂移。
// 匹配裸栈关键词（SFMono / Menlo / Consolas）或任何直接写出完整字体名（JetBrains Mono 等）
// 而非引用常量的字符串字面量。
const noHardcodedFontFamily = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hardcoded font-family stacks; use fonts.ts constants or CSS vars' },
    schema: [],
  },
  create(context) {
    // utils/fonts.ts 是字体栈的唯一真相源，允许在此定义字面量（Windows 下 filename 是反斜杠，先归一）
    if (context.filename.replace(/\\/g, '/').includes('utils/fonts.ts')) return {}
    const HARDCODED = /(SFMono|Menlo|Consolas|monospace|JetBrains Mono|Fira Code|Cascadia Code|Press Start 2P|VT323)/i
    function check(node) {
      if (node.type !== 'Literal' || typeof node.value !== 'string') return
      if (!HARDCODED.test(node.value)) return
      // 允许通过 CSS 变量引用（var(--reader-font) / var(--mono)）
      if (/var\(--/.test(node.value)) return
      context.report({
        node,
        message:
          '不要写死字体栈，请使用 utils/fonts.ts 的 READER_FONT / PIXEL_FONT / LOGO_FONT 常量，或 CSS 变量 var(--reader-font) / var(--mono)。',
      })
    }
    return {
      // fontFamily: '...' 对象属性
      Property(node) {
        if (node.key && (node.key.name === 'fontFamily' || node.key.value === 'fontFamily')) {
          check(node.value)
        }
      },
      // 直接作为字面量出现（如嵌套 style 字符串拼接场景的兜底）
      Literal: check,
    }
  },
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      local: { rules: { 'no-hardcoded-font-family': noHardcodedFontFamily } },
    },
    rules: {
      // react-hooks v7 新规则过于严格，与项目惯用法冲突
      // - set-state-in-effect: effect 内 setState 是合理模式（数据获取、事件处理）
      // - refs: render 时更新 ref 是标准惯用法
      // - immutability: ref.current = value 是标准同步模式
      // - preserve-manual-memoization: 项目未使用 React Compiler
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      // 字体栈必须统一引用 fonts.ts 常量或 CSS 变量，禁止裸栈写死
      'local/no-hardcoded-font-family': 'error',
    },
  },
])
