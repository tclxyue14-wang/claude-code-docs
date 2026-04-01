---
title: 第十章：CLI 基础设施
---

# 第十章：CLI 基础设施

> 理解 Claude Code 的命令行入口、参数解析和启动流程。

## 一、概念解释

### CLI 架构层次

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI 入口层                                 │
│  main.tsx                                                        │
│    ├── 参数解析 (commander)                                       │
│    ├── 配置加载 (settings.json)                                   │
│    ├── 认证检查 (OAuth/API Key)                                   │
│    └── 启动 REPL 或 SDK 模式                                      │
├─────────────────────────────────────────────────────────────────┤
│                        命令层                                     │
│  commands/                                                       │
│    ├── /help      → 显示帮助                                      │
│    ├── /config    → 配置管理                                      │
│    ├── /login     → 认证                                          │
│    ├── /compact   → 上下文压缩                                    │
│    ├── /resume    → 恢复会话                                      │
│    └── ...80+ 命令                                                │
├─────────────────────────────────────────────────────────────────┤
│                        服务层                                     │
│  services/                                                       │
│    ├── api/        → API 客户端                                   │
│    ├── mcp/        → MCP 连接                                     │
│    └── analytics/  → 遥测                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 启动流程

```
1. 解析命令行参数
2. 加载全局配置
3. 检查认证状态
4. 初始化 MCP 服务器
5. 加载 Memory (CLAUDE.md)
6. 启动 REPL 或执行命令
```

## 二、源码分析

### 入口函数

位置：`src/main.tsx`

```typescript
// 命令行参数定义
const program = new CommanderCommand()

program
  .name('claude')
  .description('Claude Code - AI-powered coding assistant')
  .version(VERSION)
  .argument('[prompt]', 'Initial prompt')
  .option('-c, --continue', 'Continue last session')
  .option('-r, --resume <session>', 'Resume specific session')
  .option('-p, --print', 'Print mode (non-interactive)')
  .option('--model <model>', 'Model to use')
  .option('--dangerously-skip-permissions', 'Skip all permission checks')
  .option('--verbose', 'Verbose output')
  .action(async (prompt, options) => {
    await main(prompt, options)
  })

// 子命令
program
  .command('config')
  .description('Manage configuration')
  .action(() => { /* ... */ })

program.parse()

// 主函数
async function main(prompt: string | undefined, options: CliOptions) {
  // 1. 初始化
  await init()

  // 2. 检查认证
  const auth = await checkAuth()
  if (!auth.isLoggedIn) {
    await runLoginFlow()
    return
  }

  // 3. 加载配置
  const config = await loadConfig()

  // 4. 初始化 MCP
  await initMCP(config.mcpServers)

  // 5. 启动模式选择
  if (options.print) {
    await runPrintMode(prompt, options)
  } else if (prompt) {
    await runOneShotMode(prompt, options)
  } else {
    await launchRepl(options)
  }
}
```

### 斜杠命令

位置：`src/commands.ts`

```typescript
export type Command = {
  name: string
  description: string
  aliases?: string[]
  handler: CommandHandler
  completions?: CompletionProvider
}

export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => Promise<CommandResult>

// 命令注册
export const COMMANDS: Command[] = [
  {
    name: 'help',
    description: 'Show help',
    aliases: ['h', '?'],
    handler: async () => ({
      type: 'display',
      content: generateHelpText(),
    }),
  },
  {
    name: 'clear',
    description: 'Clear conversation',
    aliases: ['c'],
    handler: async (args, context) => {
      context.setMessages([])
      return { type: 'continue' }
    },
  },
  {
    name: 'compact',
    description: 'Compact conversation history',
    handler: async (args, context) => {
      const result = await autoCompact(context.messages)
      return {
        type: 'display',
        content: `Compacted: ${result.preCompactTokenCount} → ${result.postCompactTokenCount} tokens`,
      }
    },
  },
  // ... 80+ 其他命令
]

// 命令查找
export function findCommand(name: string): Command | undefined {
  return COMMANDS.find(cmd =>
    cmd.name === name || cmd.aliases?.includes(name)
  )
}
```

## 三、从零实现 CLI

### 最简 CLI

```typescript
// minimal-cli.ts
import { Command } from '@commander-js/extra-typings'

const program = new Command()

program
  .name('my-cli')
  .description('My CLI tool')
  .version('1.0.0')
  .argument('[prompt]', 'Initial prompt')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (prompt, options) => {
    if (prompt) {
      console.log(`Processing: ${prompt}`)
    } else {
      await startRepl()
    }
  })

program.parse()

async function startRepl() {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const ask = () => {
    rl.question('> ', async (input) => {
      if (input === '/exit') {
        rl.close()
        return
      }

      // 处理斜杠命令
      if (input.startsWith('/')) {
        await handleCommand(input)
      } else {
        // 处理普通输入
        console.log(`You said: ${input}`)
      }

      ask()
    })
  }

  ask()
}

async function handleCommand(input: string) {
  const [cmd, ...args] = input.slice(1).split(' ')

  switch (cmd) {
    case 'help':
      console.log('Available commands: /help, /exit, /clear')
      break
    case 'clear':
      console.clear()
      break
    default:
      console.log(`Unknown command: ${cmd}`)
  }
}
```

### 完整 CLI 框架

```typescript
// cli-framework.ts
import { Command, Option } from '@commander-js/extra-typings'
import chalk from 'chalk'

// 命令定义
type CommandHandler = (args: string[], context: Context) => Promise<void>

type SlashCommand = {
  name: string
  description: string
  aliases?: string[]
  handler: CommandHandler
}

// 上下文
type Context = {
  verbose: boolean
  config: Config
  messages: Message[]
}

// 配置
type Config = {
  apiKey?: string
  model: string
  maxTokens: number
}

class CLI {
  private commands: Map<string, SlashCommand> = new Map()
  private aliases: Map<string, string> = new Map()
  private context: Context

  constructor() {
    this.context = {
      verbose: false,
      config: { model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
      messages: [],
    }
  }

  // 注册命令
  registerCommand(command: SlashCommand) {
    this.commands.set(command.name, command)
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias, command.name)
      }
    }
  }

  // 解析命令行参数
  parseArgs(): { prompt?: string; options: Record<string, unknown> } {
    const program = new Command()

    program
      .name('my-agent')
      .version('1.0.0')
      .argument('[prompt]', 'Initial prompt')
      .option('-v, --verbose', 'Verbose output')
      .option('-m, --model <model>', 'Model to use')
      .option('-c, --continue', 'Continue last session')
      .option('--config <path>', 'Config file path')
      .addOption(
        new Option('--mode <mode>', 'Run mode')
          .choices(['repl', 'print', 'one-shot'])
          .default('repl'),
      )

    program.parse()
    const options = program.opts()
    const [prompt] = program.args

    return { prompt, options }
  }

  // 执行斜杠命令
  async executeCommand(input: string): Promise<boolean> {
    if (!input.startsWith('/')) return false

    const parts = input.slice(1).split(' ')
    const cmdName = parts[0]
    const args = parts.slice(1)

    // 查找命令
    const resolvedName = this.aliases.get(cmdName) || cmdName
    const command = this.commands.get(resolvedName)

    if (!command) {
      console.log(chalk.red(`Unknown command: /${cmdName}`))
      console.log(chalk.gray('Type /help for available commands'))
      return true
    }

    await command.handler(args, this.context)
    return true
  }

  // 启动 REPL
  async startRepl() {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log(chalk.cyan('Welcome! Type your message or /help for commands.'))

    const ask = () => {
      rl.question(chalk.green('> '), async (input) => {
        input = input.trim()

        if (!input) {
          ask()
          return
        }

        // 处理斜杠命令
        if (await this.executeCommand(input)) {
          ask()
          return
        }

        // 处理普通输入
        try {
          await this.processInput(input)
        } catch (error) {
          console.log(chalk.red(`Error: ${error}`))
        }

        ask()
      })
    }

    ask()
  }

  private async processInput(input: string) {
    // 调用 Agent 循环
    // ...
    console.log(`Processing: ${input}`)
  }
}

// 使用
const cli = new CLI()

// 注册命令
cli.registerCommand({
  name: 'help',
  description: 'Show available commands',
  aliases: ['h', '?'],
  handler: async (_, context) => {
    console.log(chalk.bold('Available commands:'))
    console.log('  /help     - Show this help')
    console.log('  /clear    - Clear conversation')
    console.log('  /exit     - Exit the program')
    console.log('  /config   - Show current config')
  },
})

cli.registerCommand({
  name: 'clear',
  description: 'Clear conversation',
  aliases: ['c'],
  handler: async (_, context) => {
    context.messages = []
    console.clear()
    console.log(chalk.gray('Conversation cleared'))
  },
})

cli.registerCommand({
  name: 'config',
  description: 'Show configuration',
  handler: async (_, context) => {
    console.log(chalk.bold('Current configuration:'))
    console.log(JSON.stringify(context.config, null, 2))
  },
})

cli.registerCommand({
  name: 'exit',
  description: 'Exit the program',
  aliases: ['quit', 'q'],
  handler: async () => {
    console.log(chalk.cyan('Goodbye!'))
    process.exit(0)
  },
})

// 启动
const { prompt, options } = cli.parseArgs()
if (prompt) {
  await cli.processInput(prompt)
} else {
  await cli.startRepl()
}
```

## 四、配置管理

```typescript
// config-manager.ts
import fs from 'fs/promises'
import path from 'path'

const CONFIG_DIR = path.join(process.env.HOME!, '.my-cli')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

type Config = {
  apiKey?: string
  model: string
  maxTokens: number
  mcpServers: Record<string, MCPServerConfig>
}

const DEFAULT_CONFIG: Config = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
  mcpServers: {},
}

async function loadConfig(): Promise<Config> {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8')
    const config = JSON.parse(content)
    return { ...DEFAULT_CONFIG, ...config }
  } catch {
    return DEFAULT_CONFIG
  }
}

async function saveConfig(config: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}
```

## 五、最佳实践

### 1. 优雅退出

```typescript
// 优雅退出处理
const cleanup = async () => {
  console.log('\nCleaning up...')
  // 保存状态
  // 关闭连接
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('beforeExit', cleanup)
```

### 2. 错误处理

```typescript
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
  // 记录错误
  // 清理资源
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection:', reason)
})
```

### 3. 进度显示

```typescript
// 长时间操作显示进度
async function withProgress<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0

  const interval = setInterval(() => {
    process.stdout.write(`\r${frames[i]} ${message}`)
    i = (i + 1) % frames.length
  }, 80)

  try {
    const result = await operation()
    clearInterval(interval)
    process.stdout.write(`\r✓ ${message}\n`)
    return result
  } catch (error) {
    clearInterval(interval)
    process.stdout.write(`\r✗ ${message}\n`)
    throw error
  }
}
```

---

下一章：[11-build-your-own.md](./11-build-your-own.md) - 实战：构建自己的 AI CLI
