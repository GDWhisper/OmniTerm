# 移动端体验优化设计

> 状态：待实现  
> 创建日期：2026-06-28  
> 关联规范：`docs/ui-style-guide.md`

## 1. 背景与目标

OmniTerm 目前仅在 `Layout.tsx` 中做了最基础的移动端适配：屏幕宽度小于 768px 时切换为底部 tab 导航（终端/文件/会话/设置），但存在以下问题：

- 底部 tab 实际渲染在顶部，未做信息展示与手势支持
- 导航使用 emoji，违反 `docs/ui-style-guide.md` §5.0 的 emoji 禁止令
- 终端在纯触屏设备上几乎不可用：选中文本困难、缺少特殊键（Ctrl/Esc/Tab）、软键盘遮挡输出
- 文件管理器工具栏按钮过小，触屏点不中
- 无状态信息显示（当前会话、连接状态）

本设计目标：让 OmniTerm 在纯触屏手机上也能完整完成终端操作、文件管理和会话切换。

## 2. 设计原则

1. **桌面端零回归**：所有改动限制在 `isMobile` 分支或独立移动端组件内
2. **复用现有图标**：不新增无意义的图标，终端/文件直接复用桌面端已有 SVG
3. **手势可选**：任何可能干扰系统手势的交互都必须提供开关
4. **触控优先**：按钮最小触控区 40×40，关键操作不依赖精确点击

## 3. 布局改造

### 3.1 断点与检测

- 保持 `useMediaQuery.ts` 中的 `max-width: 768px` 断点
- `isMobile` 状态继续由 `useMobileDetection` 写入 `appStore`
- 桌面端三栏布局（Sidebar | Terminal | FileManager）完全不变

### 3.2 移动端结构

```
┌──────────────────────────────┐
│  顶部状态栏                    │  ← 24-32px 高
│  ● online   api-server    +  │
├──────────────────────────────┤
│                              │
│        内容区                 │  ← 终端 / 文件 / 会话
│                              │
├──────────────────────────────┤
│     [ 会话 ][ 终端 ][ 文件 ]   │  ← 底部悬浮式药丸导航
└──────────────────────────────┘
```

### 3.3 顶部状态栏

| 位置 | 内容 | 交互 |
|------|------|------|
| 左 | 在线状态点 + 连接状态 | 无点击，仅指示 |
| 中 | 当前激活会话名 | 点击弹出会话快速切换浮层 |
| 右 | `+` 图标 | 点击新建会话；长按选择新建类型 |

状态栏高度 28-32px，背景 `bg-base`，底部 1px `border-subtle`。

### 3.4 底部导航

- 仅保留三个入口，从左到右：**会话 / 终端 / 文件**
- 纯图标，无文字标签
- 采用悬浮式药丸容器，高度约 32px，避免厚重
- 当前激活项使用 `accent-violet`，未激活项使用 `text-muted`
- 容器背景 `bg-base`，边框 `border-subtle`，圆角 20px

### 3.5 图标定义

| 入口 | 图标 | 来源 |
|------|------|------|
| 会话 | 垂直镜像翻转后的阶梯横杠列表 | 新增（SVG，stroke + currentColor） |
| 终端 | `IconWorkbench`（`>` + `_` 提示符） | `frontend/src/components/FileManager/icons.tsx` 已有 |
| 文件 | `IconFolder` | `frontend/src/components/FileManager/icons.tsx` 已有 |

所有图标尺寸 18×18，viewBox `0 0 16 16`，符合 §5.0。

### 3.6 设置入口

- 从底部导航移除「设置」tab
- 在「会话」界面右上角放置齿轮图标按钮
- 点击后进入独立设置页（仍在 mobile 视图内，不覆盖桌面端的 `SettingsPopup`）

## 4. 手势设计

### 4.1 切换 tab 手势

- **内容区中部左右滑动**：切换到上一个/下一个 tab
- **底部导航条上左右滑动**：循环切换 tab
- **两侧 24px 边缘**：留给系统返回手势，不做应用内处理

### 4.2 手势开关

- 在设置页新增「启用手势切换」开关
- 默认开启
- 关闭后只能通过点击底部导航切换 tab
- 状态持久化到 localStorage，key：`omniterm_mobile_gesture_enabled`

## 5. 终端触屏优化

### 5.1 软键盘适配

- 终端容器需要监听 `VisualViewport` resize 事件
- 软键盘弹起时，自动滚动到底部，确保光标不被遮挡
- 预留输入区域高度，避免最后一行被键盘盖住

### 5.2 触摸滚动与 tmux 回滚

**现状**：后端创建 tmux 会话时已执行 `tmux set-option -t <session> mouse on`，桌面端鼠标滚轮可触发 tmux 复制模式滚动。但手机触屏滑动不会自动转换成 xterm.js 的 wheel 事件，导致终端内容滑不动。

**方案**：

1. **优先依赖 xterm.js 原生触摸滚动**：开启 xterm.js 的触摸支持，让 xterm.js 把触摸 swipe 转成 wheel 事件发送给 pty；tmux 的 `mouse on` 会接管 wheel 事件进入复制模式滚动。
2. **备用「滚动模式」**：如果原生触摸滚动在 tmux 下仍无效，在特殊键工具栏增加一个「滚动」开关。开启后：
   - 触摸上下滑动不再输入字符，而是向 tmux 发送复制模式滚动指令
   - 第一次向上滑时自动发送 `Ctrl+B [` 进入 tmux copy 模式
   - 后续滑动发送 `↑` / `↓` / `PageUp` / `PageDown`
   - 点击终端任意位置或按 `Esc` / `q` 退出滚动模式
3. **底线**：至少保证用户能看历史输出，不依赖鼠标滚轮。

### 5.3 文本选择

- 启用 xterm.js 的触摸选择支持（`allowProposedApi` + selection 相关 API）
- 长按触发选择模式，出现复制/粘贴/全选浮层
- 注意：在 tmux mouse on 模式下，xterm.js 的触摸选择可能与 tmux 的鼠标选择冲突，需测试并优先保证复制/粘贴可用

### 5.4 特殊键快捷栏

在终端页底部提供一个可折叠的特殊键工具栏，最小高度 36px，包含：

- `Ctrl`
- `Esc`
- `Tab`
- `↑` / `↓` / `←` / `→`
- `复制` / `粘贴`

点击 `Ctrl` 后进入组合模式，下一次按键作为 Ctrl+组合发送。

### 5.4 默认字体

- 移动端默认字体大小从 14px 提升到 16px
- 仍可通过设置页调整，范围 12-20px
- 单独持久化 key：`omniterm_mobile_font_size`，未设置时回退到桌面端设置

## 6. 文件管理器触屏优化

### 6.1 工具栏

- 所有按钮最小触控区 40×40
- 按钮间距增大
- 上传、新建文件夹、新建文件等核心操作保持可见
- 搜索、下载模式等次级操作可收入更多菜单（⋮）

### 6.2 文件列表

- 行高从桌面端的 ~28px 提升到 ~44px
- 支持长按某行弹出上下文菜单：打开、重命名、删除、下载
- 面包屑路径支持横向滚动，避免 truncation

### 6.3 抽屉/编辑器

- 文件查看/编辑抽屉在移动端改为从底部弹出（类似 sheet）
- 高度默认 60%，可拖拽调整
- 编辑模式下软键盘弹起时同步调整抽屉高度

## 7. 状态管理

### 7.1 appStore 新增字段

```ts
interface AppState {
  // ... existing fields

  // Mobile
  isMobile: boolean
  activeTab: 'terminal' | 'files' | 'sessions'
  mobileGestureEnabled: boolean
  mobileFontSize: number
}
```

### 7.2 新增 Actions

```ts
setActiveTab: (tab: AppState['activeTab']) => void
setMobileGestureEnabled: (v: boolean) => void
setMobileFontSize: (s: number) => void
```

### 7.3 持久化

| key | 默认值 | 说明 |
|-----|--------|------|
| `omniterm_mobile_gesture_enabled` | `true` | 手势开关 |
| `omniterm_mobile_font_size` | `16` | 移动端字体 |
| `omniterm_mobile_last_tab` | `terminal` | 上次活跃 tab |

## 8. 组件改动清单

| 文件 | 改动 |
|------|------|
| `frontend/src/components/Layout/Layout.tsx` | 重写移动端布局分支：顶部状态栏 + 内容区 + 底部导航 |
| `frontend/src/components/Layout/MobileNav.tsx` | 改为三入口药丸导航，移除 emoji，使用 SVG 图标 |
| `frontend/src/components/Layout/MobileStatusBar.tsx` | 新增顶部状态栏组件 |
| `frontend/src/stores/appStore.ts` | 新增 `mobileGestureEnabled`、`mobileFontSize`，tab 枚举移除 `settings` |
| `frontend/src/components/Terminal/Terminal.tsx` | 移动端：软键盘适配、特殊键工具栏、触摸选择、滚动模式 |
| `frontend/src/components/Terminal/MobileKeyBar.tsx` | 新增特殊键工具栏组件（含滚动模式开关） |
| `frontend/src/components/FileManager/FileManager.tsx` | 移动端：工具栏放大、行高增加、长按菜单 |
| `frontend/src/components/FileManager/FileDrawer.tsx` | 移动端改为底部 sheet |
| `frontend/src/components/Settings/Settings.tsx` | 新增「启用手势切换」和移动端字体大小设置 |
| `frontend/src/components/Sidebar/Sidebar.tsx` | 移动端视图右上角增加设置入口 |

## 9. 路由与入口不变

- 不新增路由
- 移动端仍通过同一 URL 访问，由 `Layout.tsx` 根据 `isMobile` 决定渲染方式

## 10. 测试计划

### 10.1 手动回归

- iPhone Safari / Chrome 软键盘弹起与收起
- Android Chrome 软键盘弹起与收起
- 底部导航点击切换
- 手势开关开启/关闭后的切换行为
- 终端特殊键工具栏发送 Ctrl+C / Esc / Tab
- 终端触摸滚动可看历史输出（或滚动模式生效）
- 文件管理器长按菜单、上传、新建文件夹
- 桌面端三栏布局无回归

### 10.2 检查项

- [ ] 无 emoji 字符
- [ ] 图标均为 SVG / currentColor / 18×18
- [ ] 按钮触控区 ≥ 40×40
- [ ] 手势不劫持系统返回
- [ ] 桌面端 untouched

## 11. 依赖

- `@xterm/xterm` 已包含触摸选择能力，无需新增依赖
- 不引入新的 UI 组件库

## 12. 未纳入范围

- 平板（iPad / Android 平板）专项优化：本期先解决手机端
- 横屏模式专项适配：本期以竖屏为主
- 原生应用（PWA / AppShell）：保持 Web 应用形态
- 离线模式：本期不涉及

## 13. 参考资料

- `docs/ui-style-guide.md`
- `frontend/src/components/FileManager/icons.tsx`
- `frontend/src/components/Layout/Layout.tsx`
- `frontend/src/components/Layout/MobileNav.tsx`
- `frontend/src/stores/appStore.ts`
- `frontend/src/hooks/useMediaQuery.ts`
