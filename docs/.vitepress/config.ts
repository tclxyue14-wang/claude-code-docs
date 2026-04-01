import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Code 深度解析',
  description: '从源码层面理解 Claude Code 的设计与实现',

  lang: 'zh-CN',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/01-overview' },
    ],

    sidebar: [
      {
        text: '开始',
        items: [
          { text: '导航索引', link: '/' },
        ]
      },
      {
        text: '总览',
        items: [
          { text: '第一章：总体架构概览', link: '/01-overview' },
        ]
      },
      {
        text: '核心模块',
        items: [
          { text: '第二章：核心 Agent 循环', link: '/02-core-loop' },
          { text: '第三章：工具系统设计', link: '/03-tool-system' },
          { text: '第四章：权限系统', link: '/04-permission-system' },
          { text: '第五章：上下文管理', link: '/05-context-management' },
          { text: '第六章：子 Agent 架构', link: '/06-sub-agents' },
        ]
      },
      {
        text: '高级特性',
        items: [
          { text: '第七章：MCP 协议集成', link: '/07-mcp-integration' },
          { text: '第八章：状态持久化', link: '/08-state-persistence' },
          { text: '第九章：终端 UI 实现', link: '/09-terminal-ui' },
          { text: '第十章：CLI 基础设施', link: '/10-cli-infrastructure' },
        ]
      },
      {
        text: '实战',
        items: [
          { text: '第十一章：构建自己的 AI CLI', link: '/11-build-your-own' },
        ]
      },
      {
        text: '附录',
        collapsed: false,
        items: [
          { text: '工具清单', link: '/appendix/tool-inventory' },
          { text: 'Feature Flags', link: '/appendix/feature-flags' },
          { text: '设计模式', link: '/appendix/design-patterns' },
        ]
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/tclxyue14-wang/claude-code-source-code' }
    ],

    footer: {
      message: '基于 Claude Code v2.1.88 源码分析',
      copyright: '仅供技术研究和教育目的'
    },

    outline: {
      level: [2, 3],
      label: '目录'
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换'
            }
          }
        }
      }
    },

    editLink: {
      pattern: 'https://github.com/tclxyue14-wang/claude-code-source-code/edit/main/docs-site/docs/:path',
      text: '在 GitHub 上编辑此页'
    },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: {
        dateStyle: 'short',
        timeStyle: 'short'
      }
    },

    docFooter: {
      prev: '上一页',
      next: '下一页'
    },

    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
  },

  markdown: {
    lineNumbers: true,
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    }
  },

  vite: {
    server: {
      host: '0.0.0.0',
      port: 5180
    }
  }
})
