# MCP Server for Kali Linux — Toolchain Reference

## Architecture Overview

```
MCP Client ─── Streamable HTTP (MCP 2025-11-25) ───> server.js (Express)
                                                          │
                                           ┌──────────────┴──────────────┐
                                           │  RequestQueue (concurrency) │
                                           │  IP Whitelist / Rate Limit  │
                                           │  Session Manager (node-pty) │
                                           └──────────────┬──────────────┘
                                                          │
                                           ┌──────────────┴──────────────┐
                                           │       tools.js              │
                                           │  7 tools, ~60 sub-actions  │
                                           │  AJV schema validation      │
                                           └──┬───┬───┬───┬───┬───┬───┬─┘
                                              │   │   │   │   │   │   │
                     terminal  tmux  execute  file  session  system  path
```

All tools use a unified dispatch pattern: `{ action: "<op>", ...params }` via `tools/call`.

---

## 1. terminal — Interactive PTY Shell Sessions

**Purpose:** Interactive terminal sessions (bash, msfconsole, sliver, python, etc.) with state persistence.

**Actions:** `create`, `write`, `read`, `exec`, `signal`, `resize`, `kill`, `info`, `rename`, `stream`

### Common Workflow

```json
// Step 1: Create session
{"action":"create", "shell":"/bin/bash", "args":["-i"], "cols":120, "rows":30}
// Response: { success:true, sessionId:"session_xxx", pid:12345, state:"running" }

// Step 2: Execute command (waits for completion)
{"action":"exec", "sessionId":"session_xxx", "command":"ls -la", "timeout":30}
// Response: { success:true, output:"...", completed:true, exitCode:0 }

// Step 3: Read output (non-blocking)
{"action":"read", "sessionId":"session_xxx", "clear":true, "wait":"idle"}
// Response: { success:true, output:"...", hasOutput:true, state:"idle" }

// Step 4: Kill session
{"action":"kill", "sessionId":"session_xxx"}
// Response: { success:true, message:"Session killed" }
```

### Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | string | **required** | One of: create, write, read, exec, signal, resize, kill, info, rename, stream |
| `sessionId` | string | — | Required for all except `create` |
| `shell` | string | `/bin/bash` | Shell/executable path: `/bin/bash`, `/bin/zsh`, `/usr/bin/msfconsole`, `/usr/bin/sliver-client`, `/usr/bin/python3` |
| `args` | string[] | `["-i"]` | Shell arguments: `["-i"]` for bash, `["-q"]` for msfconsole |
| `data` | string | — | Raw input to write (use `\n` for Enter) |
| `command` | string | — | Command to execute (`exec` action) |
| `signal` | string | — | `SIGINT`(Ctrl+C), `SIGTSTP`(Ctrl+Z), `SIGQUIT`, `SIGEOF`(Ctrl+D) |
| `cols` / `rows` | number | 120 / 30 | Terminal size (width/height) |
| `timeout` | number | tool-recommended | Wait timeout in seconds (1-300) |
| `clear` | boolean | true | Clear output buffer after read |
| `wait` | boolean/string | false | Read mode: `false`(immediate), `"idle"`(wait prompt), `"output"`(wait output), `"pattern"`(wait regex) |
| `pattern` | string | — | Regex when `wait="pattern"`, e.g. `"password:"` |

### Shell-Specific Prompt Detection

The session manager auto-detects command completion via shell prompt patterns:

| Shell | Pattern | Timeout Adjustment |
|-------|---------|-------------------|
| bash/zsh/sh | `$ ` or `# ` | Fast: 5s default |
| msfconsole | `msf6 (>) >` | Long-running: 300s default |
| sliver-client | `sliver >` | Long-running: 300s default |
| python/ipython | `>>> ` / `In [1]:` | Standard: 30s default |
| mysql | `mysql> ` | Standard: 30s default |
| nmap/hydra/john | auto-detected | Auto-background, 300s |

### Fast-Command Optimization

Commands matching a `FAST_COMMANDS` pattern (ls, pwd, whoami, id, date, echo, cat, head, etc.) use a 200ms polling loop for near-instant response.

### Error Codes

| Response | Meaning |
|----------|---------|
| `{success:false, error:"Session not found"}` | sessionId invalid or expired |
| `{success:false, error:"Session is not active"}` | Session already exited/errored |
| `{success:false, error:"Command contains dangerous operations"}` | Blocked by security.js |
| `{success:true, async:true, longRunning:true}` | Command auto-detected as long-running |

---

## 2. tmux — Terminal Multiplexer

**Purpose:** Persistent terminal sessions, split-screen, background tasks that survive disconnection.

**Actions:** `status`, `create`, `createDetached`, `attach`, `list`, `kill`, `killAll`, `rename`, `createWindow`, `listWindows`, `selectWindow`, `killWindow`, `splitPane`, `resizePane`, `selectPane`, `listPanes`, `killPane`, `sendKeys`, `sendPrefix`, `capture`, `type`, `execute`, `waitFor`, `listBuffers`, `saveBuffer`, `copyMode`, `info`, `refresh` — 28 total.

### Core Sessions

```json
// Check availability
{"action":"status"}
// Response: { success:true, available:true, version:"3.4", serverRunning:true }

// Create named session (detached)
{"action":"create", "sessionName":"pentest", "options":{"command":"nmap -sV 192.168.1.1"}}
// Response: { success:true, sessionName:"pentest", attached:false }

// Create background session
{"action":"createDetached", "sessionName":"scan"}
// Response: { success:true, sessionName:"scan", attached:false }

// List sessions
{"action":"list", "detailed":true}
// Response: { success:true, sessions:[{name:"pentest", windows:2, attached:false, ...}], count:1 }

// Kill session
{"action":"kill", "sessionName":"pentest"}
// Response: { success:true, sessionName:"pentest" }
```

### Window & Pane Management

```json
// Split pane horizontal
{"action":"splitPane", "sessionName":"pentest", "options":{"direction":"horizontal", "size":50}}
// Response: { success:true, sessionName:"pentest", direction:"horizontal" }

// List panes
{"action":"listPanes", "sessionName":"pentest", "options":{"windowIndex":0}}
// Response: { success:true, panes:[{index:0, active:true, width:60, height:24, pid:1234}] }

// Create new window
{"action":"createWindow", "sessionName":"pentest", "options":{"windowName":"nmap"}}
// Response: { success:true, sessionName:"pentest", windowName:"nmap" }
```

### Keyboard & Content

```json
// Send keys with Enter
{"action":"sendKeys", "sessionName":"pentest", "options":{"keys":"ls -la", "enter":true}}
// Response: { success:true, sessionName:"pentest", keys:"ls -la" }

// Capture pane content
{"action":"capture", "sessionName":"pentest", "options":{"lines":50, "cleanOutput":true}}
// Response: { success:true, content:["line1","line2",...], lineCount:50 }

// Execute command and wait
{"action":"execute", "sessionName":"pentest", "options":{"command":"whoami", "waitUntilComplete":true, "timeout":30}}
// Response: { success:true, captured output }

// Wait for pattern in output
{"action":"waitFor", "sessionName":"pentest", "options":{"pattern":"password:", "timeout":60}}
// Response: { success:true, matched:true/false }
```

### Architecture Note

The tmux ops module includes:
- **Aggressive caching** — `_envCache` with 30s TTL and exponential backoff (500ms/1s/2s/4s)
- **Prewarming** — tmux environment check runs on module load with 100ms delay
- **Connection recovery** — automatic retry with backoff on `no server running`
- **Session registry** — in-memory `_sessionRegistry` Map tracks all created sessions
- **ANSI cleanup** — `_cleanAnsiOutput()` strips escape sequences from captured output
- **Output limit** — 1MB max per tmux command, 15s capture timeout

### Configuration (config.json)

```json
{"tmux": {"path":"/usr/bin/tmux", "default_session_prefix":"mcp_", "max_sessions":10}}
```

---

## 3. execute — One-Shot Command Execution

**Purpose:** Run commands without PTY overhead. No session state. Faster than `terminal` for simple commands.

**Actions:** `exec`, `stream`, `batch`

### exec — Single Synchronous Command

```json
{"action":"exec", "command":"whoami", "timeout":60}
// Response: { success:true, output:"root\n", stdout:"root\n", stderr:"", exitCode:0, completed:true }
```

### batch — Parallel Execution

```json
{"action":"batch", "commands":["nmap -p 22 host1", "nmap -p 22 host2"], "timeout":60, "concurrency":5}
// Response: {
//   success:true,
//   results:[{command:"nmap ...", success:true, output:"..."}, ...],
//   summary:{total:2, succeeded:2, failed:0}
// }
```

### stream — Start Command via PTY (for long-lived output streaming)

```json
{"action":"stream", "command":"tail -f /var/log/syslog"}
// Response: { success:true, sessionId:"stream_xxx", pid:12345, message:"Command started. Use terminal read to get output." }
```

**Note:** `stream` falls back to `sessionManager.createSession()`, creating a PTY session usable with `terminal` tool's `read` action.

### Parameter Reference

| Parameter | Type | Default | Limits |
|-----------|------|---------|--------|
| `command` | string | — | Max 4096 chars |
| `commands` | string[] | — | Max 50 items, 4096 chars each |
| `timeout` | number | 60 | 1-300 seconds |
| `concurrency` | number | 5 | 1-20 |
| `cwd` | string | — | Working directory |
| `env` | object | — | Extra env vars (BLOCKED_ENV_KEYS filtered) |

---

## 4. file — File System & HTTP Fetch

**Purpose:** File operations plus traffic-obfuscated HTTP requests.

**Actions:** `read`, `write`, `list`, `delete`, `download`, `upload`, `fetch`

### File Operations

```json
// Read file
{"action":"read", "path":"/etc/hostname", "encoding":"utf8"}
// Response: { success:true, content:[{type:"text", text:"kali\n"}], size:5 }

// Write file
{"action":"write", "path":"/tmp/script.sh", "content":"#!/bin/bash\necho hello"}
// Response: { success:true, path:"/tmp/script.sh", bytesWritten:26 }

// List directory
{"action":"list", "path":"/home/user", "showHidden":true}
// Response: { success:true, items:[{name:"projects", type:"directory", size:4096}, ...], count:5 }

// Delete
{"action":"delete", "path":"/tmp/oldfile.txt"}
// Response: { success:true, message:"Deleted successfully" }

// Download as base64
{"action":"download", "path":"/tmp/large.bin", "offset":0, "chunkSize":1048576}
// Response: { success:true, data:"base64...", encoding:"base64", fileSize:12345 }

// Upload base64
{"action":"upload", "path":"/tmp/restored.bin", "data":"base64...", "append":false}
// Response: { success:true, bytesWritten:1024, totalSize:1024 }
```

### HTTP Fetch with Traffic Obfuscation — The Core Feature

```json
// Basic GET
{"action":"fetch", "url":"https://api.example.com/data"}
// Response: { success:true, status:200, headers:{...}, body:"...", parsedBody:{...} }

// POST with JSON body and custom headers
{"action":"fetch", "url":"https://target.com/api",
 "method":"POST", "headers":{"Authorization":"Bearer token"},
 "body":{"key":"value"}}

// Obfuscated request (WAF/IDS evasion)
{"action":"fetch", "url":"https://waf-protected.com",
 "uaMode":"random", "tlsProfile":"chrome131", "paramHide":true}
```

### Three-Layer Obfuscation Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: TLS Fingerprint (curl-impersonate)                │
│  ─── 23 profiles: chrome99-131, edge99/101,                │
│       firefox91esr-133, safari15_3-17                      │
│  ─── Uses precompiled curl binaries from curl-impersonate/ │
│  ─── Evades JA3/JA4 fingerprint detection                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: HTTP Headers (getBrowserHeaders)                  │
│  ─── Dynamic Sec-Ch-Ua, Sec-Fetch-*, Accept-Language        │
│  ─── Browser-specific headers (Chrome gets Sec-Ch-Ua,      │
│       Firefox doesn't, etc.)                                 │
│  ─── Randomized Accept-Language (5 locales)                 │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: UA String (generateUA)                            │
│  ─── Dynamic: Chrome(120-133), Firefox(120-133),           │
│       Edge(120-133), Safari(16-17)                          │
│  ─── Randomized OS: Windows/Mac/Linux per call              │
│  ─── Sub-versions randomized per generation                 │
├──────────────────────────────────────────────────────────────┤
│  Security: Parameter Hiding                                 │
│  ─── ConfigPool: URL/headers passed via tmpfile, not argv   │
│  ─── Prevents exposure in ps/aux, auditd, process monitors  │
│  ─── Temporary body files auto-cleaned after request        │
│  ─── TLS session cache files reused across requests         │
└──────────────────────────────────────────────────────────────┘
```

### uaMode Profiles

| Mode | Behavior | Example Output |
|------|----------|---------------|
| `"random"` (default) | Random browser family + dynamic version | `Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 ... Chrome/128.0.1234.56 Safari/537.36` |
| `"chrome"` | Chrome family, v120-133 | `... Chrome/131.0.987.65 Safari/537.36` |
| `"firefox"` | Firefox family, v120-133 | `... Gecko/20100101 Firefox/132.0` |
| `"edge"` | Edge family, v120-133 | `... Edg/130.0.4567.89` |
| `"safari"` | Safari, v16-17 | `... Version/17.0 Safari/605.1.15` |
| `"mobile"` | Falls back to Chrome UA | Same as chrome |
| `"bot"` | Googlebot | `Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` |
| `"curl"` | Native curl version | `curl/8.4` |

### tlsProfile Options

| Browser | Available Profiles |
|---------|-------------------|
| Chrome | `chrome99`, `chrome100`, `chrome101`, `chrome104`, `chrome107`, `chrome110`, `chrome116`, `chrome120`, `chrome131` |
| Edge | `edge99`, `edge101` |
| Firefox | `firefox91esr`, `firefox95`, `firefox98`, `firefox100`, `firefox102`, `firefox109`, `firefox117`, `firefox133` |
| Safari | `safari15_3`, `safari15_5`, `safari17` |
| Default | `"auto"` — uses system curl (no impersonation) |

### When to Use Each Feature

| Scenario | Recommended Settings |
|----------|-------------------|
| WAF/IDS evasion | `uaMode:"random"`, `tlsProfile:"chrome131"`, `paramHide:true` |
| API call to known service | No params needed (system curl is faster) |
| Evading rate limiting | `uaMode:["random", "chrome", "firefox"]` rotates per request |
| IoT/embedded targets | `uaMode:"bot"` or `tlsProfile:"edge99"` |
| Maximum stealth | `paramHide:true` prevents argv leakage (always on for HTTPS) |

### ConfigPool Mechanism

```
ConfigPool ──── caches ────> /tmp/.mcp_cfg_<random>
  │
  ├── Keyed by hash(url + method + headers + tlsProfile)
  ├── Files created with mode 0o600 (owner-only read)
  ├── Auto-cleanup after 120s inactivity
  └── body content → /tmp/.mcp_body_<random> (deleted after request)
```

### Required curl-impersonate Binaries

Precompiled binaries located at `curl-impersonate/`. Detection order:
1. `projectDir/curl-impersonate/<binary>`
2. `/usr/local/bin/<binary>`
3. `/usr/bin/<binary>`
4. `$HOME/.local/bin/<binary>`
5. System `PATH`

---

## 5. session — Session Lifecycle Management

**Purpose:** View, clean up, and manage all PTY + tmux sessions.

**Actions:** `list`, `killAll`, `reset`, `background`, `foreground`, `stats`

```json
// List all sessions with zombie detection
{"action":"list", "includeDetails":true, "zombieThreshold":15}
// Response: { success:true, sessions:[{id:"session_xxx", state:"idle", ...}], count:3 }

// Statistics mode — summary view
{"action":"list", "statsMode":true}
// Response: { success:true, statistics:{total:5, byState:{bash:3,msfconsole:2}, zombies:[], ...},
//              summary:{total:5, zombies:0, recent:5, old:0} }

// Force kill all
{"action":"killAll", "force":true}
// Response: { success:true, message:"Killed 5 sessions", canCreateNew:true }

// Mark session as background (long-running task)
{"action":"background", "sessionId":"session_xxx", "command":"nmap -sV 192.168.1.0/24"}
// Response: { success:true, sessionId:"session_xxx", isBackground:true }

// Resource statistics
{"action":"stats", "includeProcesses":true}
// Response: { success:true, server:{heapUsed:45, heapTotal:128, rss:200},
//              sessions:{total:3, maxAllowed:20}, memory:{totalMB:15.3} }
```

### Zombie Detection Logic

A session is marked as `zombie` when `inactiveTime > zombieThreshold` (default 15 min). Zombies are listed separately in `stats.zombies[]` but not auto-killed (user decides).

---

## 6. system — System Information & Network Tools

**Purpose:** Quick system overview and network reconnaissance.

**Actions:** `info`, `network`, `portScan`

```json
// System info
{"action":"info"}
// Response: { success:true, hostname:"kali", uptime:"up 2 hours",
//              users:"root   tty1", memory:"Mem: 7.7G total, ...", disk:"/dev/sda1  58G  12G  44G  ..." }

// Network info
{"action":"network"}
// Response: { success:true, interfaces:"...ip addr output...",
//              routes:"...ip route output...", dns:"nameserver 8.8.8.8" }

// Port scan (uses nmap -T5 for speed)
{"action":"portScan", "target":"192.168.1.1", "ports":"22,80,443,8080"}
// Response: { success:true, target:"192.168.1.1", result:"PORT  STATE  SERVICE\n22/tcp  open  ssh\n80/tcp  open  http", code:0 }
```

### Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | string | — | Hostname/IP for port scan |
| `ports` | string | `"21,22,80,443"` | Port specification (single, range `"1-1000"`, comma `"22,80,443"`) |

**Note:** Port scan runs with `nmap -p <ports> --open -T5 <target>`, 30s timeout, no NSE scripts.

---

## 7. path — Smart Directory Navigation

**Purpose:** Efficient directory exploration, context memory, bookmarks, file search. Replaces multiple `ls`/`find` calls.

**Actions:** `tree`, `explore`, `context`, `bookmark`, `find`, `stats`, `quickView`

### tree — Recursive Directory Listing

```json
{"action":"tree", "path":"/home/user/project", "maxDepth":3, "showHidden":false, "dirsOnly":false}
// Response: { success:true, root:"/home/user/project",
//   tree:{name:"project", type:"directory", children:[{name:"src", type:"directory", children:[...]}]},
//   stats:{totalDirs:12, totalFiles:45, totalSize:123456, formattedSize:"120.6KB"} }
```

### explore — Smart Directory Summary

```json
{"action":"explore", "path":"/var/log", "groupByType":true, "showInteresting":true}
// Response: { success:true, path:"/var/log", parent:"/var",
//   summary:{dirs:3, files:28, totalSize:12345, byType:{Log:10, Config:2, Text:16},
//     interesting:[{name:"auth.log", type:"Log", size:"1.2MB"}]},
//   contents:{directories:[{name:"nginx",...}], files:[{name:"syslog",...}]},
//   suggestions:[{type:"config", file:"nginx.conf", hint:"Nginx configuration"}] }
```

### context — Location Memory

```json
// Get current context
{"action":"context", "name":"get"}
// Response: { success:true, currentPath:"/home/user", history:[...], bookmarks:[...] }

// Set new context
{"action":"context", "name":"set", "path":"/etc/nginx"}
// Response: { success:true, previousPath:"/home/user", currentPath:"/etc/nginx" }

// Navigate back
{"action":"context", "name":"back"}
// Response: { success:true, currentPath:"/home/user", history:[...] }

// View history
{"action":"context", "name":"history", "limit":10}
// Response: { success:true, history:[{path:"/etc/nginx", visitedAt:..., visitCount:3}], total:20 }
```

### bookmark — Path Shortcuts

```json
// Add bookmark
{"action":"bookmark", "name":"logs", "path":"/var/log"}
// Response: { success:true, bookmark:{name:"logs", path:"/var/log"}, total:3 }

// Get bookmark
{"action":"bookmark", "name":"logs"}
// Response: { success:true, name:"logs", path:"/var/log" }

// List all
{"action":"bookmark", "name":"list"}
// Response: { success:true, bookmarks:[{name:"logs", path:"/var/log"}], total:3 }
```

### find — File Search

```json
{"action":"find", "path":"/home", "pattern":".py", "type":"file", "maxDepth":5, "maxResults":50}
// Response: { success:true, root:"/home", pattern:".py",
//   results:[{name:"server.py", path:"/home/user/server.py", type:"file", ext:".py"}],
//   stats:{searched:1500, found:12, truncated:false, duration:45} }
```

### stats — Directory Size Analysis

```json
{"action":"stats", "path":"/home/user"}
// Response: { success:true, path:"/home/user",
//   summary:{totalDirs:50, totalFiles:300, totalSize:524288000, formattedSize:"500MB",
//     largestFiles:[{name:"data.db", path:"/home/user/data.db", size:104857600, formattedSize:"100MB"}],
//     byExtension:{".js":{count:50, size:512000}, ".py":{count:30, size:256000}},
//     recentFiles:[{name:"main.py", path:"/home/user/main.py", modified:...}]},
//   breakdown:{topDirs:[{path:"/home/user/node_modules", files:200, size:..."}], emptyDirs:[]} }
```

### quickView — File Preview

```json
{"action":"quickView", "path":"/home/user/main.py"}
// Response: { success:true, path:"/home/user/main.py", type:"file", size:"2.3KB", lines:120,
//   preview:"import os\n\ndef main():\n    ...",
//   truncated:false }
```

### Files Ignored by path Tool

Dirs: `node_modules`, `.git`, `.svn`, `__pycache__`, `.pytest_cache`, `venv`, `.venv`, `dist`, `build`, `coverage`, `tmp`, `temp`, etc.

Files: `.DS_Store`, `Thumbs.db`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

### Interesting Extensions (highlighted in explore)

`.py`, `.js`, `.ts`, `.jsx`, `.tsx`, `.go`, `.rs`, `.java`, `.kt`, `.rb`, `.php`, `.c`, `.cpp`, `.h`, `.sh`, `.yaml`, `.json`, `.xml`, `.toml`, `.md`, `.sql`, `.conf`, `.cfg`, `.ini`, `.env`, `.pem`, `.key`, `.pub`, `.bash`, `.zsh`

---

## Security Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1: IP Whitelist (ip-whitelist.js)                       │
│  ─── isAllowedIP() — validates against config.allowed_ips      │
│  ─── Supports CIDR, handles ::ffff:IPv6 prefix                 │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2: Rate Limiting (express-rate-limit)                   │
│  ─── config.json: window_ms + max_requests                     │
│  ─── Default: 200 req/min                                      │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3: Command Validation (security.js)                     │
│  ─── validateCommand(): checks null bytes, newlines,           │
│      22 DANGEROUS_PATTERNS (rm -rf, dd, mkfs, pipe-to-sh, etc)│
│  ─── validatePath(): blocks /etc/shadow, /etc/sudoers,        │
│      /root/.ssh                                                │
│  ─── validateShell(): whitelist of /bin/bash, /bin/zsh, etc.  │
│  ─── validateTimeout(): clamp 1-300 seconds                    │
├──────────────────────────────────────────────────────────────────┤
│  Layer 4: Environment Sanitization (session-manager.js)        │
│  ─── BLOCKED_ENV_KEYS: LD_PRELOAD, IFS, BASH_ENV, etc.        │
│  ─── Key length capped at 4096                                 │
├──────────────────────────────────────────────────────────────────┤
│  Layer 5: Memory & Process Limits                              │
│  ─── Output buffer: 5MB max per session                        │
│  ─── Max sessions: 20 (configurable)                           │
│  ─── File download: 10MB max                                   │
│  ─── curl output: 5MB max                                      │
│  ─── Orphan kill: 5s after SIGTERM → SIGKILL                   │
├──────────────────────────────────────────────────────────────────┤
│  Layer 6: Parameter Hiding (traffic-core.js)                   │
│  ─── ConfigPool: URL/headers via tmpfile instead of argv       │
│  ─── Prevents exposure in ps/aux, auditd, process monitoring  │
│  ─── Files created 0o600, auto-cleaned                         │
├──────────────────────────────────────────────────────────────────┤
│  Layer 7: Global Exception Handlers                            │
│  ─── uncaughtException + unhandledRejection → logger.fatal()   │
│  ─── Graceful shutdown on SIGTERM/SIGINT                       │
│  ─── All sessions terminated, HTTP server closed (5s force)    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Auto-Tuner (sampling/auto-tuner.js)

Adaptive concurrency control running every 30 seconds:

```
input:  global.perfStats (slow requests / total requests)
output: global.requestQueue.concurrency (range: 20-80)

logic:
  if slowRatio > 0.15:
    target = MAX(20, 80 * (1 - slowRatio))  // reduce concurrency
  else:
    loadFactor = 1 - slowRatio
    target = MIN(80, 20 + 60 * loadFactor)  // increase concurrency
```

Also provides `getRecommendedTimeout(toolName)` for dynamic timeout assignment (base + extra based on slow ratio).

---

## Error Response Format

All tools return a consistent JSON structure:

```json
// Success
{"success":true, ...toolSpecificFields}

// Error
{"success":false, "error":"<human-readable message>", "errorCode":"<code>"}

// MCP Protocol Error (from server.js)
{"jsonrpc":"2.0", "id":1, "error":{"code":-32603, "message":"<error>"}}
```

### Error Codes

| errorCode | Meaning |
|-----------|---------|
| `VALIDATION_ERROR` | Invalid parameters / schema violation |
| `SESSION_ERROR` | Session not found, expired, or inactive |
| `TIMEOUT_ERROR` | Tool/command exceeded timeout |
| `SECURITY_ERROR` | Blocked by security validation |
| `INTERNAL_ERROR` | Unexpected internal error (wraps to `Internal error in tool.action`) |

### MCP Error Codes (JSON-RPC)

| Code | Meaning |
|------|---------|
| `-32601` | Unknown method |
| `-32603` | Internal server error |
| `-32000` | Session not found/expired |
| `-32001` | HTTP session not found |

---

## Quick Reference: When to Use Which Tool

| Task | Tool | Action | Why |
|------|------|--------|-----|
| Run `ls` once | **execute** | exec | Fastest, no state |
| Interactive bash session | **terminal** | create | PTY state persistence |
| Run nmap (long wait) | **terminal** | exec | Auto-detects long-running, returns immediately with async mode |
| Persistent background job | **tmux** | createDetached | Survives disconnection |
| Split terminal | **tmux** | splitPane | Native tmux split |
| Read file contents | **file** | read | Direct file I/O |
| Download binary file | **file** | download | Base64 chunked output |
| Fetch URL with stealth | **file** | fetch | 3-layer obfuscation |
| View all sessions | **session** | list | Lifecycle management |
| Check system info | **system** | info | Quick overview |
| Explore a directory | **path** | explore | Smart summary with file types |
| Find files by name | **path** | find | Recursive pattern search |
| Port scan | **system** | portScan | Quick nmap (5 default ports, -T5) |
| Parallel commands | **execute** | batch | Up to 20 concurrent |
