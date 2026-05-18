# MCP Server 架构深度分析文档

> **项目名称**: mcp-server-kali
> **分析日期**: 2026-05-14
> **代码库位置**: `/home/song/mcp-server_2025.11.25`

---

## 📌 概要

| 维度 | 说明 |
|------|------|
| **目的** | 面向 Kali Linux 渗透测试的 MCP 服务器，通过 MCP 2025-11-25 Streamable HTTP 传输协议提供 7 个工具（60+ 子操作），具备 3 层流量混淆能力用于隐蔽网络操作 |
| **领域** | Offensive Security / 红队工具链 |
| **规模** | 文件 `41` | 代码行 `~8,200` | 模块 `19`（15 个源文件 + 4 个子目录模块） |
| **入口** | `[server.js:1]` — Express + MCP Streamable HTTP 服务器，端口 10000 |

---

## ⚙️ 技术栈

| 类别 | 工具 | 版本/置信度 |
|------|------|-------------|
| 语言/运行时 | Node.js (ES Modules) | ⚡ 不确定（`package.json` 中 `"type": "module"`，无 engines 字段） |
| 框架/ORM | Express + `@modelcontextprotocol/sdk` | ✅ `package.json` |
| PTY 终端 | `node-pty` | ✅ `package.json` |
| Schema 校验 | AJV | ✅ `package.json` |
| 传输安全 | `helmet` | ✅ `package.json` |
| 限流 | `express-rate-limit` | ✅ `package.json` |
| 流量混淆 | `curl-impersonate`（预编译二进制） | ✅ `curl-impersonate/` 目录 |
| 测试 | Node 内置 `node:test` + `node:assert` | ✅ `__tests__/unit.test.js:6-7` |
| 代码规范 | ESLint | ✅ `.eslintrc.json` |
| 配置管理 | `config-manager.js` | ✅ 新增 (P2-9) 类型安全配置访问 + 热重载 |
| 并发管理 | `concurrency-manager.js` | ✅ 新增 (P0-1) 替换全局 `perfStats` |
| 网络并发队列 | `performance-optimizer.js` | ✅ 新增 NetworkRequestQueue，per-tool 限流 + 重试 |

---

## 🔗 核心函数

### 1. 服务启动

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `server.js:initializeServer` | 启动 Express + MCP 传输层，注册工具，开启监听 | 进程启动 | `createMcpServer`, `initializeTools`, `startAutoTuner` | 打开端口 10000，注册 SIGTERM/SIGINT 处理器 |

### 2. 工具层

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `tools.js:initializeTools` | 初始化 7 个工具模块，共享 SessionManager + config | `server.js` | 所有 `ops-*` 模块 | 创建 `SessionManager` 实例 |
| `utils-error-handler.js:withErrorHandling` | 用 try/catch + 错误分类包装每个工具处理器 | `tools.js` | 通过 `utils-logger` 记录 | 返回结构化 `{success, error, errorCode, details}` |

### 3. PTY 终端工具

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `ops-terminal.js:TerminalOps.createSession` | 通过 `node-pty` 创建 PTY 会话 | `tools.js`（terminal create） | `sessionManager.createSession` | 分配 PTY master/slave，启动 shell 进程 |
| `ops-terminal.js:TerminalOps.executeCommand` | 在 PTY 会话中执行命令，含 prompt 检测 | `tools.js`（terminal exec） | `session.write`, `sessionManager` 轮询 | 读取 PTY 输出，检测 30+ 种 shell prompt |

### 4. Tmux 多路复用器

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `ops-tmux.js:TmuxOps` | Tmux 会话/窗口/窗格管理，通过 `child_process` | `tools.js`（tmux 工具） | `child_process.exec` | 创建 tmux 会话、窗口、窗格；缓存环境 |

### 5. 会话管理

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `session-manager.js:SessionManager` | PTY 会话生命周期：创建/杀死/轮询/清理 | 所有 terminal/tmux ops 调用 | `node-pty`, `process.kill`, `setInterval` | 内存上限（5MB/会话）、僵尸检测、孤儿进程清理 |
| `ops-session.js:sessionOps.list` | 列出 PTY 会话，含僵尸检测 | `tools.js`（session list） | `sessionManager.listSessions` | 计算 inactiveTime，分类 zombies/old |

### 6. 命令执行

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `ops-exec.js:executeOps.exec` | 直接 `child_process.exec` 执行非 PTY 命令 | `tools.js`（execute exec） | `child_process.execFile` | 无 PTY 开销；比 terminal 工具快 |
| `intelligent/enhancer.js:IntelligentEnhancer.enhance` | 自动包装 curl/wget/nmap 为 curl-impersonate 二进制 + UA | `ops-exec.js`（增强 exec） | `uaPool.getRandomDesktop`, `curl-impersonate` 二进制 | 替换 `curl` → `curl_chrome131`，追加 `-A "UA"` |

### 7. 系统工具

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `ops-system.js:systemOps.portScan` | Nmap 端口扫描封装 | `tools.js`（system portScan） | `child_process.exec('nmap')` | 执行 `nmap -p ports --open -T5 target` |
| `ops-system.js:systemOps` (info/network) | 系统信息获取（hostname, uptime, users, memory, disk, interfaces, routes, dns） | `tools.js`（system info/network） | `child_process.exec` | 执行系统命令返回结构化结果 |

### 8. 文件与路径

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `ops-file.js`（read/write/list/delete） | 文件 CRUD 操作，含安全校验 | `tools.js`（file tool） | `fs` 模块 | 读写文件，执行 curl 下载/上传 |
| `ops-file.js:getSpoofedHeaders` | 生成浏览器伪造 TLS+HTTP 头 | `ops-file.js`（fetch） | `uaPool.getRandomDesktop`, `getBrowserHeaders` | 返回 Chrome/Firefox/Safari/Edge 头集合 |
| `ops-path.js:pathOps` | 目录树、探索、上下文、书签、文件搜索 | `tools.js`（path 工具） | `fs.readdir`, `fs.stat`, `fs.readFile` | 内存中上下文历史 + 书签 |

### 9. 基础设施

| 模块.函数 | 作用 | 被谁调用 | 调用了谁 | 副作用 |
|---|---|---|---|---|
| `security.js:validateCommand` | 阻断危险模式（rm -rf、/dev/ 写入、pipe-to-sh） | 所有 ops 模块 | 正则匹配 22 个 DANGEROUS_PATTERNS | 匹配时抛出 SecurityError |
| `security.js:validatePath` | 阻断敏感文件系统路径访问 | `ops-file.js` | 正则匹配阻断路径 | 阻断 `/etc/shadow`、`/root/.ssh` 等 |
| `ip-whitelist.js:isAllowedIP` | 校验客户端 IP 是否在 CIDR 白名单内 | `server.js`（中间件） | `ipInAnyCIDR` 处理 IPv6 `::ffff:` 前缀 | 拒绝非白名单 IP 的请求 |
| `utils-logger.js:Logger` | 结构化 JSON 日志，含文件轮转（10MB，5 文件） | 所有模块 | `createWriteStream`, `fs.renameSync` | 控制台（彩色/emoji）+ JSONL 文件输出 |
| `sampling/auto-tuner.js:autoAdjustConcurrency` | 基于慢请求比例的自适应并发调节 | `server.js`（每 30 秒） | 读取 `global.perfStats`，写入 `global.requestQueue.concurrency` | 调节 20-80 并发范围 |

---

## 🏗️ 架构设计

### 架构模式

**分层架构（展示层 → 应用层 → 领域层 → 基础设施层）**，含服务层抽象

### 分层结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  展示层 (Presentation)                                               │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  server.js                                                     ││
│  │  ├─ Express HTTP 服务器 (端口 10000)                           ││
│  │  ├─ MCP Streamable HTTP 传输层                                 ││
│  │  ├─ Helmet (安全头)                                            ││
│  │  └─ express-rate-limit (限流中间件)                            ││
│  └─────────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────┤
│  应用层 (Application)                                                │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  tools.js                                                      ││
│  │  ├─ 7 个工具注册表                                             ││
│  │  ├─ AJV Schema 校验                                            ││
│  │  └─ withErrorHandling 统一错误包装                              ││
│  └─────────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────┤
│  领域层 (Domain)                                                     │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────┐│
│  │ ops-terminal │  ops-tmux    │  ops-exec    │   ops-file       ││
│  │ ops-system   │  ops-path    │  ops-session │                  ││
│  └──────────────┴──────────────┴──────────────┴──────────────────┘│
├─────────────────────────────────────────────────────────────────────┤
│  基础设施层 (Infrastructure)                                         │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  session-manager.js   → PTY 会话生命周期管理                    ││
│  │  traffic-core.js      → curl-impersonate TLS 混淆              ││
│  │  security.js          → 命令/路径/Shell 安全校验               ││
│  │  intelligent/         → 命令增强器 + UA 池                     ││
│  │  config-manager.js      → 配置集中化管理 (P2-9)                ││
│  │  concurrency-manager.js → 全局状态 + 并发控制 (P0-1)           ││
│  │  performance-optimizer  → NetworkRequestQueue 网络并发队列      ││
│  │  sampling/auto-tuner    → 自适应并发调节                        ││
│  │  ip-whitelist.js        → IP 白名单校验                        ││
│  │  utils-logger.js        → 结构化日志                           ││
│  │  utils-error-handler    → 错误分类体系 + 降级机制 (P1-6)        ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### 模块调用关系

```
tools.js (工具注册表)
  │
  ├──→ ops-terminal.js    ←(AJV 校验参数)→  PTY 会话 I/O
  │       │
  │       ├──→ session-manager.js   → node-pty
  │       └──→ security.js          → validateCommand
  │
  ├──→ ops-tmux.js        ←(AJV 校验参数)→  Tmux 多路复用器
  │       │
  │       ├──→ child_process.exec
  │       └──→ 环境缓存 (_envCache, 30s TTL)
  │
  ├──→ ops-exec.js        ←(AJV 校验参数)→  直接命令执行
  │       │
  │       ├──→ child_process.execFile
  │       └──→ intelligent/enhancer.js   → curl-impersonate 检测
  │
  ├──→ ops-file.js        ←(AJV 校验参数)→  文件 I/O + HTTP
  │       │
  │       ├──→ fs (read/write/list/delete)
  │       ├──→ traffic-core.js          → TLS 指纹混淆
  │       └──→ intelligent/enhancer.js  → 自动 UA 注入
  │
  ├──→ ops-system.js      ←(AJV 校验参数)→  系统信息 + 端口扫描
  │       │
  │       └──→ child_process.exec (nmap / hostname / ip 等)
  │
  ├──→ ops-path.js        ←(AJV 校验参数)→  目录导航 + 搜索
  │       │
  │       └──→ fs (readdir/stat/readFile)
  │
  └──→ ops-session.js     ←(AJV 校验参数)→  会话生命周期管理
          │
          └──→ session-manager (listSessions / killAll / stats)
```

### 数据流：典型工具调用链路（以 `file fetch` 为例）

```
客户端 MCP 请求
  │
  ▼
server.js (Express + MCP 传输)
  │ 1. IP 白名单校验 [ip-whitelist.js]
  │ 2. Helmet 安全头
  │ 3. Rate Limit 限流
  ▼
tools.js (AJV Schema 校验)
  │
  ▼
ops-file.js (file fetch action)
  │ 4. security.js → validatePath (路径校验)
  │ 5. NetworkRequestQueue 并发控制 [performance-optimizer.js]
  │    ├── per-tool 限流 (max 5 concurrent 'fetch' ops)
  │    ├── 优先级排序 (interactive > background)
  │    └── 指数退避重试
  ▼
traffic-core.js (3 层流量混淆)
  │ 6. Layer 1: curl-impersonate 选择 (chrome/firefox/safari/edge)
  │ 7. Layer 2: getBrowserHeaders (动态 Sec-Ch-Ua, Sec-Fetch-*, Accept-Language)
  │ 8. Layer 3: generateUA (动态 UA 字符串, 随机 OS/版本)
  │ 9. ConfigPool: 参数隐藏 (tmpfile, 非 argv 传递)
  ▼
intelligent/enhancer.js
  │ 10. UA Pool 随机选择桌面浏览器 UA
  │ 11. curl-impersonate 二进制检测 (本地 → /usr/local/bin → /usr/bin → PATH)
  ▼
curl-impersonate 二进制 (curl_chrome131 / curl_firefox133 / ...)
  │ 12. 执行 curl 请求，返回响应
  ▼
ops-file.js 解析响应 → tools.js 包装 → server.js 返回客户端
```

### 数据流：PTY 会话生命周期

```
tools.js (terminal create)
  │
  ▼
ops-terminal.js (TerminalOps.createSession)
  │
  ▼
session-manager.js (SessionManager.createSession)
  │ 1. 检查 max_sessions (默认 20)
  │ 2. node-pty spawn(shell, args, env)
  │ 3. 注册 session 到 sessions Map
  │ 4. 启动 output 轮询 (polling)
  │ 5. 启动 zombie 检测 (inactiveTime 检查)
  │ 6. 注册 SIGCHLD 退出处理器
  │
  ▼
返回 sessionId / pid / state
```

---

## 📂 目录结构总览

```
mcp-server_2025.11.25/
├── server.js                  # 主入口：Express + MCP Streamable HTTP
├── tools.js                   # 7 个工具注册表 + AJV Schema
├── config.json                # 端口 10000, IP 白名单, 终端默认值, Tmux 配置
├── package.json               # 项目元数据 + 依赖声明
├── .eslintrc.json             # ESLint 配置
├── .gitignore                 # Git 忽略规则
│
├── ops-terminal.js            # PTY 终端操作：创建/写入/读取/执行/信号/缩放/杀死
├── ops-tmux.js                # Tmux 多路复用器操作：会话/窗口/窗格管理
├── ops-exec.js                # 直接命令执行：exec/stream/batch
├── ops-file.js                # 文件操作 + HTTP 请求（含混淆）
├── ops-system.js              # 系统信息 + 端口扫描
├── ops-path.js                # 目录导航：tree/explore/context/bookmark/find/stats
├── ops-session.js             # 会话管理：list/killAll/reset/background/foreground/stats
│
├── session-manager.js         # PTY 会话核心：生命周期/内存/僵尸检测
├── traffic-core.js            # TLS 指纹混淆核心
├── security.js                # 安全校验：命令/路径/Shell/Timeout
├── ip-whitelist.js            # IP CIDR 白名单校验
│
├── config-manager.js          # 配置集中化管理器 (P2-9)：类型安全 getter + 热重载
├── concurrency-manager.js     # 并发管理器 (P0-1)：替换 global.perfStats + 滑动窗口统计
├── performance-optimizer.js   # 网络并发队列：NetworkRequestQueue + per-tool 限流 + 重试
├── utils-logger.js            # 结构化日志：控制台 + JSONL 文件（10MB 轮转）
├── utils-error-handler.js     # 错误分类体系 + 降级机制 (P1-6)：MCPError/DegradedTracker
│
├── intelligent/               # 智能增强模块
│   ├── index.js               # 模块导出
│   ├── enhancer.js            # 命令增强器：自动 curl-impersonate + UA 注入
│   ├── ua-pool.js             # UA 池管理：5 种浏览器 + 桌面/移动端
│   └── reporter.js            # 增强报告生成
│
├── sampling/                  # 自适应调节模块
│   └── auto-tuner.js          # 并发自适应调节（每 30s）+ 超时推荐
│
├── types/                     # TypeScript 类型定义
│   └── mcp-tools.d.ts         # MCP 协议/工具/终端/Tmux/执行/文件/会话/系统类型
│
├── prompts/                   # 扫描提示配置
│   └── catalog.json           # Masscan/Nmap/Combo 扫描模式选择
│
├── skills/                    # MCP 技能文档
│   └── skill.md               # 工具链参考文档
│
├── curl-impersonate/          # curl-impersonate 预编译二进制
│   ├── curl_chrome131
│   ├── curl_chrome120
│   ├── curl_chrome116
│   ├── curl_chrome110
│   ├── curl_chrome107
│   ├── curl_chrome104
│   ├── curl_chrome101
│   ├── curl_chrome100
│   ├── curl_chrome99
│   ├── curl_firefox133
│   ├── curl_firefox117
│   ├── curl_firefox109
│   ├── curl_firefox102
│   ├── curl_firefox100
│   ├── curl_firefox98
│   ├── curl_firefox95
│   ├── curl_firefox91esr
│   ├── curl_safari17
│   ├── curl_safari15_5
│   ├── curl_safari15_3
│   ├── curl_edge101
│   ├── curl_edge99
│   └── curl_ff120            # (共 23 个 TLS 指纹配置文件)
│
├── __tests__/                 # 测试文件
│   ├── unit.test.js           # 单元/Schema/安全测试
│   ├── benchmark.test.js      # 性能基准测试
│   ├── traffic-core.test.js   # 流量核心测试
│   └── chunked-reference.test.js  # 分块引用测试
│
├── test/                      # 测试辅助
│   └── test_spawn.js          # spawn 测试脚本
│
├── test-improvements.js       # 改进测试脚本
├── test-new-tools.js          # 新工具测试脚本
├── test-tmux-security.js      # Tmux 安全测试脚本
├── validate-mcp-schema.js     # MCP Schema 验证脚本
│
├── backup/                    # 备份
│   └── tools-old.js.backup    # 旧版 tools.js 备份
│
├── logs/                      # 日志目录
└── node_modules/              # 依赖
```

---

## 🛡️ 七层安全架构

```
┌────────────────────────────────────────────────────────────────────┐
│  第 1 层: IP 白名单 (ip-whitelist.js)                              │
│  ├── isAllowedIP() — 校验 config.allowed_ips                       │
│  └── 支持 CIDR 表示法，处理 IPv6 ::ffff: 前缀                      │
├────────────────────────────────────────────────────────────────────┤
│  第 2 层: 限流 (express-rate-limit)                                │
│  ├── config.json: window_ms + max_requests                         │
│  └── 默认: 200 请求/分钟                                           │
├────────────────────────────────────────────────────────────────────┤
│  第 3 层: 命令校验 (security.js)                                   │
│  ├── validateCommand(): 阻断 null 字节、换行符、22 个危险模式       │
│  │   (rm -rf, dd, mkfs, pipe-to-sh, sudo, chmod 777, /dev/tcp 等) │
│  ├── validatePath(): 阻断 /etc/shadow, /etc/sudoers, /root/.ssh   │
│  ├── validateShell(): 白名单 /bin/bash, /bin/zsh 等               │
│  └── validateTimeout(): 钳制 1-300 秒                             │
├────────────────────────────────────────────────────────────────────┤
│  第 4 层: 环境变量净化 (session-manager.js)                        │
│  ├── BLOCKED_ENV_KEYS: LD_PRELOAD, IFS, BASH_ENV, ...            │
│  └── Key 长度限制 4096 字节                                       │
├────────────────────────────────────────────────────────────────────┤
│  第 5 层: 内存与进程限制                                            │
│  ├── 输出缓冲区: 每会话 5MB 上限                                   │
│  ├── 最大会话: 20（可配置）                                        │
│  ├── 文件下载: 10MB 上限                                           │
│  ├── curl 输出: 5MB 上限                                           │
│  └── 孤儿进程清理: SIGTERM 后 5s → SIGKILL                        │
├────────────────────────────────────────────────────────────────────┤
│  第 6 层: 参数隐藏 (traffic-core.js)                               │
│  ├── ConfigPool: URL/headers 通过 tmpfile 传递（非 argv）          │
│  ├── 防止 ps/aux, auditd 等进程监控泄露                           │
│  ├── 文件权限 0o600，自动 120s 清理                                │
│  └── TLS 会话缓存文件跨请求复用                                    │
├────────────────────────────────────────────────────────────────────┤
│  第 7 层: 全局异常处理                                              │
│  ├── uncaughtException + unhandledRejection → logger.fatal()      │
│  ├── SIGTERM/SIGINT 优雅关闭                                       │
│  └── 终止所有会话，HTTP 服务器 5s 强制关闭                          │
└────────────────────────────────────────────────────────────────────┘
```

---

## 📊 七工具一览

### 1. terminal — 交互式 PTY Shell 会话

| 项目 | 说明 |
|------|------|
| **用途** | 交互式终端会话（bash, msfconsole, sliver, python 等），状态持久化 |
| **Actions** | `create`, `write`, `read`, `exec`, `signal`, `resize`, `kill`, `info`, `rename`, `stream`（10 个） |
| **Shell 支持** | `/bin/bash`, `/bin/zsh`, `/usr/bin/msfconsole`, `/usr/bin/sliver-client`, `/usr/bin/python3` |
| **Prompt 检测** | 30+ 种 shell/工具 prompt 模式 |
| **快速命令** | `ls`, `pwd`, `whoami`, `id`, `date`, `echo`, `cat`, `head` 等 → 200ms 轮询 |
| **长命令** | `nmap`, `msfconsole`, `hydra`, `john` 等 → 自动后台模式，300s 超时 |

### 2. tmux — 终端多路复用器

| 项目 | 说明 |
|------|------|
| **用途** | 持久化终端会话、分屏、断线后可恢复的任务 |
| **Actions** | `status`, `create`, `createDetached`, `attach`, `list`, `kill`, `killAll`, `rename`, `createWindow`, `listWindows`, `selectWindow`, `killWindow`, `splitPane`, `resizePane`, `selectPane`, `listPanes`, `killPane`, `sendKeys`, `sendPrefix`, `capture`, `type`, `execute`, `waitFor`, `listBuffers`, `saveBuffer`, `copyMode`, `info`, `refresh`（28 个） |
| **特性** | 激进缓存（30s TTL）、预启动、连接恢复重试、ANSI 清理、1MB 输出上限 |

### 3. execute — 一次性命令执行

| 项目 | 说明 |
|------|------|
| **用途** | 不需要 PTY 开销的简单命令执行，比 terminal 更快 |
| **Actions** | `exec`（单条同步）、`stream`（PTY 流式）、`batch`（并行 1-50 条） |
| **限制** | 命令 4096 字符、批次最多 50 条、超时 1-300 秒、并发 1-20 |

### 4. file — 文件系统 + HTTP 请求（含流量混淆）

| 项目 | 说明 |
|------|------|
| **用途** | 文件操作 + 带 3 层混淆的 HTTP 请求 |
| **Actions** | `read`, `write`, `list`, `delete`, `download`（base64 分块）, `upload`（base64 分块）, `fetch`（HTTP）|
| **混淆层 1** | curl-impersonate TLS 指纹（23 个配置文件：Chrome/Firefox/Safari/Edge） |
| **混淆层 2** | 动态浏览器头（Sec-Ch-Ua, Sec-Fetch-*, Accept-Language 等） |
| **混淆层 3** | 动态 UA 字符串（随机浏览器家族、版本、OS） |
| **UA 模式** | `random`, `chrome`, `firefox`, `edge`, `safari`, `mobile`, `bot`, `curl` |
| **参数隐藏** | ConfigPool 通过 tmpfile 传递 URL/headers，防止 argv 泄露 |

### 5. session — 会话生命周期管理

| 项目 | 说明 |
|------|------|
| **用途** | 查看、清理和管理所有 PTY + tmux 会话 |
| **Actions** | `list`（含僵尸检测）, `killAll`, `reset`, `background`, `foreground`, `stats` |
| **僵尸检测** | `inactiveTime > zombieThreshold`（默认 15 分钟） |
| **资源统计** | 堆内存 / RSS / 会话数量 / 内存总量 / 每会话详情 |

### 6. system — 系统信息与网络工具

| 项目 | 说明 |
|------|------|
| **用途** | 快速系统概览 + 网络侦察 |
| **Actions** | `info`（hostname, uptime, users, memory, disk）, `network`（interfaces, routes, dns）, `portScan`（nmap -T5） |
| **端口扫描** | `nmap -p ports --open -T5 target`，30s 超时，无 NSE 脚本 |

### 7. path — 智能目录导航

| 项目 | 说明 |
|------|------|
| **用途** | 高效目录探索、上下文记忆、书签、文件搜索 |
| **Actions** | `tree`（递归目录树）, `explore`（智能摘要）, `context`（位置记忆）, `bookmark`（路径书签）, `find`（文件搜索）, `stats`（目录大小分析）, `quickView`（文件预览） |
| **忽略路径** | `node_modules`, `.git`, `__pycache__`, `venv`, `dist`, `build`, `tmp`, `temp` 等 |
| **忽略文件** | `.DS_Store`, `Thumbs.db`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` |
| **关注扩展** | `.py`, `.js`, `.ts`, `.go`, `.rs`, `.java`, `.sh`, `.yaml`, `.json`, `.conf`, `.pem`, `.key`, `.env` 等 |

---

## ⚠️ 风险与问题

### 循环依赖
未发现（导入方向单向：`tools.js → ops-*.js ← 共享工具模块`）

### 紧耦合
| 问题 | 位置 | 说明 | 修复状态 |
|------|------|------|----------|
| `global.perfStats` 直接访问 | — | 已替换为 `ConcurrencyManager` 类 | ✅ `concurrency-manager.js` (P0-1) |
| `global.requestQueue.concurrency` 直接写入 | — | 已通过 `ConcurrencyManager.concurrency` setter 委托 | ✅ `auto-tuner.js` + `server.js` |
| `sessionManager` 模块级单例 | `ops-session.js:8` | 通过模块级变量传递，非依赖注入，紧耦合 | ❌ 待修复 |

### 测试覆盖盲区
| 盲区 | 说明 |
|------|------|
| PTY 操作 | 无 `ops-terminal.js` / `session-manager.js` 的集成测试 |
| Tmux 操作 | 无 `ops-tmux.js` 的集成测试 |
| 流量混淆 | `traffic-core.js` 测试存在但 `intelligent/reporter.js` 未审查 |
| 安全校验 | `security.js` 仅有 schema 层测试，无真实命令注入测试用例 |
| 自适应并发 | `auto-tuner.js` 无测试 |

### 其他风险

| 风险类型 | 说明 |
|----------|------|
| **安全设计** | 工具主要功能（WAF/IDS 绕过、TLS 指纹混淆、参数隐藏）专为攻防安全设计 |
| **资源消耗** | 每个会话 5MB 输出缓冲区 + 20 最大会话 = 100MB 潜在内存占用 |
| **预编译二进制** | `curl-impersonate/` 下 23 个二进制文件无源码验证，存在供应链风险 |
| **硬编码路径** | Shell (`/bin/bash`)、tmux (`/usr/bin/tmux`)、curl-impersonate 目录硬编码 |
| **临时文件泄露** | ConfigPool 在 `/tmp/.mcp_cfg_*` 创建临时文件，虽为 0o600 权限且 120s 清理，但存在时间窗口泄露 |
| **日志内存** | `utils-logger.js` 有 LRU 清理：超过 1000 条时裁剪至 500 条 ✅ |
| **孤儿进程** | SIGTERM 后 5s 强制 SIGKILL — 5 秒窗口内进程仍可输出或执行操作 |

---

## 📐 TypeScript 类型体系概览

`types/mcp-tools.d.ts` 定义了以下类型体系：

| 类型体系 | 内容 |
|----------|------|
| JSON-RPC | `JSONRPCRequest`, `JSONRPCResponse`, `JSONRPCError`, `JSONRPCMessage` |
| 工具系统 | `ToolInputSchema`, `MCPToolDefinition`, `ToolResult` |
| 终端工具 | `TerminalAction` (10 种), `TerminalParams` (10 个参数接口) |
| Tmux 工具 | `TmuxAction` (7 种), `TmuxParams` (7 个参数接口) |
| 执行工具 | `ExecuteAction` (2 种), `ExecuteParams` (2 个参数接口) |
| 文件工具 | `FileAction` (7 种), `FileParams` (7 个参数接口) |
| 会话工具 | `SessionAction` (5 种), `SessionParams` (5 个参数接口) |
| 系统工具 | `SystemAction` (3 种), `SystemParams` (3 个参数接口) |
| 服务器配置 | `ServerConfig` |
| 会话信息 | `SessionInfo` |
| 性能指标 | `PerformanceMetrics`, `MemorySample`, `ToolStats` |
| 错误类型 | `ErrorDetails`, `MCPErrorResponse` |

---

## 📝 附录

### 自适应并发调节算法

```
输入: ConcurrencyManager.getSlowRatio() (滑动窗口: 最近 60s 慢请求比例)
输入: concurrencyManager.minConcurrency / maxConcurrency (来自 ConfigManager)
输出: concurrencyManager.concurrency (范围: config 中配置的最小-最大)

IF slowRatio > 0.15:
    目标并发 = max(minC, floor(maxC * (1 - slowRatio)))   // 高负载 → 降低并发
ELSE:
    loadFactor = 1 - slowRatio
    目标并发 = min(maxC, floor(minC + (maxC - minC) * loadFactor))  // 低负载 → 提升并发
```

### 降级机制 (P1-6)

```
DegradationTracker (utils-error-handler.js)
├── 每 tool+action 追踪连续失败次数
├── 阈值: 3 次连续失败 → 进入降级模式
├── 恢复: 2 次连续成功 或 30s 冷却期 → 自动恢复
├── 降级模式: 操作仍会尝试执行（可能成功并自动恢复）
└── 日志: 进入/退出降级模式时记录结构化告警日志
```

### NetworkRequestQueue (performance-optimizer.js)

```
NetworkRequestQueue
├── 全局最大并发: 10 (来自 performance.network_queue.max_concurrent)
├── 每工具并发限制: 5 (来自 per_tool_limit)
├── 最大队列深度: 100 (来自 max_queue_size)
├── 优先级排序: 高优先级 (interactive) 先出队
├── 重试策略: 指数退避 (1s, 2s, 4s)，网络错误可重试
└── 集成: ops-file.js (fetchUrl) + ops-system.js (portScan)
```

### UA 池覆盖范围

| 浏览器 | 桌面 | 移动 |
|--------|------|------|
| Chrome | ✅ | ✅ (Pixel 8, SM-G998B) |
| Firefox | ✅ | ✅ (Android 14) |
| Safari | ✅ (Mac) | ✅ (iPhone/iPad) |
| Edge | ✅ | ❌ |
| curl | ✅ (curl/8.4.0) | ❌ |

### curl-impersonate TLS 配置文件

| 浏览器 | 配置文件（共 23 个） |
|--------|---------------------|
| Chrome | chrome99, chrome100, chrome101, chrome104, chrome107, chrome110, chrome116, chrome120, chrome131 |
| Firefox | firefox91esr, firefox95, firefox98, firefox100, firefox102, firefox109, firefox117, firefox133 |
| Safari | safari15_3, safari15_5, safari17 |
| Edge | edge99, edge101 |

---

*文档自动生成，基于 `/home/song/mcp-server_2025.11.25` 代码库深度分析*
