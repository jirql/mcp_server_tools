<div align="center">

# 🛡️ MCP Server for Kali Linux

**A powerful, security-first MCP (Model Context Protocol) server that exposes Kali Linux's penetration testing toolchain as structured, schema-validated tools — with interactive PTY sessions, traffic-obfuscated HTTP fetching, and intelligent session management.**

[![MCP Protocol](https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square)](https://spec.modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Kali Linux](https://img.shields.io/badge/Platform-Kali%20Linux-557C94?style=flat-square)](https://www.kali.org/)

[📋 Features](#-features) · [🚀 Quick Start](#-quick-start) · [🔧 Tools](#-tools-reference) · [🔒 Security](#-security-architecture) · [⚙️ Configuration](#️-configuration) · [🤝 Contributing](#-contributing)

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🖥️ **Interactive PTY Sessions** | Stateful bash / msfconsole / sliver / python shells with prompt auto-detection |
| 📡 **tmux Multiplexer** | 28 actions: split panes, background jobs, session persistence across disconnects |
| ⚡ **One-Shot & Batch Execution** | Zero-overhead `exec` + parallel `batch` (up to 20 concurrent) |
| 🕵️ **3-Layer Traffic Obfuscation** | TLS fingerprint impersonation (23 profiles) + dynamic browser headers + UA rotation |
| 📁 **Smart File System** | Read / write / upload / download / HTTP fetch in one tool |
| 🧭 **Intelligent Navigation** | Context memory, bookmarks, `explore` summaries, `find` search, `quickView` previews |
| 🔒 **7-Layer Security** | IP whitelist → rate limiting → command validation → env sanitization → resource limits → param hiding → global exception handlers |
| 🧠 **Adaptive Auto-Tuner** | Dynamic concurrency control (20–80) based on real-time performance metrics |

---

## 🏗️ Architecture

This server implements the **Streamable HTTP Transport** spec (MCP 2025-11-25), providing a lightweight yet extensible bridge between MCP-compatible clients and Kali Linux's native toolchain.

```
┌──────────────┐    Streamable HTTP     ┌──────────────────┐
│  MCP Client  │ ◄────────────────────► │  MCP Server      │
│  (Architect- │    POST /mcp           │  (Express.js)    │
│   udio,      │    GET  /mcp           ├──────────────────┤
│   Kelivo)    │                        │  Tools Layer     │
└──────────────┘                        │  ┌────────────┐  │
                                        │  │ terminal   │  │
                                        │  │ tmux       │  │
                                        │  │ exec       │  │
                                        │  │ file       │  │
                                        │  │ path       │  │
                                        │  │ system     │  │
                                        │  │ session    │  │
                                        │  └────────────┘  │
                                        │  Security Layer  │
                                        │  Concurrency     │
                                        │  Auto-Tuner      │
                                        └──────────────────┘
```

---

## 🚀 Quick Start

### 📦 Installation

```bash
# Clone the repository
git clone git@github.com:jirql/mcp_server_tools.git
cd mcp_server_tools

# Install dependencies
npm install

# Configure (edit config.local.json or use .env)
cp config.json config.local.json

# Start the server
npm start
```

> [!NOTE]
> **No terminal output on startup!** The server runs silently — this is **normal behavior**. Connect your MCP client to verify it's running.

### 🔌 Client Configuration

| Setting | Value |
|---------|-------|
| **Transport** | `Streamable HTTP` (MCP 2025-11-25) |
| **URL** | `http://127.0.0.1:10000/mcp` |
| **Session** | Managed via `MCP-Session-Id` header |

### ✅ Client Compatibility

| Client | Status |
|--------|--------|
| 🏗️ **Architectudio** | ✅ Tested & Verified |
| 🧪 **Kelivo  Cherry Studio** | ✅ Tested & Verified |
| 🔮 **Other MCP Clients** | ✅ Should work — any client supporting **Streamable HTTP (MCP 2025-11-25)** can connect |

---

## 🔧 Tools Reference

| # | Tool | Description |
|---|------|-------------|
| 1 | 🖥️ `terminal` | Create & manage interactive PTY sessions with bash, msfconsole, sliver, python |
| 2 | 📡 `tmux` | Full tmux multiplexer (28 sub-actions): splits, windows, panes, background jobs |
| 3 | ⚡ `exec` | One-shot command execution with real-time output |
| 4 | 📁 `file` | File system operations: read, write, upload, download, HTTP fetch |
| 5 | 🧭 `path` | Directory navigation with context memory, bookmarks, explore summaries |
| 6 | 🛠️ `system` | System information & operations |
| 7 | 📋 `session` | Session lifecycle management & state monitoring |

### Terminal Deep Dive 🖥️

Terminal sessions are powered by **node-pty**, providing full interactive shell access with:

- 🔄 **Prompt auto-detection** — Knows when a command has finished executing
- 💾 **State persistence** — Sessions survive network disconnects
- 🧵 **Multi-session support** — Run multiple shells simultaneously (configurable, default: 20 max)
- ⏰ **Configurable timeouts** — Idle sessions auto-cleanup (default: 1 hour)

Supported shells include `bash`, `zsh`, `msfconsole`, `sliver`, `python`, `python3`, and any command available on the system.

### tmux Multiplexer Deep Dive 📡

The tmux module exposes 28 distinct operations organized into categories:

| Category | Actions |
|----------|---------|
| 📋 **Session Management** | `list-sessions`, `new-session`, `kill-session`, `rename-session`, `switch-client` |
| 🪟 **Window Management** | `list-windows`, `new-window`, `kill-window`, `rename-window`, `select-window`, `move-window` |
| 📐 **Pane Management** | `list-panes`, `split-window`, `kill-pane`, `select-pane`, `swap-pane`, `resize-pane` |
| 💬 **Commands** | `send-keys`, `capture-pane`, `pipe-pane`, `set-buffer`, `paste-buffer` |
| ⚙️ **Configuration** | `set-option`, `show-options`, `bind-key`, `source-file` |
| 🔍 **Display** | `display-message`, `display-menu`, `choose-tree` |

### Traffic Obfuscation Deep Dive 🕵️

The `curl-impersonate` module provides **TLS fingerprint spoofing** with 23 browser profiles:

- 🌐 **Chrome**: 100, 101, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117
- 🌐 **Edge**: 99, 101
- 🦊 **Firefox**: 100, 102, 109
- 🍏 **Safari**: 15_3, 15_5, 17_0

On top of TLS impersonation, the module also rotates **User-Agent** strings and dynamically adjusts request headers to mimic real browser traffic patterns.

### Intelligent Navigation Deep Dive 🧭

The path operation module goes beyond simple `ls` — it remembers where you've been:

- 📝 **Context Memory** — Remembers last visited directories per-session
- 🔖 **Bookmarks** — Save frequently accessed paths with labels
- 📊 **`explore` Summaries** — Get a bird's-eye view of directory contents with file type breakdowns
- 🔍 **`find` Search** — Recursive search with filtering by name, type, size, date
- 👁️ **`quickView` Previews** — Preview file contents without opening a full session

---

## 🔒 Security Architecture

A **7-layer defense-in-depth** approach ensures the server can be safely exposed even in hostile network environments:

| Layer | Mechanism | Description |
|-------|-----------|-------------|
| 🚫 1 | **IP Whitelist** | Only pre-configured IP addresses can connect (`allowed_ips` in config) |
| ⏱️ 2 | **Rate Limiting** | Max 200 requests per minute per IP (configurable) |
| 🧹 3 | **Command Validation** | Blacklists dangerous operations, shell injection attempts, and escape sequences |
| 🧼 4 | **Environment Sanitization** | Strips sensitive environment variables before execution |
| 💾 5 | **Resource Limits** | Enforces max sessions, max concurrency, and per-session timeouts |
| 🙈 6 | **Parameter Hiding** | Sensitive parameters (passwords, tokens, keys) are masked in logs |
| 🛡️ 7 | **Global Exception Handlers** | Catches all uncaught exceptions — no stack traces leaked to client |

---

## ⚙️ Configuration

Default configuration in [`config.json`](config.json):

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
> Use `.env` for sensitive overrides — it's gitignored by default.

### Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `start` | `node server.js` | Run in production mode |
| `dev` | `node --watch server.js` | Run with auto-restart on file changes |
| `test` | `node --test __tests__/*.test.js` | Run the full test suite |
| `benchmark` | `node --test __tests__/benchmark.test.js` | Run performance benchmarks |
| `validate` | `node validate-mcp-schema.js` | Validate MCP schema compliance |

---

## 📁 Project Structure

```
mcp-server-kali/
├── server.js              # 🚀 Entry point — Express app, MCP transport, middleware
├── tools.js               # 🧰 Tool definitions — registers all MCP tools
├── config.json            # ⚙️ Default configuration
├── config-manager.js      # 📋 Config loader — file + env overlay
├── security.js            # 🔒 Security utilities — validation, sanitization
├── ip-whitelist.js        # 🚫 IP whitelist middleware
├── concurrency-manager.js # ⚡ Concurrency control — adaptive queue
├── session-manager.js     # 📋 Session lifecycle management
├── ops-terminal.js        # 🖥️ Terminal operation handlers
├── ops-tmux.js            # 📡 tmux operation handlers
├── ops-file.js            # 📁 File operation handlers
├── ops-path.js            # 🧭 Path/navigation operation handlers
├── ops-system.js          # 🛠️ System operation handlers
├── ops-session.js         # 📋 Session operation handlers
├── ops-exec.js            # ⚡ Exec operation handlers
├── curl-impersonate/      # 🕵️ TLS fingerprint impersonation binaries
│   ├── curl_chrome*       #   Chrome impersonation profiles
│   ├── curl_edge*         #   Edge impersonation profiles
│   ├── curl_ff*           #   Firefox impersonation profiles
│   └── curl_safari*       #   Safari impersonation profiles
├── intelligent/           # 🧠 Request enhancement module
│   ├── enhancer.js        #   Request enhancer logic
│   ├── ua-pool.js         #   User-Agent rotation pool
│   └── reporter.js        #   Performance reporter
├── sampling/              # 🧪 Adaptive auto-tuner
│   └── auto-tuner.js      #   Dynamic timeout & concurrency tuning
├── __tests__/             # 🧪 Test suite
│   ├── unit.test.js       #   Unit tests
│   ├── benchmark.test.js  #   Performance benchmarks
│   └── tool-call-perf.js  #   Tool call performance tests
└── .env.example           # 📄 Environment variable template
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run performance benchmarks
npm run benchmark

# Validate MCP schema compliance
npm run validate
```

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Before submitting a PR:
- Run `npm test` to ensure existing tests pass
- Run `npm run validate` to check MCP schema compliance
- Follow the existing code style (ESLint is configured)

---

## 📄 License

[MIT](LICENSE) © 2026 jirql

---

<div align="center">

**Made with ☕ and 🖤 for the Kali Linux security community**

</div>
