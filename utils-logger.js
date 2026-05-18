/**
 * Unified Structured Logger
 * Logs to console and file (./logs/ by default)
 */
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const COLORS = {
  DEBUG: '\x1b[36m',
  INFO: '\x1b[32m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  FATAL: '\x1b[35m',
  RESET: '\x1b[0m'
};

const EMOJI = {
  DEBUG: '\u{1F50D}',
  INFO: '\u2139\uFE0F ',
  WARN: '\u26A0\uFE0F ',
  ERROR: '\u274C',
  FATAL: '\u{1F525}'
};

let globalLogLevel = LOG_LEVELS.INFO;
let logFilePath = null;
let fileWriteStream = null;
let requestCounter = 0;
let currentFileSize = 0;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

function rotateLogFile(filepath) {
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const oldPath = i === 1 ? filepath : `${filepath}.${i - 1}`;
    const newPath = `${filepath}.${i}`;
    if (existsSync(oldPath)) {
      try {
        if (i === MAX_LOG_FILES - 1 && existsSync(newPath)) {
          unlinkSync(newPath);
        }
        renameSync(oldPath, newPath);
      } catch (e) {
        // Skip if rename fails
      }
    }
  }
}

function checkAndRotate(filepath) {
  try {
    if (existsSync(filepath)) {
      const stats = statSync(filepath);
      if (stats.size >= MAX_LOG_SIZE) {
        if (fileWriteStream) {
          fileWriteStream.end();
          fileWriteStream = null;
        }
        rotateLogFile(filepath);
        fileWriteStream = createWriteStream(filepath, { flags: 'a' });
        currentFileSize = 0;
      } else {
        currentFileSize = stats.size;
      }
    }
  } catch (e) {
    // If rotation fails, continue with current file
  }
}

class Logger {
  constructor(context = '', defaultMeta = {}) {
    this.context = context;
    this.defaultMeta = defaultMeta;
    this.logs = [];
    this.maxLogs = 1000;
  }

  static setLogLevel(level) {
    const levelMap = {
      'DEBUG': LOG_LEVELS.DEBUG,
      'INFO': LOG_LEVELS.INFO,
      'WARN': LOG_LEVELS.WARN,
      'ERROR': LOG_LEVELS.ERROR,
      'FATAL': LOG_LEVELS.FATAL
    };
    globalLogLevel = typeof level === 'string' ? (levelMap[level.toUpperCase()] || LOG_LEVELS.INFO) : level;
  }

  static setLogFile(filepath) {
    logFilePath = filepath;
    if (fileWriteStream) {
      fileWriteStream.end();
      fileWriteStream = null;
    }
    if (filepath) {
      const dir = dirname(filepath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      checkAndRotate(filepath);
      if (!fileWriteStream) {
        fileWriteStream = createWriteStream(filepath, { flags: 'a' });
        currentFileSize = existsSync(filepath) ? statSync(filepath).size : 0;
      }
    }
  }

  static createRequestId() {
    return `req_${Date.now()}_${++requestCounter}`;
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';
    const mergedMeta = { ...this.defaultMeta, ...meta };

    const structured = {
      timestamp,
      level,
      context: this.context || 'ROOT',
      message,
      ...mergedMeta
    };

    const metaStr = Object.keys(mergedMeta).length > 0
      ? ` ${JSON.stringify(mergedMeta)}`
      : '';

    return {
      formatted: `${timestamp} ${ctx} [${level}] ${message}${metaStr}`,
      structured
    };
  }

  write(level, message, meta = {}) {
    if (globalLogLevel > LOG_LEVELS[level]) {
      return;
    }

    const { formatted, structured } = this.formatMessage(level, message, meta);

    this.logs.push({
      ...structured,
      raw: formatted
    });

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs / 2);
    }

    const consoleMsg = `${EMOJI[level]} ${formatted}`;

    switch (level) {
      case 'ERROR':
      case 'FATAL':
        console.error(`${COLORS[level]}${consoleMsg}${COLORS.RESET}`);
        break;
      case 'WARN':
        console.warn(`${COLORS[level]}${consoleMsg}${COLORS.RESET}`);
        break;
      default:
        if (globalLogLevel <= LOG_LEVELS.DEBUG) {
          console.log(`${COLORS[level]}${consoleMsg}${COLORS.RESET}`);
        }
    }

    if (fileWriteStream && level !== 'DEBUG') {
      fileWriteStream.write(JSON.stringify(structured) + '\n');
      currentFileSize += JSON.stringify(structured).length + 1;
      if (currentFileSize >= MAX_LOG_SIZE) {
        checkAndRotate(logFilePath);
      }
    }
  }

  debug(message, meta) {
    this.write('DEBUG', message, meta);
  }

  info(message, meta) {
    this.write('INFO', message, meta);
  }

  warn(message, meta) {
    this.write('WARN', message, meta);
  }

  error(message, meta) {
    this.write('ERROR', message, meta);
  }

  fatal(message, meta) {
    this.write('FATAL', message, meta);
  }

  child(context, extraMeta = {}) {
    return new Logger(context, { ...this.defaultMeta, ...extraMeta });
  }

  withRequest(requestId, extraMeta = {}) {
    return this.child('REQUEST', { requestId, ...extraMeta });
  }

  withSession(sessionId, extraMeta = {}) {
    return this.child('SESSION', { sessionId, ...extraMeta });
  }

  getLogs() {
    return this.logs;
  }

  clearLogs() {
    this.logs = [];
  }

  flush() {
    if (fileWriteStream) {
      fileWriteStream.flush();
    }
  }
}

const globalLogger = new Logger('MCP');

export function createLogger(context, meta) {
  if (!context && !meta) {
    return globalLogger;
  }
  return new Logger(context, meta);
}

export function errorMeta(error, toolName, action, params = {}) {
  return {
    tool: toolName,
    action: action,
    params: JSON.stringify(params).substring(0, 200),
    errorType: error?.constructor?.name || 'Unknown',
    errorMessage: error?.message || String(error),
    errorStack: error?.stack?.split('\n').slice(0, 3).join(' | ') || 'N/A',
    timestamp: Date.now()
  };
}

export function safeErrorResponse(error, toolName, action) {
  const isInternal = error instanceof TypeError || !error.message;
  const meta = errorMeta(error, toolName, action);

  if (isInternal) {
    globalLogger.error(`Internal error in ${toolName}.${action}`, { error: meta });
  }

  return {
    success: false,
    error: isInternal ? `Internal error in ${toolName}.${action}` : error.message,
    errorCode: isInternal ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
    timestamp: Date.now()
  };
}

export { Logger, LOG_LEVELS, globalLogger };

export default Logger;
