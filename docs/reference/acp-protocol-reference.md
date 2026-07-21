# ACP 协议开发参考手册

> **来源**：本文档从 ACP 官方文档（https://agentclientprotocol.com/）提取整理，对应协议版本 v2（当前稳定版）。仓库：https://github.com/agentclientprotocol/agent-client-protocol
>
> **用途**：开发 ACP Client/Agent 时的协议参考手册。按主题分章，可直接查阅。

---

## 目录

1. [协议概览](#1-协议概览)
2. [传输层](#2-传输层)
3. [初始化握手](#3-初始化握手)
4. [认证](#4-认证)
5. [会话管理](#5-会话管理)
6. [Prompt 生命周期](#6-prompt-生命周期)
7. [消息内容类型](#7-消息内容类型)
8. [Tool Calls](#8-tool-calls)
9. [权限请求](#9-权限请求)
10. [Agent Plan](#10-agent-plan)
11. [Slash 命令](#11-slash-命令)
12. [会话配置选项](#12-会话配置选项)
13. [终端（Terminal）](#13-终端terminal)
14. [文件系统访问](#14-文件系统访问)
15. [取消机制](#15-取消机制)
16. [扩展机制](#16-扩展机制)
17. [会话列表与删除](#17-会话列表与删除)
18. [Client 实现清单](#18-client-实现清单)
19. [错误码参考](#19-错误码参考)

---

## 1. 协议概览

### 1.1 什么是 ACP

Agent Client Protocol（ACP）标准化 code editor（Client）与 coding agent（Agent）之间的通信。类似于 LSP 标准化了语言服务器集成，ACP 标准化了 AI agent 集成。

### 1.2 设计理念

1. **MCP-friendly**：基于 JSON-RPC，复用 MCP 类型，集成者不需要再造数据表示
2. **UX-first**：解决 AI agent 交互的 UX 挑战，足够灵活渲染 agent 意图
3. **Trusted**：用户信任 agent 时工作，editor 给 agent 访问本地文件和 MCP server 的权限

### 1.3 通信模型

基于 **JSON-RPC 2.0**，两种消息类型：

- **Methods**：请求-响应对，期望返回 result 或 error
- **Notifications**：单向通知，不期望响应

### 1.4 消息流（完整生命周期）

```
1. 初始化阶段
   Client → Agent: initialize（协商版本 + 能力）
   Client → Agent: auth/login（如果需要认证）

2. 会话创建（二选一）
   Client → Agent: session/new（新建会话）
   Client → Agent: session/resume（恢复已有会话，可选 replay 历史）

3. Prompt 生命周期
   Client → Agent: session/prompt（发送用户消息）
   Agent → Client: session/prompt response（prompt 已接受）
   Agent → Client: session/update 通知（消息、状态、工具调用等）
   Agent → Client: session/request_permission（如需权限）
   Client → Agent: session/cancel（可选取消）
   Agent → Client: state_update: idle（前台工作完成，附带 stopReason）

4. 会话关闭
   Client → Agent: session/close
```

### 1.5 角色定义

| 角色 | 说明 | 我们的身份 |
|------|------|------------|
| **Client** | 提供用户界面，管理环境，处理用户交互，控制资源访问 | ✅ 我们是 Client |
| **Agent** | 使用生成式 AI 自主修改代码的程序，通常作为 Client 的子进程运行 | Agent adapter（如 claude-agent-acp） |

### 1.6 约定

- 所有文件路径 **MUST** 是绝对路径
- 行号从 1 开始（1-based）
- JSON 对象属性名用 `camelCase`
- 判别字段的字符串值用 `snake_case`
- JSON-RPC 信封字段（`jsonrpc`, `id`, `method`, `params`, `result`, `error`）遵循 JSON-RPC 2.0 规范

### 1.7 MCP 集成

Client 可在 session 创建时传入 MCP server 配置，Agent 直接连接 MCP server：

```
Client → Agent: session/new (含 mcpServers 配置)
Agent → MCP Server: 直接连
```

Client 也可自身导出 MCP 工具，通过 proxy 桥接。

---

## 2. 传输层

### 2.1 stdio（主要传输）

```
Client 启动 Agent 作为子进程
Agent 从 stdin 读 JSON-RPC 消息，向 stdout 写消息
消息用换行符 \n 分隔，MUST NOT 包含内嵌换行
Agent MAY 向 stderr 写 UTF-8 日志（Client 可捕获、转发或忽略）
Agent MUST NOT 向 stdout 写非 ACP 消息
Client MUST NOT 向 Agent stdin 写非 ACP 消息
```

消息格式：每行一个 JSON-RPC 消息（ndJSON）。

```
Client → Agent stdin:  {"jsonrpc":"2.0","id":0,"method":"initialize","params":{...}}\n
Agent → Client stdout: {"jsonrpc":"2.0","id":0,"result":{...}}\n
```

### 2.2 JSON-RPC 批量消息

JSON-RPC 2.0 允许将多个请求/通知组合在批量数组中。ACP 遵循 JSON-RPC 2.0 批量规则：

- 批量本身无效 JSON → 返回单个 Parse error（code: -32700, id: null）
- 空数组 → 返回单个 Invalid Request（code: -32600, id: null）
- 接收方 MAY 并发处理批量条目，顺序不限
- 接收方 SHOULD 返回对应响应数组
- 通知条目不产生响应
- 全通知批量 → 不返回任何内容（不返回空数组）
- **生命周期敏感消息**（`initialize`, `auth/login`, `session/new`, `session/resume`, `session/prompt`）**SHOULD NOT** 批量发送

### 2.3 Streamable HTTP（草案中）

正在讨论中，尚未稳定。

### 2.4 自定义传输

协议是传输无关的，只要支持双向消息交换的通道都可以用。自定义传输 MUST 保持 JSON-RPC 消息格式和生命周期要求。

---

## 3. 初始化握手

### 3.1 请求

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 2,
    "capabilities": {},
    "info": {
      "name": "my-client",
      "title": "My Client",
      "version": "1.0.0"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `protocolVersion` | integer | Client 支持的最新协议版本 |
| `capabilities` | object | Client 能力声明（全部 OPTIONAL） |
| `info.name` | string | 程序标识符 |
| `info.title` | string | 人类可读名称 |
| `info.version` | string | 实现版本号 |

### 3.2 响应

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 2,
    "capabilities": {
      "session": {
        "prompt": {
          "image": {},
          "audio": {},
          "embeddedContext": {}
        },
        "mcp": {
          "stdio": {},
          "http": {}
        },
        "delete": {},
        "additionalDirectories": {}
      }
    },
    "info": {
      "name": "my-agent",
      "title": "My Agent",
      "version": "1.0.0"
    },
    "authMethods": []
  }
}
```

### 3.3 版本协商

- Client 发送自己支持的最新版本
- Agent 如果支持该版本，返回相同版本
- 否则返回 Agent 支持的最新版本
- Client 不支持 Agent 返回的版本 → SHOULD 关闭连接

### 3.4 Agent 能力（capabilities）

| 能力 | 含义 | 省略/null | `{}` |
|------|------|-----------|------|
| `session` | 支持 session/* 方法面 | 不支持 | 支持基线方法：session/new, session/list, session/resume, session/close, session/prompt, session/cancel, session/update |
| `session.prompt.image` | prompt 可含 Image 内容 | 不支持 | 支持 |
| `session.prompt.audio` | prompt 可含 Audio 内容 | 不支持 | 支持 |
| `session.prompt.embeddedContext` | prompt 可含 Resource 内容 | 不支持 | 支持 |
| `session.mcp.stdio` | 支持 stdio MCP server | 不支持 | 支持 |
| `session.mcp.http` | 支持 HTTP MCP server | 不支持 | 支持 |
| `session.delete` | 支持 session/delete 方法 | 不支持 | 支持 |
| `session.additionalDirectories` | 支持额外工作区根目录 | 不支持 | 支持 |

**基线要求**：声明了 `session` 的 Agent MUST 支持 `ContentBlock::Text` 和 `ContentBlock::ResourceLink` 在 prompt 中。

---

## 4. 认证

### 4.1 认证方法声明

Agent 在 `initialize` 响应的 `authMethods` 字段声明认证方法：

```json
{
  "authMethods": [
    {
      "methodId": "agent-login",
      "name": "Agent login",
      "type": "agent",
      "description": "Sign in using the agent's login flow"
    }
  ]
}
```

- 返回 ≥1 个有效条目 → Agent MUST 实现 `auth/login` 和 `auth/logout`
- 省略或空 → Client MUST NOT 调用这两个方法
- `type: "agent"` 是标准类型，表示 Agent 自己处理认证
- 自定义 type MUST 以 `_` 开头

### 4.2 登录

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "auth/login",
  "params": {
    "methodId": "agent-login"
  }
}

// Agent → Client
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {}
}
```

### 4.3 登出

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "auth/logout",
  "params": {}
}

// Agent → Client
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

登出后，需要认证的新 session 需要重新 `auth/login`。已有 session 的行为不保证（可能终止、可能继续、可能返回 auth_required 错误）。

---

## 5. 会话管理

### 5.1 创建会话

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      {
        "type": "stdio",
        "name": "workspace-tools",
        "command": "/path/to/mcp-server",
        "args": ["--stdio"],
        "env": [
          { "name": "API_KEY", "value": "secret123" }
        ]
      },
      {
        "type": "http",
        "name": "api-server",
        "url": "https://api.example.com/mcp",
        "headers": [
          { "name": "Authorization", "value": "Bearer token123" }
        ]
      }
    ],
    "additionalDirectories": [
      "/home/user/shared-lib",
      "/home/user/product-docs"
    ]
  }
}

// Agent → Client
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123def456",
    "configOptions": [
      // 可选：会话配置选项（见第 12 章）
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | string | ✅ | 工作目录，MUST 为绝对路径 |
| `mcpServers` | array | ❌ | MCP server 配置列表 |
| `additionalDirectories` | string[] | ❌ | 额外工作区根目录（需 Agent 声明 `session.additionalDirectories`） |

**MCP Server 类型**：

| 传输 | 必填字段 |
|------|---------|
| `stdio` | `type`, `name`, `command`；可选：`args`, `env` |
| `http` | `type`, `name`, `url`；可选：`headers` |

### 5.2 恢复会话

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/resume",
  "params": {
    "sessionId": "sess_789xyz",
    "cwd": "/home/user/project",
    "mcpServers": [],
    "replayFrom": {
      "type": "start"
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `replayFrom` 省略/null | 不回放历史，仅恢复上下文 |
| `replayFrom: { type: "start" }` | 回放完整历史 |

回放时 Agent 通过 `session/update` 通知发送历史消息（`user_message`, `agent_message`, `agent_thought`），全部回放完毕后才响应。

回放的消息含 `messageId`，是 upsert 语义：
- 完整消息更新：`content` 替换全部内容
- chunk 更新：`content` 追加到当前内容
- 如果完整更新在 chunk 之后到达，替换 chunk 积累的内容

### 5.3 关闭会话

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/close",
  "params": {
    "sessionId": "sess_789xyz"
  }
}

// Agent → Client
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {}
}
```

Agent MUST 取消该 session 的所有进行中工作（如同 session/cancel），然后释放资源。

### 5.4 工作目录规则

- `cwd` MUST 为绝对路径
- MUST 作为 session 的主工作目录，无论 Agent 进程在哪启动
- MUST 作为相对路径解析的基准
- MUST 在 session 的有效根集中
- 使用 `additionalDirectories` 时，有效根集 = `[cwd, ...additionalDirectories]`

---

## 6. Prompt 生命周期

### 6.1 发送 Prompt

```json
// Client → Agent
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      {
        "type": "text",
        "text": "Can you analyze this code for potential issues?"
      },
      {
        "type": "resource",
        "resource": {
          "uri": "file:///home/user/project/main.py",
          "mimeType": "text/x-python",
          "text": "def process_data(items):\n    for item in items:\n        print(item)"
        }
      }
    ]
  }
}
```

`prompt` 是 `ContentBlock[]`，类型受 Prompt Capabilities 限制（见 §3.4）。

### 6.2 Prompt 已接受

Agent 接受 prompt 后返回空响应：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

**完成不通过 prompt 响应报告**，而是通过 `state_update` 通知。

### 6.3 用户消息确认

Agent MUST 报告用户消息插入位置（含 `messageId`）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "user_message",
      "messageId": "msg_user_8f7a1",
      "content": [
        { "type": "text", "text": "Can you analyze this code for potential issues?" }
      ]
    }
  }
}
```

### 6.4 状态流转

```json
// 前台工作开始
{
  "update": {
    "sessionUpdate": "state_update",
    "state": "running"
  }
}

// 前台工作完成
{
  "update": {
    "sessionUpdate": "state_update",
    "state": "idle",
    "stopReason": "end_turn"
  }
}

// 需要用户操作（如权限）
{
  "update": {
    "sessionUpdate": "state_update",
    "state": "requires_action"
  }
}
```

| 状态 | 说明 |
|------|------|
| `running` | 前台工作进行中 |
| `idle` | Agent 就绪，可接受新 prompt |
| `requires_action` | 前台工作阻塞于用户操作 |

**注意**：`idle` 状态下仍 MAY 发送其他 `session/update` 通知（如 tool_call_update），这些通知不改变状态。

### 6.5 Agent 输出通知

Agent 通过多种 `session/update` 通知报告输出：

| sessionUpdate 类型 | 说明 |
|-------------------|------|
| `agent_message` | 完整 agent 消息（含 content 数组） |
| `agent_message_chunk` | 流式 agent 消息（追加内容） |
| `agent_thought` | 完整 agent 思考 |
| `agent_thought_chunk` | 流式 agent 思考 |
| `tool_call_update` | 工具调用状态更新 |
| `tool_call_content_chunk` | 工具调用内容流式追加 |
| `plan_update` | 执行计划更新 |
| `usage_update` | token 使用量和费用 |
| `session_info_update` | 会话元数据更新 |
| `available_commands_update` | slash 命令列表更新 |
| `config_option_update` | 配置选项更新 |
| `terminal_update` | 终端状态更新 |
| `terminal_output_chunk` | 终端输出流式追加 |

### 6.6 消息 ID 语义

`messageId` 是 Agent 分配的不透明标识符：

- `user_message` / `agent_message` / `agent_thought` 是 **upsert**（按 messageId 键）
  - 省略 `content` → 内容不变
  - `content: null` 或 `content: []` → 清空内容
  - 具体 `content` → 替换全部内容（包括之前 chunk 积累的）
- `*_chunk` 更新 → **追加**内容到当前 messageId

**示例**：
1. `agent_message` content: [A] → 渲染 [A]
2. `agent_message_chunk` B → 渲染 [A, B]
3. `agent_message` content: [C] → 渲染 [C]（替换）
4. `agent_message_chunk` D → 渲染 [C, D]

### 6.7 Usage 更新

```json
{
  "update": {
    "sessionUpdate": "usage_update",
    "used": 53000,
    "size": 200000,
    "cost": {
      "amount": 0.045,
      "currency": "USD"
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `used` | ✅ | 当前 session 上下文已用 token 数 |
| `size` | ✅ | 当前 session 上下文总大小 |
| `cost` | ❌ | 累计费用，含 `amount`（数字）和 `currency`（ISO 4217） |

### 6.8 停止原因（stopReason）

idle 状态转换结束前台工作时 MUST 包含 stopReason：

| stopReason | 说明 |
|------------|------|
| `end_turn` | LLM 完成响应，没有更多工具调用 |
| `max_tokens` | 达到最大 token 限制 |
| `max_turn_requests` | 超过最大模型请求次数 |
| `refusal` | Agent 拒绝继续 |
| `cancelled` | Client 取消了活动工作 |

自定义 stopReason MUST 以 `_` 开头。

---

## 7. 消息内容类型

Content Block 复用 MCP 的 `ContentBlock` 结构，出现在 prompt、消息更新、工具调用内容中。

### 7.1 Text Content（基线，所有 Agent MUST 支持）

```json
{
  "type": "text",
  "text": "What's the weather like today?"
}
```

### 7.2 Image Content（需 `session.prompt.image` 能力）

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..."
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `data` | ✅ | Base64 编码图片数据 |
| `mimeType` | ✅ | MIME 类型（image/png, image/jpeg 等） |
| `uri` | ❌ | 图片来源 URI |
| `annotations` | ❌ | 内容使用/显示元数据 |

### 7.3 Audio Content（需 `session.prompt.audio` 能力）

```json
{
  "type": "audio",
  "mimeType": "audio/wav",
  "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAAB..."
}
```

### 7.4 Embedded Resource（需 `session.prompt.embeddedContext` 能力）

直接嵌入资源内容，适合 @-mention 引用文件：

```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///home/user/script.py",
    "mimeType": "text/x-python",
    "text": "def hello():\n    print('Hello, world!')"
  }
}
```

Resource 可为 Text Resource（含 `text`）或 Blob Resource（含 base64 `blob`）。

### 7.5 Resource Link

引用 Agent 可访问的资源：

```json
{
  "type": "resource_link",
  "uri": "file:///home/user/document.pdf",
  "name": "document.pdf",
  "mimeType": "application/pdf",
  "title": "Project Spec",
  "description": "Project specification document",
  "icons": [
    {
      "src": "https://example.com/icons/pdf.png",
      "mimeType": "image/png",
      "sizes": ["48x48"]
    }
  ],
  "size": 1024000
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `uri` | ✅ | 资源 URI |
| `name` | ✅ | 人类可读名称 |
| `mimeType` | ❌ | MIME 类型 |
| `title` | ❌ | 显示标题 |
| `description` | ❌ | 资源描述 |
| `icons` | ❌ | 图标列表 |
| `size` | ❌ | 文件大小（字节） |

---

## 8. Tool Calls

### 8.1 报告工具调用

当 LLM 请求工具调用时，Agent SHOULD 报告 `tool_call_update`：

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "title": "Reading configuration file",
      "kind": "read",
      "status": "pending"
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `toolCallId` | ✅ | session 内唯一的工具调用 ID |
| `title` | ❌ | 人类可读标题（首次报告 SHOULD 包含） |
| `kind` | ❌ | 工具类型 |
| `status` | ❌ | 执行状态（默认 pending） |
| `content` | ❌ | 工具产生的内容 |
| `locations` | ❌ | 文件位置（用于"跟随"功能） |
| `rawInput` | ❌ | 工具的原始输入参数 |
| `rawOutput` | ❌ | 工具的原始输出 |

### 8.2 工具类型（kind）

| kind | 说明 |
|------|------|
| `read` | 读取文件或数据 |
| `edit` | 修改文件或内容 |
| `delete` | 删除文件或数据 |
| `move` | 移动或重命名文件 |
| `search` | 搜索信息 |
| `execute` | 运行命令或代码 |
| `think` | 内部推理或规划 |
| `fetch` | 获取外部数据 |
| `other` | 其他（默认） |

自定义 kind MUST 以 `_` 开头。

### 8.3 工具状态（status）

| status | 说明 |
|--------|------|
| `pending` | 工具尚未开始运行（输入流式或等待批准） |
| `in_progress` | 工具正在运行 |
| `completed` | 工具成功完成 |
| `failed` | 工具失败 |

### 8.4 Upsert 语义

`tool_call_update` 是按 `toolCallId` 的 upsert：

- 省略字段 → 值不变
- `null` → 清除值
- 具体值 → 替换值
- `content` 和 `locations` 作为整个数组替换
- `content: []` 或 `content: null` → 清空

### 8.5 流式内容

工具执行时，Agent MAY 用 `tool_call_content_chunk` 流式发送内容：

```json
{
  "update": {
    "sessionUpdate": "tool_call_content_chunk",
    "toolCallId": "call_001",
    "content": {
      "type": "content",
      "content": {
        "type": "text",
        "text": "Found 3 configuration files..."
      }
    }
  }
}
```

- chunk **追加**到当前 content
- 后续 `tool_call_update` with `content` **替换**全部 content（包括 chunk 积累的）
- 再后续的 chunk 追加到新 content

### 8.6 工具调用内容类型

| content.type | 说明 |
|--------------|------|
| `content` | 标准 ContentBlock（text/image/resource 等） |
| `terminal` | 终端引用（见 §13） |
| `diff` | 文件差异（见下） |

### 8.7 Diff 内容

```json
{
  "type": "diff",
  "changes": [
    {
      "operation": "modify",
      "path": "/home/user/project/src/config.json",
      "fileType": "text",
      "mimeType": "application/json"
    }
  ],
  "patch": {
    "format": "git_patch",
    "text": "diff --git a/config.json b/config.json\n--- a/config.json\n+++ b/config.json\n@@ -1,3 +1,3 @@\n {\n-  \"debug\": false\n+  \"debug\": true\n }\n"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `changes` | ✅ | 结构化文件变更列表 |
| `changes[].operation` | ✅ | `add` / `delete` / `modify` / `move` / `copy` |
| `changes[].path` | ✅ | 操作后的绝对路径 |
| `changes[].oldPath` | move/copy 必填 | 操作前的绝对路径 |
| `changes[].fileType` | ❌ | `text` / `binary` / `directory` / `symlink` |
| `changes[].mimeType` | ❌ | 文件 MIME 类型 |
| `patch` | ❌ | 可渲染的补丁文本 |
| `patch.format` | ✅ | 补丁格式，ACP 定义了 `git_patch` |
| `patch.text` | ✅ | 补丁文本（`diff --git` 格式，路径 MUST 为绝对路径） |

`changes` 是权威的结构化变更。`patch` 是可选的渲染文本，SHOULD 与 changes 一致。Client MUST 处理 `patch` 省略的情况。

### 8.8 文件位置（locations）

```json
{
  "path": "/home/user/project/src/main.py",
  "line": 42
}
```

用于实现"跟随 Agent"功能，显示 Agent 正在访问的文件位置。

---

## 9. 权限请求

### 9.1 请求格式

Agent MAY 在执行操作前请求用户权限：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123",
    "title": "Approve file edit?",
    "description": "Allow the agent to edit src/main.rs?",
    "subject": {
      "type": "tool_call",
      "toolCall": {
        "toolCallId": "call_001"
      }
    },
    "options": [
      {
        "optionId": "allow-once",
        "name": "Allow once",
        "kind": "allow_once"
      },
      {
        "optionId": "allow-always",
        "name": "Allow always",
        "kind": "allow_always"
      },
      {
        "optionId": "reject-once",
        "name": "Reject",
        "kind": "reject_once"
      }
    ]
  }
}
```

### 9.2 Subject 类型

| subject.type | 说明 | 附加字段 |
|--------------|------|---------|
| `tool_call` | 关联工具调用 | `toolCall: { toolCallId }` |
| `command` | 关联命令 | `command`, `cwd`（必填）；`toolCallId`, `terminalId`（可选） |

`command` subject 示例：
```json
{
  "title": "Run the test suite?",
  "subject": {
    "type": "command",
    "command": "cargo test",
    "cwd": "/home/user/project",
    "toolCallId": "call_001",
    "terminalId": "term_001"
  }
}
```

### 9.3 权限选项（options）

| 字段 | 必填 | 说明 |
|------|------|------|
| `optionId` | ✅ | 唯一标识符 |
| `name` | ✅ | 人类可读标签 |
| `kind` | ✅ | UI 提示类型 |

| kind | 说明 |
|------|------|
| `allow_once` | 仅允许本次 |
| `allow_always` | 允许并记住选择 |
| `reject_once` | 仅拒绝本次 |
| `reject_always` | 拒绝并记住选择 |

### 9.4 Client 响应

```json
// 用户选择了某个选项
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "selected",
      "optionId": "allow-once"
    }
  }
}

// 活动工作被取消时
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "cancelled"
    }
  }
}
```

- Client MAY 根据用户设置自动允许或拒绝
- 当前活动工作被取消时，Client MUST 返回 `"cancelled"` outcome
- Agent 不理解的 outcome MUST NOT 视为批准

---

## 10. Agent Plan

### 10.1 创建计划

```json
{
  "update": {
    "sessionUpdate": "plan_update",
    "plan": {
      "type": "items",
      "planId": "plan-1",
      "entries": [
        {
          "content": "Analyze the existing codebase structure",
          "priority": "high",
          "status": "pending"
        },
        {
          "content": "Identify components that need refactoring",
          "priority": "high",
          "status": "pending"
        },
        {
          "content": "Create unit tests for critical functions",
          "priority": "medium",
          "status": "in_progress"
        }
      ]
    }
  }
}
```

### 10.2 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `plan.type` | ✅ | 计划内容类型，当前只有 `items` |
| `plan.planId` | ✅ | session 内唯一的计划 ID |
| `plan.entries[]` | ✅ | 计划条目列表 |

### 10.3 Plan Entry

| 字段 | 说明 | 可选值 |
|------|------|--------|
| `content` | 任务描述 | 任意字符串 |
| `priority` | 优先级 | `high` / `medium` / `low` |
| `status` | 状态 | `pending` / `in_progress` / `completed` |

### 10.4 更新语义

- 更新时 MUST 发送完整的 entries 列表（全量替换）
- Agent MAY 动态增删改计划条目
- 多个 plan 通过不同 `planId` 独立跟踪
- 自定义 plan.type MUST 以 `_` 开头

---

## 11. Slash 命令

### 11.1 声明命令

Agent 创建 session 后 MAY 推送可用命令：

```json
{
  "update": {
    "sessionUpdate": "available_commands_update",
    "availableCommands": [
      {
        "name": "web",
        "description": "Search the web for information",
        "input": {
          "type": "text",
          "hint": "query to search for"
        }
      },
      {
        "name": "test",
        "description": "Run tests for the current project"
      }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 命令名（如 "web", "test"） |
| `description` | ✅ | 命令描述 |
| `input` | ❌ | 输入规范，`type: "text"` + `hint` |

### 11.2 执行命令

命令作为普通用户消息发送，Agent 自行识别前缀：

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [
      { "type": "text", "text": "/web agent client protocol" }
    ]
  }
}
```

### 11.3 动态更新

Agent MAY 随时通过另一个 `available_commands_update` 通知更新命令列表。

---

## 12. 会话配置选项

### 12.1 初始状态

`session/new` 或 `session/resume` 响应 MAY 返回 `configOptions`：

```json
{
  "result": {
    "sessionId": "sess_abc123",
    "configOptions": [
      {
        "configId": "mode",
        "name": "Session Mode",
        "description": "Controls how the agent requests permission",
        "category": "mode",
        "type": "select",
        "currentValue": "ask",
        "options": [
          { "value": "ask", "name": "Ask", "description": "Request permission before changes" },
          { "value": "code", "name": "Code", "description": "Write and modify code with full tool access" }
        ]
      },
      {
        "configId": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "model-1",
        "options": [
          { "value": "model-1", "name": "Model 1", "description": "The fastest model" },
          { "value": "model-2", "name": "Model 2", "description": "The most powerful model" }
        ]
      },
      {
        "configId": "brave_mode",
        "name": "Brave Mode",
        "description": "Skip confirmation prompts",
        "type": "boolean",
        "currentValue": false
      }
    ]
  }
}
```

### 12.2 ConfigOption 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `configId` | ✅ | 唯一标识符 |
| `name` | ✅ | 人类可读标签 |
| `description` | ❌ | 描述 |
| `category` | ❌ | 语义类别（见下） |
| `type` | ✅ | `select` 或 `boolean` |
| `currentValue` | ✅ | 当前值（select 为 string，boolean 为 bool） |
| `options` | select 必填 | 可选值列表 |

### 12.3 类别（category）

| 类别 | 说明 |
|------|------|
| `mode` | 会话模式选择器 |
| `model` | 模型选择器 |
| `model_config` | 模型相关参数（上下文大小、速度/质量权衡） |
| `thought_level` | 思考/推理级别选择器 |

类别仅用于 UX，MUST NOT 影响正确性。Client MUST 优雅处理缺失或未知类别。

### 12.4 Client 设置配置

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "sess_abc123",
    "configId": "mode",
    "type": "id",
    "value": "code"
  }
}
```

- `type: "id"` 用于 select 选项，`value` 是 string
- `type: "boolean"` 用于 boolean 选项，`value` 是 boolean

响应返回**完整配置状态**（允许 Agent 反映依赖变更，如切换 model 影响可用 reasoning 选项）。

### 12.5 Agent 推送配置变更

```json
{
  "update": {
    "sessionUpdate": "config_option_update",
    "configOptions": [/* 完整配置状态 */]
  }
}
```

常见场景：规划阶段后切换模式、因 rate limit 回退到其他模型、基于上下文调整可用选项。

---

## 13. 终端（Terminal）

### 13.1 v2 方式：Display-only Terminals

v2 中终端是 Agent 拥有的，通过 `session/update` 通知报告状态：

**创建/更新终端状态**：
```json
{
  "update": {
    "sessionUpdate": "terminal_update",
    "terminalId": "term_001",
    "command": "cargo test",
    "cwd": "/home/user/project",
    "output": {
      "data": "cnVubmluZyB0ZXN0cw0K"
    },
    "exitStatus": {
      "exitCode": 0,
      "signal": null
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `terminalId` | session 内唯一，生命周期内稳定，MUST NOT 复用 |
| `command` | 运行的命令 |
| `cwd` | 命令工作目录（绝对路径） |
| `output.data` | base64 编码的字节快照（RFC 4648） |
| `exitStatus.exitCode` | 退出码 |
| `exitStatus.signal` | 终止信号（如 SIGTERM） |

`output` 是权威替换快照——替换之前存储的全部字节，Client MUST NOT 合并或拼接旧快照。

**流式输出**：
```json
{
  "update": {
    "sessionUpdate": "terminal_output_chunk",
    "terminalId": "term_001",
    "data": "cGFzc2VkDQo="
  }
}
```

每个 `data` 是独立的 base64 编码字节块，Client 解码后按顺序追加。chunk 边界可能拆分 UTF-8 码点或终端转义序列，解码器需保留解析器状态。

**终端引用（在 tool_call 中）**：
```json
{
  "type": "terminal",
  "terminalId": "term_001"
}
```

`terminal_update` 是 upsert 语义。引用和终端更新可能以任意顺序到达，Client 需为首次见到的 `terminalId` 保留状态。

### 13.2 v1 方式：Client-managed Terminals（向后兼容）

v1 中终端由 Client 管理，Agent 通过请求创建：

**terminal/create**：
```json
{
  "method": "terminal/create",
  "params": {
    "sessionId": "sess_abc123",
    "command": "npm",
    "args": ["test", "--coverage"],
    "env": [{ "name": "NODE_ENV", "value": "test" }],
    "cwd": "/home/user/project",
    "outputByteLimit": 1048576
  }
}
// 响应
{ "result": { "terminalId": "term_xyz789" } }
```

**terminal/output**：
```json
{
  "method": "terminal/output",
  "params": { "sessionId": "...", "terminalId": "term_xyz789" }
}
// 响应
{
  "result": {
    "output": "Running tests...\n✓ All tests passed\n",
    "truncated": false,
    "exitStatus": { "exitCode": 0, "signal": null }
  }
}
```

**terminal/wait_for_exit**：
```json
{
  "method": "terminal/wait_for_exit",
  "params": { "sessionId": "...", "terminalId": "term_xyz789" }
}
// 响应
{ "result": { "exitCode": 0, "signal": null } }
```

**terminal/kill**：终止命令但不释放 terminal ID，仍可用于 output/wait_for_exit。

**terminal/release**：终止命令（如仍在运行）并释放所有资源，terminal ID 变为无效。

**超时模式**：
1. `terminal/create` 创建
2. 启动计时器
3. 并发等待计时器到期 or `terminal/wait_for_exit`
4. 计时器先到 → `terminal/kill` → `terminal/output` 取输出 → `terminal/release`

---

## 14. 文件系统访问

### 14.1 能力声明

```json
{
  "clientCapabilities": {
    "fs": {
      "readTextFile": true,
      "writeTextFile": true
    }
  }
}
```

### 14.2 读取文件

```json
{
  "method": "fs/read_text_file",
  "params": {
    "sessionId": "sess_abc123",
    "path": "/home/user/project/src/main.py",
    "line": 10,
    "limit": 50
  }
}
// 响应
{
  "result": {
    "content": "def hello_world():\n    print('Hello, world!')\n"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `path` | ✅ | 绝对路径 |
| `line` | ❌ | 起始行号（1-based） |
| `limit` | ❌ | 最大行数 |

### 14.3 写入文件

```json
{
  "method": "fs/write_text_file",
  "params": {
    "sessionId": "sess_abc123",
    "path": "/home/user/project/config.json",
    "content": "{\n  \"debug\": true\n}"
  }
}
// 响应
{ "result": null }
```

Client MUST 在文件不存在时创建它。

---

## 15. 取消机制

### 15.1 session/cancel（通知）

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

行为：
- Client SHOULD 立即标记所有未完成的 tool_call 为 `cancelled`
- Client MUST 回应所有待处理的 `session/request_permission` 为 `"cancelled"` outcome
- Agent SHOULD 尽快停止所有 LLM 请求和工具调用
- Agent MUST 最终发送 idle `state_update`，stopReason 为 `"cancelled"`
- Agent MAY 在 cancel 后、idle 前发送更多 update（如工具结果）
- Client SHOULD 接受 cancel 后到达的 tool_call 更新

### 15.2 `$/cancel_request`（通用 JSON-RPC 取消）

```json
{
  "jsonrpc": "2.0",
  "method": "$/cancel_request",
  "params": {
    "id": 2
  }
}
```

通用取消机制，取消指定 id 的请求。接收方 MAY 取消，MUST 最终返回有效响应或 -32800 错误。

### 15.3 级联取消示例

```
1. session/prompt 进行中
2. Agent 发起多个并发权限请求 (id=2, id=3)
3. Client 发送 session/cancel
4. Agent 内部级联：对 id=2 和 id=3 发送 $/cancel_request
5. Client 确认每个取消（返回 -32800 错误）
6. Agent 发送 state_update: idle, stopReason: cancelled
```

---

## 16. 扩展机制

### 16.1 `_meta` 字段

所有协议类型都包含 `_meta` 字段（`{ [key: string]: unknown }`），可附加自定义信息。

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "...",
    "prompt": [...],
    "_meta": {
      "traceparent": "00-80e1afed08e019fc-7a085853722dc6d2-01",
      "zed.dev/debugMode": true
    }
  }
}
```

保留的 `_meta` 根级键（用于 W3C trace context）：
- `traceparent`
- `tracestate`
- `baggage`

**MUST NOT** 在规范类型的根级添加自定义字段——所有名称保留给未来协议版本。

### 16.2 扩展方法

以 `_` 开头的方法名保留给扩展：

```json
{
  "method": "_zed.dev/workspace/buffers",
  "params": { "language": "rust" }
}
```

- 扩展请求：含 `id`，期望响应
- 扩展通知：不含 `id`，单方向
- 不识别的扩展请求 → 返回 -32601 Method not found
- 不识别的扩展通知 → SHOULD 忽略

### 16.3 扩展能力声明

在 capabilities 的 `_meta` 中声明扩展：

```json
{
  "capabilities": {
    "session": { "load": {} },
    "_meta": {
      "zed.dev": {
        "workspace": true,
        "fileNotifications": true
      }
    }
  }
}
```

### 16.4 枚举/联合类型扩展规则

- `_` 前缀值 → 实现特定扩展
- 非 `_` 前缀的未知值 → 保留给未来 ACP 变体
- 扩展 MUST NOT 定义非 `_` 前缀的自定义值
- 实现 MUST NOT 将未知非 `_` 值视为自定义扩展
- 存储回放/代理转发时 SHOULD 保留未知值

---

## 17. 会话列表与删除

### 17.1 列出会话

```json
{
  "method": "session/list",
  "params": {
    "cwd": "/home/user/project",
    "cursor": "eyJwYWdlIjogMn0="
  }
}
// 响应
{
  "result": {
    "sessions": [
      {
        "sessionId": "sess_abc123",
        "cwd": "/home/user/project",
        "title": "Implement session list API",
        "updatedAt": "2025-10-29T14:22:15Z",
        "_meta": { "messageCount": 12, "hasErrors": false }
      }
    ],
    "nextCursor": "eyJwYWdlIjogM30="
  }
}
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `cwd` | ❌ | 按工作目录过滤（绝对路径） |
| `cursor` | ❌ | 分页游标（不透明） |

| 响应字段 | 说明 |
|---------|------|
| `sessions[]` | SessionInfo 数组 |
| `sessions[].sessionId` | 唯一标识 |
| `sessions[].cwd` | 工作目录 |
| `sessions[].title` | 标题（可选） |
| `sessions[].updatedAt` | RFC 3339 时间戳 |
| `nextCursor` | 有则表示还有更多结果 |

无匹配时返回空数组，不是 null。

### 17.2 会话元数据实时更新

```json
{
  "update": {
    "sessionUpdate": "session_info_update",
    "title": "Implement user authentication",
    "_meta": { "tags": ["feature", "auth"], "priority": "high" }
  }
}
```

所有字段可选，仅包含变更字段，`null` 清除字段。

### 17.3 删除会话（需 `session.delete` 能力）

```json
{
  "method": "session/delete",
  "params": { "sessionId": "sess_abc123" }
}
// 响应
{ "result": {} }
```

- 删除后不再出现在 `session/list` 结果中
- 删除不存在的 session SHOULD 静默成功
- 软删除还是硬删除由实现决定
- 删除活动 session 的行为由实现定义

---

## 18. Client 实现清单

### 18.1 Client → Agent 方法（Client 调用）

| 方法 | 类型 | 必须实现 | 说明 |
|------|------|---------|------|
| `initialize` | request | ✅ 必须 | 握手协商 |
| `auth/login` | request | 条件 | Agent 声明 authMethods 时 |
| `auth/logout` | request | 条件 | Agent 声明 authMethods 时 |
| `session/new` | request | ✅ 必须 | 创建会话 |
| `session/resume` | request | ✅ 必须 | 恢复会话 |
| `session/close` | request | ✅ 必须 | 关闭会话 |
| `session/prompt` | request | ✅ 必须 | 发送 prompt |
| `session/list` | request | ✅ 必须 | 列出会话 |
| `session/delete` | request | 条件 | Agent 声明 session.delete 时 |
| `session/set_config_option` | request | 可选 | 设置配置选项 |
| `session/cancel` | notification | ✅ 必须 | 取消活动工作 |

### 18.2 Agent → Client 方法（Client 实现 handler）

| 方法 | 类型 | 必须实现 | 说明 |
|------|------|---------|------|
| `session/update` | notification | ✅ 必须 | 接收所有 session 事件 |
| `session/request_permission` | request | ✅ 必须 | 权限请求 |
| `terminal/create` | request | v1 可选 | 创建终端 |
| `terminal/output` | request | v1 可选 | 获取终端输出 |
| `terminal/wait_for_exit` | request | v1 可选 | 等待终端退出 |
| `terminal/kill` | request | v1 可选 | 杀终端 |
| `terminal/release` | request | v1 可选 | 释放终端 |
| `fs/read_text_file` | request | 可选 | 读文件 |
| `fs/write_text_file` | request | 可选 | 写文件 |

### 18.3 session/update 事件类型汇总

| sessionUpdate | 说明 | 关键字段 |
|---------------|------|---------|
| `state_update` | 状态变更 | `state`, `stopReason` |
| `user_message` | 用户消息（完整） | `messageId`, `content` |
| `user_message_chunk` | 用户消息（追加） | `messageId`, `content` |
| `agent_message` | Agent 消息（完整） | `messageId`, `content` |
| `agent_message_chunk` | Agent 消息（追加） | `messageId`, `content` |
| `agent_thought` | Agent 思考（完整） | `messageId`, `content` |
| `agent_thought_chunk` | Agent 思考（追加） | `messageId`, `content` |
| `tool_call_update` | 工具调用更新 | `toolCallId`, `title`, `kind`, `status`, `content`, `locations` |
| `tool_call_content_chunk` | 工具内容追加 | `toolCallId`, `content` |
| `plan_update` | 计划更新 | `plan.type`, `plan.planId`, `plan.entries` |
| `usage_update` | 使用量更新 | `used`, `size`, `cost` |
| `session_info_update` | 会话元数据 | `title`, `updatedAt` |
| `available_commands_update` | 命令列表 | `availableCommands` |
| `config_option_update` | 配置选项 | `configOptions` |
| `terminal_update` | 终端状态 | `terminalId`, `command`, `cwd`, `output`, `exitStatus` |
| `terminal_output_chunk` | 终端输出追加 | `terminalId`, `data` |

---

## 19. 错误码参考

遵循 JSON-RPC 2.0 错误处理：

| 错误码 | 含义 |
|--------|------|
| `-32700` | Parse error（解析错误） |
| `-32600` | Invalid Request（无效请求） |
| `-32601` | Method not found（方法未找到） |
| `-32602` | Invalid params（无效参数） |
| `-32603` | Internal error（内部错误） |
| `-32800` | Request Cancelled（请求已取消） |

- 成功响应包含 `result` 字段
- 错误响应包含 `error` 对象（含 `code` 和 `message`）
- 通知永远不接收响应

---

## 附录：完整交互时序

```
Client                                          Agent
  |                                               |
  |--- initialize (protocolVersion, caps) ------->|
  |<-- initialize response (version, caps) -------|
  |                                               |
  |--- auth/login (methodId) -------------------> |  (如需认证)
  |<-- auth/login response -----------------------|
  |                                               |
  |--- session/new (cwd, mcpServers) -----------> |
  |<-- session/new response (sessionId, config) --|
  |                                               |
  |<-- session/update (available_commands) -------|  (可选)
  |<-- session/update (config_options) ----------|  (可选)
  |                                               |
  |--- session/prompt (prompt[]) ---------------> |
  |<-- session/prompt response ({}) --------------|
  |                                               |
  |<-- session/update (user_message) -------------|
  |<-- session/update (state_update: running) ---|
  |                                               |
  |<-- session/update (plan_update) -------------|  (可选)
  |<-- session/update (agent_message_chunk) -----|  (流式)
  |<-- session/update (agent_message_chunk) -----|
  |<-- session/update (tool_call_update) --------|
  |                                               |
  |<-- session/request_permission (id=5) --------|  (可选)
  |--- permission response (allow) ------------->|
  |                                               |
  |<-- session/update (tool_call_update: in_progress) |
  |<-- session/update (tool_call_content_chunk) -|
  |<-- session/update (tool_call_update: completed) |
  |                                               |
  |<-- session/update (usage_update) ------------|  (可选)
  |<-- session/update (agent_message_chunk) -----|
  |                                               |
  |<-- session/update (state_update: idle,       |
  |    stopReason: end_turn) --------------------|
  |                                               |
  |--- session/prompt (next message) ----------> |  (继续对话)
  |                                               |
  |--- session/cancel -------------------------> |  (可选取消)
  |<-- session/update (state_update: idle,       |
  |    stopReason: cancelled) ------------------|
  |                                               |
  |--- session/close (sessionId) --------------> |  (结束)
  |<-- session/close response -------------------|
```

---

## 参考链接

| 资源 | 地址 |
|------|------|
| ACP 官网 | https://agentclientprotocol.com/ |
| 协议仓库 | https://github.com/agentclientprotocol/agent-client-protocol |
| TS SDK | https://github.com/agentclientprotocol/typescript-sdk |
| TS SDK examples | `typescript-sdk/src/examples/` |
| JSON Schema (v2) | `schema/v2/schema.json` |
| JSON Schema (unstable) | `schema/v2/schema.unstable.json` |
| v1→v2 迁移指南 | `docs/protocol/v2/migration.mdx` |
| 参考实现（Obsidian） | https://github.com/RAIT-09/obsidian-agent-client |
