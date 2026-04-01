---
title: 第三章：工具系统设计
---

# 第三章：工具系统设计

> 理解 Claude Code 的工具抽象，掌握构建可扩展工具系统的方法。

## 一、概念解释

### 什么是 Tool？

Tool 是 AI Agent 可以调用的能力单元。每个工具：

1. **有明确的输入 Schema**：使用 Zod 定义，自动校验
2. **有清晰的输出格式**：结构化数据，可被 AI 理解
3. **有权限控制**：决定是否允许执行
4. **有 UI 渲染**：在终端中显示调用过程和结果

### 工具的核心职责

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool 接口                                 │
├─────────────────────────────────────────────────────────────────┤
│  生命周期                                                        │
│  ├── validateInput()      → 提前校验参数                         │
│  ├── checkPermissions()   → 工具级权限检查                       │
│  └── call()               → 执行并返回结果                       │
├─────────────────────────────────────────────────────────────────┤
│  能力标记                                                        │
│  ├── isEnabled()          → 是否启用 (feature gate)             │
│  ├── isConcurrencySafe()  → 能否并行执行                        │
│  ├── isReadOnly()         → 是否只读                            │
│  └── isDestructive()      → 是否破坏性操作                       │
├─────────────────────────────────────────────────────────────────┤
│  AI 面向                                                         │
│  ├── prompt()             → 给 LLM 的工具描述                    │
│  ├── description()        → 动态描述（根据输入变化）              │
│  └── inputSchema          → Zod Schema                          │
├─────────────────────────────────────────────────────────────────┤
│  UI 渲染                                                         │
│  ├── renderToolUseMessage()         → 输入显示                  │
│  ├── renderToolResultMessage()      → 输出显示                  │
│  └── renderToolUseProgressMessage() → 进度显示                  │
└─────────────────────────────────────────────────────────────────┘
```

### 工具类型

Claude Code 内置 40+ 工具，分为以下类别：

| 类别 | 工具示例 | 特点 |
|------|----------|------|
| **文件操作** | Read, Edit, Write | 需要路径权限 |
| **搜索发现** | Glob, Grep | 只读，可并行 |
| **执行** | Bash, PowerShell | 高风险，需要严格权限 |
| **网络** | WebFetch, WebSearch | 只读，可能需要网络权限 |
| **Agent** | AgentTool, Task 系列 | 子任务调度 |
| **交互** | AskUserQuestion | 需要用户交互 |
| **MCP** | MCPTool | 外部协议工具 |

## 二、源码分析

### Tool 类型定义

位置：`src/Tool.ts`

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  // ==================== 核心属性 ====================
  readonly name: string                    // 工具名称
  readonly inputSchema: Input              // Zod Schema
  readonly inputJSONSchema?: ToolInputJSONSchema  // JSON Schema（MCP 工具）
  readonly outputSchema?: z.ZodType<unknown>      // 输出 Schema（可选）

  // ==================== 别名与提示 ====================
  aliases?: string[]                       // 别名（重命名兼容）
  searchHint?: string                      // 搜索提示（ToolSearch 用）

  // ==================== 生命周期方法 ====================
  // 校验输入
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  // 权限检查
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // 执行工具
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>

  // ==================== 能力标记 ====================
  isEnabled(): boolean                     // 是否启用
  isConcurrencySafe(input: z.infer<Input>): boolean  // 能否并行
  isReadOnly(input: z.infer<Input>): boolean         // 是否只读
  isDestructive?(input: z.infer<Input>): boolean     // 是否破坏性

  // ==================== AI 面向 ====================
  prompt(options: {...}): Promise<string>  // 工具描述
  description(input: z.infer<Input>, options: {...}): Promise<string>  // 动态描述

  // ==================== UI 渲染 ====================
  renderToolUseMessage(input: Partial<z.infer<Input>>, options: {...}): React.ReactNode
  renderToolResultMessage?(content: Output, ...): React.ReactNode
  renderToolUseProgressMessage?(progressMessages: ProgressMessage<P>[], ...): React.ReactNode
  renderToolUseRejectedMessage?(input: z.infer<Input>, ...): React.ReactNode
  renderToolUseErrorMessage?(result: ..., ...): React.ReactNode

  // ==================== 其他 ====================
  maxResultSizeChars: number               // 结果大小限制
  userFacingName(input: Partial<z.infer<Input>> | undefined): string  // 用户可见名称
  getPath?(input: z.infer<Input>): string  // 获取操作路径
  interruptBehavior?(): 'cancel' | 'block' // 中断行为
  // ...
}
```

### buildTool 工厂函数

`buildTool` 为工具定义提供安全默认值：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,                   // 默认启用
  isConcurrencySafe: () => false,          // 默认不安全（保守策略）
  isReadOnly: () => false,                 // 默认可写
  isDestructive: () => false,              // 默认非破坏性
  checkPermissions: (input, _ctx) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),  // 默认允许
  toAutoClassifierInput: () => '',         // 默认跳过分类器
  userFacingName: () => '',                // 默认空名称
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,        // 默认使用工具名
    ...def,                                // 用户定义覆盖默认值
  }
}
```

**默认值设计原则**：
- **安全优先**：`isConcurrencySafe` 默认 `false`（宁可串行，不要冒险）
- **保守估计**：`isReadOnly` 默认 `false`（假定会修改）
- **权限下沉**：`checkPermissions` 默认允许（由通用权限系统处理）

### 工具注册

位置：`src/tools.ts`

```typescript
// 导入所有工具
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
// ... 其他工具

// 条件导入（feature gate）
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

// 获取所有工具
export function getTools(options: GetToolsOptions): Tools {
  const tools: Tool[] = [
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    AgentTool,
    // ...
  ]

  // 添加条件工具
  if (SleepTool) {
    tools.push(SleepTool)
  }

  // 添加 MCP 工具
  if (options.mcpTools) {
    tools.push(...options.mcpTools)
  }

  return tools
}
```

## 三、工具实现示例

### 示例 1：简单工具 - Glob

```typescript
// src/tools/GlobTool/GlobTool.ts
import { z } from 'zod'
import { buildTool, Tool } from '../../Tool.js'
import { glob } from 'fast-glob'

// 输入 Schema
const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files'),
  path: z.string().optional().describe('Directory to search in'),
})

// 输出类型
type Output = {
  files: string[]
  truncated: boolean
}

export const GlobTool: Tool<typeof inputSchema, Output> = buildTool({
  name: 'Glob',

  inputSchema,

  // 工具描述（给 AI 看）
  async prompt() {
    return `Find files matching a glob pattern.
Supports **, *, ? patterns.
Examples: "**/*.ts", "src/**/*.test.ts"`
  },

  // 动态描述（根据输入变化）
  async description(input) {
    return `Find files matching "${input.pattern}"`
  },

  // 能力标记
  isConcurrencySafe: () => true,   // 可以并行
  isReadOnly: () => true,          // 只读

  // 权限检查
  async checkPermissions(input, context) {
    // 检查路径权限
    const basePath = input.path || context.options.cwd
    // ... 权限检查逻辑
    return { behavior: 'allow', updatedInput: input }
  },

  // 执行
  async call(input, context) {
    const basePath = input.path || context.options.cwd
    const files = await glob(input.pattern, {
      cwd: basePath,
      absolute: true,
    })

    // 限制结果数量
    const maxResults = 1000
    const truncated = files.length > maxResults

    return {
      data: {
        files: files.slice(0, maxResults),
        truncated,
      },
    }
  },

  // 结果大小限制
  maxResultSizeChars: 50000,

  // UI 渲染
  renderToolUseMessage(input) {
    return `Glob: ${input.pattern}`
  },

  renderToolResultMessage(output) {
    if (output.files.length === 0) {
      return 'No files found'
    }
    return `${output.files.length} files found${output.truncated ? ' (truncated)' : ''}`
  },

  // 用户可见名称
  userFacingName: (input) => `Find ${input?.pattern || 'files'}`,
})
```

### 示例 2：复杂工具 - Bash

```typescript
// src/tools/BashTool/BashTool.ts
import { z } from 'zod'
import { buildTool, Tool } from '../../Tool.js'
import { spawn } from 'child_process'

const inputSchema = z.object({
  command: z.string().describe('The bash command to run'),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
  description: z.string().optional().describe('Description of what the command does'),
})

type Output = {
  stdout: string
  stderr: string
  exitCode: number
  interrupted: boolean
}

export const BashTool: Tool<typeof inputSchema, Output> = buildTool({
  name: 'Bash',

  inputSchema,

  async prompt() {
    return `Execute a bash command in a persistent shell session.
Commands run in the current working directory.
Use for: git operations, npm/node commands, file system operations.`
  },

  async description(input) {
    return input.description || input.command
  },

  // Bash 命令不能并行（可能有副作用）
  isConcurrencySafe: () => false,

  // Bash 命令可能修改文件
  isReadOnly: (input) => {
    // 简单检测：只读命令
    const readOnlyCommands = ['ls', 'cat', 'grep', 'find', 'git status', 'git diff']
    return readOnlyCommands.some(cmd => input.command.startsWith(cmd))
  },

  // 破坏性命令检测
  isDestructive: (input) => {
    const destructivePatterns = [/rm\s/, /git\s+push/, /npm\s+publish/]
    return destructivePatterns.some(p => p.test(input.command))
  },

  // 权限检查
  async checkPermissions(input, context) {
    // 检查是否在允许列表中
    const alwaysAllow = context.toolPermissionContext.alwaysAllowRules
    // ... 检查逻辑

    // 危险命令需要交互确认
    if (this.isDestructive?.(input)) {
      return {
        behavior: 'ask',
        message: `This command may have irreversible effects: ${input.command}`,
      }
    }

    return { behavior: 'allow', updatedInput: input }
  },

  async call(input, context, canUseTool, parentMessage, onProgress) {
    return new Promise((resolve, reject) => {
      const timeout = input.timeout || 120000  // 默认 2 分钟

      const proc = spawn('bash', ['-c', input.command], {
        cwd: context.options.cwd,
        signal: context.abortController.signal,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
        // 报告进度
        onProgress?.({
          toolUseID: parentMessage.message.content.find(b => b.type === 'tool_use')!.id,
          data: { type: 'bash_output', output: data.toString() },
        })
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
      }, timeout)

      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          data: {
            stdout,
            stderr,
            exitCode: code ?? 0,
            interrupted: code === null,
          },
        })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  },

  maxResultSizeChars: 100000,

  renderToolUseMessage(input) {
    return `$ ${input.command}`
  },

  renderToolResultMessage(output, progressMessages) {
    if (output.exitCode !== 0) {
      return `Exit ${output.exitCode}\n${output.stderr}`
    }
    return output.stdout || '(no output)'
  },

  renderToolUseProgressMessage(progressMessages) {
    const outputs = progressMessages
      .filter(m => m.data.type === 'bash_output')
      .map(m => m.data.output)
    return outputs.join('')
  },

  userFacingName: (input) => input?.description || input?.command?.slice(0, 30) || 'Bash',
})
```

### 示例 3：子 Agent 工具 - AgentTool

```typescript
// src/tools/AgentTool/AgentTool.ts
import { z } from 'zod'
import { buildTool, Tool } from '../../Tool.js'
import { query } from '../../query.js'

const inputSchema = z.object({
  prompt: z.string().describe('Task for the sub-agent'),
  agent_type: z.string().optional().describe('Type of agent to spawn'),
})

type Output = {
  result: string
  turns: number
}

export const AgentTool: Tool<typeof inputSchema, Output> = buildTool({
  name: 'Agent',

  inputSchema,

  async prompt() {
    return `Spawn a sub-agent to handle a complex subtask.
The sub-agent gets a fresh context and can use all available tools.
Use for: research tasks, code refactoring, multi-step operations.`
  },

  // 子 Agent 可以并行
  isConcurrencySafe: () => true,

  // 子 Agent 只读（不直接影响父 Agent 的文件系统）
  isReadOnly: () => true,

  async call(input, context) {
    // 创建子 Agent 上下文
    const subContext = createSubagentContext(context)

    // 准备消息
    const messages = [
      { role: 'user' as const, content: input.prompt },
    ]

    // 运行子 Agent
    let turns = 0
    let finalResult = ''

    for await (const event of query({
      messages,
      systemPrompt: context.renderedSystemPrompt!,
      toolUseContext: subContext,
      canUseTool: context.canUseTool,
      // ...
    })) {
      if (event.type === 'assistant' && !event.tool_use) {
        finalResult = event.message.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
      }
      turns++
    }

    return {
      data: {
        result: finalResult,
        turns,
      },
    }
  },

  maxResultSizeChars: 200000,

  renderToolUseMessage(input) {
    return `Agent: ${input.prompt.slice(0, 50)}...`
  },

  renderToolResultMessage(output) {
    return output.result
  },

  userFacingName: (input) => `Sub-agent: ${input?.prompt?.slice(0, 30) || 'task'}`,
})
```

## 四、从零实现工具系统

### 最简版本

```typescript
// minimal-tool-system.ts
import { z } from 'zod'

// 工具定义
type Tool<I extends z.ZodType, O> = {
  name: string
  schema: I
  execute: (input: z.infer<I>) => Promise<O>
  description: string
}

// 工具注册表
class ToolRegistry {
  private tools = new Map<string, Tool<any, any>>()

  register(tool: Tool<any, any>) {
    this.tools.set(tool.name, tool)
  }

  get(name: string) {
    return this.tools.get(name)
  }

  // 生成给 AI 的工具描述
  getToolDefinitions() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema),
    }))
  }
}

// 示例工具
const readTool: Tool<z.ZodObject<{ path: z.ZodString }>, string> = {
  name: 'read_file',
  schema: z.object({
    path: z.string(),
  }),
  description: 'Read a file',
  execute: async (input) => {
    const fs = await import('fs')
    return fs.readFile(input.path, 'utf-8')
  },
}

// 使用
const registry = new ToolRegistry()
registry.register(readTool)

// 执行工具
async function executeTool(name: string, input: unknown) {
  const tool = registry.get(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)

  // 校验输入
  const parsed = tool.schema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`Invalid input: ${parsed.error}`)
  }

  // 执行
  return tool.execute(parsed.data)
}
```

### 增强版本：添加权限

```typescript
// tool-system-with-permissions.ts
import { z } from 'zod'

type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: boolean; ask: true; message: string }

type Tool<I extends z.ZodType, O> = {
  name: string
  schema: I
  description: string
  execute: (input: z.infer<I>, context: Context) => Promise<O>
  checkPermissions?: (input: z.infer<I>, context: Context) => Promise<PermissionResult>
  isReadOnly?: boolean
  isDestructive?: boolean
}

type Context = {
  cwd: string
  userId: string
  // ...
}

class ToolExecutor {
  private tools = new Map<string, Tool<any, any>>()

  register(tool: Tool<any, any>) {
    this.tools.set(tool.name, tool)
  }

  async execute(
    name: string,
    input: unknown,
    context: Context,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` }
    }

    // 1. 校验输入
    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: `Invalid input: ${parsed.error.message}` }
    }

    // 2. 权限检查
    if (tool.checkPermissions) {
      const permResult = await tool.checkPermissions(parsed.data, context)

      if (!permResult.allowed) {
        return { success: false, error: permResult.reason }
      }

      if (permResult.ask) {
        // 交互式确认
        const confirmed = await askUser(permResult.message)
        if (!confirmed) {
          return { success: false, error: 'User denied permission' }
        }
      }
    }

    // 3. 执行
    try {
      const result = await tool.execute(parsed.data, context)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
}

// 示例：带权限的工具
const deleteTool: Tool<z.ZodObject<{ path: z.ZodString }>, void> = {
  name: 'delete_file',
  schema: z.object({ path: z.string() }),
  description: 'Delete a file',
  isReadOnly: false,
  isDestructive: true,

  checkPermissions: async (input, context) => {
    // 检查是否在允许的目录
    if (!input.path.startsWith(context.cwd)) {
      return { allowed: false, reason: 'Can only delete files in working directory' }
    }

    // 破坏性操作需要确认
    return {
      allowed: true,
      ask: true,
      message: `Are you sure you want to delete ${input.path}?`,
    }
  },

  execute: async (input) => {
    const fs = await import('fs/promises')
    await fs.unlink(input.path)
  },
}
```

### 完整版本：并行执行

```typescript
// tool-system-with-parallel.ts
import { z } from 'zod'
import PQueue from 'p-queue'

type Tool<I extends z.ZodType = any, O = any> = {
  name: string
  schema: I
  description: string
  execute: (input: z.infer<I>, context: ToolContext) => Promise<O>
  isConcurrencySafe?: (input: z.infer<I>) => boolean
  // ...
}

type ToolContext = {
  cwd: string
  signal: AbortSignal
  onProgress?: (progress: unknown) => void
}

type ToolCall = {
  id: string
  name: string
  input: unknown
}

type ToolResult = {
  tool_use_id: string
  content: string
  is_error?: boolean
}

class ParallelToolExecutor {
  private tools = new Map<string, Tool>()
  private queue = new PQueue({ concurrency: 10 })

  register(tool: Tool) {
    this.tools.set(tool.name, tool)
  }

  async executeBatch(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
    // 分组：并发安全 vs 串行
    const safeCalls: ToolCall[] = []
    const serialCalls: ToolCall[] = []

    for (const call of calls) {
      const tool = this.tools.get(call.name)
      if (!tool) {
        safeCalls.push(call)  // 未知的当作安全（会报错）
        continue
      }

      const parsed = tool.schema.safeParse(call.input)
      if (!parsed.success) {
        safeCalls.push(call)  // 无效的当作安全（会报错）
        continue
      }

      const isSafe = tool.isConcurrencySafe?.(parsed.data) ?? false
      if (isSafe) {
        safeCalls.push(call)
      } else {
        serialCalls.push(call)
      }
    }

    const results: ToolResult[] = []

    // 并发安全工具并行执行
    const safeResults = await Promise.all(
      safeCalls.map(call => this.executeOne(call, context)),
    )
    results.push(...safeResults)

    // 串行工具逐个执行
    for (const call of serialCalls) {
      if (context.signal.aborted) break
      const result = await this.executeOne(call, context)
      results.push(result)
    }

    return results
  }

  private async executeOne(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name)

    if (!tool) {
      return {
        tool_use_id: call.id,
        content: `Error: Unknown tool ${call.name}`,
        is_error: true,
      }
    }

    const parsed = tool.schema.safeParse(call.input)
    if (!parsed.success) {
      return {
        tool_use_id: call.id,
        content: `Error: Invalid input - ${parsed.error.message}`,
        is_error: true,
      }
    }

    try {
      const result = await this.queue.add(
        () => tool.execute(parsed.data, context),
        { signal: context.signal },
      )

      return {
        tool_use_id: call.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      }
    } catch (error) {
      if (context.signal.aborted) {
        return {
          tool_use_id: call.id,
          content: 'Tool execution was interrupted',
          is_error: true,
        }
      }
      return {
        tool_use_id: call.id,
        content: `Error: ${error}`,
        is_error: true,
      }
    }
  }
}

// 使用示例
async function main() {
  const executor = new ParallelToolExecutor()

  // 注册工具
  executor.register({
    name: 'read_file',
    schema: z.object({ path: z.string() }),
    description: 'Read a file',
    isConcurrencySafe: () => true,
    execute: async (input) => {
      const fs = await import('fs/promises')
      return fs.readFile(input.path, 'utf-8')
    },
  })

  executor.register({
    name: 'write_file',
    schema: z.object({ path: z.string(), content: z.string() }),
    description: 'Write a file',
    isConcurrencySafe: () => false,  // 写文件不能并行
    execute: async (input) => {
      const fs = await import('fs/promises')
      await fs.writeFile(input.path, input.content)
      return 'File written successfully'
    },
  })

  // 批量执行
  const controller = new AbortController()
  const results = await executor.executeBatch(
    [
      { id: '1', name: 'read_file', input: { path: '/tmp/a.txt' } },
      { id: '2', name: 'read_file', input: { path: '/tmp/b.txt' } },
      { id: '3', name: 'write_file', input: { path: '/tmp/c.txt', content: 'hello' } },
    ],
    { cwd: '/tmp', signal: controller.signal },
  )

  console.log(results)
}
```

## 五、关键设计决策

### 1. 为什么用 Zod Schema？

```typescript
// 好处 1: 运行时校验
const parsed = tool.schema.safeParse(input)
if (!parsed.success) {
  return { error: parsed.error.message }
}

// 好处 2: 类型推导
type Input = z.infer<typeof tool.schema>  // 自动推导输入类型

// 好处 3: JSON Schema 转换
const jsonSchema = zodToJsonSchema(tool.schema)  // 给 API 用
```

### 2. 为什么区分并发安全与串行？

```typescript
// 并发安全的可以并行
const safeCalls = calls.filter(c => tool.isConcurrencySafe(c.input))
await Promise.all(safeCalls.map(execute))

// 不安全的必须串行
for (const call of serialCalls) {
  await execute(call)
}
```

**原因**：
- 读操作可以并行（无竞争）
- 写操作必须串行（避免冲突）
- Shell 命令必须串行（环境变量、工作目录）

### 3. 为什么用 buildTool 工厂？

```typescript
// 不好的方式：手动填写所有字段
const myTool: Tool = {
  name: 'my_tool',
  schema,
  isEnabled: () => true,        // 样板代码
  isConcurrencySafe: () => false, // 样板代码
  isReadOnly: () => false,       // 样板代码
  // ...
}

// 好的方式：只写关键部分
const myTool = buildTool({
  name: 'my_tool',
  schema,
  // 其他字段使用安全默认值
  isConcurrencySafe: () => true,  // 只覆盖需要的
})
```

## 六、最佳实践

### 1. 工具描述要精确

```typescript
// 不好的描述
async prompt() {
  return 'A tool for files'
}

// 好的描述
async prompt() {
  return `Read a file from the local filesystem.
Supports text files, PDFs, and images.
The path must be within the allowed directories.
Maximum file size: 10MB`
}
```

### 2. 输入校验要严格

```typescript
const inputSchema = z.object({
  path: z.string()
    .min(1, 'Path cannot be empty')
    .max(4096, 'Path too long')
    .refine(
      p => !p.includes('..'),
      'Path cannot contain ".."'
    ),

  limit: z.number()
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(1000, 'Limit cannot exceed 1000')
    .optional(),
})
```

### 3. 权限检查要分层

```typescript
async checkPermissions(input, context) {
  // 第一层：路径检查
  if (!isWithinAllowedDirectory(input.path, context)) {
    return { behavior: 'deny', reason: 'Path outside allowed directory' }
  }

  // 第二层：敏感路径检查
  if (isSensitivePath(input.path)) {
    return {
      behavior: 'ask',
      message: `This file may contain sensitive data. Continue?`,
    }
  }

  // 第三层：破坏性检查
  if (this.isDestructive?.(input)) {
    return {
      behavior: 'ask',
      message: `This operation cannot be undone. Continue?`,
    }
  }

  return { behavior: 'allow' }
}
```

### 4. 进度报告要实时

```typescript
async call(input, context, canUseTool, parentMessage, onProgress) {
  // 长时间操作要报告进度
  for (const chunk of processLargeFile(input.path)) {
    onProgress?.({
      toolUseID: '...',
      data: { type: 'progress', processed: chunk.count },
    })
  }

  return { data: result }
}
```

---

下一章：[04-permission-system.md](./04-permission-system.md) - 深入权限系统的设计
