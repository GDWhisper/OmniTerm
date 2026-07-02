/**
 * OmniTerm version — 由 vite.config.ts 在 build 时从 .env.local 注入
 * (import.meta.env.VITE_APP_VERSION)
 * 运行时 fallback 到 '0.0.0'（仅在 .env.local 缺失时）
 */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'
