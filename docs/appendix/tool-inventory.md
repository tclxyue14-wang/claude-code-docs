---
title: 附录 A：工具清单
---

# 附录 A：工具清单

Claude Code v2.1.88 内置工具完整清单。

## 文件操作

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Read` | 读取文件内容（支持 PDF、图片） | ✓ | ✓ |
| `Edit` | 字符串替换编辑文件 | ✗ | ✗ |
| `Write` | 创建或覆盖文件 | ✗ | ✗ |
| `NotebookEdit` | 编辑 Jupyter Notebook | ✗ | ✗ |

## 搜索发现

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Glob` | 文件模式匹配搜索 | ✓ | ✓ |
| `Grep` | 内容搜索（基于 ripgrep） | ✓ | ✓ |
| `ToolSearch` | 搜索可用工具 | ✓ | ✓ |

## 执行

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Bash` | 执行 Shell 命令 | ✗ | 取决于命令 |
| `PowerShell` | 执行 PowerShell 命令 | ✗ | 取决于命令 |

## 网络

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `WebFetch` | 获取网页内容 | ✓ | ✓ |
| `WebSearch` | 网页搜索 | ✓ | ✓ |

## Agent / Task

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Agent` | 生成子 Agent | ✓ | ✓ |
| `SendMessage` | Agent 间通信 | ✓ | ✓ |
| `TaskCreate` | 创建任务 | ✓ | ✗ |
| `TaskGet` | 获取任务状态 | ✓ | ✓ |
| `TaskUpdate` | 更新任务 | ✓ | ✗ |
| `TaskList` | 列出任务 | ✓ | ✓ |
| `TaskStop` | 停止任务 | ✓ | ✗ |
| `TaskOutput` | 获取任务输出 | ✓ | ✓ |
| `TeamCreate` | 创建团队 | ✓ | ✗ |
| `TeamDelete` | 删除团队 | ✓ | ✗ |

## 交互

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `AskUserQuestion` | 向用户提问 | ✓ | ✓ |
| `Brief` | 简要报告 | ✓ | ✓ |

## 规划 / 工作流

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `EnterPlanMode` | 进入规划模式 | ✓ | ✓ |
| `ExitPlanMode` | 退出规划模式 | ✓ | ✓ |
| `EnterWorktree` | 进入工作树 | ✓ | ✗ |
| `ExitWorktree` | 退出工作树 | ✓ | ✗ |
| `TodoWrite` | 写入待办列表 | ✓ | ✗ |

## MCP 协议

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `MCPTool` | 调用 MCP 工具 | ✓ | 取决于工具 |
| `ListMcpResources` | 列出 MCP 资源 | ✓ | ✓ |
| `ReadMcpResource` | 读取 MCP 资源 | ✓ | ✓ |

## Skills / 扩展

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Skill` | 调用 Skill | ✓ | 取决于 Skill |
| `LSP` | LSP 工具 | ✓ | ✓ |

## 系统

| 工具 | 描述 | 并发安全 | 只读 |
|------|------|----------|------|
| `Config` | 配置管理 | ✓ | ✗ |
| `ScheduleCron` | 定时任务 | ✓ | ✗ |

## 内部工具（Feature Gated）

| 工具 | 描述 | Feature Gate |
|------|------|--------------|
| `Sleep` | 睡眠 | `PROACTIVE` / `KAIROS` |
| `Monitor` | MCP 监控 | `MONITOR_TOOL` |
| `WebBrowser` | 浏览器自动化 | `WEB_BROWSER_TOOL` |
| `REPL` | 交互式 REPL | `ant` (内部) |
| `PushNotification` | 推送通知 | `KAIROS` |
| `SubscribePR` | PR 订阅 | `KAIROS_GITHUB_WEBHOOKS` |
