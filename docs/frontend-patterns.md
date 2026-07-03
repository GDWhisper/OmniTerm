# Frontend Patterns

记录 OmniTerm 前端开发中复用的设计模式与约定。每个 pattern 是
「数据如何从代码外部流入组件」「组件如何对外暴露接口」的契约。

新增组件或拆分数据前先扫一眼本文档，避免重复发明。

## 数据/渲染分离 (data.ts convention)

**适用场景**：组件需要渲染一份**纯静态或低频变更**的展示数据
（命令表、配置模板、术语对照表、快捷键清单等），且后续 Agent 或
开发者可能频繁增删条目。

**约定**：

- 数据放在同目录下的 `data.ts`，导出**类型化常量**
  （如 `export const SECTIONS: CheatsheetSection[]`）
- 数据条目中**可读部分**用 i18n key 引用
  （`titleKey` / `labelKey` / `hintKey`），ASCII 字面量
  （如 tmux 快捷键本身）直接放数据里
- 组件文件只负责 `useTranslation()` 渲染，**不内联数据**
- `data.ts` 顶部 JSDoc 写明「加/改数据改本文件 + 两个
  `frontend/src/locales/{en,zh}/translation.json`」

**已有案例**：

- `frontend/src/components/TmuxCheatsheet/data.ts` — tmux 速查命令表
  （拆自 `TmuxCheatsheet.tsx`，4 个 sections / 17 个 items）

**收益**：

- Agent 改命令不用动 `.tsx`，零 React 上下文
- TS 类型校验（`titleKey: string` 等）保证结构合法
- 后续如需按模式切换（例：tmux vs modern keybinding），
  在 data.ts 加第二份常量 + 组件里 `SECTIONS_MAP[mode]` 即可

**代价**：

- i18n key 写错不会编译失败，UI 上会显示原始 key 兜底
  （build-time i18n key 校验是未来工作）
- `cmd` 字符串目前是英文硬编码；如需本地化按键需额外搬进 i18n

## Sidebar 底部按钮弹出面板 (sidebar-popup convention)

**适用场景**：Sidebar 底部状态栏新增按钮 → 点击弹出 fixed 面板。
需要移动端/桌面端两套定位、视口边界保护、Esc/外部点击关闭。
**简单弹出（单 section、内容自适应高度）用此契约；多分类 + 固定尺寸
的游戏风格面板用下面「状态栏游戏风格面板模板」**。

**契约**：

- 触发按钮加 `data-toggle="<name>"` 属性，供 Popup 用 `document.querySelector` 定位
- Popup 文件命名 `<Feature>Popup.tsx`，内部组件为 `<Feature>`（纯内容，不关心弹出逻辑）
- Store 里一对 toggle：`settingsOpen` / `tmuxCheatsheetOpen`，互斥（开 A 关 B）
- 定位逻辑：统一走 `useAnchorPopup` hook（`frontend/src/hooks/useAnchorPopup.ts`）
  - Desktop: popup `bottom` 吸按钮上方 (`bottom: vh - rect.top + GAP`)；可选
    `topAnchorSelector: '.logo-title-bar'` 让 maxHeight 贴合 logo 底，避
    免向上溢出
  - Mobile: 全宽 bottom sheet，`bottom` 锚定在 `MobileNav + SidebarBottomBar` 之上，
    `height: calc(100dvh - mobileTotal)` 限制高度
- **滚动**：外层 popup 统一 `overflow: hidden`（让 `.panel-title-bar` 钉在顶部），
  滚动交给内层有 `overflow-y: auto` 的容器（`.settings-content` / `.tmux-cheatsheet-content`）
- 移动端定位常量统一在 `frontend/src/components/constants/popup.ts`：`MOBILE_NAV_HEIGHT`、`SIDEBAR_BOTTOM_BAR_HEIGHT`、`MOBILE_STATUS_BAR_RESERVE`、`GAP`
- **关闭**：`mousedown` 外部点击 + `Escape` 键（hook 自动处理），`onMouseDown` `stopPropagation` 阻止冒泡到关闭逻辑
- 边框效果（`borderRadius` / `boxShadow` / `animation`）都在外层 div inline style
- **顶部标题**：用 `.panel-title-bar` 类（自动获得木纹背景 + VT323 字 +
  3px letter-spacing），文案走 i18n（`t('<feature>.title')`）
- **滚动条**：项目已为 `.settings-content` / `.tmux-cheatsheet-content` 提供
  8px 硬角主题感知 scrollbar 样式，新加面板复用同款类名即可获得一致外观

**已有案例**：

- `frontend/src/components/Settings/SettingsPopup.tsx` + `Settings.tsx` — 设置面板（游戏风格 tab 菜单，详细见下节）
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx` + `TmuxCheatsheet.tsx` — tmux 快捷键速查（简单单 section 版本）

**复制清单**（新增一个简单 sidebar 弹出面板时）：

| 文件 | 做什么 |
|------|--------|
| `frontend/src/components/<Feature>/<Feature>.tsx` | 纯内容组件，用 `useTranslation()` 渲染 |
| `frontend/src/components/<Feature>/<Feature>Popup.tsx` | 照搬 `TmuxCheatsheetPopup` 骨架：调 `useAnchorPopup`（含 `topAnchorSelector: '.logo-title-bar'`）、`display: flex; flexDirection: column; overflow: hidden`、内层包 `<Feature />` 的容器加 `flex: 1; minHeight: 0; overflowY: auto`、顶部加 `.panel-title-bar` |
| `frontend/src/index.css` | scrollbar 复用：给新内容容器加同 `.settings-content` / `.tmux-cheatsheet-content` 风格类名即可（可选） |
| `frontend/src/stores/appStore.ts` | 加 `xxxOpen: false` + `toggleXxx()`（互斥逻辑照抄 `toggleSettings`） |
| `frontend/src/components/Layout/Layout.tsx` | 按钮加 `data-toggle="xxx"`，Desktop + Mobile 双路径条件渲染 `<XxxPopup />` |
| `frontend/src/locales/{en,zh}/translation.json` | 加 `<feature>.title` 等 i18n key |

---

## 状态栏游戏风格面板模板 (Game-style Status Bar Panel Template)

**适用场景**：状态栏新增按钮，弹出**复杂面板**——多 section、多分类、
需要 tab 分组、固定尺寸、pixel-game 风格。**简单弹出走上面契约即可**。

**参考实现**：`frontend/src/components/Settings/`（项目内目前最完整的游戏风格面板）
新加面板**以这个为模板复制**。简化版（无 tab）可参考 `TmuxCheatsheet`。

### 布局标准

```
┌─[ ◆ <TITLE> ]─────────────────┐ ← .panel-title-bar，木纹背景，粉
│┌────────┬──────────────────┐  │ 色顶部边缘闪击点
││ TAB 1  │ <section>        │  │ ← 90px 固定 tab 列
││▌ TAB 2 │ <section>        │  │  active 态：木纹底 + accent 3px 左边界
││ TAB 3  │ <section>        │  │ ← flex:1 滚动内容区
││        │ ...              │  │
│└────────┴──────────────────┘  │
└────────────────────────────────┘
```

- **顶部标题栏**：`.panel-title-bar`（必填），文案 i18n。HTML 结构：
  ```tsx
  <div className="panel-title-bar">
    <span>◆</span>
    <span>{t('<feature>.title')}</span>
  </div>
  ```
- **桌面尺寸**：
  - **高度** `33vh`（切 tab 高度不变，`useAnchorPopup` 的 `maxHeight` 作
    极短视口下的硬上限）
  - **宽度** `25vw`（屏 1/4）+ `useState` 跟踪 `window.innerWidth * 0.25`
    传给 `useAnchorPopup` 的 `width` 参数做水平 clamp，resize 同步更新
- **移动尺寸**：bottom sheet 全宽，高度 `calc(100dvh - mobileTotal)`，`borderRadius: 16`
- **结构**：popup 统一 `display: flex; flexDirection: column; overflow: hidden`，
  滚动交给有 `overflow-y: auto` 的内容容器（`.settings-content` /
  `.tmux-cheatsheet-content` 风格）

### Tab 菜单规范（以 Settings 为例）

- 左 90–92px 固定列用 `.settings-tabs`（深色背景 + wood-shadow 右边框）
- 每个 tab 是 `<button>` 加 `.settings-tab` 类，active 态加 `.active` 修饰
- Active tab：木纹底 + accent 3px 左边界 + 奶白字；hover 背景变亮
- 字体：VT323 14px，`letter-spacing: 1.5px`，**文字 UPPERCASE**
- mobile-only tab 标 `mobileOnly: true` 在分类配置中，桌面自动过滤

```tsx
const CATEGORIES: Category[] = [
  { id: 'appearance', labelKey: '...', sections: [ThemeSection, ...] },
  { id: 'mobile',     labelKey: '...', sections: [...], mobileOnly: true },
]

function <Feature>() {
  const isMobile = useAppStore(s => s.isMobile)
  const [activeId, setActiveId] = useState<CategoryId>('appearance')
  const visible = CATEGORIES.filter(c => !c.mobileOnly || isMobile)
  const active = visible.find(c => c.id === activeId) ?? visible[0]
  return (
    <div className="settings-layout">
      <nav className="settings-tabs">...tabs...</nav>
      <div className="settings-content">
        {active.sections.map((S, i) => <S key={i} />)}
      </div>
    </div>
  )
}
```

### Section 拆分原则

**每个 section 是独立 sub-component**（`ThemeSection` / `FontSizeSection` / …），
主组件只负责 tab 状态和 layout。这样：

- 每个 section 独立 `useAppStore` 切片订阅，toggle 只重渲对应 section
- 添加新 section 不动其他 section
- 公共 UI（如开关按钮组）抽为 `ToggleRow` 复用，消除复制代码

```tsx
function ToggleRow({ labelKey, hintKey, value, onToggle }: ToggleRowProps) {
  const { t } = useTranslation()
  return (
    <section className="space-y-2">
      <SectionTitle>{t(labelKey)}</SectionTitle>
      <button onClick={onToggle} style={{ ... }}>...</button>
      <p>{t(hintKey)}</p>
    </section>
  )
}
```

### i18n 约定

| 元素 | 风格 | 原因 |
|------|------|------|
| Tab 标签 | 英文 UPPERCASE（en/zh 一致） | VT323 不支持中文，pixel 风统一 |
| 选项标签 | 正常翻译 | `settings.theme: "Theme" / "主题"` |
| 开关状态 | `settings.on` / `settings.off` | 复用 key，避免每处写死 "ON" |
| Hint 文本 | 正常翻译，key 后缀 `Hint` | 与选项 key 配对 |
| 标题 | `t('<feature>.title')` | 走 i18n，便于将来调文案 |

### 复制清单（新增一个状态栏游戏风格面板时）

| 文件 | 做什么 |
|------|--------|
| `frontend/src/components/<Feature>/<Feature>.tsx` | 主组件 + sub-components；用 `.settings-layout` flex 容器、tab + content 布局；引入 `CATEGORIES` 配置；用 `ToggleRow` 等公共组件复用开关 UI |
| `frontend/src/components/<Feature>/<Feature>Popup.tsx` | 照搬 `SettingsPopup`：`useAnchorPopup`（`topAnchorSelector: '.logo-title-bar'`、动态 `width`）；固定 33vh × 25vw 桌面 + mobile bottom sheet；`display: flex; flexDirection: column; overflow: hidden`；顶部 `.panel-title-bar`；内层内容容器加 `flex: 1; minHeight: 0; overflowY: auto` |
| `frontend/src/index.css` | 复用 `.settings-layout` / `.settings-tabs` / `.settings-tab` / `.settings-content` 等已有类（仅 Tab 文本颜色差异可加 modifier）；新内容容器复用同款 scrollbar 样式 |
| `frontend/src/stores/appStore.ts` | 加 `xxxOpen: false` + `toggleXxx()`，与现有 toggle 互斥 |
| `frontend/src/components/Layout/Layout.tsx` | 按钮加 `data-toggle="xxx"`，Desktop + Mobile 双路径条件渲染 `<XxxPopup />` |
| `frontend/src/locales/{en,zh}/translation.json` | i18n key：标题 + tab 标签（英文 UPPERCASE） + section title + hint + `settings.on`/`settings.off`（复用） |

### 验证清单

- [ ] `pnpm build` 无 type error
- [ ] `pnpm lint` 无新增问题
- [ ] 桌面宽度 = 25vw、高度 = 33vh，且切 tab 不抖高度
- [ ] 极短视口下高度被 `maxHeight` 裁，**不溢出 logo 顶部**
- [ ] 桌面端水平 clamp 正确（按钮靠右时 popup 右边不出视口）
- [ ] 移动端 bottom sheet 全宽，MobileKeyBar 之上
- [ ] 滚动条硬角 8px、主题感知
- [ ] 顶部标题栏木纹背景**铺满 popup 整个顶部**（无 padding 让标题离边）
- [ ] i18n 完整：标题 / tab / section / hint / on-off 全部走 t()
- [ ] 没引入新依赖、没硬编码颜色（用 CSS 变量）
