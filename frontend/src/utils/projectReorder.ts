/**
 * 侧栏项目卡片拖拽排序的纯计算：把 `draggedId` 插到 `targetId` 之前
 * （`before`）/ 之后，产出新的完整 id 顺序。
 *
 * 单一真源——Sidebar 的 pointerup 提交、乐观重排与失败回滚都走这里；
 * 落盘载荷（`PUT /projects/order` 的 `ids`）与本地渲染顺序由此保证一致。
 *
 * 边界（均返回内容不变的新数组，调用方按 no-op 处理）：
 * - `draggedId === targetId`（拖回自己）
 * - `targetId` 不在 `ids` 中（DOM 与 store 竞态）
 */
export function computeProjectReorder(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  before: boolean,
): string[] {
  if (draggedId === targetId) return [...ids]
  const rest = ids.filter((id) => id !== draggedId)
  const at = rest.indexOf(targetId)
  if (at < 0) return [...ids]
  rest.splice(before ? at : at + 1, 0, draggedId)
  return rest
}
