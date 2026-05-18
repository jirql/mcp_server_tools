/**
 * TypeScript Type Definitions for MCP Server
 * @version 1.0.0
 */

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JSONRPCError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCError;

// ============================================================================
// Tool System Types
// ============================================================================

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  [key: string]: unknown;
}

// ============================================================================
// Terminal Tool Types
// ============================================================================

export type TerminalAction = 'create' | 'write' | 'read' | 'exec' | 'signal' | 'resize' | 'kill' | 'info' | 'rename' | 'stream';

export interface TerminalCreateParams {
  action: 'create';
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

export interface TerminalWriteParams {
  action: 'write';
  sessionId: string;
  data: string;
}

export interface TerminalReadParams {
  action: 'read';
  sessionId: string;
  clear?: boolean;
  wait?: boolean;
}

export interface TerminalExecParams {
  action: 'exec';
  sessionId: string;
  command: string;
  timeout?: number;
}

export interface TerminalSignalParams {
  action: 'signal';
  sessionId: string;
  signal: 'SIGINT' | 'SIGTSTP' | 'SIGQUIT' | 'SIGEOF';
}

export interface TerminalResizeParams {
  action: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalKillParams {
  action: 'kill';
  sessionId: string;
}

export interface TerminalInfoParams {
  action: 'info';
  sessionId: string;
}

export interface TerminalRenameParams {
  action: 'rename';
  sessionId: string;
  name: string;
}

export interface TerminalStreamParams {
  action: 'stream';
  sessionId: string;
  command: string;
}

export type TerminalParams = TerminalCreateParams | TerminalWriteParams | TerminalReadParams 
  | TerminalExecParams | TerminalSignalParams | TerminalResizeParams | TerminalKillParams
  | TerminalInfoParams | TerminalRenameParams | TerminalStreamParams;

// ============================================================================
// Tmux Tool Types
// ============================================================================

export type TmuxAction = 'create' | 'attach' | 'list' | 'kill' | 'command' | 'send' | 'capture';

export interface TmuxCreateParams {
  action: 'create';
  sessionName: string;
  command?: string;
  cols?: number;
  rows?: number;
}

export interface TmuxAttachParams {
  action: 'attach';
  sessionName: string;
  cols?: number;
  rows?: number;
}

export interface TmuxListParams {
  action: 'list';
  sessionName?: string;
}

export interface TmuxKillParams {
  action: 'kill';
  sessionName: string;
}

export interface TmuxCommandParams {
  action: 'command';
  sessionId: string;
  key: string;
  command?: string;
}

export interface TmuxSendParams {
  action: 'send';
  sessionName: string;
  keys: string;
  paneIndex?: number;
}

export interface TmuxCaptureParams {
  action: 'capture';
  sessionName: string;
  paneIndex?: string;
  lines?: number;
}

export type TmuxParams = TmuxCreateParams | TmuxAttachParams | TmuxListParams 
  | TmuxKillParams | TmuxCommandParams | TmuxSendParams | TmuxCaptureParams;

// ============================================================================
// Execute Tool Types
// ============================================================================

export type ExecuteAction = 'exec' | 'stream';

export interface ExecuteExecParams {
  action: 'exec';
  command: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecuteStreamParams {
  action: 'stream';
  command: string;
  cwd?: string;
}

export type ExecuteParams = ExecuteExecParams | ExecuteStreamParams;

// ============================================================================
// File Tool Types
// ============================================================================

export type FileAction = 'read' | 'write' | 'list' | 'delete' | 'download' | 'upload' | 'fetch';

export interface FileReadParams {
  action: 'read';
  path: string;
  encoding?: string;
}

export interface FileWriteParams {
  action: 'write';
  path: string;
  content: string;
  encoding?: string;
  append?: boolean;
}

export interface FileListParams {
  action: 'list';
  path?: string;
  showHidden?: boolean;
}

export interface FileDeleteParams {
  action: 'delete';
  path: string;
}

export interface FileDownloadParams {
  action: 'download';
  path: string;
  offset?: number;
  chunkSize?: number;
}

export interface FileUploadParams {
  action: 'upload';
  path: string;
  data: string;
  offset?: number;
  append?: boolean;
}

export interface FileFetchParams {
  action: 'fetch';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export type FileParams = FileReadParams | FileWriteParams | FileListParams 
  | FileDeleteParams | FileDownloadParams | FileUploadParams | FileFetchParams;

// ============================================================================
// Session Tool Types
// ============================================================================

export type SessionAction = 'list' | 'killAll' | 'background' | 'foreground' | 'stats';

export interface SessionListParams {
  action: 'list';
  includeDetails?: boolean;
  statsMode?: boolean;
  zombieThreshold?: number;
}

export interface SessionKillAllParams {
  action: 'killAll';
  force?: boolean;
}

export interface SessionBackgroundParams {
  action: 'background';
  sessionId: string;
  command?: string;
}

export interface SessionForegroundParams {
  action: 'foreground';
  sessionId: string;
}

export interface SessionStatsParams {
  action: 'stats';
  includeProcesses?: boolean;
}

export type SessionParams = SessionListParams | SessionKillAllParams 
  | SessionBackgroundParams | SessionForegroundParams | SessionStatsParams;

// ============================================================================
// System Tool Types
// ============================================================================

export type SystemAction = 'info' | 'network' | 'portScan';

export interface SystemInfoParams {
  action: 'info';
}

export interface SystemNetworkParams {
  action: 'network';
}

export interface SystemPortScanParams {
  action: 'portScan';
  target: string;
  ports?: string;
}

export type SystemParams = SystemInfoParams | SystemNetworkParams | SystemPortScanParams;

// ============================================================================
// Server Configuration Types
// ============================================================================

export interface ServerConfig {
  server: {
    port: number;
    host: string;
    name: string;
    version: string;
  };
  security: {
    allowed_ips: string[];
    rate_limit: {
      window_ms: number;
      max_requests: number;
    };
  };
  terminal: {
    shell: string;
    args: string[];
    env: Record<string, string>;
    cols: number;
    rows: number;
    timeout: number;
    max_sessions: number;
  };
  tmux: {
    path: string;
    default_session_prefix: string;
    max_sessions: number;
  };
}

// ============================================================================
// Session Types
// ============================================================================

export interface SessionInfo {
  id: string;
  pid: number;
  state: string;
  shell: string;
  created: number;
  lastActivity: number;
  exitCode: number | null;
  isTmuxSession: boolean;
  tmuxSession: string | null;
  isBackground: boolean;
  isLongRunning: boolean;
}

// ============================================================================
// Performance Metrics Types
// ============================================================================

export interface PerformanceMetrics {
  timestamp: number;
  uptime: {
    seconds: number;
    formatted: string;
  };
  http: {
    totalRequests: number;
    totalErrors: number;
    errorRate: string;
    avgResponseTime: string;
  };
  sessions: {
    created: number;
    killed: number;
    active: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    history: MemorySample[];
  };
  topSlowTools: ToolStats[];
  nodeVersion: string;
  platform: string;
}

export interface MemorySample {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export interface ToolStats {
  tool: string;
  count: number;
  totalDuration: number;
  errors: number;
  slowCount: number;
  avgDuration: number;
}

// ============================================================================
// Error Types
// ============================================================================

export interface ErrorDetails {
  tool?: string;
  action?: string;
  params?: string;
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
  timestamp?: number;
  sessionId?: string;
  timeoutMs?: number;
  reason?: string;
  [key: string]: unknown;
}

export interface MCPErrorResponse {
  success: false;
  error: string;
  errorCode: string;
  details?: ErrorDetails;
  timestamp: number;
}
