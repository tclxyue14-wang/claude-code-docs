---
title: 附录 C：设计模式
---

# 附录 C：设计模式

Claude Code 源码中使用的关键设计模式总结。

## 1. AsyncGenerator 流式模式

**用途**：全链路流式输出

```typescript
async function* query(params: QueryParams): AsyncGenerator<Message> {
  for await (const event of streamAPI()) {
    yield event
  }
}

// 消费
for await (const msg of query(params)) {
  console.log(msg)
}
```

**好处**：
- 低延迟：用户立即看到输出
- 可取消：通过 AbortController 中断
- 内存高效：不需要缓存完整响应

## 2. Builder + Factory 模式

**用途**：工具定义的安全默认值

```typescript
function buildTool<D extends ToolDef>(def: D): BuiltTool<D> {
  return {
    ...DEFAULTS,
    ...def,
  }
}

// 使用
const myTool = buildTool({
  name: 'MyTool',
  // 只需定义关键字段
})
```

## 3. Branded Types

**用途**：防止类型混淆

```typescript
type SystemPrompt = string & { __brand: 'SystemPrompt' }

function asSystemPrompt(s: string): SystemPrompt {
  return s as SystemPrompt
}

// 编译时防止字符串和系统提示词混淆
function callAPI(prompt: SystemPrompt) { /* ... */ }

callAPI('hello')  // 类型错误
callAPI(asSystemPrompt('hello'))  // 正确
```

## 4. Discriminated Unions

**用途**：类型安全的消息处理

```typescript
type Message =
  | { type: 'user'; content: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool_use'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string }

function handleMessage(msg: Message) {
  switch (msg.type) {
    case 'user':
      // msg.content 是 string
      break
    case 'tool_use':
      // msg.toolName 是 string
      break
  }
}
```

## 5. Observer + State Machine

**用途**：工具执行生命周期跟踪

```typescript
class StreamingToolExecutor {
  private tools: TrackedTool[] = []

  addTool(block: ToolUseBlock) {
    this.tools.push({ id: block.id, status: 'queued' })
    this.processQueue()
  }

  private async executeTool(tool: TrackedTool) {
    tool.status = 'executing'
    try {
      const result = await tool.call()
      tool.status = 'completed'
      tool.results = result
    } catch (error) {
      tool.status = 'error'
    }
  }
}
```

## 6. Snapshot State

**用途**：文件操作的撤销/重做

```typescript
type FileHistoryState = {
  snapshots: Map<string, FileSnapshot[]>
}

function makeSnapshot(state: FileHistoryState, path: string, content: string) {
  const snapshots = state.snapshots.get(path) || []
  snapshots.push({ content, timestamp: Date.now() })
  state.snapshots.set(path, snapshots)
}

function undo(state: FileHistoryState, path: string): string | null {
  const snapshots = state.snapshots.get(path)
  return snapshots?.pop()?.content ?? null
}
```

## 7. Fire-and-Forget Write

**用途**：非阻塞持久化

```typescript
// 用户消息：阻塞写入
await recordTranscript(userMessage)

// 助手消息：异步写入（不阻塞）
recordTranscript(assistantMessage)  // 不 await
```

## 8. Lazy Schema

**用途**：延迟 Zod schema 求值

```typescript
function lazySchema<T>(factory: () => z.ZodType<T>): z.ZodType<T> {
  return z.lazy(factory)
}

// 使用
const recursiveSchema = lazySchema(() => z.object({
  name: z.string(),
  children: z.array(recursiveSchema),
}))
```

## 9. Context Isolation

**用途**：共享进程中的每 Agent 上下文

```typescript
import { AsyncLocalStorage } from 'async_hooks'

const agentContext = new AsyncLocalStorage<AgentContext>()

function runAgent<T>(context: AgentContext, fn: () => T): T {
  return agentContext.run(context, fn)
}

function getContext(): AgentContext | undefined {
  return agentContext.getStore()
}
```

## 10. Ring Buffer

**用途**：长会话的有界内存

```typescript
class RingBuffer<T> {
  private buffer: T[]
  private head = 0
  private size = 0

  constructor(private capacity: number) {
    this.buffer = new Array(capacity)
  }

  push(item: T) {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    this.size = Math.min(this.size + 1, this.capacity)
  }

  toArray(): T[] {
    if (this.size < this.capacity) {
      return this.buffer.slice(0, this.size)
    }
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)]
  }
}
```

---

**文档完成！**

本系列文档完整覆盖了 Claude Code 的核心架构和实现细节。通过阅读和实践，你应该能够：

1. 理解 AI Agent CLI 的核心原理
2. 实现自己的 Agent 循环和工具系统
3. 构建生产级的权限和上下文管理
4. 设计可扩展的 CLI 架构

如有问题，请参考源码或提交 Issue。
