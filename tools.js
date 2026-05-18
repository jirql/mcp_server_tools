/**
 * MCP Tools for Kali Linux - AI-Optimized Descriptions
 *
 * 7 Core Tools designed for AI assistants to control Kali Linux:
 *
 * 1. terminal - Interactive shell sessions (bash, msfconsole, sliver, etc.)
 * 2. tmux - Terminal multiplexer for persistent sessions
 * 3. execute - One-shot command execution
 * 4. file - File system operations
 * 5. session - Session lifecycle management
 * 6. system - System information and network tools
 * 7. path - Smart directory navigation with context memory
 */

import Ajv from "ajv";
import {
  terminalOps,
  setSessionManager as setTerminalSM,
} from "./ops-terminal.js";
import { tmuxOps } from "./ops-tmux.js";
import { fileOps } from "./ops-file.js";
import {
  sessionOps,
  setSessionManager as setSessionSM,
} from "./ops-session.js";
import { systemOps } from "./ops-system.js";
import { execOps, setSessionManager as setExecSM } from "./ops-exec.js";
import { pathOps } from "./ops-path.js";

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: true,
  allowUnionTypes: true,
});

function wrapHandler(schema, handler) {
  const validate = ajv.compile(schema);
  return async (params) => {
    if (!validate(params)) {
      const errors = validate.errors
        .map((e) => `${e.instancePath || "root"} ${e.message}`)
        .join("; ");
      return { success: false, error: `Invalid parameters: ${errors}` };
    }
    return handler(params);
  };
}

// ============================================================================
// TERMINAL TOOL - Interactive PTY Shell Sessions
// Backend: terminalOps.create/write/read/exec/signal/resize/kill/info/rename/stream
// ============================================================================
const terminalSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "create",
        "write",
        "read",
        "exec",
        "signal",
        "resize",
        "kill",
        "info",
        "rename",
        "stream",
      ],
      description:
        "Terminal operation. CREATE=start new session, WRITE=send raw input, READ=get output, EXEC=run command and wait, SIGNAL=send Ctrl+C etc, RESIZE=change terminal size, KILL=terminate session, INFO=get session details, RENAME=set session name, STREAM=start streaming mode",
    },
    sessionId: {
      type: "string",
      description:
        "Session ID from create action. Required for all actions except create.",
      maxLength: 128,
    },
    shell: {
      type: "string",
      description:
        "Shell program path. Examples: /bin/bash, /bin/zsh, /usr/bin/msfconsole, /usr/bin/sliver-client, /usr/bin/python3. Default: /bin/bash",
      default: "/bin/bash",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description:
        'Shell arguments. For bash use ["-i"] for interactive mode. For msfconsole use ["-q"] for quiet mode.',
    },
    data: {
      type: "string",
      maxLength: 4096,
      description:
        'Raw data to write to terminal. Use "\\n" for Enter key. Example: "ls -la\\n" to run ls command.',
    },
    command: {
      type: "string",
      maxLength: 4096,
      description:
        'Command to execute (for exec action). Will wait for command completion. Example: "nmap -sV 192.168.1.1"',
    },
    signal: {
      type: "string",
      enum: ["SIGINT", "SIGTSTP", "SIGQUIT", "SIGEOF"],
      description:
        "Control signal. SIGINT=Ctrl+C (interrupt), SIGTSTP=Ctrl+Z (suspend), SIGQUIT=Ctrl+\\ (quit), SIGEOF=Ctrl+D (end of input)",
    },
    cols: {
      type: "number",
      minimum: 10,
      maximum: 300,
      description: "Terminal width in characters. Default: 120",
    },
    rows: {
      type: "number",
      minimum: 5,
      maximum: 100,
      description: "Terminal height in lines. Default: 30",
    },
    name: {
      type: "string",
      maxLength: 64,
      description: "Human-readable name for the session (rename action)",
    },
    timeout: {
      type: "number",
      default: 30,
      minimum: 1,
      maximum: 300,
      description:
        "Wait timeout in seconds. For exec: max time to wait for command. For read with wait: max time to wait for condition.",
    },
    clear: {
      type: "boolean",
      default: true,
      description:
        "Clear output buffer after reading. Set false to keep output for next read.",
    },
    wait: {
      type: ["boolean", "string"],
      default: false,
      description:
        'Read wait mode: false=return immediately, "idle"=wait until shell prompt appears, "output"=wait until new output available, "pattern"=wait until regex pattern matches (requires pattern param)',
    },
    pattern: {
      type: "string",
      maxLength: 512,
      description:
        'Regex pattern to match when wait="pattern". Example: "password:" to wait for password prompt',
    },
  },
  required: ["action"],
};

// ============================================================================
// TMUX TOOL - Terminal Multiplexer (Persistent Sessions)
// Backend: tmuxOps.status/create/createDetached/attach/list/kill/killAll/rename/...
// ============================================================================
const tmuxSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "status",
        "create",
        "createDetached",
        "attach",
        "list",
        "kill",
        "killAll",
        "rename",
        "createWindow",
        "listWindows",
        "selectWindow",
        "killWindow",
        "splitPane",
        "resizePane",
        "selectPane",
        "listPanes",
        "killPane",
        "sendKeys",
        "sendPrefix",
        "capture",
        "type",
        "execute",
        "waitFor",
        "listBuffers",
        "saveBuffer",
        "copyMode",
        "info",
        "refresh",
      ],
      description:
        "Tmux operation. STATUS=check tmux availability, CREATE=new session, LIST=show sessions, KILL=terminate session, SENDKEYS=send keystrokes, CAPTURE=get screen content, EXECUTE=run command and wait, WAITFOR=wait for pattern match",
    },
    sessionName: {
      type: "string",
      description:
        'Tmux session name. Use descriptive names like "pentest", "msf", "scan". Required for most session operations.',
      maxLength: 200,
    },
    options: {
      type: "object",
      description: "Additional options for the operation",
      properties: {
        cols: {
          type: "number",
          minimum: 10,
          maximum: 300,
          description: "Session width in characters",
        },
        rows: {
          type: "number",
          minimum: 5,
          maximum: 100,
          description: "Session height in lines",
        },
        cwd: {
          type: "string",
          description: "Working directory for new session/window",
        },
        command: {
          type: "string",
          description: "Command to run in new session/pane",
        },
        detach: {
          type: "boolean",
          description: "Create session without attaching",
        },
        windowName: { type: "string", description: "Name for new window" },
        windowIndex: {
          type: "number",
          default: 0,
          description: "Window number (0-based)",
        },
        paneIndex: {
          type: "number",
          default: 0,
          description: "Pane number (0-based)",
        },
        direction: {
          type: "string",
          enum: ["horizontal", "vertical"],
          description: "Split direction for splitPane",
        },
        size: { type: "number", description: "Size for resize/split" },
        width: { type: "number", description: "Width for split" },
        height: { type: "number", description: "Height for split" },
        lines: {
          type: "number",
          default: -1,
          description: "Lines to capture (-1 for all visible)",
        },
        startLine: { type: "number", description: "Start line for capture" },
        delay: {
          type: "number",
          default: 10,
          description: "Delay in ms after sending keys",
        },
        enter: {
          type: "boolean",
          default: true,
          description: "Append Enter key after text",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Force kill without confirmation",
        },
        detailed: {
          type: "boolean",
          default: false,
          description: "Include detailed session info",
        },
        waitUntilComplete: {
          type: "boolean",
          default: false,
          description: "Wait for command to finish",
        },
        timeout: {
          type: "number",
          default: 60,
          description: "Timeout in seconds",
        },
        interval: {
          type: "number",
          default: 500,
          description: "Check interval in ms for waitFor",
        },
        pattern: { type: "string", description: "Regex pattern to wait for" },
        bufferIndex: {
          type: "number",
          default: 0,
          description: "Buffer index for saveBuffer",
        },
        filePath: { type: "string", description: "File path to save buffer" },
        clientName: { type: "string", description: "Client name for refresh" },
      },
    },
  },
  required: ["action"],
};

// ============================================================================
// EXECUTE TOOL - One-shot Command Execution (No Session Persistence)
// Backend: execOps.exec/batch/stream
// ============================================================================
const executeSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["exec", "stream", "batch"],
      description:
        "Execution mode. EXEC=run command synchronously and return result, STREAM=run command and return immediately with output stream, BATCH=run multiple commands in parallel",
    },
    command: {
      type: "string",
      maxLength: 4096,
      description:
        'Command to execute. Example: "nmap -sV 192.168.1.1", "cat /etc/passwd"',
    },
    commands: {
      type: "array",
      items: { type: "string", maxLength: 4096 },
      maxItems: 50,
      description:
        "Array of commands for batch mode. Will execute in parallel up to concurrency limit.",
    },
    timeout: {
      type: "number",
      default: 60,
      minimum: 1,
      maximum: 300,
      description: "Timeout in seconds per command",
    },
    concurrency: {
      type: "number",
      default: 5,
      minimum: 1,
      maximum: 20,
      description: "Maximum parallel commands for batch mode",
    },
    cwd: {
      type: "string",
      description: 'Working directory. Example: "/tmp", "/home/user/project"',
    },
    env: {
      type: "object",
      description:
        'Environment variables as key-value pairs. Example: {"PATH": "/usr/bin:/bin", "DEBUG": "1"}',
    },
  },
  required: ["action"],
};

// ============================================================================
// FILE TOOL - File System Operations + HTTP Fetch with Traffic Obfuscation
// Backend: fileOps.read/write/list/delete/download/upload/fetchUrl
// ============================================================================
const fileSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "write", "list", "delete", "download", "upload", "fetch"],
      description:
        "File operation. READ=get file content, WRITE=create/overwrite file, LIST=list directory, DELETE=remove file, DOWNLOAD=read file as base64 chunks, UPLOAD=write base64 data, FETCH=HTTP request WITH CHUNKED SUPPORT FOR LARGE FILES",
    },
    path: {
      type: "string",
      description:
        'File or directory path. Use absolute paths for clarity. Example: "/etc/passwd", "/home/user/project"',
    },
    content: {
      type: "string",
      description: "Content to write to file (for write action)",
    },
    data: {
      type: "string",
      description: "Base64 encoded data for upload action",
    },
    encoding: {
      type: "string",
      default: "utf8",
      description: "File encoding: utf8, binary, base64, etc.",
    },
    append: {
      type: "boolean",
      default: false,
      description: "Append to existing file instead of overwrite",
    },
    showHidden: {
      type: "boolean",
      default: false,
      description: "Show hidden files (starting with .) in directory listing",
    },
    offset: {
      type: "number",
      default: 0,
      description: "Byte offset for chunked download/upload operations",
    },
    chunkSize: {
      type: "number",
      default: 1048576,
      description: "Chunk size in bytes for download/upload (default: 1MB)",
    },
    url: {
      type: "string",
      maxLength: 2048,
      description: "URL to fetch (for fetch action). Supports HTTP/HTTPS.",
    },
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "DELETE", "HEAD"],
      default: "GET",
      description: "HTTP method for fetch action",
    },
    headers: {
      type: "object",
      description:
        'HTTP headers as key-value pairs. Example: {"Authorization": "Bearer token", "Content-Type": "application/json"}',
    },
    body: {
      type: ["string", "object"],
      description:
        "Request body for POST/PUT requests. Can be a string or an object (will be JSON serialized).",
    },
    timeout: {
      type: "number",
      default: 60,
      minimum: 1,
      maximum: 300,
      description: "Request timeout in seconds",
    },
    retry: {
      type: "number",
      default: 0,
      minimum: 0,
      maximum: 3,
      description: "Number of retry attempts on failure",
    },
    uaMode: {
      type: "string",
      enum: [
        "random",
        "chrome",
        "firefox",
        "edge",
        "safari",
        "mobile",
        "bot",
        "curl",
      ],
      description:
        "User-Agent rotation mode for fetch. RANDOM=dynamic real browser UA, CHROME=Chrome UA with dynamic version, FIREFOX=Firefox UA, EDGE=Edge UA, SAFARI=Safari UA, MOBILE=mobile UA, BOT=crawler UA, CURL=curl UA. Default: random (recommended for most requests)",
    },
    tlsProfile: {
      type: "string",
      enum: [
        "auto",
        "chrome99",
        "chrome100",
        "chrome101",
        "chrome104",
        "chrome107",
        "chrome110",
        "chrome116",
        "chrome120",
        "chrome131",
        "edge99",
        "edge101",
        "firefox91esr",
        "firefox95",
        "firefox98",
        "firefox100",
        "firefox102",
        "firefox109",
        "firefox117",
        "firefox133",
        "safari15_3",
        "safari15_5",
        "safari17",
      ],
      default: "auto",
      description:
        "TLS fingerprint profile for fetch. AUTO=system curl. Chrome profiles: chrome99-131. Edge profiles: edge99/101. Firefox profiles: firefox91esr-133. Safari profiles: safari15_3-17. Requires curl-impersonate. Use when target has WAF/IDS fingerprint detection",
    },
    paramHide: {
      type: "boolean",
      default: true,
      description:
        "Hide sensitive parameters from process command line. When true, URL/headers/UA are passed via config file instead of command arguments, preventing exposure in ps/aux or audit logs. Always true for HTTPS requests",
    },
    chunkStart: {
      type: "number",
      default: 0,
      minimum: 0,
      description:
        "Byte offset for chunked fetch. Use to read large files in segments. Default: 0 (beginning). Combined with chunkSize for pagination. Example: chunkStart=50000, chunkSize=50000 reads bytes 50000-99999.",
    },
    chunkSize: {
      type: "number",
      default: 50000,
      minimum: 1000,
      maximum: 200000,
      description:
        "Maximum chunk size in bytes for fetch. Default: 50000 (50KB). Use together with chunkStart for pagination. Ideal for files >100KB to avoid truncation.",
    },
    referenceId: {
      type: "string",
      maxLength: 64,
      description:
        "Reference ID for cross-tool linkage. Use to connect results across multiple tool calls. Example: 'asset_discovery_001'. Optional. The same referenceId will appear in all related responses.",
    },
    contextVar: {
      type: "string",
      maxLength: 64,
      description:
        "Context variable name for storing result for use in next tool calls. Automatically generated if not provided.",
    },
  },
  required: ["action"],
};

// ============================================================================
// SESSION TOOL - Session Lifecycle Management
// Backend: sessionOps.list/killAll/reset/background/foreground/stats
// ============================================================================
const sessionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "killAll", "reset", "background", "foreground", "stats"],
      description:
        "Session operation. LIST=show all sessions, KILLALL=terminate all sessions, RESET=cleanup and reset, BACKGROUND=mark session as background task, FOREGROUND=bring background task to front, STATS=show resource statistics",
    },
    includeDetails: {
      type: "boolean",
      default: true,
      description: "Include detailed session information in list",
    },
    statsMode: {
      type: "boolean",
      default: false,
      description: "Show statistics summary instead of detailed list",
    },
    zombieThreshold: {
      type: "number",
      default: 15,
      description: "Minutes of inactivity before marking session as zombie",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Force kill without confirmation",
    },
    sessionId: {
      type: "string",
      description: "Session ID for background/foreground actions",
    },
    command: {
      type: "string",
      description: "Description of command running in background session",
    },
    httpSessionId: {
      type: "string",
      description: "Filter sessions by owner HTTP session ID",
    },
    includeProcesses: {
      type: "boolean",
      default: false,
      description: "Include per-session process statistics",
    },
  },
  required: ["action"],
};

// ============================================================================
// SYSTEM TOOL - System Information & Network Utilities
// Backend: systemOps.info/network/portScan
// ============================================================================
const systemSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["info", "network", "portScan"],
      description:
        "System operation. INFO=get system information (OS, CPU, memory, disk), NETWORK=get network interfaces and connections, PORTSCAN=quick port scan of target",
    },
    target: {
      type: "string",
      maxLength: 256,
      description:
        'Target host for port scan. Can be IP address or hostname. Example: "192.168.1.1", "scanme.nmap.org"',
    },
    ports: {
      type: "string",
      maxLength: 512,
      description:
        'Ports to scan. Can be single port, range, or comma-separated. Example: "80", "1-1000", "22,80,443,8080"',
    },
  },
  required: ["action"],
};

// ============================================================================
// PATH TOOL - Smart Directory Navigation with Context Memory
// Backend: pathOps.tree/explore/context/bookmark/find/stats/quickView
// ============================================================================
const pathSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "tree",
        "explore",
        "context",
        "bookmark",
        "find",
        "stats",
        "quickView",
      ],
      description:
        "Path operation. TREE=recursive directory structure (like `tree` command), EXPLORE=smart directory summary with file type grouping, CONTEXT=get/set current location or history, BOOKMARK=save/quick access to paths, FIND=search files by name pattern, STATS=directory size analysis, QUICKVIEW=file preview",
    },
    path: {
      type: "string",
      maxLength: 1024,
      description:
        "Target path. If omitted, uses current context path. Use absolute paths for clarity.",
    },
    maxDepth: {
      type: "number",
      minimum: 1,
      maximum: 10,
      default: 3,
      description:
        "Maximum recursion depth for tree/find operations. Use 1-2 for quick overview, 3-5 for detailed scan.",
    },
    showHidden: {
      type: "boolean",
      default: false,
      description: "Include hidden files (starting with .) in results",
    },
    dirsOnly: {
      type: "boolean",
      default: false,
      description: "Show only directories, omit files (for tree action)",
    },
    groupByType: {
      type: "boolean",
      default: true,
      description:
        "Group files by type in explore results (JavaScript, Python, Config, etc.)",
    },
    pattern: {
      type: "string",
      maxLength: 256,
      description:
        'Search pattern. For find: filename pattern to match. For tree: filter results. Example: ".py" to find Python files, "config" to find config files.',
    },
    type: {
      type: "string",
      enum: ["all", "file", "dir"],
      default: "all",
      description:
        "Type filter for find action: all=files and directories, file=only files, dir=only directories",
    },
    name: {
      type: "string",
      maxLength: 128,
      description:
        'For context action: "get"=show current path, "set"=set current path (requires path param), "back"=go to previous path, "history"=show visit history, "clear"=reset context. For bookmark action: bookmark name to save/get.',
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 100,
      description: "Maximum number of results to return",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: 500,
      default: 50,
      description: "Maximum results for find action",
    },
    includeSize: {
      type: "boolean",
      default: true,
      description: "Include file sizes in tree output",
    },
    showInteresting: {
      type: "boolean",
      default: true,
      description:
        "Highlight interesting files in explore (config files, scripts, etc.)",
    },
  },
  required: ["action"],
};

// ============================================================================
// Tool Initialization
// ============================================================================

export function initializeTools(sessionManager, config) {
  const tools = {};

  setTerminalSM(sessionManager);
  setSessionSM(sessionManager);
  setExecSM(sessionManager);

  tools["terminal"] = {
    name: "terminal",
    description: `Interactive PTY terminal sessions for running shell commands and interactive tools.

WHEN TO USE:
- Running interactive tools (msfconsole, sliver-client, ncat, mysql, python, etc.)
- Long-running commands that need session state persistence
- Commands that require terminal interaction (vim, top, htop, etc.)

PARAMETERS:
- sessionId: Session ID from create action (required for most actions)
- shell: Shell path (default: /bin/bash)
- args: Shell arguments array (e.g., ["-i"] for interactive mode)
- command: Command to execute
- data: Raw input to write to terminal (use "\\n" for Enter)
- signal: Control signal (SIGINT/Ctrl+C, SIGTSTP/Ctrl+Z, SIGQUIT, SIGEOF/Ctrl+D)
- cols/rows: Terminal size (width/height)
- name: Human-readable session name
- timeout: Wait timeout in seconds (default: 30)
- clear: Clear output buffer after read (default: true)
- wait: Wait mode: false=immediate, "idle"=wait for prompt, "output"=wait for new output, "pattern"=wait for regex
- pattern: Regex pattern when wait="pattern"

WORKFLOW:
1. {action: "create", shell: "/bin/bash"} → returns sessionId
2. {action: "exec", sessionId: "...", command: "ls -la"} → runs command
3. {action: "read", sessionId: "...", wait: "idle"} → get output
4. {action: "kill", sessionId: "..."} → cleanup

SUPPORTED SHELLS: bash, zsh, fish, python, msfconsole, sliver-client, ncat, mysql, psql, etc.

EXAMPLES:
- {action: "create", shell: "/bin/bash"} → start bash session
- {action: "exec", sessionId: "xxx", command: "whoami"} → run command
- {action: "read", sessionId: "xxx", wait: "idle"} → wait for prompt
- {action: "signal", sessionId: "xxx", signal: "SIGINT"} → send Ctrl+C
- {action: "resize", sessionId: "xxx", cols: 120, rows: 30} → resize

TIP: For one-shot commands without state, use 'execute' tool. For persistent sessions across disconnections, use 'tmux' tool.`,
    inputSchema: terminalSchema,
    handler: wrapHandler(terminalSchema, async (params) => {
      switch (params.action) {
        case "create":
          return terminalOps.create(
            `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            params.shell,
            params.args || ["-i"],
            {},
            params.cols || 120,
            params.rows || 30,
            null,
            { mcpSessionId: params.__mcpSessionId },
          );
        case "write":
          return terminalOps.write(params.sessionId, params.data);
        case "read":
          return terminalOps.read(
            params.sessionId,
            params.clear !== false,
            params.wait,
            params.pattern,
            params.timeout,
          );
        case "exec":
          return terminalOps.exec(
            params.sessionId,
            params.command,
            params.timeout,
          );
        case "signal":
          return terminalOps.signal(params.sessionId, params.signal);
        case "resize":
          return terminalOps.resize(params.sessionId, params.cols, params.rows);
        case "kill":
          return terminalOps.kill(params.sessionId);
        case "info":
          return terminalOps.info(params.sessionId);
        case "rename":
          return terminalOps.rename(params.sessionId, params.name);
        case "stream":
          return terminalOps.stream(params.sessionId, params.command);
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["tmux"] = {
    name: "tmux",
    description: `Terminal multiplexer for persistent sessions, split-screen operations, and background tasks.

WHEN TO USE:
- Need sessions that survive disconnection
- Multiple terminal windows in one session
- Split screen (horizontal/vertical panes)
- Running background tasks
- Shared terminal sessions

KEY CONCEPTS:
- Session: Container for windows (e.g., "pentest", "msf", "scan")
- Window: Tab within session
- Pane: Split terminal within window

ACTIONS:
- status: Check tmux availability
- create/createDetached: Create named session (detach for background)
- attach: Attach to existing session
- list: Show all sessions
- kill/killAll: Terminate session(s)
- rename: Rename a session
- createWindow/listWindows/selectWindow/killWindow: Window management
- splitPane/resizePane: Pane splitting and resizing
- selectPane/killPane: Pane management
- sendKeys/sendPrefix: Send keystrokes to pane
- capture: Get screen content (output buffer)
- execute: Run command and wait for result
- waitFor: Wait for pattern in output
- type: Type text into pane
- listBuffers/saveBuffer: Buffer management
- copyMode: Enter copy/scroll mode
- info: Get session details
- refresh: Refresh client

PARAMETERS:
- sessionName: Tmux session name (required for most operations)
- options: Object containing:
  - cols/rows: Terminal size
  - cwd: Working directory
  - command: Command to run
  - detach: Create session without attaching
  - windowName: Name for new window
  - windowIndex/paneIndex: Window/pane number (0-based)
  - direction: Split direction ("horizontal"/"vertical")
  - size/width/height: Size for resize/split
  - lines: Lines to capture (-1 for all visible)
  - startLine: Start line for capture
  - delay: Delay in ms after sending keys (default: 10)
  - enter: Append Enter after text (default: true)
  - force: Force kill without confirmation
  - detailed: Include detailed session info
  - waitUntilComplete: Wait for command to finish
  - timeout: Timeout in seconds
  - interval: Check interval in ms for waitFor
  - pattern: Regex pattern for waitFor
  - bufferIndex: Buffer index for saveBuffer
  - filePath: File path for saveBuffer
  - clientName: Client name for refresh
  - key: Key for sendPrefix

EXAMPLES:
- {action: "status"} → check tmux availability
- {action: "create", sessionName: "pentest"} → create session
- {action: "createDetached", sessionName: "scan"} → background session
- {action: "sendKeys", sessionName: "pentest", options: {command: "ls"}} → run command
- {action: "capture", sessionName: "pentest"} → get screen output
- {action: "splitPane", sessionName: "pentest", options: {direction: "horizontal"}} → split

TIP: Use descriptive session names. Use createDetached for background sessions. Sessions survive disconnection.`,
    inputSchema: tmuxSchema,
    handler: wrapHandler(tmuxSchema, async (params) => {
      const opts = params.options || {};
      switch (params.action) {
        case "status":
          return tmuxOps.status();
        case "create":
          return tmuxOps.create(params.sessionName, {
            ...opts,
            mcpSessionId: params.__mcpSessionId,
          });
        case "createDetached":
          return tmuxOps.createDetached(params.sessionName, {
            ...opts,
            mcpSessionId: params.__mcpSessionId,
          });
        case "attach":
          return tmuxOps.attach(params.sessionName, opts);
        case "list":
          return tmuxOps.list(opts.detailed);
        case "kill":
          return tmuxOps.kill(params.sessionName, opts);
        case "killAll":
          return tmuxOps.killAll();
        case "rename":
          return tmuxOps.rename(params.sessionName, opts.newName);
        case "createWindow":
          return tmuxOps.createWindow(
            params.sessionName,
            opts.windowName,
            opts,
          );
        case "listWindows":
          return tmuxOps.listWindows(params.sessionName);
        case "selectWindow":
          return tmuxOps.selectWindow(params.sessionName, opts.windowIndex);
        case "killWindow":
          return tmuxOps.killWindow(params.sessionName, opts.windowIndex);
        case "splitPane":
          return tmuxOps.splitPane(params.sessionName, opts);
        case "resizePane":
          return tmuxOps.resizePane(params.sessionName, opts);
        case "selectPane":
          return tmuxOps.selectPane(
            params.sessionName,
            opts.windowIndex,
            opts.paneIndex,
          );
        case "listPanes":
          return tmuxOps.listPanes(params.sessionName, opts.windowIndex);
        case "killPane":
          return tmuxOps.killPane(
            params.sessionName,
            opts.windowIndex,
            opts.paneIndex,
          );
        case "sendKeys":
          return tmuxOps.sendKeys(
            params.sessionName,
            opts.keys || opts.command,
            opts,
          );
        case "sendPrefix":
          return tmuxOps.sendPrefix(opts.key);
        case "capture":
          return tmuxOps.capture(params.sessionName, opts);
        case "type":
          return tmuxOps.type(params.sessionName, opts.text, opts);
        case "execute":
          return tmuxOps.execute(params.sessionName, opts.command, opts);
        case "waitFor":
          return tmuxOps.waitFor(params.sessionName, opts.pattern, opts);
        case "listBuffers":
          return tmuxOps.listBuffers();
        case "saveBuffer":
          return tmuxOps.saveBuffer(opts.bufferIndex, opts.filePath);
        case "copyMode":
          return tmuxOps.copyMode(params.sessionName, opts);
        case "info":
          return tmuxOps.info(params.sessionName);
        case "refresh":
          return tmuxOps.refresh(params.sessionName, opts.clientName);
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["execute"] = {
    name: "execute",
    description: `Run commands without creating a persistent session.

WHEN TO USE:
- One-shot command execution (no session state needed)
- Running multiple commands in parallel (batch mode)
- Streaming command output in real-time

KEY DIFFERENCE FROM terminal:
- No session persistence (each call is independent)
- No PTY overhead (faster for simple commands)
- Better for scripts and one-off tasks

ACTIONS:
- exec: Run single command synchronously, wait for result
- stream: Run command, return immediately with output stream
- batch: Run multiple commands in parallel

PARAMETERS:
- command/commands: Command(s) to execute
- timeout: Max wait time in seconds (default: 60, max: 300)
- concurrency: Max parallel commands for batch (default: 5, max: 20)
- cwd: Working directory
- env: Environment variables as key-value pairs

EXAMPLES:
- {action: "exec", command: "whoami"} → get current user
- {action: "exec", command: "nmap -sV 192.168.1.1", timeout: 120} → scan with 2min timeout
- {action: "batch", commands: ["nmap -p 22 host1", "nmap -p 22 host2"], concurrency: 5} → parallel scans
- {action: "stream", command: "tail -f /var/log/syslog"} → stream log output

TIP: For interactive commands (msfconsole, vim, top) or commands needing state, use 'terminal' tool.`,
    inputSchema: executeSchema,
    handler: wrapHandler(executeSchema, async (params) => {
      switch (params.action) {
        case "exec":
          return execOps.exec(
            params.command,
            params.timeout,
            params.cwd,
            params.env,
          );
        case "stream":
          return execOps.stream(params.command, params.cwd);
        case "batch":
          return execOps.batch(params.commands, {
            timeout: params.timeout,
            concurrency: params.concurrency,
          });
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["file"] = {
    name: "file",
    description: `File system operations and HTTP requests with traffic obfuscation.

WHEN TO USE:
- Reading/writing files, listing directories
- Downloading/uploading binary files
- Making HTTP requests (especially to security-sensitive targets)

TRAFFIC OBFUSCATION (fetch action only):
- uaMode: Control User-Agent fingerprint
  - "random" (default): Dynamic real browser UA with randomized version (120-133)
  - "chrome"/"firefox"/"edge"/"safari": Specific browser family with dynamic version
  - "mobile": Mobile device UA | "bot": Crawler UA | "curl": Native curl UA
- tlsProfile: Control TLS fingerprint (requires curl-impersonate)
  - "auto" (default): System curl TLS fingerprint
  - "chrome99" ~ "chrome131": Chrome TLS fingerprints
  - "edge99"/"edge101": Edge TLS fingerprints
  - "firefox91esr" ~ "firefox133": Firefox TLS fingerprints
  - "safari15_3" ~ "safari17": Safari TLS fingerprints
- paramHide: Hide URL/headers from process command line (default: true)
  - Uses config file instead of command arguments
  - Prevents exposure in ps/aux, auditd, or process monitoring

ACTIONS:
- read: Get file content as text
- write: Create or overwrite file
- list: List directory contents
- delete: Remove file
- download: Read file as base64 chunks (for binary files)
- upload: Write base64 data to file
- fetch: Make HTTP request with traffic obfuscation

PARAMETERS:
- path: File or directory path (use absolute paths)
- content: Content to write
- encoding: File encoding (default: utf8)
- append: Append to existing file instead of overwrite
- showHidden: Show hidden files in directory listing
- url/method/headers/body: HTTP request parameters
- timeout/retry: Request timeout and retry attempts
- offset/chunkSize: Chunked download/upload parameters

EXAMPLES:
- {action: "read", path: "/etc/passwd"} → read file
- {action: "write", path: "/tmp/script.sh", content: "#!/bin/bash\\necho hello"} → create file
- {action: "list", path: "/home/user", showHidden: true} → list directory
- {action: "fetch", url: "https://api.example.com/data"} → basic HTTP GET
- {action: "fetch", url: "https://target.com/api", method: "POST", headers: {"Content-Type": "application/json"}, body: {"key": "value"}, uaMode: "random", tlsProfile: "chrome131"} → obfuscated POST
- {action: "fetch", url: "https://waf-protected.com", uaMode: "chrome", paramHide: true} → evade WAF

TIP: For directory exploration, use 'path' tool's tree/explore. For security-sensitive HTTP requests, always use uaMode="random" (default) and paramHide=true.`,
    inputSchema: fileSchema,
    handler: wrapHandler(fileSchema, async (params) => {
      switch (params.action) {
        case "read":
          return fileOps.read(params.path, params.encoding);
        case "write":
          return fileOps.write(
            params.path,
            params.content,
            params.encoding,
            params.append,
            false,
          );
        case "list":
          return fileOps.list(params.path, params.showHidden, false);
        case "delete":
          return fileOps.delete(params.path);
        case "download":
          return fileOps.download(params.path, params.offset, params.chunkSize);
        case "upload":
          return fileOps.upload(
            params.path,
            params.data,
            params.offset,
            params.append,
          );
        case "fetch":
          return fileOps.fetchUrl(
            params.url,
            params.method,
            params.headers,
            params.body,
            params.timeout || 60,
            params.retry,
            params.uaMode,
            params.tlsProfile,
            params.chunkStart || 0,
            params.chunkSize || 50000,
            params.referenceId || null,
          );
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["session"] = {
    name: "session",
    description: `Manage terminal and tmux sessions (lifecycle control).

WHEN TO USE:
- Viewing all active sessions
- Cleaning up zombie/inactive sessions
- Managing background tasks
- Viewing resource usage statistics

ACTIONS:
- list: Show all active sessions (with optional details/stats mode)
- killAll: Terminate all sessions
- reset: Cleanup and reset session manager
- background: Mark session as background task
- foreground: Bring background task to front
- stats: Show resource usage statistics

PARAMETERS:
- includeDetails: Include detailed session info (default: true)
- statsMode: Show statistics summary instead of list (default: false)
- zombieThreshold: Minutes of inactivity before marking as zombie (default: 15)
- force: Force kill without confirmation (default: false)
- sessionId: Session ID for background/foreground actions
- httpSessionId: Filter sessions by owner HTTP session ID

EXAMPLES:
- {action: "list"} → show all sessions
- {action: "list", statsMode: true} → show statistics summary
- {action: "list", zombieThreshold: 30} → find sessions inactive > 30 min
- {action: "killAll", force: true} → force kill all sessions
- {action: "stats"} → show memory and process statistics
- {action: "background", sessionId: "xxx", command: "nmap scan"} → mark as background

TIP: Use list regularly to find and clean up zombie sessions. Sessions inactive for > zombieThreshold minutes are marked as zombies.`,
    inputSchema: sessionSchema,
    handler: wrapHandler(sessionSchema, async (params) => {
      switch (params.action) {
        case "list":
          return sessionOps.list(
            params.includeDetails,
            params.statsMode,
            params.zombieThreshold,
            params.httpSessionId || params.__mcpSessionId,
          );
        case "killAll":
          return sessionOps.killAll(params.force);
        case "reset":
          return sessionOps.reset();
        case "background":
          return sessionOps.background(params.sessionId, params.command);
        case "foreground":
          return sessionOps.foreground(params.sessionId);
        case "stats":
          return sessionOps.stats(params.includeProcesses);
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["system"] = {
    name: "system",
    description: `System information and network utilities.

WHEN TO USE:
- Getting OS information (hostname, uptime, users, memory, disk)
- Getting network interfaces and routing tables
- Quick port scans of targets

ACTIONS:
- info: Get system information (OS, CPU, memory, disk usage)
- network: Get network interfaces, routes, DNS config
- portScan: Quick port scan using nmap

PARAMETERS:
- target: Hostname or IP address for port scan
- ports: Ports to scan (e.g., "22,80,443", "1-1000", "80", default: "21,22,80,443")

EXAMPLES:
- {action: "info"} → get system specs (hostname, uptime, users, free memory, disk)
- {action: "network"} → get interfaces, routes, DNS configuration
- {action: "portScan", target: "192.168.1.1"} → scan default ports (21,22,80,443)
- {action: "portScan", target: "192.168.1.1", ports: "22,80,443,8080"} → scan specific ports
- {action: "portScan", target: "scanme.nmap.org", ports: "1-1000"} → scan port range

TIP: For detailed scanning with custom nmap options, use 'execute' tool with nmap directly.`,
    inputSchema: systemSchema,
    handler: wrapHandler(systemSchema, async (params) => {
      switch (params.action) {
        case "info":
          return systemOps.info();
        case "network":
          return systemOps.network();
        case "portScan":
          return systemOps.portScan(params.target, params.ports);
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  tools["path"] = {
    name: "path",
    description: `Smart directory navigation with context memory - SOLVES the "multiple ls" problem.

WHEN TO USE:
- Exploring directory structure efficiently (ONE call instead of multiple ls)
- Remembering location across calls
- Finding files by name pattern
- Directory size and file type analysis

KEY FEATURES (why better than multiple ls):
- tree: Get complete directory structure in ONE call
- explore: Smart summary with file types grouped
- context: System remembers your location across calls
- bookmark: Quick access to frequently used paths

ACTIONS:
- tree: Recursive directory listing (like tree command)
- explore: Smart summary with file type grouping and suggestions
- context: Get/set current location, view history, go back
- bookmark: Save and quick access to paths
- find: Search files by name pattern
- stats: Directory size and file type analysis
- quickView: File preview (auto-detects text/binary)

PARAMETERS:
- path: Target path (absolute or relative to context)
- maxDepth: Max recursion depth for tree/find (1-10, default: 3)
- showHidden: Include hidden files (starting with .)
- dirsOnly: Show only directories (tree action)
- groupByType: Group files by type in explore results
- pattern: Search pattern for find/tree
- type: Filter for find ("all"/"file"/"dir")
- name: Context action ("get"/"set"/"back"/"history"/"clear") or bookmark name
- includeSize: Include file sizes in output
- showInteresting: Highlight interesting files (configs, scripts, etc.)

EXAMPLES:
- {action: "tree", path: "/home/user/project", maxDepth: 3} → full structure
- {action: "explore", path: "/var/log"} → smart summary of directory
- {action: "context", name: "set", path: "/etc"} → remember location
- {action: "context", name: "back"} → go to previous location
- {action: "bookmark", name: "logs", path: "/var/log"} → save bookmark
- {action: "find", pattern: ".py", type: "file"} → find Python files
- {action: "find", pattern: "config", type: "dir"} → find config directories
- {action: "stats", path: "/tmp"} → directory size analysis

TIP: Start with explore to understand a directory, then use tree for detailed structure.`,
    inputSchema: pathSchema,
    handler: wrapHandler(pathSchema, async (params) => {
      switch (params.action) {
        case "tree":
          return pathOps.tree(params.path, {
            maxDepth: params.maxDepth || 3,
            showHidden: params.showHidden,
            dirsOnly: params.dirsOnly,
            filter: params.pattern,
            includeSize: params.includeSize !== false,
            maxFiles: params.maxResults || 200,
          });
        case "explore":
          return pathOps.explore(params.path, {
            depth: params.maxDepth || 2,
            showHidden: params.showHidden,
            groupByType: params.groupByType !== false,
            showInteresting: params.showInteresting !== false,
          });
        case "context":
          const contextAction = params.name || "get";
          return pathOps.context(contextAction, {
            path: params.path,
            limit: params.limit,
          });
        case "bookmark":
          const bookmarkAction = params.name
            ? params.path
              ? "add"
              : "get"
            : "list";
          return pathOps.bookmark(bookmarkAction, {
            name: params.name,
            path: params.path,
          });
        case "find":
          return pathOps.find(params.path, {
            pattern: params.pattern,
            type: params.type || "all",
            maxDepth: params.maxDepth || 5,
            maxResults: params.maxResults || 50,
          });
        case "stats":
          return pathOps.stats(params.path);
        case "quickView":
          return pathOps.quickView(params.path);
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    }),
  };

  return tools;
}

export function getToolsList(tools) {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}
