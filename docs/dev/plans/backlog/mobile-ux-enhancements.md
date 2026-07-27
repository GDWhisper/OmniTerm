# 移动端体验增强（P2 待排期）

> 来源：`docs/dev/plans/2026-07-27-mobile-optimization.md` Phase 5
> 状态：待排期

## 触觉反馈（MobileKeyBar）

- MobileKeyBar `handleClick` 内加 `navigator.vibrate?.(10)`
- iOS Safari 不支持 vibrate API，静默跳过
- 可选：appStore 加 `mobileHapticEnabled` 设置项
- 竞品参考：Termius 10ms、Blink Shell 15ms

## 横屏 KeyBar 自动隐藏

- 问题：横屏 + 软键盘弹出后终端可视高度为负（StatusBar 30 + KeyBar 76 + Nav 50 + 键盘 ~260 > 屏高 ~393）
- 方案 A（推荐）：`matchMedia('(orientation: landscape)')` + 键盘弹出时不渲染 MobileKeyBar
- 方案 B：横屏时 MobileNav 改侧边竖排（改动大）
- 方案 C：toast 提示竖屏使用（最保守）
