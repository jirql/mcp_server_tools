#!/usr/bin/env node
/**
 * MCP Server for Kali Linux
 * Streamable HTTP Transport (MCP 2025-11-25)
 *
 * Streamable HTTP spec:
 * - POST /mcp  -> returns JSON response (or stream if Accept: text/event-stream)
 * - GET  /mcp  -> long-polling for server messages (optional)
 * - No separate /messages endpoint
 * - Session managed via MCP-Session-Id header
 */
import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  startAutoTuner,
  initAutoTuner,
  getRecommendedTimeout,
} from "./sampling/auto-tuner.js";
import { isAllowedIP } from "./ip-whitelist.js";
import { createLogger, Logger } from "./utils-logger.js";
import { SessionManager, SessionState } from "./session-manager.js";
import { initializeTools, getToolsList } from "./tools.js";
import {
  getConcurrencyManager,
} from "./concurrency-manager.js";
import {
  getNetworkQueue,
} from "./performance-optimizer.js";
import configManager from "./config-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("SERVER");

// Initialize file logging (project directory)
Logger.setLogFile(join(__dirname, "logs", "server.log"));

// Load configuration via config-manager (P2-9)
const config = configManager.getAll();

// ============================================================================
// Global Exception Handlers - Prevent process crashes
// ============================================================================
process.on("uncaughtException", (error) => {
  logger.fatal("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
});

process.on("unhandledRejection", (reason, promise) => {
  logger.fatal("Unhandled Rejection", { reason: String(reason) });
});

// MCP Protocol version (2025-11-25)
const MCP_PROTOCOL_VERSION = "2025-11-25";

// Session management for Streamable HTTP
const httpSessions = new Map();
const MAX_HTTP_SESSIONS = 1000;

// Pending server messages for GET long-polling
const pendingMessages = new Map();

// ============================================================================
// ConcurrencyManager — replaces global.perfStats (P0-1)
// ============================================================================
const concurrencyManager = getConcurrencyManager({
  initialConcurrency: configManager.getConcurrencyInitial(),
  minConcurrency: configManager.getConcurrencyMin(),
  maxConcurrency: configManager.getConcurrencyMax(),
});

// Initialize auto-tuner with the ConcurrencyManager
initAutoTuner(concurrencyManager);

// ============================================================================
// NetworkRequestQueue — dedicated queue for network tools (performance-optimizer)
// ============================================================================
const networkQueue = getNetworkQueue({
  maxConcurrent: configManager.getNetworkQueueMaxConcurrent(),
  maxQueueSize: configManager.getNetworkQueueMaxSize(),
  perToolLimit: configManager.getNetworkQueuePerToolLimit(),
  concurrencyManager,
});

// ============================================================================
// Request queue for concurrent request handling - Optimized
// Concurrency is managed by ConcurrencyManager, exposed for direct access
// ============================================================================
const requestQueue = {
  queue: [],
  highPriorityQueue: [],
  processing: false,
  activeRequests: 0,
  maxQueueSize: 1000,

  get concurrency() {
    return concurrencyManager.concurrency;
  },
  set concurrency(value) {
    concurrencyManager.concurrency = value;
  },

  async add(request, handler, highPriority = false) {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new Error("Request queue is full"));
    }

    return new Promise((resolve, reject) => {
      const item = { request, handler, resolve, reject, addedAt: Date.now() };
      if (highPriority) {
        this.highPriorityQueue.push(item);
      } else {
        this.queue.push(item);
      }
      this.process();
    });
  },

  async process() {
    if (this.processing) return;
    if (this.activeRequests >= this.concurrency) return;

    const totalQueued = this.queue.length + this.highPriorityQueue.length;
    if (totalQueued === 0) return;

    this.processing = true;

    while (this.activeRequests < this.concurrency) {
      let item = this.highPriorityQueue.shift();
      if (!item) {
        item = this.queue.shift();
      }
      if (!item) break;

      this.activeRequests++;

      const startTime = Date.now();

      item
        .handler()
        .then((result) => {
          const duration = Date.now() - startTime;
          if (duration > 1000) {
            logger.warn("Slow request", {
              tool: item.request?.name,
              durationMs: duration,
            });
          }
          item.resolve(result);
        })
        .catch((error) => {
          item.reject(error);
        })
        .finally(() => {
          this.activeRequests--;
          setImmediate(() => this.process());
        });
    }

    this.processing = false;
  },

  getStats() {
    return {
      queued: this.queue.length,
      highPriorityQueued: this.highPriorityQueue.length,
      active: this.activeRequests,
      concurrency: this.concurrency,
      maxQueueSize: this.maxQueueSize,
    };
  },
};

// Create Express app
const app = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

// CORS middleware
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "MCP-Protocol-Version",
      "MCP-Session-Id",
      "Authorization",
    ],
  }),
);

// Handle OPTIONS requests
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Authorization",
  );
  res.sendStatus(200);
});

// Rate limiting
const limiter = rateLimit({
  windowMs: config.security.rate_limit.window_ms,
  max: config.security.rate_limit.max_requests,
  message: { error: "Too many requests" },
});
app.use(limiter);

// Parse JSON
app.use(express.json({ limit: "10mb" }));

// IP whitelist middleware
app.use((req, res, next) => {
  const clientIP =
    req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  if (!isAllowedIP(clientIP, config.security.allowed_ips)) {
    logger.warn("Connection denied - IP not in whitelist", { clientIP });
    return res
      .status(403)
      .json({ error: "IP not allowed", client_ip: clientIP });
  }
  next();
});

// Initialize session manager
const sessionManager = new SessionManager(config);

// Initialize tools (sessionManager injected directly, no global state)
const tools = initializeTools(sessionManager, config);
// 启动采样自适应调节器（每 30 秒自动调节并发等参数）
startAutoTuner();

// ============================================================================
// Helper: enqueue a server message for GET long-polling
// ============================================================================
function enqueueMessage(sessionId, message) {
  const queue = pendingMessages.get(sessionId);
  if (queue) {
    queue.push(message);
    // Also notify any waiting GET request
    const waiter = getWaiters.get(sessionId);
    if (waiter) {
      waiter(message);
      getWaiters.delete(sessionId);
    }
  }
}

const getWaiters = new Map();

// ============================================================================
// Performance Monitoring (ConcurrencyManager-backed, P0-1)
// ============================================================================
/**
 * Record a tool call — routes through ConcurrencyManager.
 * Kept as a standalone function for backward compatibility.
 */
function recordToolCall(toolName, duration, success = true) {
  concurrencyManager.recordCall(toolName, duration, success);
}

function getPerfStats() {
  const stats = concurrencyManager.getStats();
  const toolStats = concurrencyManager.getToolStats();
  return {
    uptime: stats.uptime,
    totalRequests: stats.requests,
    totalErrors: stats.errors,
    errorRate: stats.errorRate,
    avgDuration: stats.avgDuration,
    toolCalls: toolStats,
    slowRequests: concurrencyManager.getSlowRequests(10),
    requestsPerSecond: stats.requestsPerSecond,
    concurrency: stats.concurrency,
  };
}

// Performance monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn("Slow HTTP request", {
        method: req.method,
        path: req.path,
        durationMs: duration,
        statusCode: res.statusCode,
      });
    }
  });

  next();
});

// ============================================================================
// Root endpoint - server info
// ============================================================================
app.get("/", (req, res) => {
  res.json({
    name: config.server.name,
    version: config.server.version,
    protocol_version: MCP_PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoints: {
      mcp: "/mcp",
      health: "/health",
    },
    status: "running",
  });
});

// ============================================================================
// Health check endpoint
// ============================================================================
app.get("/health", (req, res) => {
  const sessions = sessionManager.listSessions();
  const sessionStats = {
    total: sessions.length,
    byState: {},
  };

  for (const session of sessions) {
    sessionStats.byState[session.state] =
      (sessionStats.byState[session.state] || 0) + 1;
  }

  const memUsage = process.memoryUsage();

  res.json({
    status: "ok",
    name: config.server.name,
    version: config.server.version,
    sessions: sessionStats,
    max_sessions: config.terminal.max_sessions,
    protocol_version: MCP_PROTOCOL_VERSION,
    features: ["streamable-http", "tools", "session-management", "tmux"],
    httpSessions: httpSessions.size,
    queue: requestQueue.getStats(),
    networkQueue: networkQueue.getStats(),
    memory: {
      heapUsed: Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotal: Math.round((memUsage.heapTotal / 1024 / 1024) * 100) / 100,
      rss: Math.round((memUsage.rss / 1024 / 1024) * 100) / 100,
      external: Math.round((memUsage.external / 1024 / 1024) * 100) / 100,
    },
    uptime: Math.round(process.uptime()),
    performance: getPerfStats(),
  });
});

// ============================================================================
// Performance stats endpoint
// ============================================================================
app.get("/stats", (req, res) => {
  res.json({
    performance: getPerfStats(),
    queue: requestQueue.getStats(),
    networkQueue: networkQueue.getStats(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    // ------------------- Sampling 数据 -------------------
    sampling: {
      // 当前请求并发上限（由 auto‑tuner 动态调节）
      currentConcurrency: concurrencyManager.concurrency,
      // ConcurrencyManager bounds
      concurrencyMin: concurrencyManager.minConcurrency,
      concurrencyMax: concurrencyManager.maxConcurrency,
      // 最近 10 条慢请求概览
      recentSlowRequests: concurrencyManager.getSlowRequests(10),
      // 各工具调用次数与累计耗时（便于 AI 决策）
      toolCalls: concurrencyManager.getToolStats(),
    },
  });
});

// ============================================================================
// GET /mcp - Long-polling for server messages (Streamable HTTP)
// ============================================================================
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // Must have a valid session for GET
  if (!sessionId || !httpSessions.has(sessionId)) {
    return res.status(404).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Session not found. Initialize first via POST.",
      },
    });
  }

  const accept = req.headers.accept || "";
  const wantsStream = accept.includes("text/event-stream");

  if (wantsStream) {
    // Client wants SSE-style stream -> return JSON Lines stream
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("MCP-Session-Id", sessionId);

    // Flush any pending messages
    const queue = pendingMessages.get(sessionId) || [];
    pendingMessages.set(sessionId, []);

    for (const msg of queue) {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    }

    // Keep connection open for future messages
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch (e) {
        clearInterval(keepalive);
      }
    }, 30000);

    // Store a writer function so POST can push messages
    const writer = (msg) => {
      try {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch (e) {
        // Connection closed
      }
    };

    const httpSession = httpSessions.get(sessionId);
    if (httpSession) {
      httpSession.streamWriter = writer;
      httpSession.keepalive = keepalive;
    }

    req.on("close", () => {
      clearInterval(keepalive);
      if (httpSession) {
        httpSession.streamWriter = null;
        httpSession.keepalive = null;
      }
    });

    return;
  }

  // Standard long-polling: wait up to 30s for a message
  const queue = pendingMessages.get(sessionId);
  if (queue && queue.length > 0) {
    const msg = queue.shift();
    return res.json(msg);
  }

  // No messages available, wait
  try {
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        getWaiters.delete(sessionId);
        resolve(null); // Timeout -> return empty
      }, 30000);

      getWaiters.set(sessionId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    if (msg) {
      return res.json(msg);
    } else {
      return res.status(200).json({});
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// POST /mcp - Main endpoint: initialize, tools/call, etc.
// ============================================================================
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const request = req.body;

  logger.debug("MCP request received", {
    method: request.method,
    sessionId: sessionId || "none",
  });

  // Validate session for non-initialize requests
  const method = request.method;
  if (method !== "initialize" && sessionId && !httpSessions.has(sessionId)) {
    return res.status(404).json({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: "Session not found or expired. Please reinitialize.",
      },
    });
  }

  try {
    const requestId = request.id;
    const params = request.params || {};
    const isNotification = requestId === undefined;

    let result;
    let currentSessionId = sessionId;

    switch (method) {
      case "initialize": {
        const clientVersion = params.protocolVersion || "2024-11-05";

        // Enforce HTTP session limit
        if (httpSessions.size >= MAX_HTTP_SESSIONS) {
          return res.status(503).json({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32000,
              message: `Maximum HTTP sessions reached (${MAX_HTTP_SESSIONS}). Try again later.`,
            },
          });
        }

        // Generate new session ID
        currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        httpSessions.set(currentSessionId, {
          clientId: params.clientInfo?.name || "unknown",
          created: Date.now(),
          capabilities: params.capabilities || {},
          clientInfo: params.clientInfo || {},
          streamWriter: null,
          keepalive: null,
        });

        // Initialize message queue
        pendingMessages.set(currentSessionId, []);

        // Set session ID header
        res.setHeader("MCP-Session-Id", currentSessionId);

        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            resources: { subscribe: true, list: true },
            prompts: { list: true },
            sampling: {},
          },
          serverInfo: {
            name: config.server.name,
            version: config.server.version,
          },
        };
        // ---------- Load Prompt Catalog (if exists) ----------
        let promptList = [];
        try {
          const catalogRaw = readFileSync(
            join(__dirname, "prompts", "catalog.json"),
            "utf8",
          );
          const catalog = JSON.parse(catalogRaw);
          promptList = catalog.prompts || [];
        } catch (e) {
          logger.warn("Prompt catalog load failed", { error: e.message });
        }
        result.prompts = promptList;

        logger.info("Protocol initialization", {
          sessionId: currentSessionId,
          clientVersion,
          serverVersion: MCP_PROTOCOL_VERSION,
        });
        break;
      }

      case "tools/list":
        result = {
          tools: getToolsList(tools),
        };
        break;

      case "tools/call": {
        const toolName = params.name;
        const toolArgs = params.arguments || {};

        // Inject MCP session context for session ownership tracking
        toolArgs.__mcpSessionId = currentSessionId;

        const tool = tools[toolName];
        if (!tool) {
          result = {
            content: [
              { type: "text", text: `Unknown tool: ${toolName}` },
            ],
            isError: true,
          };
          break;
        }

        // ---- 自动为工具注入推荐 timeout（若调用方未提供） ----
        if (
          toolArgs.timeout === undefined &&
          toolName !== "resources" &&
          toolName !== "prompts"
        ) {
          toolArgs.timeout = getRecommendedTimeout(toolName);
        }

        let rawResult;
        try {
          rawResult = await requestQueue.add(
            { name: toolName, sessionId: currentSessionId },
            async () => {
              const startTime = Date.now();
              try {
                const handlerResult = await tool.handler(toolArgs);
                const duration = Date.now() - startTime;
                recordToolCall(toolName, duration, true);
                if (duration > 3000) {
                  logger.warn("Tool execution slow", {
                    tool: toolName,
                    durationMs: duration,
                    action: toolArgs.action,
                  });
                }
                return handlerResult;
              } catch (error) {
                const duration = Date.now() - startTime;
                recordToolCall(toolName, duration, false);
                throw error;
              }
            },
          );
        } catch (handlerError) {
          // Handler threw runtime exception → MCP tool-level error
          result = {
            content: [
              {
                type: "text",
                text: `Tool execution error: ${handlerError.message}`,
              },
            ],
            isError: true,
          };
          break;
        }

        // Handler returned business-level error → MCP tool-level error
        if (rawResult && rawResult.error) {
          result = {
            content: [
              {
                type: "text",
                text:
                  typeof rawResult === "string"
                    ? rawResult
                    : rawResult.error,
              },
            ],
            isError: true,
          };
        } else {
          // Success → standard MCP content wrapper
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(rawResult, null, 2),
              },
            ],
          };
        }
        break;
      }

      case "ping":
        result = {};
        break;

      case "resources/list":
        result = { resources: [] };
        break;

      case "resources/subscribe":
        result = { success: true, uri: params.uri };
        break;

      case "prompts/list":
        result = { prompts: [] };
        break;

      case "notifications/":
      case "notifications":
      case "notifications/initialized":
        return res.status(202).end();

      default:
        return res.status(400).json({
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`,
          },
        });
    }

    if (isNotification) {
      return res.status(202).end();
    }

    res.json({
      jsonrpc: "2.0",
      id: requestId,
      result: result,
    });
  } catch (error) {
    logger.error("Request processing error", {
      error: error.message,
      requestId: request.id,
    });

    if (requestId === undefined) {
      return res.status(202).end();
    }

    res.status(500).json({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32603,
        message: error.message,
      },
    });
  }
});

// ============================================================================
// Clean up expired sessions every minute
// ============================================================================
const cleanupInterval = setInterval(() => {
  sessionManager.cleanupExpired();

  const now = Date.now();
  for (const [sessionId, session] of httpSessions.entries()) {
    if (now - session.created > 3600000) {
      // Cascade kill all PTY sessions owned by this HTTP session
      const killed = sessionManager.killByOwner(sessionId);
      if (killed > 0) {
        logger.info("Cascade killed PTY sessions", {
          httpSessionId: sessionId,
          count: killed,
        });
      }
      httpSessions.delete(sessionId);
      pendingMessages.delete(sessionId);
      logger.info("HTTP session cleaned up", { sessionId });
    }
  }
}, 60000);

// ============================================================================
// Graceful shutdown
// ============================================================================
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} - starting shutdown`);
  console.log(`\n[SHUTDOWN] Graceful shutdown initiated...`);

  clearInterval(cleanupInterval);

  try {
    sessionManager.shutdown(true);
    logger.info("All sessions terminated");
  } catch (err) {
    logger.error("Error during session shutdown", { error: err.message });
  }

  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");
      console.log("[SHUTDOWN] Server closed. Goodbye!");
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn("Forced exit after timeout");
      console.log("[SHUTDOWN] Forced exit after timeout");
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================================
// Start server
// ============================================================================
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`[INFO] ${config.server.name} started`);
  logger.info(
    `[INFO] MCP Endpoint: http://${config.server.host}:${config.server.port}/mcp`,
  );
  logger.info(
    `[INFO] Protocol Version: ${MCP_PROTOCOL_VERSION} (Streamable HTTP)`,
  );
  logger.info(`[INFO] IP Whitelist: ${config.security.allowed_ips.join(", ")}`);
  logger.info(
    `Health Check: http://${config.server.host}:${config.server.port}/health`,
  );
});
