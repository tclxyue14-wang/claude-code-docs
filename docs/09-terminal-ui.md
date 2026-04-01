---
title: 第九章：终端 UI 实现
---

# 第九章：终端 UI 实现

> 理解 Claude Code 如何使用 React + Ink 构建终端用户界面。

## 一、概念解释

### 什么是 Ink？

Ink 是一个 React 框架，用于构建命令行界面：

```jsx
// React 组件渲染到终端
import React from 'react'
import { render, Text, Box } from 'ink'

const App = () => (
  <Box flexDirection="column">
    <Text color="green">Hello, World!</Text>
  </Box>
)

render(<App />)
```

### 核心组件

| 组件 | 用途 |
|------|------|
| `<Box>` | 布局容器 |
| `<Text>` | 文本显示 |
| `<Spinner>` | 加载指示器 |
| `<TextInput>` | 用户输入 |
| `<Select>` | 选择列表 |

### Claude Code UI 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         REPL.tsx                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ MessageList                                                │  │
│  │   ├── UserMessage                                          │  │
│  │   ├── AssistantMessage                                     │  │
│  │   │     ├── TextBlock                                      │  │
│  │   │     └── ToolUseBlock                                   │  │
│  │   └── ToolResultBlock                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ PromptInput                                                │  │
│  │   ├── TextInput                                            │  │
│  │   ├── Suggestions                                          │  │
│  │   └── StatusBar                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 二、源码分析

### 主入口

位置：`src/main.tsx`

```typescript
// 启动 REPL
async function launchRepl(options: ReplOptions) {
  const { waitUntilExit } = render(
    <AppStateProvider>
      <REPL options={options} />
    </AppStateProvider>,
    {
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await waitUntilExit()
}
```

### REPL 组件

位置：`src/components/REPL.tsx`

```typescript
const REPL: React.FC<{ options: ReplOptions }> = ({ options }) => {
  const [messages, setMessages] = useState<Message[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // 处理用户输入
  const handleSubmit = async (input: string) => {
    if (isProcessing) return

    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setIsProcessing(true)

    try {
      // 添加用户消息
      const userMessage = createUserMessage(input)
      setMessages(prev => [...prev, userMessage])

      // 调用 Agent 循环
      for await (const event of query({
        messages: [...messages, userMessage],
        systemPrompt: options.systemPrompt,
        toolUseContext: options.toolUseContext,
        canUseTool: options.canUseTool,
      })) {
        // 更新 UI
        setMessages(prev => [...prev, event])
      }
    } finally {
      setIsProcessing(false)
    }
  }

  // 处理中断
  const handleInterrupt = () => {
    abortControllerRef.current?.abort()
  }

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      <PromptInput
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        isProcessing={isProcessing}
      />
    </Box>
  )
}
```

### 消息渲染

```typescript
const MessageList: React.FC<{ messages: Message[] }> = ({ messages }) => {
  return (
    <Box flexDirection="column">
      {messages.map((message, index) => (
        <MessageRenderer key={index} message={message} />
      ))}
    </Box>
  )
}

const MessageRenderer: React.FC<{ message: Message }> = ({ message }) => {
  switch (message.type) {
    case 'user':
      return <UserMessage message={message} />
    case 'assistant':
      return <AssistantMessage message={message} />
    case 'tool_use':
      return <ToolUseMessage message={message} />
    case 'tool_result':
      return <ToolResultMessage message={message} />
    default:
      return null
  }
}
```

## 三、从零实现终端 UI

### 最简 REPL

```typescript
// minimal-repl.tsx
import React, { useState } from 'react'
import { render, Box, Text, TextInput } from 'ink'

const App: React.FC = () => {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<string[]>([])

  const handleSubmit = () => {
    if (!input.trim()) return
    setMessages(prev => [...prev, `You: ${input}`])
    setMessages(prev => [...prev, `AI: Processing "${input}"...`])
    setInput('')
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <Text key={i}>{msg}</Text>
        ))}
      </Box>
      <Box>
        <Text color="cyan">&gt; </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
        />
      </Box>
    </Box>
  )
}

render(<App />)
```

### 带流式输出的 REPL

```typescript
// streaming-repl.tsx
import React, { useState, useRef } from 'react'
import { render, Box, Text, TextInput, Spinner } from 'ink'

const App: React.FC = () => {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([])
  const [currentOutput, setCurrentOutput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const handleSubmit = async (input: string) => {
    if (isProcessing) return

    const abortController = new AbortController()
    abortRef.current = abortController
    setIsProcessing(true)
    setCurrentOutput('')

    // 添加用户消息
    setMessages(prev => [...prev, { role: 'user', content: input }])

    try {
      // 模拟流式输出
      for (const char of 'Hello! This is a streaming response...') {
        if (abortController.signal.aborted) break
        setCurrentOutput(prev => prev + char)
        await new Promise(r => setTimeout(r, 50))
      }

      // 完成后添加到消息列表
      setMessages(prev => [...prev, { role: 'assistant', content: currentOutput }])
    } finally {
      setIsProcessing(false)
      setCurrentOutput('')
    }
  }

  const handleInterrupt = () => {
    abortRef.current?.abort()
    setIsProcessing(false)
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text bold color={msg.role === 'user' ? 'cyan' : 'green'}>
              {msg.role === 'user' ? 'You' : 'Claude'}:{' '}
            </Text>
            <Text>{msg.content}</Text>
          </Box>
        ))}
        {isProcessing && (
          <Box>
            <Text bold color="green">Claude: </Text>
            <Text>{currentOutput}</Text>
            <Spinner type="dots" />
          </Box>
        )}
      </Box>
      <PromptInput
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        isProcessing={isProcessing}
      />
    </Box>
  )
}

const PromptInput: React.FC<{
  onSubmit: (input: string) => void
  onInterrupt: () => void
  isProcessing: boolean
}> = ({ onSubmit, onInterrupt, isProcessing }) => {
  const [input, setInput] = useState('')

  // 监听 Ctrl+C
  React.useEffect(() => {
    const handleKey = (key: string) => {
      if (key === '\x03') {  // Ctrl+C
        if (isProcessing) {
          onInterrupt()
        } else {
          process.exit(0)
        }
      }
    }

    process.stdin.on('data', handleKey)
    return () => { process.stdin.off('data', handleKey) }
  }, [isProcessing, onInterrupt])

  return (
    <Box>
      <Text color="cyan" bold>&gt; </Text>
      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={() => {
          onSubmit(input)
          setInput('')
        }}
        placeholder={isProcessing ? 'Processing... (Ctrl+C to interrupt)' : 'Type your message...'}
      />
    </Box>
  )
}

render(<App />)
```

## 四、高级组件

### Spinner 组件

```typescript
// spinner.tsx
import React, { useState, useEffect } from 'react'
import { Text } from 'ink'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const Spinner: React.FC<{ message?: string }> = ({ message = 'Loading' }) => {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(prev => (prev + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <Text>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      {' '}{message}...
    </Text>
  )
}
```

### 进度条

```typescript
// progress-bar.tsx
import React from 'react'
import { Text, Box } from 'ink'

export const ProgressBar: React.FC<{
  current: number
  total: number
  width?: number
}> = ({ current, total, width = 40 }) => {
  const percent = Math.min(current / total, 1)
  const filled = Math.round(width * percent)
  const empty = width - filled

  return (
    <Box>
      <Text>[</Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text>]</Text>
      <Text> {Math.round(percent * 100)}%</Text>
    </Box>
  )
}
```

## 五、最佳实践

### 1. 响应式布局

```typescript
import { useStdout } from 'ink'

const ResponsiveComponent: React.FC = () => {
  const { stdout } = useStdout()
  const width = stdout?.columns || 80

  return (
    <Box width={width} flexDirection="column">
      {/* 根据宽度调整布局 */}
    </Box>
  )
}
```

### 2. 颜色主题

```typescript
const theme = {
  primary: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  muted: 'gray',
}

const ThemedText: React.FC<{ type: keyof typeof theme; children: string }> = ({
  type,
  children,
}) => <Text color={theme[type]}>{children}</Text>
```

### 3. 按键处理

```typescript
import { useInput } from 'ink'

const App: React.FC = () => {
  useInput((input, key) => {
    if (key.escape) {
      // 处理 Escape
    }
    if (key.return) {
      // 处理 Enter
    }
    if (key.ctrl && input === 'c') {
      // 处理 Ctrl+C
    }
  })

  return <Box>...</Box>
}
```

---

下一章：[10-cli-infrastructure.md](./10-cli-infrastructure.md) - 深入 CLI 基础设施
