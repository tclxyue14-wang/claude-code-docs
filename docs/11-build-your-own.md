---
title: 第十一章：实战——构建自己的 AI CLI
---

# 第十一章：实战——构建自己的 AI CLI

> 综合前面所学，从零构建一个功能完整的 AI CLI 工具。

## 一、项目规划

### 功能需求

我们要构建一个具备以下功能的 AI CLI：

1. **核心 Agent 循环**：调用 API、执行工具、迭代
2. **工具系统**：文件操作、搜索、Shell 命令
3. **权限系统**：工具调用授权
4. **上下文管理**：自动压缩
5. **会话持久化**：保存和恢复会话
6. **终端 UI**：美观的命令行界面

### 技术选型

```
┌─────────────────────────────────────────────────────────────────┐
│  运行时    │  Node.js >= 18                                    │
│  语言      │  TypeScript                                       │
│  LLM API   │  @anthropic-ai/sdk                                │
│  终端 UI   │  ink + react                                      │
│  CLI 框架  │  commander                                        │
│  Schema    │  zod                                              │
│  持久化    │  JSONL                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 目录结构

```
my-ai-cli/
├── src/
│   ├── index.ts              # 入口
│   ├── agent/
│   │   ├── loop.ts           # Agent 循环
│   │   └── query.ts          # 查询处理
│   ├── tools/
│   │   ├── index.ts          # 工具注册
│   │   ├── read.ts           # 文件读取
│   │   ├── write.ts          # 文件写入
│   │   ├── bash.ts           # Shell 命令
│   │   └── search.ts         # 搜索工具
│   ├── permissions/
│   │   ├── index.ts          # 权限管理
│   │   └── rules.ts          # 权限规则
│   ├── context/
│   │   ├── manager.ts        # 上下文管理
│   │   └── compact.ts        # 压缩逻辑
│   ├── storage/
│   │   └── session.ts        # 会话持久化
│   ├── ui/
│   │   ├── repl.tsx          # REPL 组件
│   │   └── components/       # UI 组件
│   └── types/
│       └── index.ts          # 类型定义
├── package.json
├── tsconfig.json
└── README.md
```

## 二、完整实现

### 1. 类型定义

```typescript
// src/types/index.ts
import { z } from 'zod'

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage

export type UserMessage = {
  role: 'user'
  content: string
  timestamp: number
}

export type AssistantMessage = {
  role: 'assistant'
  content: string | ContentBlock[]
  timestamp: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export type ToolUseMessage = {
  role: 'tool_use'
  toolUseId: string
  toolName: string
  input: unknown
}

export type ToolResultMessage = {
  role: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

export type Tool<Input extends z.ZodType = z.ZodType, Output = unknown> = {
  name: string
  description: string
  inputSchema: Input
  execute: (input: z.infer<Input>, context: ToolContext) => Promise<Output>
  isConcurrencySafe?: (input: z.infer<Input>) => boolean
  isReadOnly?: (input: z.infer<Input>) => boolean
}

export type ToolContext = {
  cwd: string
  signal: AbortSignal
  onProgress?: (message: string) => void
}

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: boolean; ask: true; message: string }
```

### 2. Agent 循环

```typescript
// src/agent/loop.ts
import Anthropic from '@anthropic-ai/sdk'
import { Message, Tool, ToolContext } from '../types'
import { executeTools } from '../tools'
import { checkPermission } from '../permissions'
import { manageContext } from '../context'

const client = new Anthropic()

export async function* agentLoop(
  messages: Message[],
  tools: Tool[],
  context: ToolContext,
): AsyncGenerator<Message> {
  let currentMessages = [...messages]

  while (true) {
    // 1. 上下文管理
    currentMessages = await manageContext(currentMessages)

    // 2. 调用 API
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: currentMessages.map(formatMessage),
      tools: tools.map(formatTool),
    })

    // 3. 提取内容
    const assistantMessage: Message = {
      role: 'assistant',
      content: response.content,
      timestamp: Date.now(),
    }
    yield assistantMessage

    // 4. 检查工具调用
    const toolCalls = response.content.filter(
      block => block.type === 'tool_use'
    )

    if (toolCalls.length === 0) {
      // 没有工具调用，结束
      return
    }

    // 5. 权限检查
    const toolResults: Message[] = []

    for (const call of toolCalls) {
      const tool = tools.find(t => t.name === call.name)
      if (!tool) {
        toolResults.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: `Error: Unknown tool ${call.name}`,
          isError: true,
        })
        continue
      }

      const permResult = await checkPermission(tool, call.input)
      if (!permResult.allowed) {
        toolResults.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: permResult.reason || 'Permission denied',
          isError: true,
        })
        continue
      }

      // 6. 执行工具
      try {
        const result = await tool.execute(call.input, context)
        toolResults.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: JSON.stringify(result),
        })
      } catch (error) {
        toolResults.push({
          role: 'tool_result',
          toolUseId: call.id,
          content: `Error: ${error}`,
          isError: true,
        })
      }
    }

    // 7. Yield 工具结果
    for (const result of toolResults) {
      yield result
    }

    // 8. 更新消息，继续循环
    currentMessages = [...currentMessages, assistantMessage, ...toolResults]
  }
}

function formatMessage(message: Message): Anthropic.MessageParam {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content }
    case 'assistant':
      if (typeof message.content === 'string') {
        return { role: 'assistant', content: message.content }
      }
      return { role: 'assistant', content: message.content }
    case 'tool_result':
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolUseId,
          content: message.content,
          is_error: message.isError,
        }],
      }
    default:
      return { role: 'user', content: JSON.stringify(message) }
  }
}

function formatTool(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema) as any,
  }
}
```

### 3. 工具系统

```typescript
// src/tools/index.ts
import { z } from 'zod'
import { Tool } from '../types'
import { readTool } from './read'
import { writeTool } from './write'
import { bashTool } from './bash'
import { searchTool } from './search'

export const allTools: Tool[] = [
  readTool,
  writeTool,
  bashTool,
  searchTool,
]

// src/tools/read.ts
import { z } from 'zod'
import { Tool } from '../types'
import fs from 'fs/promises'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to read'),
})

export const readTool: Tool<typeof inputSchema, string> = {
  name: 'Read',
  description: 'Read the contents of a file',
  inputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,

  async execute(input, context) {
    const content = await fs.readFile(input.file_path, 'utf-8')
    return content
  },
}

// src/tools/bash.ts
import { z } from 'zod'
import { Tool } from '../types'
import { spawn } from 'child_process'

const inputSchema = z.object({
  command: z.string().describe('The bash command to run'),
})

export const bashTool: Tool<typeof inputSchema, { stdout: string; stderr: string }> = {
  name: 'Bash',
  description: 'Execute a bash command',
  inputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: (input) => {
    const readOnlyCommands = ['ls', 'cat', 'grep', 'find', 'git status']
    return readOnlyCommands.some(cmd => input.command.startsWith(cmd))
  },

  async execute(input, context) {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', input.command], {
        cwd: context.cwd,
        signal: context.signal,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', data => { stdout += data })
      proc.stderr.on('data', data => { stderr += data })

      proc.on('close', code => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`))
        }
      })

      proc.on('error', reject)
    })
  },
}
```

### 4. 权限系统

```typescript
// src/permissions/index.ts
import { Tool, PermissionResult } from '../types'

type PermissionRule = {
  pattern: string
  behavior: 'allow' | 'deny' | 'ask'
}

const rules: PermissionRule[] = []

export function addRule(pattern: string, behavior: 'allow' | 'deny' | 'ask') {
  rules.push({ pattern, behavior })
}

export async function checkPermission(
  tool: Tool,
  input: unknown,
): Promise<PermissionResult> {
  // 检查规则
  for (const rule of rules) {
    if (matchPattern(rule.pattern, tool.name, input)) {
      if (rule.behavior === 'allow') {
        return { allowed: true }
      }
      if (rule.behavior === 'deny') {
        return { allowed: false, reason: `Denied by rule: ${rule.pattern}` }
      }
      if (rule.behavior === 'ask') {
        return {
          allowed: false,
          ask: true,
          message: `Tool ${tool.name} requires permission`,
        }
      }
    }
  }

  // 默认询问
  return {
    allowed: false,
    ask: true,
    message: `Allow ${tool.name}?`,
  }
}

function matchPattern(pattern: string, toolName: string, input: unknown): boolean {
  if (pattern === toolName) return true

  // Bash(git *) 模式
  const match = pattern.match(/^(\w+)\((.+)\)$/)
  if (match && match[1] === toolName) {
    if (toolName === 'Bash' && typeof input === 'object') {
      const command = (input as any).command || ''
      return minimatch(command, match[2])
    }
  }

  return false
}
```

### 5. 上下文管理

```typescript
// src/context/manager.ts
import { Message } from '../types'

const MAX_TOKENS = 180000

export async function manageContext(messages: Message[]): Promise<Message[]> {
  const tokenCount = estimateTokens(messages)

  if (tokenCount <= MAX_TOKENS) {
    return messages
  }

  // 需要压缩
  return compact(messages)
}

function estimateTokens(messages: Message[]): number {
  const text = JSON.stringify(messages)
  return Math.ceil(text.length / 4)
}

async function compact(messages: Message[]): Promise<Message[]> {
  if (messages.length <= 10) {
    return messages
  }

  // 保留最近 10 条消息
  const recent = messages.slice(-10)
  const old = messages.slice(0, -10)

  // 生成摘要
  const summary = await generateSummary(old)

  return [
    {
      role: 'user',
      content: `[Previous conversation summary: ${summary}]`,
      timestamp: Date.now(),
    },
    ...recent,
  ]
}

async function generateSummary(messages: Message[]): Promise<string> {
  // 简化：返回消息数量
  // 实际应该调用 API 生成摘要
  return `Summary of ${messages.length} messages`
}
```

### 6. 会话持久化

```typescript
// src/storage/session.ts
import fs from 'fs/promises'
import path from 'path'
import { Message } from '../types'

const SESSION_DIR = path.join(process.env.HOME!, '.my-ai-cli', 'sessions')

export class SessionManager {
  private sessionId: string
  private sessionFile: string

  constructor(sessionId?: string) {
    this.sessionId = sessionId || generateSessionId()
    this.sessionFile = path.join(SESSION_DIR, `${this.sessionId}.jsonl`)
  }

  async save(message: Message): Promise<void> {
    const line = JSON.stringify(message) + '\n'
    await fs.mkdir(SESSION_DIR, { recursive: true })
    await fs.appendFile(this.sessionFile, line)
  }

  async load(): Promise<Message[]> {
    try {
      const content = await fs.readFile(this.sessionFile, 'utf-8')
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    } catch {
      return []
    }
  }

  getId(): string {
    return this.sessionId
  }
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
```

### 7. 终端 UI

```typescript
// src/ui/repl.tsx
import React, { useState, useRef, useEffect } from 'react'
import { render, Box, Text, TextInput, useInput } from 'ink'
import { Message } from '../types'
import { agentLoop } from '../agent/loop'
import { allTools } from '../tools'
import { SessionManager } from '../storage/session'

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef(new SessionManager())

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      if (isProcessing) {
        abortRef.current?.abort()
        setIsProcessing(false)
      } else {
        process.exit(0)
      }
    }
  })

  const handleSubmit = async () => {
    if (!input.trim() || isProcessing) return

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsProcessing(true)

    const abortController = new AbortController()
    abortRef.current = abortController

    try {
      await sessionRef.current.save(userMessage)

      const context = {
        cwd: process.cwd(),
        signal: abortController.signal,
      }

      for await (const message of agentLoop(
        [...messages, userMessage],
        allTools,
        context,
      )) {
        setMessages(prev => [...prev, message])
        await sessionRef.current.save(message)
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error('Error:', error)
      }
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text bold color={msg.role === 'user' ? 'cyan' : 'green'}>
              {msg.role === 'user' ? 'You' : 'Claude'}:{' '}
            </Text>
            <Text>
              {typeof msg.content === 'string'
                ? msg.content.slice(0, 200)
                : JSON.stringify(msg.content).slice(0, 200)}
            </Text>
          </Box>
        ))}
        {isProcessing && (
          <Text color="yellow">Processing...</Text>
        )}
      </Box>

      <Box>
        <Text color="cyan" bold>&gt; </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type your message..."
        />
      </Box>
    </Box>
  )
}

// 入口
export function startRepl() {
  render(<App />)
}
```

### 8. CLI 入口

```typescript
// src/index.ts
import { Command } from '@commander-js/extra-typings'
import { startRepl } from './ui/repl'
import { agentLoop } from './agent/loop'
import { allTools } from './tools'

const program = new Command()

program
  .name('my-ai-cli')
  .description('AI-powered coding assistant')
  .version('1.0.0')
  .argument('[prompt]', 'Initial prompt')
  .option('-p, --print', 'Print mode (non-interactive)')
  .option('-c, --continue', 'Continue last session')
  .action(async (prompt, options) => {
    if (options.print && prompt) {
      // 打印模式
      const messages = [{ role: 'user' as const, content: prompt, timestamp: Date.now() }]
      const context = { cwd: process.cwd(), signal: new AbortController().signal }

      for await (const msg of agentLoop(messages, allTools, context)) {
        if (msg.role === 'assistant' && typeof msg.content === 'string') {
          console.log(msg.content)
        }
      }
    } else if (prompt) {
      // 单次模式
      // ...
    } else {
      // REPL 模式
      startRepl()
    }
  })

program.parse()
```

## 三、打包与发布

### package.json

```json
{
  "name": "my-ai-cli",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "my-ai-cli": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@commander-js/extra-typings": "^12.0.0",
    "ink": "^5.0.0",
    "react": "^18.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/react": "^18.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react"
  },
  "include": ["src/**/*"]
}
```

## 四、扩展建议

### 短期扩展

1. **更多工具**：添加 WebFetch、WebSearch、Git 工具
2. **更好的压缩**：调用 API 生成摘要
3. **MCP 支持**：集成 MCP 协议
4. **Memory 系统**：支持 CLAUDE.md

### 中期扩展

1. **子 Agent**：支持并行任务
2. **规划模式**：先规划再执行
3. **插件系统**：用户自定义工具
4. **多模型支持**：支持 OpenAI、Gemini 等

### 长期扩展

1. **IDE 集成**：VS Code 扩展
2. **Web UI**：浏览器界面
3. **团队协作**：共享会话
4. **云端同步**：跨设备同步

## 五、总结

通过本章，我们完成了一个功能完整的 AI CLI：

```
✓ 核心 Agent 循环
✓ 工具系统 (Read, Write, Bash, Search)
✓ 权限系统 (规则 + 交互确认)
✓ 上下文管理 (自动压缩)
✓ 会话持久化 (JSONL)
✓ 终端 UI (React + Ink)
✓ CLI 入口 (commander)
```

这个实现涵盖了 Claude Code 的核心架构，可以作为进一步扩展的基础。

---

## 附录

### 附录 A：工具清单

参考 [appendix/tool-inventory.md](./appendix/tool-inventory.md)

### 附录 B：Feature Flags

参考 [appendix/feature-flags.md](./appendix/feature-flags.md)

### 附录 C：设计模式

参考 [appendix/design-patterns.md](./appendix/design-patterns.md)
