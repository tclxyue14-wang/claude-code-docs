---
title: 第六章：子 Agent 架构
---

# 第六章：子 Agent 架构

> 理解 Claude Code 如何通过子 Agent 实现任务分解和并行处理。

## 一、概念解释

### 什么是子 Agent？

子 Agent 是独立运行的 Agent 实例，拥有：

1. **独立的上下文**：不污染父 Agent 的消息历史
2. **独立的工具集**：可以限制可用工具
3. **独立的生命周期**：可以并行执行

### 为什么需要子 Agent？

```
单个 Agent 的局限：
┌────────────────────────────────────────────────────┐
│ Main Agent                                          │
│   ├── 消息历史越来越长                              │
│   ├── 上下文窗口有限                                │
│   ├── 一次只能做一件事                              │
│   └── 难以处理复杂的多步骤任务                      │
└────────────────────────────────────────────────────┘

多个子 Agent：
┌────────────────────────────────────────────────────┐
│ Main Agent (协调者)                                 │
│   ├── Sub-agent A: 研究问题                        │
│   ├── Sub-agent B: 实现方案                        │
│   └── Sub-agent C: 测试验证                        │
│                                                     │
│ 每个子 Agent：                                      │
│   ├── 独立的上下文                                  │
│   ├── 可以并行执行                                  │
│   └── 完成后返回结果给父 Agent                     │
└────────────────────────────────────────────────────┘
```

### 子 Agent 类型

Claude Code 支持多种子 Agent 模式：

| 模式 | 描述 | 适用场景 |
|------|------|----------|
| **fork** | 子进程，全新 messages[]，共享文件缓存 | 独立任务 |
| **worktree** | 隔离 git worktree + fork | 并行开发 |
| **remote** | Bridge 到远程容器 | 资源隔离 |
| **in-process** | 同进程，AsyncLocalStorage | 轻量协作 |

## 二、源码分析

### AgentTool 定义

位置：`src/tools/AgentTool/AgentTool.ts`

```typescript
const inputSchema = z.object({
  prompt: z.string().describe('Task for the sub-agent'),
  agent_type: z.string().optional().describe('Type of agent to spawn'),
  fork_mode: z.enum(['fork', 'worktree', 'in-process', 'remote']).optional(),
  tools: z.array(z.string()).optional().describe('Tools available to sub-agent'),
})

export const AgentTool: Tool = buildTool({
  name: 'Agent',

  inputSchema,

  async prompt() {
    return `Spawn a sub-agent to handle a complex subtask.

The sub-agent:
- Gets a fresh context (empty message history)
- Can use all or a subset of available tools
- Runs independently and returns results

Use for:
- Research tasks that need multiple queries
- Code refactoring in isolated scope
- Parallel processing of independent tasks`
  },

  isConcurrencySafe: () => true,

  isReadOnly: () => true,

  async call(input, context) {
    // 1. 创建子 Agent 上下文
    const subContext = await createSubagentContext(context, {
      agentType: input.agent_type,
      forkMode: input.fork_mode,
      allowedTools: input.tools,
    })

    // 2. 准备消息
    const messages = [
      { role: 'user', content: input.prompt },
    ]

    // 3. 运行子 Agent
    const result = await runSubagent(subContext, messages)

    // 4. 返回结果
    return {
      data: {
        result: result.output,
        turns: result.turns,
        toolsUsed: result.toolsUsed,
      },
    }
  },
})
```

### 创建子 Agent 上下文

```typescript
async function createSubagentContext(
  parentContext: ToolUseContext,
  options: SubagentOptions,
): Promise<ToolUseContext> {
  // 生成 Agent ID
  const agentId = generateAgentId()

  // 过滤工具
  const tools = filterTools(
    parentContext.options.tools,
    options.allowedTools,
  )

  // 创建独立的 AbortController
  const abortController = new AbortController()

  // 创建子上下文
  return {
    ...parentContext,
    agentId,
    messages: [],  // 空消息历史
    options: {
      ...parentContext.options,
      tools,
    },
    abortController,
    // 共享文件缓存
    readFileState: parentContext.readFileState,
  }
}
```

### 运行子 Agent

```typescript
async function runSubagent(
  context: ToolUseContext,
  messages: Message[],
): Promise<SubagentResult> {
  const turns: Message[][] = []
  let currentMessages = messages
  let totalToolsUsed: string[] = []

  // 主循环
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 调用 API
    const response = await callClaudeAPI({
      messages: currentMessages,
      systemPrompt: context.systemPrompt,
      tools: context.options.tools,
    })

    // 收集工具调用
    const toolCalls = extractToolCalls(response)
    totalToolsUsed.push(...toolCalls.map(t => t.name))

    // 检查是否完成
    if (toolCalls.length === 0) {
      return {
        output: extractText(response),
        turns: turn + 1,
        toolsUsed: [...new Set(totalToolsUsed)],
      }
    }

    // 执行工具
    const toolResults = await executeTools(toolCalls, context)

    // 更新消息
    currentMessages = [
      ...currentMessages,
      response,
      { role: 'user', content: toolResults },
    ]
    turns.push(currentMessages)
  }

  // 达到最大轮次
  return {
    output: 'Sub-agent reached maximum turns',
    turns: MAX_TURNS,
    toolsUsed: [...new Set(totalToolsUsed)],
  }
}
```

## 三、从零实现子 Agent

### 最简版本

```typescript
// minimal-subagent.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

async function runSubagent(
  prompt: string,
  tools: Anthropic.Tool[],
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt },
  ]

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    // 检查是否完成
    const toolCalls = response.content.filter(b => b.type === 'tool_use')
    if (toolCalls.length === 0) {
      const textBlocks = response.content.filter(b => b.type === 'text')
      return textBlocks.map(b => (b as any).text).join('')
    }

    // 执行工具
    const toolResults = await executeTools(toolCalls)

    // 更新消息
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }
}
```

### 增强版本：并行子 Agent

```typescript
// parallel-subagents.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

type SubagentTask = {
  id: string
  prompt: string
  tools?: string[]  // 可用工具子集
}

type SubagentResult = {
  id: string
  output: string
  turns: number
}

async function runParallelSubagents(
  tasks: SubagentTask[],
  allTools: Anthropic.Tool[],
): Promise<SubagentResult[]> {
  // 并行执行所有子 Agent
  const results = await Promise.all(
    tasks.map(task => runSubagent(task, allTools)),
  )

  return results
}

async function runSubagent(
  task: SubagentTask,
  allTools: Anthropic.Tool[],
): Promise<SubagentResult> {
  // 过滤工具
  const tools = task.tools
    ? allTools.filter(t => task.tools!.includes(t.name))
    : allTools

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: task.prompt },
  ]

  let turns = 0
  const MAX_TURNS = 20

  while (turns < MAX_TURNS) {
    turns++

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    const toolCalls = response.content.filter(b => b.type === 'tool_use')
    if (toolCalls.length === 0) {
      const textBlocks = response.content.filter(b => b.type === 'text')
      return {
        id: task.id,
        output: textBlocks.map(b => (b as any).text).join(''),
        turns,
      }
    }

    const toolResults = await executeTools(toolCalls)
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  return {
    id: task.id,
    output: 'Max turns reached',
    turns,
  }
}

// 使用示例
const tasks: SubagentTask[] = [
  { id: 'research', prompt: 'Research best practices for error handling', tools: ['WebSearch', 'WebFetch'] },
  { id: 'analyze', prompt: 'Analyze the current error handling code', tools: ['Read', 'Grep'] },
  { id: 'design', prompt: 'Design an improved error handling system', tools: ['Read', 'Write'] },
]

const results = await runParallelSubagents(tasks, allTools)
```

### 完整版本：Fork 模式

```typescript
// fork-subagent.ts
import { fork } from 'child_process'
import path from 'path'

type ForkOptions = {
  prompt: string
  tools?: string[]
  timeout?: number
  sharedCache?: Map<string, unknown>
}

type ForkResult = {
  output: string
  turns: number
  error?: string
}

async function runForkedAgent(options: ForkOptions): Promise<ForkResult> {
  return new Promise((resolve, reject) => {
    // Fork 子进程
    const child = fork(
      path.join(__dirname, 'agent-worker.js'),
      [],
      {
        env: {
          ...process.env,
          AGENT_PROMPT: options.prompt,
          AGENT_TOOLS: options.tools?.join(','),
        },
      },
    )

    // 设置超时
    const timeout = setTimeout(() => {
      child.kill()
      resolve({ output: '', turns: 0, error: 'Timeout' })
    }, options.timeout || 120000)

    let result: ForkResult = { output: '', turns: 0 }

    child.on('message', (msg: any) => {
      if (msg.type === 'result') {
        result = msg.data
      }
      if (msg.type === 'cache_read' && options.sharedCache) {
        // 从共享缓存读取
        const cached = options.sharedCache.get(msg.key)
        child.send({ type: 'cache_response', key: msg.key, value: cached })
      }
      if (msg.type === 'cache_write' && options.sharedCache) {
        // 写入共享缓存
        options.sharedCache.set(msg.key, msg.value)
      }
    })

    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(result)
      } else {
        resolve({ ...result, error: `Exit code: ${code}` })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ output: '', turns: 0, error: err.message })
    })
  })
}

// agent-worker.ts (子进程入口)
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

async function main() {
  const prompt = process.env.AGENT_PROMPT!
  const tools = process.env.AGENT_TOOLS?.split(',') || []

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt },
  ]

  let turns = 0
  const MAX_TURNS = 20

  while (turns < MAX_TURNS) {
    turns++

    // 检查缓存请求
    process.on('message', (msg: any) => {
      if (msg.type === 'cache_response') {
        // 使用缓存值
      }
    })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
    })

    const toolCalls = response.content.filter(b => b.type === 'tool_use')
    if (toolCalls.length === 0) {
      const output = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('')

      process.send!({
        type: 'result',
        data: { output, turns },
      })
      process.exit(0)
    }

    // 执行工具...

    turns++
  }

  process.send!({
    type: 'result',
    data: { output: 'Max turns', turns },
  })
  process.exit(1)
}

main()
```

## 四、Agent 团队协作

### 任务分配

```typescript
// agent-team.ts
type AgentRole = 'researcher' | 'implementer' | 'reviewer' | 'coordinator'

type TeamConfig = {
  coordinator: AgentConfig
  workers: AgentConfig[]
}

class AgentTeam {
  private coordinator: Agent
  private workers: Map<string, Agent> = new Map()
  private taskBoard: Map<string, Task> = new Map()

  constructor(config: TeamConfig) {
    this.coordinator = new Agent(config.coordinator)
    for (const workerConfig of config.workers) {
      this.workers.set(workerConfig.id, new Agent(workerConfig))
    }
  }

  async run(objective: string): Promise<string> {
    // 1. 协调者分解任务
    const plan = await this.coordinator.execute(`
      Break down this objective into tasks:
      ${objective}

      For each task, specify:
      - task_id
      - description
      - assigned_agent (researcher/implementer/reviewer)
      - dependencies
    `)

    // 2. 解析任务
    const tasks = this.parsePlan(plan)

    // 3. 执行任务
    await this.executeTasks(tasks)

    // 4. 汇总结果
    return this.collectResults()
  }

  private async executeTasks(tasks: Task[]) {
    const completed = new Set<string>()

    while (completed.size < tasks.length) {
      // 找出可执行的任务
      const ready = tasks.filter(t =>
        !completed.has(t.id) &&
        t.dependencies.every(d => completed.has(d))
      )

      // 并行执行
      const results = await Promise.all(
        ready.map(task => this.executeTask(task))
      )

      // 记录完成
      for (const result of results) {
        completed.add(result.taskId)
        this.taskBoard.set(result.taskId, result)
      }
    }
  }

  private async executeTask(task: Task): Promise<TaskResult> {
    const agent = this.workers.get(task.assignedAgent)
    if (!agent) {
      throw new Error(`Unknown agent: ${task.assignedAgent}`)
    }

    const output = await agent.execute(task.description)

    return {
      taskId: task.id,
      output,
      status: 'completed',
    }
  }
}
```

### 消息传递

```typescript
// agent-messaging.ts
type AgentMessage = {
  from: string
  to: string
  type: 'request' | 'response' | 'notification'
  content: string
  timestamp: number
}

class MessageBus {
  private inboxes: Map<string, AgentMessage[]> = new Map()

  send(message: AgentMessage) {
    const inbox = this.inboxes.get(message.to) || []
    inbox.push(message)
    this.inboxes.set(message.to, inbox)
  }

  receive(agentId: string): AgentMessage[] {
    const messages = this.inboxes.get(agentId) || []
    this.inboxes.set(agentId, [])
    return messages
  }

  hasMessages(agentId: string): boolean {
    return (this.inboxes.get(agentId)?.length || 0) > 0
  }
}

// 使用
const bus = new MessageBus()

// Agent A 发送消息给 Agent B
bus.send({
  from: 'agent-a',
  to: 'agent-b',
  type: 'request',
  content: 'Please analyze the file src/index.ts',
  timestamp: Date.now(),
})

// Agent B 接收消息
const messages = bus.receive('agent-b')
for (const msg of messages) {
  // 处理消息
}
```

## 五、最佳实践

### 1. 任务分解原则

```typescript
// 好的任务分解
const tasks = [
  { id: 'research', prompt: 'Research authentication best practices', agent: 'researcher' },
  { id: 'design', prompt: 'Design authentication system', agent: 'architect', deps: ['research'] },
  { id: 'implement', prompt: 'Implement authentication', agent: 'implementer', deps: ['design'] },
  { id: 'review', prompt: 'Review implementation', agent: 'reviewer', deps: ['implement'] },
]

// 不好的任务分解（任务太模糊）
const badTasks = [
  { id: 'do-it', prompt: 'Implement authentication system', agent: 'implementer' },
]
```

### 2. 工具限制

```typescript
// 研究者：只读工具
const researcherTools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']

// 实现者：写权限
const implementerTools = ['Read', 'Edit', 'Write', 'Bash']

// 审查者：只读 + 注释
const reviewerTools = ['Read', 'Grep', 'Write']  // Write 用于写审查报告
```

### 3. 结果整合

```typescript
async function collectResults(
  results: Map<string, TaskResult>,
): Promise<string> {
  // 协调者整合所有结果
  const summaries = Array.from(results.entries()).map(([id, result]) =>
    `## Task: ${id}\n${result.output}`
  ).join('\n\n')

  return await coordinator.execute(`
    Synthesize these task results into a coherent summary:

    ${summaries}
  `)
}
```

---

下一章：[07-mcp-integration.md](./07-mcp-integration.md) - 深入 MCP 协议集成
