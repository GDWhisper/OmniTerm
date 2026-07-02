## Why

文件管理器的文本预览已经支持 SSE 驱动的自动刷新——文件在外部被修改后，预览内容自动更新。但图片预览 (`FilePreview`) 缺失此能力：当图片文件被外部改动时，`<img>` 标签展示的仍是浏览器缓存的旧图，用户必须关闭预览再重新打开才能看到新内容。这是功能缺口，不是新需求。

## What Changes

- `FilePreview` 组件接收 `fileChangeEvent` prop，匹配到当前文件时通过带 debounce (500ms) 的 cache-bust 查询参数触发图片重新加载
- debounce 写死在组件内，不做可配置——实际场景无需调参

## Capabilities

### New Capabilities

- `image-preview-refresh`: 图片预览自动刷新（SSE 驱动，debounce 500ms）

### Modified Capabilities

_（无——这是新增能力，不修改已有 spec）_

## Impact

- 受影响文件：`frontend/src/components/FileManager/FilePreview.tsx`、`frontend/src/components/FileManager/FileDrawer.tsx`（传参）
- 无 API 变更，无依赖变更，无破坏性改动
- `fileChangeEvent` prop 的传递链路 `FileManager → FileDrawer → FilePreview` 已自然延伸，`FileDrawer` 已接收该 prop
