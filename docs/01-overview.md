---
title: 第一章：总体架构概览
---

# 第一章：总体架构概览

> 理解 Claude Code 的整体设计，建立宏观认知。

## 一、Claude Code 是什么

Claude Code 是 Anthropic 官方推出的 AI 编程助手 CLI 工具，它：

1. **是一个 Agent**：不是简单的问答工具，而是能自主规划、执行、迭代的智能体
2. **是一个 CLI**：在终端中运行，与文件系统、Git、命令行工具深度集成
3. **是一个平台**：支持 MCP 扩展、Skills、插件系统

## 二、技术栈一览

```
┌─────────────────────────────────────────────────────────┐
│  运行时与编译                                             │
│  ───────────                                             │
│  Bun (开发/编译) → Node.js >= 18 (生产运行)              │
│  feature() 编译时死代码消除                               │
├─────────────────────────────────────────────────────────┤
│  语言与框架                                               │
│  ───────────                                             │
│  TypeScript / TSX                                        │
│  React + Ink (终端 UI)                                   │
│  Zod (Schema 验证)                                        │
├─────────────────────────────────────────────────────────┤
│  状态管理                                                 │
│  ───────────                                             │
│  React Context + Immer-style updates                    │
│  AsyncGenerator 流式输出                                 │
├─────────────────────────────────────────────────────────┤
│  API 通信                                                 │
│  ───────────                                             │
│  Anthropic Messages API (SSE 流式)                       │
│  支持 Bedrock / GCP Vertex AI                           │
├─────────────────────────────────────────────────────────┤
│  持久化                                                   │
│  ───────────                                             │
│  JSONL append-only log                                   │
│  ~/.claude/projects/<hash>/sessions/                    │
└─────────────────────────────────────────────────────────┘
```

## 三、架构总览图

```
┌─────────────────────────────────────────────────────────────────────┐
│                           用户层                                     │
│  终端输入 → REPL → 流式输出 → 渲染 UI                                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ENTRY LAYER                                  │
│                                                                      │
│  main.tsx                                                            │
│    ├── 参数解析 (commander)                                          │
│    ├── 初始化 (配置、认证、MCP)                                       │
│    └── 启动 REPL 或 SDK 模式                                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       QUERY ENGINE                                   │
│                                                                      │
│  QueryEngine.ts                                                      │
│    ├── submitMessage(prompt) → AsyncGenerator<SDKMessage>           │
│    ├── fetchSystemPromptParts() → 组装系统提示词                      │
│    ├── processUserInput() → 处理 /commands                          │
│    └── query() → 主 Agent 循环                                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
┌──────────────────┐ ┌─────────────────┐ ┌──────────────────┐
│   TOOL SYSTEM    │ │  SERVICE LAYER  │ │   STATE LAYER    │
│                  │ │                 │ │                  │
│ 40+ 内置工具      │ │ api/            │ │ AppState Store   │
│  ├─ BashTool     │ │  API 客户端     │ │  ├─ permissions  │
│  ├─ FileRead     │ │ compact/        │ │  ├─ fileHistory  │
│  ├─ FileEdit     │ │  自动压缩       │ │  ├─ agents       │
│  ├─ Glob/Grep    │ │ mcp/            │ │  └─ settings     │
│  ├─ AgentTool    │ │  MCP 协议       │ │                  │
│  └─ MCPTool      │ │ analytics/      │ │ React Context    │
│                  │ │  遥测           │ │  └─ useAppState  │
└──────────────────┘ └─────────────────┘ └──────────────────┘
              │                │
              ▼                ▼
┌──────────────────┐ ┌─────────────────┐
│   TASK SYSTEM    │ │   BRIDGE LAYER  │
│                  │ │                 │
│ Task 类型:       │ │ bridgeMain.ts   │
│  ├─ local_bash   │ │  会话管理       │
│  ├─ local_agent  │ │ bridgeApi.ts    │
│  ├─ remote_agent │ │  HTTP 客户端    │
│  └─ dream        │ │  远程连接       │
└──────────────────┘ └─────────────────┘
```

## 四、核心文件职责

### 入口层

| 文件 | 行数 | 职责 |
|------|------|------|
| `main.tsx` | 4,683 | CLI 启动、参数解析、初始化、REPL 启动 |
| `entrypoints/cli.tsx` | ~200 | CLI 入口点定义 |
| `entrypoints/sdk/` | ~300 | Agent SDK 入口 |

### 核心层

| 文件 | 行数 | 职责 |
|------|------|------|
| `QueryEngine.ts` | 1,295 | SDK/headless 查询生命周期引擎 |
| `query.ts` | 1,729 | 主 Agent 循环实现 |
| `Tool.ts` | 792 | 工具接口定义与工厂函数 |
| `tools.ts` | 389 | 工具注册表 |
| `commands.ts` | 754 | 斜杠命令定义 |

### 服务层

| 目录 | 职责 |
|------|------|
| `services/api/` | Claude API 客户端、流式调用、错误处理 |
| `services/compact/` | 上下文压缩（autoCompact、snipCompact） |
| `services/mcp/` | MCP 连接管理、认证、工具注册 |
| `services/analytics/` | 遥测、GrowthBook 特性开关 |
| `services/tools/` | 工具执行引擎（并行执行、编排） |

### 状态层

| 文件 | 职责 |
|------|------|
| `state/AppStateStore.ts` | 应用状态定义 |
| `state/AppState.tsx` | React Provider + hooks |

## 五、数据流总览

### 单次 Query 生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户输入                                  │
│  "帮我修复 src/index.ts 的类型错误"                              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    processUserInput()                           │
│  - 解析斜杠命令                                                  │
│  - 构建 UserMessage                                             │
│  - 处理附件                                                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                 fetchSystemPromptParts()                        │
│  - 加载 CLAUDE.md                                               │
│  - 组装工具描述                                                  │
│  - 添加权限规则                                                  │
│  - 注入 Memory                                                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    recordTranscript()                           │
│  - 持久化用户消息到 JSONL                                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                 normalizeMessagesForAPI()                       │
│  - 检查 token 数量                                               │
│  - 触发压缩（如超限）                                            │
│  - 格式化为 API 格式                                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Claude API 调用                              │
│  POST /v1/messages                                              │
│  - model: claude-sonnet-4.6                                     │
│  - system: [系统提示词]                                          │
│  - messages: [对话历史]                                          │
│  - tools: [工具定义]                                             │
│  - stream: true                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      流式响应处理                                │
│                                                                 │
│  message_start                                                  │
│      ↓                                                          │
│  content_block_start (type: text)                               │
│      ↓                                                          │
│  content_block_delta (text: "我来帮你...")                       │
│      ↓     ↓     ↓                                              │
│  ┌─────────────────────────────────┐                            │
│  │ yield SDKMessage { type: text } │ → UI 渲染                  │
│  └─────────────────────────────────┘                            │
│      ↓                                                          │
│  content_block_stop                                             │
│      ↓                                                          │
│  content_block_start (type: tool_use, name: FileRead)           │
│      ↓                                                          │
│  content_block_delta (input: { file_path: ... })                │
│      ↓                                                          │
│  content_block_stop                                             │
│      ↓                                                          │
│  message_stop (stop_reason: "tool_use")                         │
│                                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   StreamingToolExecutor                         │
│                                                                 │
│  1. 收集所有 tool_use blocks                                     │
│  2. 分区：并发安全 vs 串行                                       │
│  3. 对每个工具：                                                 │
│     ├── canUseTool() → 权限检查                                 │
│     │   ├── PreToolUse Hooks                                    │
│     │   ├── Permission Rules                                    │
│     │   └── Interactive Prompt (如需要)                         │
│     ├── tool.call() → 执行工具                                  │
│     └── append tool_result                                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      循环判断                                    │
│                                                                 │
│  if (stop_reason === "tool_use") {                              │
│    → 继续调用 API                                                │
│  } else {                                                       │
│    → 结束，yield 最终结果                                        │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

## 六、设计原则

### 1. 流式优先 (Streaming First)

整个系统基于 `AsyncGenerator` 构建，从 API 到 UI 全链路流式：

```typescript
// 源码示例：QueryEngine.ts
async function* submitMessage(prompt: string): AsyncGenerator<SDKMessage> {
  // 流式 yield 每个消息块
  for await (const event of streamEvents) {
    if (event.type === 'content_block_delta') {
      yield { type: 'text', content: event.delta.text }
    }
  }
}
```

### 2. 工具抽象 (Tool Abstraction)

所有能力通过统一的 `Tool` 接口暴露：

```typescript
// 源码示例：Tool.ts
type Tool<Input, Output, Progress> = {
  name: string
  inputSchema: z.ZodSchema<Input>
  call(input: Input, ctx: ToolUseContext): Promise<Output>
  prompt(): string  // 给 AI 的描述
  isConcurrencySafe(): boolean
  isReadOnly(): boolean
  // ...
}
```

### 3. 权限分离 (Permission Separation)

每个工具调用都经过权限检查，支持多级覆盖：

```
Hook → Rule → Prompt → Tool-specific check
```

### 4. 上下文管理 (Context Management)

自动压缩 + 手动控制：

```typescript
// 自动压缩
if (tokenCount > threshold) {
  await autoCompact(messages)
}

// 手动压缩
/compact
```

### 5. 持久化优先 (Persistence First)

用户消息阻塞写入，确保崩溃恢复：

```typescript
// 用户消息：阻塞写入
await recordTranscript(userMessage)

// 助手消息：异步写入
recordTranscript(assistantMessage) // 不 await
```

## 七、与普通 Chat 的区别

| 维度 | 普通 Chat | Claude Code (Agent) |
|------|-----------|---------------------|
| **交互模式** | 一次问答 | 多轮自主迭代 |
| **工具能力** | 无或有限 | 40+ 工具，可扩展 |
| **权限控制** | 无 | 多级权限系统 |
| **上下文** | 固定窗口 | 自动压缩 + 手动控制 |
| **持久化** | 通常无 | JSONL 会话日志 |
| **子任务** | 无 | 子 Agent 隔离执行 |
| **可扩展** | 插件系统 | MCP 协议 + Skills |

## 八、源码阅读建议

### 推荐阅读顺序

```
1. main.tsx (入口)
   ↓
2. QueryEngine.ts (查询引擎)
   ↓
3. query.ts (核心循环)
   ↓
4. Tool.ts (工具接口)
   ↓
5. tools/ 目录 (具体工具实现)
   ↓
6. services/ 目录 (服务层)
```

### 调试技巧

```bash
# 设置调试环境变量
export DEBUG=1
export OTEL_LOG_TOOL_DETAILS=1  # 记录完整工具输入

# 查看完整系统提示词
export DUMP_SYSTEM_PROMPT=1

# 禁用遥测
export CLAUDE_CODE_DISABLE_TELEMETRY=1
```

---

下一章：[02-core-loop.md](./02-core-loop.md) - 深入 Agent 循环的实现细节
