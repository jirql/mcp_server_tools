<div align="center">

# 🛡️ MCP Server for Kali Linux

**一款以安全为首要考量的 MCP 服务器，将 Kali Linux 的渗透测试工具链暴露为结构化、经 Schema 验证的工具——支持交互式 PTY 会话、流量混淆 HTTP 请求与智能会话管理。**

[![MCP Protocol](https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square)](https://spec.modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Kali Linux](https://img.shields.io/badge/Platform-Kali%20Linux-557C94?style=flat-square)](https://www.kali.org/)

[📋 功能特性](#-功能特性) · [🚀 快速开始](#-快速开始) · [🔧 工具列表](#-工具列表) · [🔒 安全架构](#-安全架构) · [⚙️ 配置说明](#️-配置说明) · [🤝 贡献指南](#-贡献指南)

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🖥️ **交互式 PTY 会话** | 带提示符自动检测的 bash / msfconsole / sliver / python 有状态终端 |
| 📡 **tmux 多路复用器** | 28 种操作：分屏、后台任务、断线会话持久化 |
| ⚡ **单次与批量执行** | 零开销 `exec` + 并行 `batch`（最多 20 并发） |
| 🕵️ **三层流量混淆** | TLS 指纹模拟（23 种配置）+ 动态浏览器标头 + UA 轮换 |
| 📁 **智能文件系统** | 一个工具搞定读写上传下载 HTTP 抓取 |
| 🧭 **智能导航** | 上下文记忆、书签、`explore` 摘要、`find` 搜索、`quickView` 预览 |
| 🔒 **七层安全体系** | IP 白名单 → 限流 → 命令校验 → 环境清理 → 资源限制 → 参数隐藏 → 全局异常处理 |
| 🧠 **自适应调优器** | 基于实时性能指标的动态并发控制（20–80） |

---

## 🚀 快速开始

### 📦 安装

```bash
# 克隆仓库
git clone git@github.com:jirql/mcp_server_tools.git
cd mcp_server_tools

# 安装依赖
npm install

# 配置（编辑 config.local.json 或使用 .env）
cp config.json config.local.json

# 启动服务器
npm start
```

> [!NOTE]
> **启动时终端没有任何输出！** 服务静默运行——这是**正常现象**，并非服务未启动，请用 MCP 客户端连接验证。

### 🔌 客户端配置

| 配置项 | 值 |
|--------|-----|
| **传输协议** | `Streamable HTTP` (MCP 2025-11-25) |
| **连接地址** | `http://127.0.0.1:10000/mcp` |
| **会话管理** | 通过 `MCP-Session-Id` 标头管理 |

### ✅ 客户端兼容性

| 客户端 | 状态 |
|--------|------|
| 🏗️ **Architectudio** | ✅ 已测试验证 |
| 🧪 **Kelivo** | ✅ 已测试验证 |
| 🔮 **其他 MCP 客户端** | ✅ 只要支持 **Streamable HTTP (MCP 2025-11-25)** 即可调用连接 |

---

## 🔧 工具列表

| # | 工具 | 说明 |
|---|------|------|
| 1 | 🖥️ `terminal` | 创建与管理交互式 PTY 会话 |
| 2 | 📡 `tmux` | tmux 多路复用器（28 个子操作） |
| 3 | ⚡ `exec` | 单次命令执行 |
| 4 | 📁 `file` | 文件系统操作（读写上传下载抓取） |
| 5 | 🧭 `path` | 带上下文记忆与书签的目录导航 |
| 6 | 🛠️ `system` | 系统信息与操作 |
| 7 | 📋 `session` | 会话生命周期管理 |

---

## 🔒 安全架构

除七层安全模型外，服务器还实现了：

- 🚫 **IP 白名单** — 仅允许可信 IP 连接（通过 `allowed_ips` 配置）
- ⏱️ **速率限制** — 默认每 IP 每分钟 200 次请求
- 🧹 **命令校验** — 危险命令被拦截
- 🧼 **环境清理** — 敏感环境变量被清除
- 💾 **资源限制** — 最大会话数与并发数受控
- 🙈 **参数隐藏** — 日志中敏感参数被隐藏
- 🛡️ **全局异常处理** — 不泄露堆栈信息

---

## ⚙️ 配置说明

[`config.json`](config.json) 默认配置：

```json
{
  "server": {
    "port": 10000,
    "host": "0.0.0.0"
  },
  "security": {
    "allowed_ips": ["127.0.0.1", "192.168.0.100"],
    "rate_limit": {
      "window_ms": 60000,
      "max_requests": 200
    }
  },
  "terminal": {
    "shell": "/bin/bash",
    "max_sessions": 20,
    "timeout": 3600
  },
  "tmux": {
    "default_session_prefix": "mcp_",
    "max_sessions": 10
  }
}
```

> [!TIP]
> 敏感配置请使用 `.env` 覆盖，该文件默认已加入 `.gitignore`。

---

## 📁 项目结构

```
mcp-server-kali/
├── server.js              # 🚀 入口文件
├── tools.js               # 🧰 工具定义
├── config.json            # ⚙️ 默认配置
├── config-manager.js      # 📋 配置加载器
├── security.js            # 🔒 安全工具
├── ip-whitelist.js        # 🚫 IP 白名单
├── concurrency-manager.js # ⚡ 并发控制
├── session-manager.js     # 📋 会话管理
├── ops-*.js               # 🛠️ 操作处理器
├── curl-impersonate/      # 🕵️ TLS 指纹二进制
├── intelligent/           # 🧠 请求增强模块
├── sampling/              # 🧪 自适应调优
├── __tests__/             # 🧪 测试用例
└── .env.example           # 📄 环境变量模板
```

---

## 🤝 贡献指南

欢迎贡献代码！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 📄 许可证

[MIT](LICENSE) © 2026 jirql

---

<div align="center">

**为 Kali Linux 安全社区倾心打造 ☕🖤**

</div>
