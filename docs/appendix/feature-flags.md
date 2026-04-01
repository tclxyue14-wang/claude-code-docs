---
title: 附录 B：Feature Flags
---

# 附录 B：Feature Flags

Claude Code 使用 Bun 的 `feature()` 编译时函数进行死代码消除。

## 编译时 Feature Flags

这些标志在编译时确定，未启用的代码会从 bundle 中移除。

| Flag | 描述 |
|------|------|
| `COORDINATOR_MODE` | 多 Agent 协调器模式 |
| `HISTORY_SNIP` | 激进历史裁剪 |
| `CONTEXT_COLLAPSE` | 上下文折叠（实验性） |
| `DAEMON` | 后台守护进程 |
| `AGENT_TRIGGERS` | Agent 触发器（定时/远程） |
| `AGENT_TRIGGERS_REMOTE` | 远程触发器支持 |
| `MONITOR_TOOL` | MCP 监控工具 |
| `WEB_BROWSER_TOOL` | 浏览器自动化工具 |
| `VOICE_MODE` | 语音输入/输出 |
| `TEMPLATES` | 任务分类器模板 |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill 发现 |
| `KAIROS` | 自主 Agent 模式 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub PR 订阅 |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知 |
| `PROACTIVE` | 主动行为（Sleep 工具） |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 |
| `TERMINAL_PANEL` | 终端捕获面板 |
| `WORKFLOW_SCRIPTS` | 工作流脚本 |
| `CHICAGO_MCP` | Computer Use MCP |
| `DUMP_SYSTEM_PROMPT` | 系统提示词导出（仅内部） |
| `UDS_INBOX` | Peer 发现 |
| `ABLATION_BASELINE` | 实验消融基线 |
| `UPGRADE_NOTICE` | 升级通知 |
| `REACTIVE_COMPACT` | 响应式压缩 |
| `CACHED_MICROCOMPACT` | 缓存微压缩 |
| `TOKEN_BUDGET` | Token 预算管理 |

## 运行时门控

### 内部用户检测

```typescript
if (process.env.USER_TYPE === 'ant') {
  // Anthropic 内部功能
}
```

### GrowthBook 特性开关

```typescript
const featureValue = getFeatureValue_CACHED_MAY_BE_STALE('feature_name', defaultValue)
```

## 使用示例

```typescript
// 编译时条件
const sleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

// 运行时检查
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const result = await contextCollapse.applyCollapsesIfNeeded(...)
}
```
