---
layout: home

hero:
  name: "Claude Code"
  text: "深度解析"
  tagline: 从源码层面理解 Claude Code 的设计与实现，掌握构建 AI Agent CLI 的核心原理
  image:
    src: /logo.svg
    alt: Claude Code
  actions:
    - theme: brand
      text: 开始阅读
      link: /01-overview
    - theme: alt
      text: 查看源码
      link: https://github.com/tclxyue14-wang/claude-code-source-code

features:
  - icon: 🏗️
    title: 架构设计
    details: 理解 Agent 循环、工具系统、权限控制、上下文管理等核心模块的设计原理
  - icon: 💻
    title: 源码分析
    details: 基于 v2.1.88 反编译源码，深入分析每个模块的实现细节
  - icon: 🔧
    title: 实战指南
    details: 从零构建自己的 AI CLI，包含完整可运行的代码示例
  - icon: 📚
    title: 概念讲解
    details: 每个概念都有详细解释，适合各层次开发者学习
---

## 文档定位

本系列文档基于 Claude Code v2.1.88 反编译源码，以**总分总**结构讲解：

- **总**：整体架构与核心流程
- **分**：各模块深度剖析（概念 + 代码示例）
- **总**：实战指南——如何构建自己的 AI CLI

## 目标读者

- 想理解 AI Agent 内部机制的开发者
- 准备构建类似 CLI 工具的工程师
- 对 Agent 架构设计感兴趣的架构师

## 核心概念速查

| 概念 | 定义 | 核心文件 |
|------|------|----------|
| **Query Engine** | 消息处理与 API 调用的生命周期管理 | `QueryEngine.ts` |
| **Agent Loop** | 持续调用 API → 执行工具 → 返回结果的循环 | `query.ts` |
| **Tool** | 可被 AI 调用的能力单元 | `Tool.ts`, `tools/*.ts` |
| **Permission** | 工具调用的授权机制 | `utils/permissions/` |
| **Compact** | 上下文压缩策略 | `services/compact/` |
| **MCP** | Model Context Protocol，外部工具协议 | `services/mcp/` |
| **Sub-Agent** | 独立上下文的子任务执行器 | `AgentTool/` |
| **Session** | 一次完整对话的持久化单元 | `utils/sessionStorage.js` |

## 12 层 Harness 演进

Claude Code 的架构从简单到复杂，经历了 12 层演进：

```
s01 THE LOOP           → 基本 API 调用循环
s02 TOOL DISPATCH      → 工具注册与分发
s03 PLANNING           → 规划模式
s04 SUB-AGENTS         → 子 Agent 隔离
s05 KNOWLEDGE ON DEMAND → 按需知识加载
s06 CONTEXT COMPRESSION → 上下文压缩
s07 PERSISTENT TASKS   → 持久化任务
s08 BACKGROUND TASKS   → 后台任务
s09 AGENT TEAMS        → Agent 团队
s10 TEAM PROTOCOLS     → 团队通信协议
s11 AUTONOMOUS AGENTS  → 自主 Agent
s12 WORKTREE ISOLATION → 工作树隔离
```

## 源码位置

本文档基于 `~/claude-code-source-code/src/` 目录下的反编译源码：

```
~/claude-code-source-code/src/
├── main.tsx          # 入口 (4,683 行)
├── QueryEngine.ts    # 查询引擎 (1,295 行)
├── query.ts          # 核心 Agent 循环 (1,729 行)
├── Tool.ts           # 工具接口 (792 行)
├── tools.ts          # 工具注册 (389 行)
├── commands.ts       # 斜杠命令 (754 行)
├── services/         # 服务层
├── tools/            # 工具实现 (40+)
├── state/            # 状态管理
└── ...
```

## 阅读顺序

### 入门路径
1. [第一章：总体架构概览](/01-overview) - 建立整体认知
2. [第二章：核心 Agent 循环](/02-core-loop) - 理解核心循环
3. [第三章：工具系统设计](/03-tool-system) - 掌握工具设计

### 进阶路径
4. [第四章：权限系统](/04-permission-system)
5. [第五章：上下文管理](/05-context-management)
6. [第六章：子 Agent 架构](/06-sub-agents)

### 高级路径
7. [第七章：MCP 协议集成](/07-mcp-integration)
8. [第八章：状态持久化](/08-state-persistence)
9. [第九章：终端 UI 实现](/09-terminal-ui)
10. [第十章：CLI 基础设施](/10-cli-infrastructure)

### 实战
11. [第十一章：构建自己的 AI CLI](/11-build-your-own) - 动手实现
