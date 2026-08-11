# External References

## Research Repos

All under `/home/pax/coding/research/`:

| Repo | Path | License | Role |
|------|------|---------|------|
| tmuxes | `research/tmuxes` | MIT | Backend architecture reference |
| dufs | `research/dufs` | Apache-2.0/MIT | Rust file server reference |
| mansio | `research/mansio` | GPL-3.0 | **Architecture reference ONLY** — do NOT copy code |
| herdr | `research/herdr` | Apache-2.0 | Agent 状态检测/会话恢复/Socket API 参考，借鉴清单见 `docs/reference/herdr-reference.md` |
| claudecodeui | `research/claudecodeui` | **AGPL-3.0-or-later** | **Architecture reference ONLY** — do NOT copy code。聊天历史分页 / 滚动锚点参考，见 `docs/reference/chat-history-loading-comparison.md` |
| openchamber | `research/openchamber` | MIT | opencode 前端；聊天历史分页 / 移动端前插手势处理参考，见 `docs/reference/chat-history-loading-comparison.md` |
| obsidian-agent-client | `research/obsidian-agent-client` | Apache-2.0 | **同为 ACP 客户端**（Obsidian 插件）——最直接可对照。会话级 LRU 限界 / cooked 存储 / 冷藏归档参考，见 `docs/reference/chat-history-loading-comparison.md` |

## License Compliance

- Mansio (GPL-3.0): read only at `research/mansio`, NEVER copy code into this project
- **claudecodeui (AGPL-3.0-or-later)**: read only，NEVER copy code。AGPL 的网络服务条款与本项目的 FSL-1.1-MIT / Apache-2.0 不兼容，引入其代码会污染整个发行物——只能看设计意图与数值阈值，不得搬代码结构
- openchamber (MIT): 可借鉴实现，抄代码时保留版权声明
- obsidian-agent-client (Apache-2.0): 与本项目兼容，可借鉴实现，抄代码时保留版权声明与 NOTICE
- All new code files: Apache-2.0 license header
- Root LICENSE: Apache-2.0
