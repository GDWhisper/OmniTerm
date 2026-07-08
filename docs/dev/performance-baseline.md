# OmniTerm v0.1.0 性能基线

> 测量日期：2026-07-02
> 分支：dev（后续通过 sync-main.sh 同步到 main 发布）
> 测量环境：Linux x86_64，本地 release 构建

## 前端产物

构建命令：

```bash
cd frontend
pnpm build
```

产物目录：`frontend/dist/assets`

| 文件 | 大小 | gzip |
|---|---|---|
| `index-0fUqRIEP.js`（主 chunk） | 754.04 kB | 203.96 kB |
| `index-0L9Yqxp1.css` | 36.77 kB | 8.16 kB |
| `FileEditor-BgNxyBJH.js`（编辑器组件） | 30.42 kB | 9.58 kB |
| 13 个语言包 chunk（`dist-*.js`） | 1.99 kB ~ 268.00 kB 不等 | — |
| **assets 总计** | **~1.6 MB** | **~560 kB** |

关键观察：

- `FileEditor` 已拆分为独立 chunk，不打开文件编辑器时主 chunk 不加载 editor 代码。
- CodeMirror 语言包已按文件扩展名拆分为独立 chunk，首次打开对应类型文件时才加载。
- 主 chunk 从优化前（含 editor + 全部 lang 包）的 **1.68 MB** 降到 **754 kB**。

## 后端产物

构建命令：

```bash
cargo build --release
```

| 指标 | 数值 |
|---|---|
| 二进制路径 | `target/release/omniterm-dev` |
| 二进制大小 | 13 MB |
| 启动端口 | 9080（测试时指定） |
| 静置 30s 后 `VmRSS` | **~2.1 MB** |
| 静置 30s 后 `VmSize` | ~18.6 MB |
| 线程数 | 1 |

关键观察：

- release profile 下后端 idle RSS 极低（约 2 MB），远低于 dev profile 的 ~30 MB。
- 该数字是在无活跃 session、无文件编辑器、无 SSE 监听的静置状态下测得。

## 验证结果

- `pnpm build`：通过
- `pnpm test`：9 个测试文件、41 个测试全部通过
- 新增回归测试 `FileEditor.dynamic.test.tsx`：覆盖 13 种文件类型的动态语言加载

## 复现命令

```bash
# 前端构建
pnpm build
ls -lh frontend/dist/assets

# 后端 release 构建
cargo build --release
./target/release/omniterm-dev --port 9080 &
PID=$!
sleep 30
grep -E "VmRSS|VmSize|Threads" /proc/$PID/status
kill $PID
```

## 备注

- 本基线基于 dev 分支 `.env.local` 的端口/身份变量测量，与 preview/main 分支仅有端口/二进制名差异，不影响内存/体积量级。
- 用户实际运行时的内存会根据打开的 session、文件编辑器、监听数量合理上浮。
