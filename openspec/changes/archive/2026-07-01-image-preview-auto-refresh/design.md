## Context

当前 `FileDrawer` 已通过 `fileChangeEvent` prop 接收 SSE 文件变更事件，并在 view 模式下自动刷新**文本**文件内容（`fetchContent()`）。但 `FilePreview`（图片预览组件）未接收任何事件 prop，`<img>` 标签的 `src` URL 固定不变，浏览器直接使用缓存，导致外部修改后预览不更新。

SSE 通道已存在，后端 notify crate 无节流地转发所有 inotify 事件。文本刷新已经在承受相同的事件频率，加入图片刷新不是新性能面。

## Goals / Non-Goals

**Goals:**
- `FilePreview` 感知匹配当前文件的 SSE 变更事件，自动刷新图片
- 用 500ms debounce 防 burst（连续高速写入合并为一次刷新）
- 复用现成的事件传递链路，改动最小化

**Non-Goals:**
- 不做服务端节流（影响面超出本次范围）
- 不做可配置 debounce（YAGNI）
- 不处理 rename 自动跟进（保持现状：rename 后旧路径预览报错，用户手动重开）
- 不处理视频/音频等非图片媒体类型

## Decisions

### 1. Cache-bust 方式：URL 查询参数
`<img src={`${imageUrl}?v=${version}`} />`，version 每次匹配事件后递增。

**替代方案**：`<img key={version}>` 强制 React 重新挂载。问题：浏览器按 URL 缓存，换 key 不换 URL 仍命中缓存，无效。

### 2. Debounce 策略：前端 useEffect + setTimeout
匹配事件时启动 500ms 定时器，新事件重置定时器。超时后方递增 version 触发刷新。

**替代方案**：`leading + trailing`（立即刷新 + 尾部延迟防 burst）。更复杂，图片通常原子写入，首次事件即可刷新，leading 没带来实质收益。

### 3. 事件匹配：按文件名（basename）
SSE 事件中 `path` 是相对路径，`FilePreview` 的 `fileName` 是 basename。用 `fileChangeEvent.path.split('/').pop()` 对比 `fileName`。

这与 `FileDrawer` 的文本刷新逻辑一致（`FileDrawer.tsx` 第 122-123 行），保持统一。

### 4. prop 传递：FileDrawer → FilePreview
`FileDrawer` 已接收 `fileChangeEvent`，只需透传给 `FilePreview`。不改动 `FileManager → FileDrawer` 的接口。

## Risks / Trade-offs

- **图片文件较大时频繁下载可能卡顿** → debounce 500ms 把连续写入合并，减少无谓下载；且图片通常原子写入，实际不会频繁触发
- **浏览器不处理 ETag/304** → `<img>` 标签无法发条件请求，每次 cache-bust 必完整下载。对 localhost 应用可接受
