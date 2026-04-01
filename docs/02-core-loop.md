---
title: 第二章：核心 Agent 循环
---

# 第二章：核心 Agent 循环

> 理解 Claude Code 的心脏——Agent 循环是如何工作的。

## 一、概念解释

### 什么是 Agent 循环？

Agent 循环是 AI Agent 的核心模式，区别于传统的单次问答：

```
传统 Chat:
用户 → AI → 回答 → 结束

Agent 循环:
用户 → AI → 工具调用 → 执行工具 → 结果 → AI → ... → 结束
         ↑_________________________________|
                    循环
```

**核心特点**：
1. **自主迭代**：AI 决定何时停止，而非用户
2. **工具调用**：AI 可以调用工具改变世界状态
3. **状态累积**：每次循环都携带完整上下文

### Agent 循环的本质

```typescript
// 伪代码：最简 Agent 循环
async function agentLoop(messages: Message[]) {
  while (true) {
    // 1. 调用 LLM
    const response = await callLLM(messages)

    // 2. 如果没有工具调用，返回结果
    if (response.stop_reason !== 'tool_use') {
      return response
    }

    // 3. 执行工具
    const toolResults = await executeTools(response.tool_calls)

    // 4. 追加结果，继续循环
    messages.push(response)
    messages.push(toolResults)
  }
}
```

### Claude Code 的增强版循环

Claude Code 在基本循环上增加了大量生产级功能：

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code Agent 循环                       │
│                                                                 │
│  while (true) {                                                 │
│    1. 上下文压缩检查 (autoCompact)                               │
│    2. 消息规范化 (normalizeMessagesForAPI)                      │
│    3. 调用 Claude API (streaming)                               │
│    4. 流式处理响应                                              │
│       ├── text block → yield 给 UI                             │
│       └── tool_use block → 收集                                 │
│    5. 权限检查 (canUseTool)                                     │
│    6. 并行执行工具 (StreamingToolExecutor)                       │
│    7. 追加 tool_result                                          │
│    8. 错误恢复 (prompt-too-long, max-output-tokens)             │
│    9. Stop Hook 检查                                            │
│    10. 循环继续 或 结束                                         │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

## 二、源码分析

### 入口函数：query()

位置：`src/query.ts`

```typescript
/**
 * 主 Agent 循环入口
 * @param params 查询参数（消息、系统提示词、工具等）
 * @returns AsyncGenerator，流式 yield 消息
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent        // 流式事件（文本增量、工具调用等）
  | RequestStartEvent  // 请求开始事件
  | Message            // 完整消息
  | TombstoneMessage   // 墓碑消息（删除 UI 中的消息）
  | ToolUseSummaryMessage,  // 工具使用摘要
  Terminal             // 最终返回值
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)

  // 清理已消费的命令
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

### 核心循环：queryLoop()

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<..., Terminal> {

  // 不可变参数
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
  } = params

  // 可变状态 - 在每次迭代中更新
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }

  // ==================== 主循环 ====================
  while (true) {
    const { toolUseContext } = state
    const { messages, autoCompactTracking, ... } = state

    // 1. yield 请求开始事件
    yield { type: 'stream_request_start' }

    // 2. 获取压缩边界后的消息
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    // 3. 应用工具结果预算（限制工具结果大小）
    messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)

    // 4. 应用 snip 压缩（激进裁剪）
    if (feature('HISTORY_SNIP')) {
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
    }

    // 5. 应用 microcompact（缓存编辑）
    const microcompactResult = await deps.microcompact(messagesForQuery, ...)
    messagesForQuery = microcompactResult.messages

    // 6. 应用 context collapse（上下文折叠）
    if (feature('CONTEXT_COLLAPSE')) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(...)
      messagesForQuery = collapseResult.messages
    }

    // 7. 自动压缩检查
    const { compactionResult } = await deps.autocompact(messagesForQuery, ...)
    if (compactionResult) {
      // 压缩成功，yield 压缩消息
      yield buildPostCompactMessages(compactionResult)
      messagesForQuery = postCompactMessages
    }

    // 8. 检查是否到达阻塞限制
    if (isAtBlockingLimit) {
      yield createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE })
      return { reason: 'blocking_limit' }
    }

    // ==================== API 调用 ====================
    const assistantMessages: AssistantMessage[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    // 创建流式工具执行器
    let streamingToolExecutor = new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )

    // 调用 API 并流式处理
    for await (const message of deps.callModel({
      messages: prependUserContext(messagesForQuery, userContext),
      systemPrompt: fullSystemPrompt,
      tools: toolUseContext.options.tools,
      signal: toolUseContext.abortController.signal,
      options: { model, ... },
    })) {
      // 处理流式消息
      yield message

      if (message.type === 'assistant') {
        assistantMessages.push(message)

        // 收集工具调用块
        const msgToolUseBlocks = message.message.content.filter(
          content => content.type === 'tool_use'
        ) as ToolUseBlock[]

        if (msgToolUseBlocks.length > 0) {
          toolUseBlocks.push(...msgToolUseBlocks)
          needsFollowUp = true

          // 添加到流式执行器
          for (const toolBlock of msgToolUseBlocks) {
            streamingToolExecutor.addTool(toolBlock, message)
          }
        }
      }

      // yield 已完成的工具结果
      for (const result of streamingToolExecutor.getCompletedResults()) {
        if (result.message) {
          yield result.message
          toolResults.push(result.message)
        }
      }
    }

    // ==================== 循环终止检查 ====================
    if (!needsFollowUp) {
      // 没有 tool_use，结束循环
      return { reason: 'completed' }
    }

    // ==================== 工具执行 ====================
    const toolUpdates = streamingToolExecutor.getRemainingResults()

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message
        toolResults.push(update.message)
      }
    }

    // ==================== 状态更新，继续循环 ====================
    state = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: updatedToolUseContext,
      autoCompactTracking: tracking,
      turnCount: turnCount + 1,
      ...
    }

    // continue 到下一次迭代
  }
}
```

### 状态管理

循环中的状态用 `State` 类型管理：

```typescript
type State = {
  messages: Message[]                    // 对话历史
  toolUseContext: ToolUseContext         // 工具使用上下文
  autoCompactTracking: AutoCompactTrackingState | undefined  // 压缩跟踪
  maxOutputTokensRecoveryCount: number   // 输出 token 恢复计数
  hasAttemptedReactiveCompact: boolean   // 是否已尝试响应式压缩
  maxOutputTokensOverride: number | undefined  // 输出 token 覆盖
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined  // 待处理工具摘要
  stopHookActive: boolean | undefined    // stop hook 是否激活
  turnCount: number                      // 轮次计数
  transition: Continue | undefined       // 上一次迭代为何继续
}
```

每次循环迭代结束时，通过 `continue` 更新状态：

```typescript
// 更新状态，继续循环
state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext,
  autoCompactTracking: tracking,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  maxOutputTokensOverride: undefined,
  pendingToolUseSummary: undefined,
  stopHookActive: undefined,
  turnCount,
  transition: { reason: 'tool_use' },
}
continue  // 跳到下一次迭代
```

## 三、关键机制详解

### 3.1 流式处理

Claude Code 使用 `AsyncGenerator` 实现全链路流式：

```typescript
// API 调用返回 AsyncGenerator
for await (const message of deps.callModel({...})) {
  // 立即 yield 给消费者
  yield message
}
```

**好处**：
1. **低延迟**：用户立即看到输出，不必等待完整响应
2. **可取消**：通过 `AbortController` 随时中断
3. **内存高效**：不需要缓存完整响应

### 3.2 错误恢复

#### Prompt Too Long 恢复

```typescript
if (isPromptTooLong) {
  // 尝试响应式压缩
  const compacted = await reactiveCompact.tryReactiveCompact({...})

  if (compacted) {
    // 压缩成功，继续循环
    state = { messages: postCompactMessages, ... }
    continue
  }

  // 压缩失败，返回错误
  return { reason: 'prompt_too_long' }
}
```

#### Max Output Tokens 恢复

```typescript
if (isMaxOutputTokens) {
  // 1. 尝试提升输出限制
  if (maxOutputTokensOverride === undefined) {
    state = { maxOutputTokensOverride: 64000, ... }
    continue  // 重试
  }

  // 2. 注入恢复消息，让 AI 继续
  if (maxOutputTokensRecoveryCount < 3) {
    const recoveryMessage = createUserMessage({
      content: 'Output token limit hit. Resume directly...',
      isMeta: true,
    })
    state = {
      messages: [...messages, recoveryMessage],
      maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
      ...
    }
    continue
  }

  // 3. 恢复耗尽，返回错误
  yield lastMessage
}
```

### 3.3 模型降级

当主模型不可用时，自动降级到备用模型：

```typescript
try {
  for await (const message of deps.callModel({...})) {
    yield message
  }
} catch (error) {
  if (error instanceof FallbackTriggeredError && fallbackModel) {
    // 切换到备用模型
    currentModel = fallbackModel

    // 清理已产生的消息
    for (const msg of assistantMessages) {
      yield { type: 'tombstone', message: msg }
    }
    assistantMessages.length = 0

    // 丢弃工具执行器
    streamingToolExecutor.discard()
    streamingToolExecutor = new StreamingToolExecutor(...)

    // 重试
    attemptWithFallback = true
    continue
  }
  throw error
}
```

### 3.4 Stop Hook

Stop Hook 允许用户在 AI 完成响应后注入检查：

```typescript
const stopHookResult = yield* handleStopHooks(
  messagesForQuery,
  assistantMessages,
  systemPrompt,
  userContext,
  systemContext,
  toolUseContext,
  querySource,
  stopHookActive,
)

// Hook 阻止继续
if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook_prevented' }
}

// Hook 产生阻塞错误
if (stopHookResult.blockingErrors.length > 0) {
  state = {
    messages: [...messages, ...assistantMessages, ...stopHookResult.blockingErrors],
    stopHookActive: true,
    ...
  }
  continue
}
```

### 3.5 轮次限制

```typescript
// 检查最大轮次
const nextTurnCount = turnCount + 1
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns' }
}
```

## 四、从零实现一个 Agent 循环

### 最简版本

```typescript
// minimal-agent.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

async function* agentLoop(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): AsyncGenerator<Anthropic.ContentBlock> {
  while (true) {
    // 调用 API
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    const toolCalls: Anthropic.ToolUseBlock[] = []

    // 流式处理
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        yield event.delta
      }
    }

    // 获取完整响应
    const response = await stream.finalMessage()

    // 追加助手消息
    messages.push({ role: 'assistant', content: response.content })

    // 检查是否有工具调用
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push(block)
      }
    }

    // 没有工具调用，结束
    if (toolCalls.length === 0) {
      return
    }

    // 执行工具
    const toolResults = await executeToolCalls(toolCalls)
    messages.push({ role: 'user', content: toolResults })

    // 继续循环
  }
}

async function executeToolCalls(toolCalls: Anthropic.ToolUseBlock[]) {
  return toolCalls.map(call => ({
    type: 'tool_result' as const,
    tool_use_id: call.id,
    content: JSON.stringify({ result: 'executed' }),
  }))
}
```

### 增强版本：添加权限检查

```typescript
// agent-with-permissions.ts
import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'

const client = new Anthropic()

// 权限规则
const alwaysAllow = new Set(['read_file', 'search'])
const alwaysDeny = new Set(['delete_file', 'execute_shell'])

async function checkPermission(toolName: string, input: unknown): Promise<boolean> {
  if (alwaysAllow.has(toolName)) return true
  if (alwaysDeny.has(toolName)) return false

  // 交互式询问
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(`Allow ${toolName}? (y/n): `, answer => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}

async function* agentLoop(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): AsyncGenerator<Anthropic.ContentBlock> {
  while (true) {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    const toolCalls: Anthropic.ToolUseBlock[] = []

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        yield event.delta
      }
    }

    const response = await stream.finalMessage()
    messages.push({ role: 'assistant', content: response.content })

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push(block)
      }
    }

    if (toolCalls.length === 0) {
      return
    }

    // 权限检查
    const toolResults = []
    for (const call of toolCalls) {
      const allowed = await checkPermission(call.name, call.input)

      if (allowed) {
        const result = await executeTool(call)
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: call.id,
          content: result,
        })
      } else {
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: call.id,
          content: 'Permission denied',
          is_error: true,
        })
      }
    }

    messages.push({ role: 'user', content: toolResults })
  }
}
```

### 增强版本：添加上下文压缩

```typescript
// agent-with-compact.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
const MAX_TOKENS = 180000  // 留 20k 余量

async function estimateTokens(messages: Anthropic.MessageParam[]): Promise<number> {
  // 简单估计：每 4 字符约 1 token
  const text = JSON.stringify(messages)
  return Math.ceil(text.length / 4)
}

async function compactMessages(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  if (messages.length < 10) return messages

  // 调用 API 生成摘要
  const summaryResponse = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Summarize the following conversation in 500 words or less:

${JSON.stringify(messages.slice(0, -5))}`,
      },
    ],
  })

  const summary = summaryResponse.content[0].type === 'text'
    ? summaryResponse.content[0].text
    : 'Summary unavailable'

  return [
    { role: 'user', content: `[Previous conversation summary: ${summary}]` },
    ...messages.slice(-5),  // 保留最近 5 条消息
  ]
}

async function* agentLoop(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): AsyncGenerator<Anthropic.ContentBlock> {
  while (true) {
    // 检查 token 数量
    const tokenCount = await estimateTokens(messages)
    if (tokenCount > MAX_TOKENS) {
      console.log(`Context too large (${tokenCount} tokens), compacting...`)
      messages = await compactMessages(messages)
    }

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    // ... 其余代码同上
  }
}
```

### 完整版本：并行工具执行

```typescript
// agent-with-parallel-tools.ts
import Anthropic from '@anthropic-ai/sdk'
import PQueue from 'p-queue'

const client = new Anthropic()

// 工具定义
const tools: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'search',
    description: 'Search for files',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
]

// 并发安全工具（可以并行执行）
const concurrencySafeTools = new Set(['read_file', 'search'])

// 串行工具（必须单独执行）
const serialTools = new Set(['write_file', 'execute_shell'])

class ToolExecutor {
  private queue = new PQueue({ concurrency: 5 })

  async executeTools(
    toolCalls: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = []

    // 分组：并发安全 vs 串行
    const safeCalls = toolCalls.filter(c => concurrencySafeTools.has(c.name))
    const serialCalls = toolCalls.filter(c => serialTools.has(c.name))

    // 并发安全工具并行执行
    const safeResults = await Promise.all(
      safeCalls.map(call => this.executeTool(call, signal)),
    )
    results.push(...safeResults)

    // 串行工具逐个执行
    for (const call of serialCalls) {
      if (signal.aborted) break
      const result = await this.executeTool(call, signal)
      results.push(result)
    }

    return results
  }

  private async executeTool(
    call: Anthropic.ToolUseBlock,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam> {
    try {
      // 实际工具执行逻辑
      const result = await this.queue.add(async () => {
        if (signal.aborted) {
          throw new Error('Aborted')
        }
        return await this.runTool(call)
      })

      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
      }
    } catch (error) {
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Error: ${error}`,
        is_error: true,
      }
    }
  }

  private async runTool(call: Anthropic.ToolUseBlock): Promise<unknown> {
    switch (call.name) {
      case 'read_file':
        return { content: 'file content...' }
      case 'search':
        return { files: ['a.ts', 'b.ts'] }
      default:
        throw new Error(`Unknown tool: ${call.name}`)
    }
  }
}

async function* agentLoop(
  messages: Anthropic.MessageParam[],
): AsyncGenerator<Anthropic.ContentBlock> {
  const executor = new ToolExecutor()
  const abortController = new AbortController()

  while (true) {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages,
      tools,
    })

    const toolCalls: Anthropic.ToolUseBlock[] = []

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        yield event.delta
      }
    }

    const response = await stream.finalMessage()
    messages.push({ role: 'assistant', content: response.content })

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push(block)
      }
    }

    if (toolCalls.length === 0) {
      return
    }

    // 并行执行工具
    const toolResults = await executor.executeTools(
      toolCalls,
      abortController.signal,
    )
    messages.push({ role: 'user', content: toolResults })
  }
}
```

## 五、关键设计决策

### 1. 为什么用 AsyncGenerator？

```typescript
// 好处 1: 流式输出
for await (const event of query()) {
  console.log(event)  // 立即看到每个增量
}

// 好处 2: 可取消
const generator = query()
setTimeout(() => generator.return(), 5000)  // 5秒后取消

// 好处 3: 背压
for await (const event of query()) {
  await slowProcessing(event)  // 消费者控制速度
}
```

### 2. 为什么状态用可变对象？

```typescript
// 不好的方式：每次迭代重建
const nextMessages = [...messages, ...newMessages]
const nextContext = { ...context, ...updates }

// 好的方式：状态对象 + continue
state = {
  ...state,
  messages: [...state.messages, ...newMessages],
}
continue
```

**原因**：
- 减少变量数量（9+ 个状态变量）
- 清晰的状态更新点
- 方便调试（打印一个对象）

### 3. 为什么工具执行要分区？

```typescript
// 并发安全工具可以并行
const safeCalls = toolCalls.filter(c => isSafe(c.name))
await Promise.all(safeCalls.map(execute))

// 串行工具必须单独执行
for (const call of serialCalls) {
  await execute(call)
}
```

**原因**：
- 文件读取可以并行
- 文件写入必须串行（避免冲突）
- Shell 命令必须串行（避免竞争）

## 六、常见问题

### Q: 如何防止无限循环？

```typescript
// 方案 1: 轮次限制
if (turnCount > maxTurns) {
  return { reason: 'max_turns' }
}

// 方案 2: Token 预算
if (totalTokens > maxTokens) {
  return { reason: 'token_budget' }
}

// 方案 3: Stop Hook
if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook' }
}
```

### Q: 如何处理超时？

```typescript
const abortController = new AbortController()

// 设置超时
const timeout = setTimeout(() => {
  abortController.abort()
}, 30000)  // 30秒

// 传递 signal 给 API
const stream = client.messages.stream({
  ...
  signal: abortController.signal,
})

// 在工具执行中检查
if (signal.aborted) {
  return { error: 'Timeout' }
}
```

### Q: 如何实现会话恢复？

```typescript
// 保存会话
function saveSession(messages: Message[], sessionId: string) {
  const jsonl = messages.map(m => JSON.stringify(m)).join('\n')
  fs.writeFileSync(`sessions/${sessionId}.jsonl`, jsonl)
}

// 恢复会话
function loadSession(sessionId: string): Message[] {
  const jsonl = fs.readFileSync(`sessions/${sessionId}.jsonl`, 'utf-8')
  return jsonl.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
```

---

下一章：[03-tool-system.md](./03-tool-system.md) - 深入工具系统的设计与实现
