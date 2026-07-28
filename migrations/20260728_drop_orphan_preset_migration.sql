-- dev 提交 3b6ef42 删除了 20260726_seed_agent_presets.sql（预设 agent 的 seed 逻辑
-- 已迁移到代码层 src/presets.rs，在运行时自愈注入），但部分环境的 DB 此前已应用过
-- 该迁移。sqlx 启动时会校验 `_sqlx_migrations` 与磁盘迁移文件一致，发现「已应用却
-- 缺失」的 20260726 会直接拒绝启动。本迁移将其元数据记录移除，使两边重新一致。
-- 预设 agent 数据由 src/presets.rs 在启动时按 PATH 自检注入，不受此删除影响。
DELETE FROM _sqlx_migrations WHERE version = '20260726';
