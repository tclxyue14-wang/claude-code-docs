---
title: 第四章：权限系统
---

# 第四章：权限系统

> 理解 Claude Code 的多层权限机制，掌握安全的工具调用授权。

## 一、概念解释

### 为什么需要权限系统？

AI Agent 可以执行任意代码、修改文件、发送网络请求。没有权限控制：

- **数据泄露风险**：AI 可能读取敏感文件
- **破坏风险**：AI 可能删除重要文件
- **安全风险**：AI 可能执行恶意命令

### 权限检查流程

```
Tool Call 请求
    │
    ▼
┌─────────────────────┐
│  validateInput()    │  ← 校验参数有效性
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  PreToolUse Hooks   │  ← 用户定义的前置钩子
│  (settings.json)    │     可 approve/deny/修改输入
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Permission Rules   │  ← 权限规则匹配
│  ├─ alwaysAllow     │     自动批准
│  ├─ alwaysDeny      │     自动拒绝
│  └─ alwaysAsk       │     总是询问
└──────────┬──────────┘
           │ 无匹配规则?
           ▼
┌─────────────────────┐
│  Interactive Prompt │  ← 交互式确认
│  Allow Once / Always│     用户决定
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  checkPermissions() │  ← 工具特定检查
│  (Tool 级别)         │     如路径沙箱
└──────────┬──────────┘
           │
           ▼
       APPROVED → tool.call()
```

### 权限模式

Claude Code 支持多种权限模式：

| 模式 | 说明 |
|------|------|
| `default` | 默认模式，需要用户确认 |
| `plan` | 规划模式，只读操作自动批准 |
| `auto` | 自动模式，所有操作自动批准（高风险） |
| `bypass` | 绕过模式，跳过所有检查（内部使用） |

## 二、源码分析

### 权限上下文定义

位置：`src/Tool.ts`

```typescript
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode                                    // 权限模式
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>  // 额外工作目录
  alwaysAllowRules: ToolPermissionRulesBySource           // 自动批准规则
  alwaysDenyRules: ToolPermissionRulesBySource            // 自动拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource             // 总是询问规则
  isBypassPermissionsModeAvailable: boolean              // 绕过模式是否可用
  isAutoModeAvailable?: boolean                           // 自动模式是否可用
  strippedDangerousRules?: ToolPermissionRulesBySource    // 已剥离的危险规则
  shouldAvoidPermissionPrompts?: boolean                  // 避免提示（后台 Agent）
  awaitAutomatedChecksBeforeDialog?: boolean              // 等待自动检查
  prePlanMode?: PermissionMode                             // 进入规划模式前的模式
}>
```

### 权限规则结构

```typescript
// 权限规则按来源分组
type ToolPermissionRulesBySource = {
  [source: string]: ToolPermissionRule[]
}

type ToolPermissionRule = {
  toolPattern: string       // 工具名模式，如 "Bash", "Bash(git *)"
  behavior: 'allow' | 'deny' | 'ask'
  source: string           // 来源（CLI、设置文件、会话决策）
  timestamp: number        // 时间戳
}
```

### canUseTool 函数

位置：`src/hooks/useCanUseTool.tsx`

```typescript
export type CanUseToolFn = (
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
  options?: CanUseToolOptions,
) => Promise<CanUseToolResult>

export type CanUseToolResult =
  | { result: 'allow'; updatedInput?: unknown }
  | { result: 'deny'; reason: string }
  | { result: 'ask'; message: string }

// 核心实现
export async function canUseTool(
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
  options?: CanUseToolOptions,
): Promise<CanUseToolResult> {
  const permContext = context.toolPermissionContext

  // 1. 绕过模式：直接允许
  if (permContext.mode === 'bypass') {
    return { result: 'allow' }
  }

  // 2. 自动模式：自动批准（除非危险）
  if (permContext.mode === 'auto' && !tool.isDestructive?.(input)) {
    return { result: 'allow' }
  }

  // 3. 规划模式：只读操作自动批准
  if (permContext.mode === 'plan' && tool.isReadOnly(input)) {
    return { result: 'allow' }
  }

  // 4. 执行 PreToolUse Hooks
  const hookResult = await executePreToolUseHooks(tool.name, input, context)
  if (hookResult.result === 'deny') {
    return hookResult
  }
  if (hookResult.result === 'allow') {
    return hookResult
  }

  // 5. 检查 alwaysDeny 规则
  const denyRule = matchRule(tool.name, input, permContext.alwaysDenyRules)
  if (denyRule) {
    return { result: 'deny', reason: `Rule: ${denyRule.toolPattern}` }
  }

  // 6. 检查 alwaysAllow 规则
  const allowRule = matchRule(tool.name, input, permContext.alwaysAllowRules)
  if (allowRule) {
    return { result: 'allow', updatedInput: hookResult.updatedInput }
  }

  // 7. 检查 alwaysAsk 规则
  const askRule = matchRule(tool.name, input, permContext.alwaysAskRules)
  if (askRule) {
    return { result: 'ask', message: `Tool requires permission: ${tool.name}` }
  }

  // 8. 默认：询问用户
  return { result: 'ask', message: `Allow ${tool.name}?` }
}
```

### 规则匹配

```typescript
function matchRule(
  toolName: string,
  input: unknown,
  rules: ToolPermissionRulesBySource,
): ToolPermissionRule | null {
  for (const sourceRules of Object.values(rules)) {
    for (const rule of sourceRules) {
      if (matchToolPattern(rule.toolPattern, toolName, input)) {
        return rule
      }
    }
  }
  return null
}

function matchToolPattern(
  pattern: string,
  toolName: string,
  input: unknown,
): boolean {
  // 简单模式：直接匹配工具名
  if (pattern === toolName) {
    return true
  }

  // 带参数的模式：Bash(git *)
  const match = pattern.match(/^(\w+)\((.+)\)$/)
  if (match) {
    const [, patternTool, paramPattern] = match
    if (patternTool !== toolName) return false

    // 对 Bash 工具，匹配命令
    if (toolName === 'Bash' && typeof input === 'object' && input !== null) {
      const command = (input as { command?: string }).command || ''
      return minimatch(command, paramPattern)
    }
  }

  return false
}
```

## 三、从零实现权限系统

### 最简版本

```typescript
// minimal-permission.ts
type PermissionRule = {
  toolPattern: string
  behavior: 'allow' | 'deny' | 'ask'
}

type PermissionContext = {
  mode: 'default' | 'auto' | 'plan' | 'bypass'
  rules: PermissionRule[]
}

async function checkPermission(
  toolName: string,
  input: unknown,
  context: PermissionContext,
): Promise<'allow' | 'deny' | { ask: true; message: string }> {
  // 自动模式：全部允许
  if (context.mode === 'auto') {
    return 'allow'
  }

  // 规划模式：只读允许
  if (context.mode === 'plan') {
    // 这里需要工具配合判断
    return { ask: true, message: `Allow ${toolName}?` }
  }

  // 检查规则
  for (const rule of context.rules) {
    if (rule.toolPattern === toolName) {
      if (rule.behavior === 'allow') return 'allow'
      if (rule.behavior === 'deny') return 'deny'
      if (rule.behavior === 'ask') {
        return { ask: true, message: `Tool ${toolName} requires permission` }
      }
    }
  }

  // 默认询问
  return { ask: true, message: `Allow ${toolName}?` }
}
```

### 增强版本：支持模式匹配

```typescript
// permission-with-patterns.ts
import minimatch from 'minimatch'

type PermissionRule = {
  pattern: string  // 支持 glob 模式
  behavior: 'allow' | 'deny' | 'ask'
}

class PermissionSystem {
  private rules: PermissionRule[] = []

  addRule(pattern: string, behavior: 'allow' | 'deny' | 'ask') {
    this.rules.push({ pattern, behavior })
  }

  check(toolName: string, input: unknown): 'allow' | 'deny' | { ask: true; message: string } {
    for (const rule of this.rules) {
      if (this.matchPattern(rule.pattern, toolName, input)) {
        if (rule.behavior === 'allow') return 'allow'
        if (rule.behavior === 'deny') return 'deny'
        return { ask: true, message: `Tool ${toolName} requires permission` }
      }
    }
    return { ask: true, message: `Allow ${toolName}?` }
  }

  private matchPattern(pattern: string, toolName: string, input: unknown): boolean {
    // 直接匹配
    if (pattern === toolName) return true

    // glob 模式：Bash(git *)
    const match = pattern.match(/^(\w+)\((.+)\)$/)
    if (match) {
      const [, patternTool, paramPattern] = match
      if (patternTool !== toolName) return false

      // 提取输入参数
      const param = this.extractParam(toolName, input)
      if (!param) return false

      return minimatch(param, paramPattern)
    }

    // 工具名 glob：Bash*
    if (pattern.includes('*')) {
      return minimatch(toolName, pattern)
    }

    return false
  }

  private extractParam(toolName: string, input: unknown): string | null {
    if (typeof input !== 'object' || input === null) return null

    switch (toolName) {
      case 'Bash':
        return (input as any).command || null
      case 'Read':
      case 'Edit':
      case 'Write':
        return (input as any).file_path || null
      default:
        return null
    }
  }
}

// 使用示例
const perm = new PermissionSystem()

// 添加规则
perm.addRule('Read', 'allow')                    // 读取文件自动批准
perm.addRule('Bash(git status*)', 'allow')       // git status 自动批准
perm.addRule('Bash(git push*)', 'ask')           // git push 需要确认
perm.addRule('Bash(rm *)', 'deny')               // rm 命令禁止
perm.addRule('Bash(*)', 'ask')                   // 其他 Bash 命令需要确认

// 检查权限
console.log(perm.check('Read', { file_path: '/tmp/a.txt' }))  // 'allow'
console.log(perm.check('Bash', { command: 'git status' }))     // 'allow'
console.log(perm.check('Bash', { command: 'rm -rf /' }))       // 'deny'
```

### 完整版本：Hook 系统

```typescript
// permission-with-hooks.ts
type HookResult =
  | { action: 'approve' }
  | { action: 'deny'; reason: string }
  | { action: 'modify'; input: unknown }
  | { action: 'continue' }  // 继续正常权限检查

type PreToolUseHook = (
  toolName: string,
  input: unknown,
  context: HookContext,
) => Promise<HookResult>

type HookContext = {
  cwd: string
  sessionId: string
  // ...
}

class PermissionSystemWithHooks {
  private rules: PermissionRule[] = []
  private hooks: PreToolUseHook[] = []

  addHook(hook: PreToolUseHook) {
    this.hooks.push(hook)
  }

  async check(
    toolName: string,
    input: unknown,
    context: HookContext,
  ): Promise<{ allowed: boolean; input?: unknown; reason?: string }> {
    // 1. 执行 Hooks
    for (const hook of this.hooks) {
      const result = await hook(toolName, input, context)

      if (result.action === 'approve') {
        return { allowed: true, input }
      }
      if (result.action === 'deny') {
        return { allowed: false, reason: result.reason }
      }
      if (result.action === 'modify') {
        input = result.input  // 更新输入，继续检查
      }
      // 'continue' 继续
    }

    // 2. 检查规则
    const ruleResult = this.checkRules(toolName, input)
    if (ruleResult !== 'ask') {
      return {
        allowed: ruleResult === 'allow',
        input,
        reason: ruleResult === 'deny' ? 'Denied by rule' : undefined,
      }
    }

    // 3. 交互式询问（返回给调用者处理）
    return {
      allowed: false,  // 需要交互
      reason: 'NEEDS_INTERACTION',
    }
  }

  private checkRules(toolName: string, input: unknown): 'allow' | 'deny' | 'ask' {
    for (const rule of this.rules) {
      if (this.matchPattern(rule.pattern, toolName, input)) {
        return rule.behavior
      }
    }
    return 'ask'
  }

  // ... matchPattern 同上
}

// 使用示例
const perm = new PermissionSystemWithHooks()

// 添加 Hook：检查敏感文件
perm.addHook(async (toolName, input, context) => {
  const sensitivePatterns = ['.env', '.pem', '.key', 'credentials']

  const filePath = (input as any)?.file_path || (input as any)?.path
  if (filePath && sensitivePatterns.some(p => filePath.includes(p))) {
    return {
      action: 'deny',
      reason: `Access to sensitive file blocked: ${filePath}`,
    }
  }

  return { action: 'continue' }
})

// 添加 Hook：记录所有工具调用
perm.addHook(async (toolName, input, context) => {
  console.log(`[${new Date().toISOString()}] ${toolName}: ${JSON.stringify(input)}`)
  return { action: 'continue' }
})

// 添加 Hook：修改输入（展开 ~）
perm.addHook(async (toolName, input, context) => {
  if (typeof input === 'object' && input !== null) {
    const modified = { ...input }
    for (const key of ['file_path', 'path', 'command']) {
      if (key in modified && typeof modified[key] === 'string') {
        modified[key] = modified[key].replace('~', process.env.HOME || '~')
      }
    }
    return { action: 'modify', input: modified }
  }
  return { action: 'continue' }
})
```

## 四、交互式确认 UI

### 实现确认对话框

```typescript
// permission-dialog.ts
import * as readline from 'readline'

type PermissionDialog = {
  toolName: string
  input: unknown
  message: string
}

async function askPermission(dialog: PermissionDialog): Promise<{
  decision: 'allow' | 'deny'
  remember: boolean
}> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    console.log('\n' + '='.repeat(50))
    console.log(`Tool: ${dialog.toolName}`)
    console.log(`Input: ${JSON.stringify(dialog.input, null, 2)}`)
    console.log(`Message: ${dialog.message}`)
    console.log('='.repeat(50))
    console.log('\nOptions:')
    console.log('  [y] Yes (allow once)')
    console.log('  [Y] Yes always (add to allow list)')
    console.log('  [n] No (deny once)')
    console.log('  [N] No always (add to deny list)')
    console.log('')

    rl.question('Your choice: ', answer => {
      rl.close()

      const lower = answer.toLowerCase()
      if (lower === 'y') {
        resolve({ decision: 'allow', remember: false })
      } else if (lower === 'yy' || answer === 'Y') {
        resolve({ decision: 'allow', remember: true })
      } else if (lower === 'n') {
        resolve({ decision: 'deny', remember: false })
      } else if (lower === 'nn' || answer === 'N') {
        resolve({ decision: 'deny', remember: true })
      } else {
        resolve({ decision: 'deny', remember: false })
      }
    })
  })
}
```

### 完整权限流程

```typescript
// complete-permission-flow.ts
class PermissionManager {
  private rules: PermissionRule[] = []
  private hooks: PreToolUseHook[] = []
  private decisions: Map<string, 'allow' | 'deny'> = new Map()  // 缓存决策

  async check(
    toolName: string,
    input: unknown,
    context: HookContext,
  ): Promise<{ allowed: boolean; input?: unknown }> {
    const key = this.getDecisionKey(toolName, input)

    // 1. 检查缓存决策
    if (this.decisions.has(key)) {
      return { allowed: this.decisions.get(key) === 'allow' }
    }

    // 2. 执行 Hooks
    for (const hook of this.hooks) {
      const result = await hook(toolName, input, context)
      if (result.action === 'approve') {
        return { allowed: true, input }
      }
      if (result.action === 'deny') {
        return { allowed: false, reason: result.reason }
      }
      if (result.action === 'modify') {
        input = result.input
      }
    }

    // 3. 检查规则
    const ruleResult = this.checkRules(toolName, input)
    if (ruleResult !== 'ask') {
      return { allowed: ruleResult === 'allow', input }
    }

    // 4. 交互式询问
    const dialogResult = await askPermission({
      toolName,
      input,
      message: `Allow ${toolName}?`,
    })

    // 5. 记住决策
    if (dialogResult.remember) {
      this.decisions.set(key, dialogResult.decision)

      // 添加规则
      const pattern = this.createPattern(toolName, input)
      this.rules.push({
        pattern,
        behavior: dialogResult.decision,
      })
    }

    return {
      allowed: dialogResult.decision === 'allow',
      input,
    }
  }

  private getDecisionKey(toolName: string, input: unknown): string {
    return `${toolName}:${JSON.stringify(input)}`
  }

  private createPattern(toolName: string, input: unknown): string {
    // 为 Bash 命令创建模式
    if (toolName === 'Bash' && typeof input === 'object') {
      const cmd = (input as any).command
      if (cmd) {
        // 提取命令前缀：git status → git*
        const prefix = cmd.split(' ')[0]
        return `Bash(${prefix}*)`
      }
    }
    return toolName
  }
}
```

## 五、最佳实践

### 1. 分层权限设计

```typescript
// 按风险级别分层
const RISK_LEVELS = {
  LOW: ['Read', 'Glob', 'Grep', 'WebFetch'],      // 低风险，自动批准
  MEDIUM: ['Edit', 'Write'],                       // 中风险，需要确认
  HIGH: ['Bash', 'Execute'],                       // 高风险，严格检查
  CRITICAL: ['Delete', 'Publish'],                 // 关键操作，始终确认
}

function getRiskLevel(toolName: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  for (const [level, tools] of Object.entries(RISK_LEVELS)) {
    if (tools.includes(toolName)) {
      return level as any
    }
  }
  return 'HIGH'  // 未知工具视为高风险
}
```

### 2. 敏感路径保护

```typescript
const SENSITIVE_PATHS = [
  '.env',
  '.pem',
  '.key',
  'id_rsa',
  'credentials',
  'secrets',
  '.git/config',
]

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some(sensitive =>
    path.includes(sensitive)
  )
}

// 在 Hook 中使用
perm.addHook(async (toolName, input) => {
  const path = (input as any)?.file_path || (input as any)?.path
  if (path && isSensitivePath(path)) {
    return {
      action: 'deny',
      reason: `Access to sensitive path blocked: ${path}`,
    }
  }
  return { action: 'continue' }
})
```

### 3. 沙箱目录

```typescript
class SandboxChecker {
  private allowedDirs: Set<string>

  constructor(allowedDirs: string[]) {
    this.allowedDirs = new Set(allowedDirs.map(d => path.resolve(d)))
  }

  isAllowed(filePath: string): boolean {
    const resolved = path.resolve(filePath)
    return Array.from(this.allowedDirs).some(dir =>
      resolved.startsWith(dir)
    )
  }
}

// 使用
const sandbox = new SandboxChecker(['/home/user/project', '/tmp'])

// 在权限检查中使用
if (!sandbox.isAllowed(input.file_path)) {
  return { action: 'deny', reason: 'Path outside sandbox' }
}
```

---

下一章：[05-context-management.md](./05-context-management.md) - 深入上下文管理
