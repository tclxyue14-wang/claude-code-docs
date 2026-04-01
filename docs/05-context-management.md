---
title: 第五章：上下文管理
---

# 第五章：上下文管理

> 理解 Claude Code 如何管理有限的上下文窗口，实现长期记忆。

## 一、概念解释

### 为什么需要上下文管理？

Claude 等 LLM 有固定的上下文窗口（如 200k tokens）。随着对话进行：

```
消息积累：
用户消息 → 助手回复 → 工具调用 → 工具结果 → 用户消息 → ...
    ↓
上下文溢出！
```

**问题**：
1. 上下文超限 → API 报错
2. 上下文过大 → 成本上升
3. 上下文过长 → 响应变慢

### 解决方案：压缩

Claude Code 实现了多层压缩策略：

| 策略 | 触发条件 | 方式 | 效果 |
|------|----------|------|------|
| **autoCompact** | token > 阈值 | 调用 API 总结旧消息 | 大幅压缩 |
| **snipCompact** | 每次迭代 | 移除僵尸消息 | 小幅清理 |
| **microCompact** | 每次迭代 | 编辑缓存的工具结果 | 精细优化 |
| **contextCollapse** | 实验性 | 重构上下文结构 | 激进压缩 |

### 压缩边界

```
┌─────────────────────────────────────────────────────────────────┐
│  System Prompt (不压缩)                                          │
│  ═══════════════════════════════════════════════════════════════│
│                                                                 │
│  Conversation History                                           │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ [compact_boundary]                                         │ │
│  │ ══════════════════════════════════════════════════════════│ │
│  │ [压缩摘要]                                                  │ │
│  │ "之前讨论了 X，实现了 Y，发现 Z 问题..."                      │ │
│  │ ══════════════════════════════════════════════════════════│ │
│  │                                                            │ │
│  │ [compact_boundary]                                         │ │
│  │ ─────────────────────────────────────────────────────────│ │
│  │ [近期消息 — 完整保留]                                        │ │
│  │ user: 继续修改                                              │ │
│  │ assistant: 好的，我来...                                    │ │
│  │ tool_use: Read(file.ts)                                    │ │
│  │ tool_result: 文件内容...                                    │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Current Turn                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 二、源码分析

### 自动压缩检查

位置：`src/services/compact/autoCompact.ts`

```typescript
export async function autoCompact(
  messages: Message[],
  toolUseContext: ToolUseContext,
  params: CompactParams,
  querySource: QuerySource,
  tracking: AutoCompactTrackingState | undefined,
  snipTokensFreed: number,
): Promise<AutoCompactResult> {
  // 1. 计算 token 数量
  const tokenCount = tokenCountWithEstimation(messages)

  // 2. 获取压缩阈值
  const threshold = getCompactThreshold(toolUseContext.options.mainLoopModel)

  // 3. 检查是否需要压缩
  const needsCompact = tokenCount > threshold

  if (!needsCompact) {
    return { compactionResult: null }
  }

  // 4. 执行压缩
  const result = await performCompact(messages, params, toolUseContext)

  return { compactionResult: result }
}
```

### 压缩执行

```typescript
async function performCompact(
  messages: Message[],
  params: CompactParams,
  toolUseContext: ToolUseContext,
): Promise<CompactionResult> {
  // 1. 找到压缩边界
  const boundaryIndex = findCompactBoundary(messages)

  // 2. 分割消息
  const messagesToCompact = messages.slice(0, boundaryIndex)
  const messagesToKeep = messages.slice(boundaryIndex)

  // 3. 调用 API 生成摘要
  const summary = await generateSummary(messagesToCompact, params)

  // 4. 构建压缩后的消息
  const compactedMessages = [
    createCompactBoundaryMessage(),
    createUserMessage({ content: summary }),
    createCompactBoundaryMessage(),
    ...messagesToKeep,
  ]

  return {
    preCompactTokenCount: tokenCountWithEstimation(messages),
    postCompactTokenCount: tokenCountWithEstimation(compactedMessages),
    summaryMessages: compactedMessages,
  }
}
```

### 摘要生成

```typescript
async function generateSummary(
  messages: Message[],
  params: CompactParams,
): Promise<string> {
  // 构建摘要请求
  const summaryRequest = {
    model: 'claude-3-5-haiku-20241022',  // 用小模型生成摘要
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Summarize the following conversation, preserving:
1. Key decisions and their reasons
2. Important findings and discoveries
3. Current task status
4. Unfinished work

Conversation:
${messages.map(m => formatMessage(m)).join('\n')}`,
      },
    ],
  }

  const response = await callClaudeAPI(summaryRequest)
  return response.content[0].text
}
```

### 压缩边界查找

```typescript
function findCompactBoundary(messages: Message[]): number {
  // 从后向前找，保留最近的完整对话
  const MIN_KEEP = 10  // 至少保留 10 条消息

  for (let i = messages.length - MIN_KEEP; i >= 0; i--) {
    const message = messages[i]

    // 在用户消息处断开
    if (message.type === 'user') {
      return i
    }
  }

  return 0
}
```

## 三、从零实现上下文管理

### 最简版本：Token 计数与警告

```typescript
// simple-context-manager.ts
import { encode } from 'gpt-tokenizer'

function countTokens(text: string): number {
  return encode(text).length
}

function countMessagesTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => {
    return total + countTokens(JSON.stringify(msg))
  }, 0)
}

function checkContextWindow(
  messages: Message[],
  maxSize: number = 180000,  // 留 20k 余量
): { ok: boolean; current: number; max: number } {
  const current = countMessagesTokens(messages)
  return {
    ok: current < maxSize,
    current,
    max: maxSize,
  }
}

// 使用
const result = checkContextWindow(messages)
if (!result.ok) {
  console.warn(`Context window near limit: ${result.current}/${result.max}`)
}
```

### 增强版本：简单压缩

```typescript
// simple-compact.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

async function compactMessages(
  messages: Anthropic.MessageParam[],
  keepLast: number = 10,
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= keepLast) {
    return messages
  }

  const toCompact = messages.slice(0, -keepLast)
  const toKeep = messages.slice(-keepLast)

  // 生成摘要
  const summary = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Summarize this conversation in 500 words or less:

${toCompact.map(m => JSON.stringify(m)).join('\n')}`,
      },
    ],
  })

  const summaryText = summary.content[0].type === 'text'
    ? summary.content[0].text
    : 'Summary unavailable'

  return [
    {
      role: 'user',
      content: `[Previous conversation summary: ${summaryText}]`,
    },
    ...toKeep,
  ]
}
```

### 完整版本：智能压缩

```typescript
// smart-compact.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

type Message = {
  role: 'user' | 'assistant'
  content: string | Anthropic.ContentBlock[]
  metadata?: {
    important?: boolean
    toolCalls?: string[]
  }
}

class ContextManager {
  private maxSize: number
  private compactThreshold: number
  private keepLast: number

  constructor(options: {
    maxSize?: number
    compactThreshold?: number
    keepLast?: number
  } = {}) {
    this.maxSize = options.maxSize ?? 200000
    this.compactThreshold = options.compactThreshold ?? 180000
    this.keepLast = options.keepLast ?? 10
  }

  async manageContext(messages: Message[]): Promise<Message[]> {
    // 1. 检查是否需要压缩
    const tokenCount = this.countTokens(messages)

    if (tokenCount <= this.compactThreshold) {
      return messages
    }

    console.log(`Context ${tokenCount} > threshold ${this.compactThreshold}, compacting...`)

    // 2. 分析消息重要性
    const analyzed = this.analyzeMessages(messages)

    // 3. 选择压缩策略
    const strategy = this.selectStrategy(analyzed, tokenCount)

    // 4. 执行压缩
    return this.executeCompact(analyzed, strategy)
  }

  private countTokens(messages: Message[]): number {
    // 简化：每 4 字符约 1 token
    const text = JSON.stringify(messages)
    return Math.ceil(text.length / 4)
  }

  private analyzeMessages(messages: Message[]): AnalyzedMessage[] {
    return messages.map((msg, index) => {
      // 检测重要消息
      const isImportant = this.isImportantMessage(msg)

      // 检测工具调用
      const toolCalls = this.extractToolCalls(msg)

      // 计算消息年龄（越旧越不重要）
      const age = messages.length - index

      return {
        ...msg,
        index,
        isImportant,
        toolCalls,
        age,
        tokenCount: this.countTokens([msg]),
      }
    })
  }

  private isImportantMessage(msg: Message): boolean {
    if (msg.metadata?.important) return true

    // 用户决策
    if (typeof msg.content === 'string') {
      const lower = msg.content.toLowerCase()
      if (lower.includes('重要') || lower.includes('remember')) {
        return true
      }
    }

    return false
  }

  private extractToolCalls(msg: Message): string[] {
    if (typeof msg.content === 'string') return []

    return msg.content
      .filter(block => block.type === 'tool_use')
      .map(block => (block as any).name)
  }

  private selectStrategy(
    messages: AnalyzedMessage[],
    tokenCount: number,
  ): CompactStrategy {
    const excess = tokenCount - this.compactThreshold
    const excessRatio = excess / tokenCount

    // 轻微超限：只移除不重要的
    if (excessRatio < 0.2) {
      return { type: 'trim', removeUnimportant: true }
    }

    // 中等超限：压缩旧消息
    if (excessRatio < 0.5) {
      return { type: 'partial_compact', targetRatio: 0.7 }
    }

    // 严重超限：完全压缩
    return { type: 'full_compact' }
  }

  private async executeCompact(
    messages: AnalyzedMessage[],
    strategy: CompactStrategy,
  ): Promise<Message[]> {
    switch (strategy.type) {
      case 'trim':
        return this.trimMessages(messages)

      case 'partial_compact':
        return this.partialCompact(messages, strategy.targetRatio!)

      case 'full_compact':
        return this.fullCompact(messages)
    }
  }

  private trimMessages(messages: AnalyzedMessage[]): Message[] {
    return messages.filter(msg =>
      msg.isImportant || msg.age <= this.keepLast
    )
  }

  private async partialCompact(
    messages: AnalyzedMessage[],
    targetRatio: number,
  ): Promise<Message[]> {
    const keepCount = Math.ceil(messages.length * (1 - targetRatio))
    const keepRecent = messages.slice(-keepCount)
    const toCompact = messages.slice(0, -keepCount)

    const summary = await this.generateSummary(toCompact)

    return [
      { role: 'user', content: `[Summary: ${summary}]` },
      ...keepRecent,
    ]
  }

  private async fullCompact(messages: AnalyzedMessage[]): Promise<Message[]> {
    const keepRecent = messages.slice(-this.keepLast)
    const toCompact = messages.slice(0, -this.keepLast)

    const summary = await this.generateSummary(toCompact)

    return [
      { role: 'user', content: `[Summary: ${summary}]` },
      ...keepRecent,
    ]
  }

  private async generateSummary(messages: AnalyzedMessage[]): Promise<string> {
    const conversation = messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content)
      return `${m.role}: ${content}`
    }).join('\n')

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation, preserving key information:

${conversation}`,
        },
      ],
    })

    return response.content[0].type === 'text'
      ? response.content[0].text
      : 'Summary unavailable'
  }
}

type AnalyzedMessage = Message & {
  index: number
  isImportant: boolean
  toolCalls: string[]
  age: number
  tokenCount: number
}

type CompactStrategy =
  | { type: 'trim'; removeUnimportant: boolean }
  | { type: 'partial_compact'; targetRatio: number }
  | { type: 'full_compact' }

// 使用
const manager = new ContextManager({
  maxSize: 200000,
  compactThreshold: 180000,
  keepLast: 10,
})

const compacted = await manager.manageContext(messages)
```

## 四、高级技术

### 工具结果截断

工具返回的结果可能很大，需要截断：

```typescript
// tool-result-budget.ts
const MAX_TOOL_RESULT_SIZE = 50000  // 字符数

function truncateToolResult(
  result: string,
  maxSize: number = MAX_TOOL_RESULT_SIZE,
): { content: string; truncated: boolean } {
  if (result.length <= maxSize) {
    return { content: result, truncated: false }
  }

  // 保留开头和结尾
  const headSize = Math.floor(maxSize * 0.4)
  const tailSize = Math.floor(maxSize * 0.4)

  const head = result.slice(0, headSize)
  const tail = result.slice(-tailSize)

  return {
    content: `${head}\n\n... [truncated ${result.length - maxSize} characters] ...\n\n${tail}`,
    truncated: true,
  }
}
```

### 缓存友好的压缩

Claude API 支持 prompt caching，压缩要考虑缓存：

```typescript
// cache-aware-compact.ts
function cacheAwareCompact(messages: Message[]): Message[] {
  // 检查哪些消息被缓存了
  const cachedBoundary = findCachedBoundary(messages)

  if (cachedBoundary > 0) {
    // 有缓存：只压缩未缓存的部分
    const cached = messages.slice(0, cachedBoundary)
    const uncached = messages.slice(cachedBoundary)

    // 压缩未缓存部分
    const compactedUncached = compact(uncached)

    return [...cached, ...compactedUncached]
  }

  // 无缓存：正常压缩
  return compact(messages)
}

function findCachedBoundary(messages: Message[]): number {
  // 查找 cache_creation_input_tokens 或 cache_read_input_tokens
  // 返回缓存边界索引
  return 0
}
```

### 渐进式压缩

根据超限程度选择不同策略：

```typescript
// progressive-compact.ts
function progressiveCompact(
  messages: Message[],
  currentTokens: number,
  maxTokens: number,
): Promise<Message[]> {
  const overage = currentTokens - maxTokens
  const overageRatio = overage / currentTokens

  if (overageRatio < 0.1) {
    // < 10% 超限：移除旧的不重要消息
    return trimOldMessages(messages)
  } else if (overageRatio < 0.3) {
    // < 30% 超限：压缩旧消息
    return partialCompact(messages, 0.5)
  } else if (overageRatio < 0.5) {
    // < 50% 超限：激进压缩
    return partialCompact(messages, 0.3)
  } else {
    // > 50% 超限：完全重建
    return fullRebuild(messages)
  }
}
```

## 五、最佳实践

### 1. 保留关键信息

```typescript
function isKeyMessage(msg: Message): boolean {
  // 用户的重要决策
  if (msg.metadata?.important) return true

  // 错误消息
  if (msg.content.toString().includes('Error:')) return true

  // 成功确认
  if (msg.content.toString().includes('Successfully')) return true

  return false
}
```

### 2. 压缩摘要质量

```typescript
const SUMMARY_PROMPT = `Summarize the conversation, including:

1. **Decisions Made**: What choices were made and why
2. **Work Completed**: What was successfully implemented
3. **Current State**: What files were modified, what's the status
4. **Pending Tasks**: What remains to be done
5. **Important Context**: Key constraints, requirements, or issues

Be concise but comprehensive. Preserve technical details.`
```

### 3. 监控压缩效果

```typescript
function logCompactMetrics(before: number, after: number) {
  const saved = before - after
  const ratio = (saved / before * 100).toFixed(1)

  console.log(`Compact: ${before} → ${after} tokens (${saved} saved, ${ratio}% reduction)`)
}
```

---

下一章：[06-sub-agents.md](./06-sub-agents.md) - 深入子 Agent 架构
