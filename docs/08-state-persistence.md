---
title: 第八章：状态持久化
---

# 第八章：状态持久化

> 理解 Claude Code 如何持久化会话状态，实现崩溃恢复和会话恢复。

## 一、概念解释

### 为什么需要持久化？

1. **崩溃恢复**：进程意外退出后恢复进度
2. **会话恢复**：关闭后重新打开继续工作
3. **审计追踪**：记录所有操作便于调试
4. **成本追踪**：统计 API 使用量

### 持久化策略

| 数据类型 | 持久化方式 | 原因 |
|----------|------------|------|
| 用户消息 | 阻塞写入 | 确保不丢失 |
| 助手消息 | 异步写入 | 不阻塞响应 |
| 进度消息 | 即时写入 | 实时状态 |
| 会话元数据 | 延迟写入 | 批量优化 |

### 存储结构

```
~/.claude/
├── projects/
│   └── <project-hash>/
│       ├── sessions/
│       │   ├── <session-id-1>.jsonl
│       │   └── <session-id-2>.jsonl
│       ├── memory/
│       │   └── MEMORY.md
│       └── settings.json
└── settings.json
```

## 二、源码分析

### 会话存储

位置：`src/utils/sessionStorage.ts`

```typescript
// 写入会话记录
export async function recordTranscript(
  message: Message,
  agentId?: string,
): Promise<void> {
  const sessionId = getSessionId()
  const sessionFile = getSessionFile(sessionId, agentId)

  // JSONL 格式：每行一个 JSON 对象
  const line = JSON.stringify({
    ...message,
    timestamp: Date.now(),
  }) + '\n'

  // 用户消息阻塞写入
  if (message.type === 'user') {
    await fs.appendFile(sessionFile, line)
  } else {
    // 其他消息异步写入
    fs.appendFile(sessionFile, line).catch(logError)
  }
}

// 读取最后会话
export function getLastSessionLog(cwd: string): Message[] {
  const sessionFile = findLatestSessionFile(cwd)
  if (!sessionFile) return []

  const content = fs.readFileSync(sessionFile, 'utf-8')
  return content
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}
```

### 文件历史

```typescript
// 文件编辑快照
export type FileHistoryState = {
  snapshots: Map<string, FileSnapshot[]>
}

export type FileSnapshot = {
  content: string
  timestamp: number
  operation: 'edit' | 'write'
}

// 创建快照
export function fileHistoryMakeSnapshot(
  state: FileHistoryState,
  filePath: string,
  content: string,
  operation: 'edit' | 'write',
): void {
  const snapshots = state.snapshots.get(filePath) || []
  snapshots.push({
    content,
    timestamp: Date.now(),
    operation,
  })

  // 保留最近 10 个快照
  if (snapshots.length > 10) {
    snapshots.shift()
  }

  state.snapshots.set(filePath, snapshots)
}

// 撤销
export function fileHistoryUndo(
  state: FileHistoryState,
  filePath: string,
): string | null {
  const snapshots = state.snapshots.get(filePath)
  if (!snapshots || snapshots.length === 0) return null

  const last = snapshots.pop()!
  return last.content
}
```

## 三、从零实现持久化

### 会话管理器

```typescript
// session-manager.ts
import fs from 'fs/promises'
import path from 'path'

type Message = {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content: string | unknown
  timestamp: number
}

class SessionManager {
  private sessionDir: string
  private sessionId: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(baseDir: string, sessionId?: string) {
    this.sessionDir = baseDir
    this.sessionId = sessionId || this.generateSessionId()
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  getSessionFile(): string {
    return path.join(this.sessionDir, `${this.sessionId}.jsonl`)
  }

  // 阻塞写入用户消息
  async recordUserMessage(content: string): Promise<void> {
    const message: Message = {
      type: 'user',
      content,
      timestamp: Date.now(),
    }
    await this.writeLine(message)
  }

  // 异步写入助手消息
  recordAssistantMessage(content: string): void {
    const message: Message = {
      type: 'assistant',
      content,
      timestamp: Date.now(),
    }
    this.writeLineAsync(message)
  }

  private async writeLine(message: Message): Promise<void> {
    const line = JSON.stringify(message) + '\n'
    await fs.appendFile(this.getSessionFile(), line)
  }

  private writeLineAsync(message: Message): void {
    const line = JSON.stringify(message) + '\n'
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.getSessionFile(), line))
      .catch(console.error)
  }

  // 读取会话
  async loadSession(): Promise<Message[]> {
    try {
      const content = await fs.readFile(this.getSessionFile(), 'utf-8')
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    } catch {
      return []
    }
  }

  // 列出所有会话
  async listSessions(): Promise<string[]> {
    const files = await fs.readdir(this.sessionDir)
    return files.filter(f => f.endsWith('.jsonl'))
  }

  // 删除旧会话
  async cleanOldSessions(keepCount: number = 10): Promise<void> {
    const sessions = await this.listSessions()
    if (sessions.length <= keepCount) return

    // 按时间排序
    const sorted = sessions.sort().reverse()
    const toDelete = sorted.slice(keepCount)

    for (const file of toDelete) {
      await fs.unlink(path.join(this.sessionDir, file))
    }
  }
}

// 使用
const manager = new SessionManager('/home/user/.claude/projects/my-project/sessions')

await manager.recordUserMessage('帮我创建一个新文件')
manager.recordAssistantMessage('好的，我来创建...')

// 恢复会话
const messages = await manager.loadSession()
```

### 成本追踪

```typescript
// cost-tracker.ts
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type CostTrackerState = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  requests: RequestRecord[]
}

type RequestRecord = {
  timestamp: number
  model: string
  usage: Usage
  cost: number
}

// 价格表 (每百万 token)
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
}

class CostTracker {
  private state: CostTrackerState = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    requests: [],
  }

  recordUsage(model: string, usage: Usage): number {
    const prices = PRICES[model] || PRICES['claude-sonnet-4-20250514']

    const inputCost = (usage.input_tokens / 1_000_000) * prices.input
    const outputCost = (usage.output_tokens / 1_000_000) * prices.output

    const cost = inputCost + outputCost

    this.state.totalInputTokens += usage.input_tokens
    this.state.totalOutputTokens += usage.output_tokens
    this.state.totalCost += cost
    this.state.requests.push({
      timestamp: Date.now(),
      model,
      usage,
      cost,
    })

    return cost
  }

  getTotalCost(): number {
    return this.state.totalCost
  }

  getTotalTokens(): { input: number; output: number } {
    return {
      input: this.state.totalInputTokens,
      output: this.state.totalOutputTokens,
    }
  }

  getRecentRequests(count: number = 10): RequestRecord[] {
    return this.state.requests.slice(-count)
  }

  // 持久化
  save(): string {
    return JSON.stringify(this.state)
  }

  load(data: string): void {
    this.state = JSON.parse(data)
  }
}
```

## 四、最佳实践

### 1. 原子写入

```typescript
// 使用临时文件 + rename 保证原子性
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, content)
  await fs.rename(tempPath, filePath)
}
```

### 2. 写入队列

```typescript
// 保证写入顺序
class WriteQueue {
  private queue: Promise<void> = Promise.resolve()

  enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(console.error)
  }

  async flush(): Promise<void> {
    await this.queue
  }
}
```

### 3. 压缩旧日志

```typescript
async function compactOldLogs(
  sessionFile: string,
  keepMessages: number = 100,
): Promise<void> {
  const content = await fs.readFile(sessionFile, 'utf-8')
  const messages = content.trim().split('\n')

  if (messages.length <= keepMessages) return

  // 保留最近的消息
  const toKeep = messages.slice(-keepMessages)

  // 生成摘要
  const toCompact = messages.slice(0, -keepMessages)
  const summary = await generateSummary(toCompact)

  // 写入压缩后的文件
  const compacted = [
    JSON.stringify({ type: 'summary', content: summary }),
    ...toKeep,
  ].join('\n')

  await fs.writeFile(sessionFile, compacted)
}
```

---

下一章：[09-terminal-ui.md](./09-terminal-ui.md) - 深入终端 UI 实现
