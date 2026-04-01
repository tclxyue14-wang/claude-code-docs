---
title: 第七章：MCP 协议集成
---

# 第七章：MCP 协议集成

> 理解 Model Context Protocol 如何扩展 Claude Code 的能力。

## 一、概念解释

### 什么是 MCP？

MCP (Model Context Protocol) 是一个开放协议，让 AI 应用能够：

1. **连接外部工具**：通过标准化接口调用外部服务
2. **访问资源**：读取文件、数据库、API 等
3. **执行提示词**：使用预定义的提示词模板

### MCP 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code (MCP Client)                     │
│                                                                  │
│  MCPConnectionManager                                           │
│    ├── 连接管理                                                  │
│    ├── 工具发现                                                  │
│    └── 资源管理                                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ MCP      │  │ MCP      │  │ MCP      │
        │ Server A │  │ Server B │  │ Server C │
        │ (stdio)  │  │ (sse)    │  │ (http)   │
        └──────────┘  └──────────┘  └──────────┘
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ GitHub   │  │ Database │  │ Custom   │
        │ API      │  │          │  │ Service  │
        └──────────┘  └──────────┘  └──────────┘
```

### 传输方式

| 传输 | 描述 | 适用场景 |
|------|------|----------|
| **stdio** | 通过标准输入/输出通信 | 本地进程 |
| **sse** | Server-Sent Events | HTTP 服务 |
| **http** | Streamable HTTP | REST API |
| **ws** | WebSocket | 实时通信 |
| **sdk** | 进程内调用 | 嵌入式 |

## 二、源码分析

### MCP 连接管理

位置：`src/services/mcp/MCPConnectionManager.tsx`

```typescript
export class MCPConnectionManager {
  private connections: Map<string, MCPServerConnection> = new Map()

  async connect(config: McpServerConfig): Promise<MCPServerConnection> {
    // 根据传输类型创建连接
    const transport = await this.createTransport(config)

    // 创建 MCP 客户端
    const client = new MCPClient(transport)

    // 初始化连接
    await client.initialize()

    // 发现工具
    const tools = await client.listTools()
    const resources = await client.listResources()

    // 注册工具
    const connection: MCPServerConnection = {
      name: config.name,
      client,
      tools: tools.map(t => this.wrapMCPTool(t, client)),
      resources,
      status: 'connected',
    }

    this.connections.set(config.name, connection)
    return connection
  }

  private async createTransport(config: McpServerConfig): Promise<Transport> {
    switch (config.transport) {
      case 'stdio':
        return new StdioTransport(config.command, config.args)
      case 'sse':
        return new SSETransport(config.url)
      case 'http':
        return new HTTPTransport(config.url)
      case 'ws':
        return new WebSocketTransport(config.url)
      default:
        throw new Error(`Unknown transport: ${config.transport}`)
    }
  }

  private wrapMCPTool(tool: MCPTool, client: MCPClient): Tool {
    return buildTool({
      name: `mcp__${tool.name}`,
      inputSchema: this.convertSchema(tool.inputSchema),
      isMcp: true,

      async call(input, context) {
        const result = await client.callTool(tool.name, input)
        return { data: result.content }
      },

      async prompt() {
        return tool.description
      },

      isConcurrencySafe: () => true,
    })
  }
}
```

### 配置格式

位置：`~/.claude/settings.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "mcp-github",
      "args": ["--token", "${GITHUB_TOKEN}"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "database": {
      "url": "http://localhost:3000/mcp",
      "transport": "http"
    },
    "filesystem": {
      "command": "mcp-filesystem",
      "args": ["/home/user/projects"]
    }
  }
}
```

## 三、从零实现 MCP 集成

### 最简 MCP 客户端

```typescript
// minimal-mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

async function connectMCP(command: string, args: string[]) {
  // 创建传输
  const transport = new StdioClientTransport({
    command,
    args,
  })

  // 创建客户端
  const client = new Client({
    name: 'my-client',
    version: '1.0.0',
  }, {
    capabilities: {
      tools: {},
      resources: {},
    },
  })

  // 连接
  await client.connect(transport)

  // 列出工具
  const { tools } = await client.listTools()
  console.log('Available tools:', tools)

  // 调用工具
  const result = await client.callTool({
    name: tools[0].name,
    arguments: { /* ... */ },
  })

  console.log('Result:', result)

  return client
}

// 使用
const client = await connectMCP('mcp-filesystem', ['/home/user'])
```

### 完整 MCP 管理器

```typescript
// mcp-manager.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type MCPServerConfig = {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

type MCPTool = {
  name: string
  description: string
  inputSchema: any
}

type MCPServerConnection = {
  name: string
  client: Client
  tools: MCPTool[]
  resources: any[]
  status: 'connecting' | 'connected' | 'error' | 'disconnected'
}

class MCPManager {
  private connections: Map<string, MCPServerConnection> = new Map()
  private tools: Map<string, { server: string; tool: MCPTool }> = new Map()

  async connectServer(config: MCPServerConfig): Promise<MCPServerConnection> {
    console.log(`Connecting to MCP server: ${config.name}`)

    try {
      // 创建传输
      const transport = await this.createTransport(config)

      // 创建客户端
      const client = new Client({
        name: 'claude-code',
        version: '1.0.0',
      }, {
        capabilities: {
          tools: {},
          resources: {},
        },
      })

      // 连接
      await client.connect(transport)

      // 发现工具和资源
      const [{ tools }, { resources }] = await Promise.all([
        client.listTools(),
        client.listResources(),
      ])

      // 注册工具
      for (const tool of tools) {
        const fullName = `mcp__${config.name}__${tool.name}`
        this.tools.set(fullName, {
          server: config.name,
          tool,
        })
      }

      // 保存连接
      const connection: MCPServerConnection = {
        name: config.name,
        client,
        tools,
        resources: resources || [],
        status: 'connected',
      }

      this.connections.set(config.name, connection)
      console.log(`Connected to ${config.name}: ${tools.length} tools, ${resources?.length || 0} resources`)

      return connection
    } catch (error) {
      console.error(`Failed to connect to ${config.name}:`, error)
      throw error
    }
  }

  private async createTransport(config: MCPServerConfig) {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({
        command: config.command!,
        args: config.args || [],
        env: {
          ...process.env,
          ...config.env,
        } as Record<string, string>,
      })
    }

    // 其他传输类型...
    throw new Error(`Unsupported transport: ${config.transport}`)
  }

  async callTool(fullName: string, input: unknown): Promise<unknown> {
    const entry = this.tools.get(fullName)
    if (!entry) {
      throw new Error(`Unknown tool: ${fullName}`)
    }

    const connection = this.connections.get(entry.server)
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Server not connected: ${entry.server}`)
    }

    const result = await connection.client.callTool({
      name: entry.tool.name,
      arguments: input,
    })

    return result.content
  }

  getAllTools(): MCPTool[] {
    return Array.from(this.tools.entries()).map(([fullName, entry]) => ({
      name: fullName,
      description: entry.tool.description,
      inputSchema: entry.tool.inputSchema,
    }))
  }

  async disconnectServer(name: string) {
    const connection = this.connections.get(name)
    if (connection) {
      await connection.client.close()
      this.connections.delete(name)

      // 移除工具
      for (const [fullName, entry] of this.tools) {
        if (entry.server === name) {
          this.tools.delete(fullName)
        }
      }
    }
  }

  async disconnectAll() {
    for (const name of this.connections.keys()) {
      await this.disconnectServer(name)
    }
  }
}

// 使用示例
const manager = new MCPManager()

// 连接服务器
await manager.connectServer({
  name: 'filesystem',
  transport: 'stdio',
  command: 'mcp-filesystem',
  args: ['/home/user/projects'],
})

await manager.connectServer({
  name: 'github',
  transport: 'stdio',
  command: 'mcp-github',
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
})

// 获取所有工具
const tools = manager.getAllTools()
console.log('Available tools:', tools.map(t => t.name))

// 调用工具
const result = await manager.callTool('mcp__filesystem__read_file', {
  path: '/home/user/projects/test.txt',
})
console.log('File content:', result)
```

### MCP 工具包装器

```typescript
// mcp-tool-wrapper.ts
import { z } from 'zod'
import { buildTool, Tool } from './tool-system'

function wrapMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  client: MCPClient,
): Tool {
  return buildTool({
    name: `mcp__${serverName}__${mcpTool.name}`,
    inputSchema: convertJSONSchemaToZod(mcpTool.inputSchema),
    isMcp: true,
    mcpInfo: {
      serverName,
      toolName: mcpTool.name,
    },

    async call(input, context) {
      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        })

        // 处理结果
        const content = extractContent(result)
        return { data: content }
      } catch (error) {
        return {
          data: null,
          newMessages: [{
            type: 'error',
            content: `MCP tool error: ${error}`,
          }],
        }
      }
    },

    async prompt() {
      return mcpTool.description
    },

    isConcurrencySafe: () => true,
  })
}

function convertJSONSchemaToZod(schema: any): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {}

  if (schema.type === 'object' && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      shape[key] = convertPropertyToZod(prop as any, schema.required?.includes(key))
    }
  }

  return z.object(shape)
}

function convertPropertyToZod(prop: any, required: boolean): z.ZodTypeAny {
  let zodType: z.ZodTypeAny

  switch (prop.type) {
    case 'string':
      zodType = z.string()
      break
    case 'number':
    case 'integer':
      zodType = z.number()
      break
    case 'boolean':
      zodType = z.boolean()
      break
    case 'array':
      zodType = z.array(convertPropertyToZod(prop.items, true))
      break
    case 'object':
      zodType = convertJSONSchemaToZod(prop)
      break
    default:
      zodType = z.any()
  }

  if (!required) {
    zodType = zodType.optional()
  }

  if (prop.description) {
    zodType = zodType.describe(prop.description)
  }

  return zodType
}
```

## 四、实现自定义 MCP 服务器

### 简单 MCP 服务器

```typescript
// my-mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// 创建服务器
const server = new Server({
  name: 'my-custom-server',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},
    resources: {},
  },
})

// 注册工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        inputSchema: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name',
            },
          },
          required: ['city'],
        },
      },
      {
        name: 'calculate',
        description: 'Evaluate a mathematical expression',
        inputSchema: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'Mathematical expression to evaluate',
            },
          },
          required: ['expression'],
        },
      },
    ],
  }
})

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'get_weather': {
      const weather = await fetchWeather(args.city)
      return {
        content: [{ type: 'text', text: JSON.stringify(weather) }],
      }
    }

    case 'calculate': {
      const result = evaluateExpression(args.expression)
      return {
        content: [{ type: 'text', text: String(result) }],
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
})

// 注册资源
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'config://settings',
        name: 'Application Settings',
        mimeType: 'application/json',
      },
    ],
  }
})

// 处理资源读取
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params

  if (uri === 'config://settings') {
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ theme: 'dark', language: 'en' }),
      }],
    }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

// 启动服务器
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP server running on stdio')
}

main().catch(console.error)
```

## 五、最佳实践

### 1. 错误处理

```typescript
async function callToolWithRetry(
  client: Client,
  toolName: string,
  args: unknown,
  maxRetries: number = 3,
): Promise<unknown> {
  let lastError: Error | null = null

  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      })

      if (result.isError) {
        throw new Error(result.content.map(c => c.text).join('\n'))
      }

      return result.content
    } catch (error) {
      lastError = error as Error
      console.warn(`MCP tool call failed (attempt ${i + 1}):`, error)

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)))
    }
  }

  throw lastError
}
```

### 2. 工具命名规范

```typescript
// MCP 工具命名：mcp__<server>__<tool>
function getMCPToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

// 解析工具名
function parseMCPToolName(fullName: string): { server: string; tool: string } | null {
  const match = fullName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return null
  return { server: match[1], tool: match[2] }
}
```

### 3. 配置验证

```typescript
const MCPServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'http', 'ws']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string()).optional(),
}).refine(
  (config) => {
    if (config.transport === 'stdio') {
      return !!config.command
    }
    return !!config.url
  },
  { message: 'stdio transport requires command, others require url' },
)

function validateConfig(config: unknown): MCPServerConfig {
  return MCPServerConfigSchema.parse(config)
}
```

---

下一章：[08-state-persistence.md](./08-state-persistence.md) - 深入状态持久化
