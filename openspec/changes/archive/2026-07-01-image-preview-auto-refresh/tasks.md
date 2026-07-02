## 1. FilePreview 添加自动刷新逻辑

- [x] 1.1 `FilePreview` 新增 `fileChangeEvent` prop（类型 `{ kind: string; path: string } | null`）
- [x] 1.2 添加 `useEffect`：匹配事件文件名 → 启动 500ms debounce → 递增 `version` state
- [x] 1.3 `<img src>` 拼接 cache-bust 参数 `?v={version}`

## 2. FileDrawer 透传事件

- [x] 2.1 `FileDrawer` 中 `<FilePreview>` 调用追加 `fileChangeEvent={fileChangeEvent}` prop

## 3. 验证

- [ ] 3.1 手动测试：打开一张图片预览 → 外部修改图片（如 `cp new.png old.png`）→ 确认预览在 500ms 内自动刷新
- [ ] 3.2 手动测试：快速连续修改同一图片 → 确认仅触发一次刷新
- [ ] 3.3 回归：确认文本预览的自动刷新行为不受影响
