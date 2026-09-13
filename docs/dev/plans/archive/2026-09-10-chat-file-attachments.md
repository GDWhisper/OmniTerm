# ACP 聊天文件附件（「+」附件抽屉）

> 状态：已实施（2026-09-10）
> 触发条件：移动端 ACP 会话没有任何附件入口——图片只能粘贴/拖拽（手机上没有拖拽），普通文件完全没有通路
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md`（F03 图片附件，同源先例）、`docs/architecture/backend.md`（ACP Module / Multi-implementation compatibility）、`docs/visual-design/ui-style-guide.md`

## 1. 背景

- 图片附件（F03）已端到端打通（粘贴/拖拽 → base64 → `ContentBlock::Image`），但入口是 `onPaste` / `onDrop`，移动端两个都用不了。
- 普通文件（PDF/zip/文档）**完全没有通路**：WS `prompt` 帧只有 `images` 字段，后端只构造 Text / Image / TextResource 三种内容块。
- `promptCapabilities.embeddedContext` 早在 initialize 解析并存入 `AcpClient`，但只服务于 `@path` 文本引用，缺 getter、缺前端下发。

本次在输入框内右侧（textarea 与 Send 之间）新增「+」按钮（移动端 + 桌面端），抽屉式弹出「相册」「文件」两张卡片，补齐移动端入口并新建文件端到端链路。

## 2. 范围

P0（本次全部实施）：

| 项 | 要点 |
|---|---|
| 相册卡片 | `<input type=file accept="image/*" multiple>`，复用 F03 图片内联管道 |
| 文件卡片 | `<input type=file multiple>`，新建 base64 blob 内联 → `ContentBlock::Resource(BlobResourceContents)` |
| 抽屉形态 | 移动端 bottom sheet（贴 MobileNav 上方，safe-area 处理）、桌面端锚定「+」的浮层；portal 到 body |
| 能力门控 | capabilities 帧新增 `embedded_context`；未声明置灰卡片 + 后端二次校验拒绝 |

不纳入范围（含理由）：

- **拖拽/粘贴扩展到非图片文件**：入口语义不同（用户明确要的是点击入口），且拖拽在移动端不存在。
- **文件上传到会话工作区再引用**：见 D1 否决项。
- **文件内容落库 / 历史回看内容**：见 D3。
- 前端预检体积/MIME：违反管道原则（唯一门禁是 WS 帧口径）。

## 3. 设计决策

### D1 文件传输 = base64 内联 blob

映射 `ContentBlock::Resource(EmbeddedResourceResource::BlobResourceContents)`，与图片附件同构。

- **理由**：不写用户项目目录；ACP 原生语义（`embeddedContext` 就是为"引用内容"设计的）；复用图片已有的管道原则（不限制内容、只受帧口径约束）。
- **否决项**：上传到会话 workspace 再用 `resource_link` / `@path` 引用。兼容性更好（任何 agent 都能读文件系统），但污染用户仓库、需要清理策略，且"把用户文件写进仓库"不是用户语义——用户是"发给你看"，不是"放进我的项目"。
- **翻盘条件**：若实测多数目标 agent 不声明 `embeddedContext` 导致文件功能长期不可用，应改走 uploaded-then-referenced 路线。

### D2 能力缺失的降级 = 拒绝，而非内联文本

`@path` 文本资源在 `embeddedContext` 缺失时可降级内联进 text block（既有行为）；**文件附件不走此降级**：二进制无文本形态，把 base64 塞进 text block 只会给 agent 一坨垃圾。因此前端置灰「文件」卡片（副文案说明原因）+ 后端 `PromptError` 双保险（§8）。

### D3 落库只存元数据（name / mimeType / size）

与图片只落缩略图同理：历史气泡只需"当时发了什么"的定位（文件名 + 大小），而文件内容可达上百 MiB，落库会让分页预算与首屏付出数量级代价。

- **代价（已知）**：历史消息无法回看/下载文件内容；用户本地仍有原文件。

### D4 附件状态图片 / 文件并列，不合并 union

图片有缩略图渲染与 `imageSrc` 逻辑，文件是 chip；发送时也走 WS 的两个不同字段。合并 union 只会让缩略图网格被迫窄化，无共享收益（抽象有度）。统一判断用派生 `hasAttachments` 去重三处判断。

## 4. 多实现差异（AGENTS §8）

| 维度 | 差异 | 兜底 |
|---|---|---|
| `promptCapabilities.embeddedContext` | 可选能力，agent 可不声明 | 前端置灰 + 后端拒绝（D2），不会盲发 |
| `ContentBlock::Resource` 形态 | 文本（`text`）与二进制（`blob`）两种，接收方处理能力不一 | 附件用 blob 自包含内容；`uri` 是名义 `file:///{name}`（picker 无真实路径），不承诺 agent 侧可寻址 |
| 超大帧 | 12MiB 由 WS 管道决定（base64 膨胀 ~33%，实际约 <9MiB 文件） | 后端显式 `message_too_large`，这是传输层口径而非内容策略 |

## 5. 实施（已全部完成）

1. **后端纯逻辑**：`FileInput`、`supports_embedded_context()`、抽出纯函数 `build_prompt_blocks`（顺序 Text → Image → Resource(Text) → Resource(Blob)）与 `file_uri`（`src/acp/client.rs`、`src/acp/mod.rs`）
2. **后端 WS**：`prompt.files` 帧（`#[serde(default)]` 向后兼容）、blocks_json 只写文件元数据、能力校验拒绝、`dispatch_prompt` 透传、capabilities 帧两处发送点（`src/ws/acp.rs`）
3. **前端数据层**：抽出共享 `readAsDataUrl`、新建 `fileAttachment.ts`、store（`FileBlock` / `embeddedContextSupported` / `addUserMessage(files)`）、`useAcpChat.sendPrompt(text, images, files)`、连接层签名（`frontend/src/utils/{readFile,fileAttachment,imageAttachment}.ts`、`frontend/src/stores/{chatStore,acpConnectionStore}.ts`、`frontend/src/hooks/useAcpChat.ts`）
4. **前端 UI**：`IconPhoto`、`ChatAttachDrawer.tsx`（portal + `useAnchorPopup` + 移动 bottom sheet）、`ChatInput` 加号/隐藏 input/文件 chip、`ChatMessage` 历史 chip、i18n zh/en（`frontend/src/components/Chat/*`、`frontend/src/components/FileManager/icons.tsx`、`frontend/src/locales/{zh,en}/translation.json`）
5. **文档**：`docs/architecture/backend.md`（WS 帧 + 能力差异）、`CHANGELOG.md`

## 6. 验收清单

- [x] `cargo fmt --all` / `cargo clippy -D warnings` 零告警
- [x] `cargo test --bins` 全绿（新增 `build_prompt_blocks` / `file_uri` / 帧反序列化共 11 个单测）
- [x] 前端 `pnpm lint`（0 error）/ `tsc -b` / `pnpm test --run` 全绿（新增抽屉 9 + 输入框 10 + 历史 chip 3 + 工具/ store 共 22 个测试）
- [ ] 移动端真机手测：sheet 定位与 safe-area、点「+」收起键盘、相册/文件选择器可唤起（待回归，用例入 `docs/reference/user-testing.md`）
- [ ] 桌面端手测：浮层锚定「+」、Esc / outside-click 关闭、非 100% zoom 不漂移
- [ ] 不支持 `embeddedContext` 的 agent：文件卡片置灰 + 直连 WS 被拒的错误可见
- [ ] >12MiB 帧触发 `message_too_large`

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 能力校验晚于落库（沿用 image 现状） | 被拒绝的 prompt 已入库、前端乐观显示后收到错误 | 与 image 行为一致；文档已标注 |
| 名义 URI 被 agent 当作真实路径读盘 | agent 读文件失败 | 内容由 blob 自包含；差异已记录在 backend.md |
| 用户选到超大文件才被拒 | 体验突兀 | 管道原则的必然（不做前端预检）；错误文案明确 |
| 移动端「+」按钮 36px | 略低于 44px 触控建议 | 沿用输入行既有高度（与 Send 对齐）；抽屉卡片 ≥52px |
