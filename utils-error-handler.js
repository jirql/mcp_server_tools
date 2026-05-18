/**
 * Unified Error Handler for MCP Operations
 * Provides consistent error handling across all tools
 * Includes degradation mechanism (P1-6) — falls back to safe modes on consecutive failures
 */

import Logger from './utils-logger.js';

const logger = new Logger('error-handler');

// ============================================================================
// Error Classes
// ============================================================================

export class MCPError extends Error {
  constructor(message, code = 'UNKNOWN', details = {}) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.details = details;
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

export class ValidationError extends MCPError {
  constructor(message, details = {}) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class SessionError extends MCPError {
  constructor(message, sessionId = null) {
    super(message, 'SESSION_ERROR', { sessionId });
    this.name = 'SessionError';
  }
}

export class TimeoutError extends MCPError {
  constructor(toolName, timeoutMs) {
    super(`${toolName} timed out after ${timeoutMs}ms`, 'TIMEOUT_ERROR', { timeoutMs });
    this.name = 'TimeoutError';
  }
}

export class SecurityError extends MCPError {
  constructor(message, reason = '') {
    super(message, 'SECURITY_ERROR', { reason });
    this.name = 'SecurityError';
  }
}

export class DegradedError extends MCPError {
  constructor(toolName, reason = 'service degraded') {
    super(`${toolName} is in degraded mode: ${reason}`, 'DEGRADED', { toolName, reason });
    this.name = 'DegradedError';
  }
}

// ============================================================================
// Degradation Tracker (P1-6)
// ============================================================================

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const DEGRADATION_COOLDOWN_MS = 30000;
const SUCCESS_RECOVERY_COUNT = 2;
const MAX_STATE_ENTRIES = 1000;      // Max unique tool:action entries in _state Map
const STALE_ENTRY_TTL_MS = 3600000;  // 1 hour — evict entries not accessed for this long
const CLEANUP_INTERVAL_MS = 300000;  // 5 minutes — periodic stale entry sweep

/**
 * Tracks per-tool degradation state with bounded memory.
 * Prevents _state Map from growing infinitely by:
 * 1. Limiting total entries (LRU-style eviction when limit is hit)
 * 2. Evicting entries not accessed within STALE_ENTRY_TTL_MS
 * 3. Periodic background cleanup
 */
class DegradationTracker {
  constructor() {
    /** Map<toolKey, { failures, successes, degradedSince, lastFailure, lastAccessed, createdAt }> */
    this._state = new Map();
    this._cleanupTimer = null;
    this._startCleanupTimer();
  }

  /**
   * Build a unique key for a tool+action combination.
   */
  _key(toolName, action) {
    return `${toolName}:${action}`;
  }

  /**
   * Touch an entry's lastAccessed timestamp.
   */
  _touch(entry) {
    entry.lastAccessed = Date.now();
  }

  /**
   * Get or create an entry, with automatic Map size management.
   * Returns null if the entry doesn't exist and creation would exceed the limit.
   */
  _getOrCreateEntry(key) {
    let entry = this._state.get(key);
    if (entry) {
      this._touch(entry);
      return entry;
    }

    // Enforce max entries limit
    if (this._state.size >= MAX_STATE_ENTRIES) {
      // Try to evict stale entries first
      this._evictStale();
      // If still over limit, evict the oldest entry
      if (this._state.size >= MAX_STATE_ENTRIES) {
        this._evictOldest();
      }
    }

    // Still at capacity even after eviction — don't create new entry
    if (this._state.size >= MAX_STATE_ENTRIES) {
      return null;
    }

    entry = {
      failures: 0,
      successes: 0,
      degradedSince: null,
      lastFailure: null,
      lastAccessed: Date.now(),
      createdAt: Date.now(),
    };
    this._state.set(key, entry);
    return entry;
  }

  /**
   * Evict entries that haven't been accessed within STALE_ENTRY_TTL_MS.
   */
  _evictStale() {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this._state) {
      if (now - entry.lastAccessed > STALE_ENTRY_TTL_MS) {
        this._state.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug("DegradationTracker evicted stale entries", { count: evicted });
    }
  }

  /**
   * Evict the single oldest entry (by lastAccessed) to make room.
   */
  _evictOldest() {
    let oldestKey = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of this._state) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._state.delete(oldestKey);
      logger.debug("DegradationTracker evicted oldest entry", { key: oldestKey });
    }
  }

  /**
   * Record a failure. Returns true if the tool just entered degraded mode.
   * If the state map is full and an entry can't be created, returns false silently.
   */
  recordFailure(toolName, action) {
    const key = this._key(toolName, action);
    let entry = this._state.get(key);

    if (!entry) {
      entry = this._getOrCreateEntry(key);
      if (!entry) {
        // Map is full and we couldn't evict — silently skip tracking
        return false;
      }
    }

    this._touch(entry);
    entry.failures++;
    entry.successes = 0;
    entry.lastFailure = Date.now();

    if (entry.failures >= CONSECUTIVE_FAILURE_THRESHOLD && !entry.degradedSince) {
      entry.degradedSince = Date.now();
      logger.warn(`Tool degraded: ${key}`, {
        consecutiveFailures: entry.failures,
        threshold: CONSECUTIVE_FAILURE_THRESHOLD,
      });
      return true;
    }
    return false;
  }

  /**
   * Record a success. Returns true if the tool recovered from degraded mode.
   */
  recordSuccess(toolName, action) {
    const key = this._key(toolName, action);
    const entry = this._state.get(key);
    if (!entry) return false;

    this._touch(entry);
    entry.failures = 0;
    entry.successes++;

    if (entry.degradedSince && entry.successes >= SUCCESS_RECOVERY_COUNT) {
      const duration = Date.now() - entry.degradedSince;
      logger.info(`Tool recovered from degraded: ${key}`, {
        degradedDurationMs: duration,
        successRecoveryCount: SUCCESS_RECOVERY_COUNT,
      });
      entry.degradedSince = null;
      return true;
    }

    if (entry.degradedSince && entry.lastFailure) {
      const elapsed = Date.now() - entry.lastFailure;
      if (elapsed > DEGRADATION_COOLDOWN_MS) {
        logger.info(`Tool auto-recovered (cooldown): ${key}`, {
          elapsedMs: elapsed,
          cooldownMs: DEGRADATION_COOLDOWN_MS,
        });
        entry.degradedSince = null;
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a tool is currently degraded.
   */
  isDegraded(toolName, action) {
    const key = this._key(toolName, action);
    const entry = this._state.get(key);
    if (!entry || !entry.degradedSince) return false;

    this._touch(entry);

    if (entry.lastFailure) {
      const elapsed = Date.now() - entry.lastFailure;
      if (elapsed > DEGRADATION_COOLDOWN_MS) {
        entry.degradedSince = null;
        return false;
      }
    }

    return true;
  }

  /**
   * Get degradation info for a tool.
   */
  getStatus(toolName, action) {
    const key = this._key(toolName, action);
    const entry = this._state.get(key);
    if (!entry) {
      return { degraded: false, consecutiveFailures: 0 };
    }

    this._touch(entry);

    return {
      degraded: this.isDegraded(toolName, action),
      consecutiveFailures: entry.failures,
      successesSinceLastFailure: entry.successes,
      degradedSince: entry.degradedSince,
      lastFailure: entry.lastFailure,
    };
  }

  /**
   * Get all degradation state (for /stats endpoint).
   * Only returns non-stale entries (to avoid infinite growth from stats polling).
   */
  getAllStatus() {
    const result = {};
    const now = Date.now();

    for (const [key, entry] of this._state) {
      // Skip stale entries in status output
      if (now - entry.lastAccessed > STALE_ENTRY_TTL_MS) {
        continue;
      }
      result[key] = {
        degraded: !!entry.degradedSince,
        consecutiveFailures: entry.failures,
        successesSinceLastFailure: entry.successes,
        degradedSince: entry.degradedSince,
        lastFailure: entry.lastFailure,
      };
    }
    return result;
  }

  /**
   * Periodic cleanup: evict stale entries and enforce max size.
   */
  cleanup() {
    const sizeBefore = this._state.size;
    this._evictStale();

    // If still over limit, evict oldest
    if (this._state.size > MAX_STATE_ENTRIES) {
      const excess = this._state.size - MAX_STATE_ENTRIES;
      for (let i = 0; i < excess; i++) {
        this._evictOldest();
      }
    }

    const evicted = sizeBefore - this._state.size;
    if (evicted > 0) {
      logger.debug("DegradationTracker cleanup completed", {
        evicted,
        remaining: this._state.size,
      });
    }
  }

  /**
   * Reset all degradation state.
   */
  reset() {
    this._state.clear();
    this._stopCleanupTimer();
    this._startCleanupTimer();
    logger.info('Degradation state reset');
  }

  /**
   * Get the current number of tracked entries.
   */
  get size() {
    return this._state.size;
  }

  // ---- Cleanup Timer ----

  _startCleanupTimer() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      try {
        this.cleanup();
      } catch (e) {
        logger.error("DegradationTracker cleanup error", { error: e.message });
      }
    }, CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref?.();
  }

  _stopCleanupTimer() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

// Singleton
const degradationTracker = new DegradationTracker();
export { degradationTracker };

// ============================================================================
// Fallback Mode Factory
// ============================================================================

/**
 * Determine if a tool should use its fallback behavior.
 * When degraded, returns instructions for graceful degradation instead of
 * attempting the full operation.
 */
export function getFallbackResponse(toolName, action) {
  const status = degradationTracker.getStatus(toolName, action);
  if (!status.degraded) return null;

  return {
    success: false,
    error: `${toolName}.${action} is temporarily degraded after ${status.consecutiveFailures} consecutive failures`,
    degraded: true,
    errorCode: 'DEGRADED',
    fallbackAdvice: `Retry in a few seconds, or use a different approach`,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Error Wrapper (with Degradation Support)
// ============================================================================

/**
 * Wrap tool handler with error handling and degradation support (P1-6).
 *
 * Features:
 * - Consistent error classification and response
 * - Slow operation logging
 * - Consecutive failure tracking with automatic degradation
 * - Automatic recovery after success streak or cooldown
 * - Returns DegradedError when in degraded mode
 */
export function withErrorHandling(handler, toolName, action) {
  return async (params) => {
    const startTime = Date.now();

    // Check degradation before execution (skip heavy work if degraded)
    if (degradationTracker.isDegraded(toolName, action)) {
      const duration = Date.now() - startTime;
      // Still attempt the operation — degradation is advisory
      // The operation might succeed and auto-recover
      logger.debug(`Executing degraded tool: ${toolName}.${action}`, {
        status: degradationTracker.getStatus(toolName, action),
      });
    }

    try {
      const result = await handler(params);
      const duration = Date.now() - startTime;

      // Log slow operations
      if (duration > 5000) {
        logger.warn(`Slow operation: ${toolName}.${action}`, {
          duration,
          params: JSON.stringify(params).substring(0, 100),
        });
      }

      // Record success for degradation tracking
      degradationTracker.recordSuccess(toolName, action);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Record failure for degradation tracking
      const enteredDegraded = degradationTracker.recordFailure(toolName, action);

      // Classify the error
      let handledError;

      if (error instanceof MCPError) {
        handledError = error;
      } else if (error.message?.includes('timeout') || error.code === 'ETIMEDOUT') {
        handledError = new TimeoutError(toolName, duration);
      } else if (error.message?.includes('permission') || error.message?.includes('blocked')) {
        handledError = new SecurityError(error.message, 'access_denied');
      } else if (error.message?.includes('session')) {
        handledError = new SessionError(error.message);
      } else {
        handledError = new MCPError(error.message || String(error), 'INTERNAL_ERROR');
      }

      // If we just entered degraded mode, log prominently
      if (enteredDegraded) {
        logger.error(`${toolName}.${action} ENTERED DEGRADED MODE`, {
          consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
          duration,
          message: handledError.message.substring(0, 200),
        });
      } else {
        logger.error(`${toolName}.${action} failed`, {
          errorType: handledError.name,
          errorCode: handledError.code,
          duration,
          message: handledError.message.substring(0, 200),
        });
      }

      return {
        success: false,
        error: handledError.message,
        errorCode: handledError.code,
        details: handledError.details || {},
        degraded: degradationTracker.isDegraded(toolName, action),
        timestamp: Date.now(),
      };
    }
  };
}

// ============================================================================
// Global Error Handler
// ============================================================================

/**
 * Global error handler for uncaught exceptions
 */
export function setupGlobalErrorHandler() {
  process.on('uncaughtException', (error) => {
    logger.fatal('Uncaught exception', { error: error.message, stack: error.stack });
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal('Unhandled promise rejection', { reason: reason?.message || String(reason) });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning', { warning: warning.message });
  });

  logger.info('Global error handlers installed');
}

export default {
  MCPError,
  ValidationError,
  SessionError,
  TimeoutError,
  SecurityError,
  DegradedError,
  withErrorHandling,
  setupGlobalErrorHandler,
  degradationTracker,
  getFallbackResponse,
};
