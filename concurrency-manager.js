/**
 * Concurrency Manager - Global State Refactoring (P0-1)
 *
 * Replaces ad-hoc global.perfStats and direct requestQueue manipulation.
 * Provides:
 * - Performance statistics collection (replaces global.perfStats)
 * - Safe concurrency settings management
 * - Sliding-window slow request tracking
 * - Per-tool call counters / duration tracking
 * - Change notification for auto-tuner integration
 */
import { createLogger } from "./utils-logger.js";

const logger = createLogger("CONCURRENCY");

// ============================================================================
// Default configuration
// ============================================================================
const DEFAULTS = {
  concurrency: {
    min: 20,
    max: 80,
    initial: 50,
  },
  slowRequestThresholdMs: 5000,
  maxSlowRequestsTracked: 50,
  windowMs: 60000, // Sliding window duration
};

// ============================================================================
// ConcurrencyManager Class
// ============================================================================
export class ConcurrencyManager {
  #concurrency;
  #minConcurrency;
  #maxConcurrency;
  #slowRequestThresholdMs;

  // Performance tracking
  #stats = {
    requests: 0,
    errors: 0,
    totalDuration: 0,
    startTime: Date.now(),
  };

  // Per-tool stats: toolName -> { count, totalDuration, errors }
  #toolStats = new Map();

  // Sliding window: array of { tool, duration, timestamp }
  #slowRequests = [];
  #maxSlowRequests;

  // Listeners for concurrency changes
  #listeners = new Map();
  #listenerIdCounter = 0;

  // Exposed for auto-tuner backward compatibility
  // The auto-tuner reads/writes this via the exposed API
  perfStats = null; // Will be set to a proxy object

  constructor(options = {}) {
    this.#minConcurrency = options.minConcurrency ?? DEFAULTS.concurrency.min;
    this.#maxConcurrency = options.maxConcurrency ?? DEFAULTS.concurrency.max;
    this.#concurrency = options.initialConcurrency ?? DEFAULTS.concurrency.initial;
    this.#slowRequestThresholdMs = options.slowRequestThresholdMs ?? DEFAULTS.slowRequestThresholdMs;
    this.#maxSlowRequests = options.maxSlowRequests ?? DEFAULTS.maxSlowRequestsTracked;

    // Verify bounds
    this.#concurrency = Math.max(this.#minConcurrency, Math.min(this.#maxConcurrency, this.#concurrency));

    // Create a backward-compatible proxy for auto-tuner.js
    this.#setupPerfStatsProxy();
  }

  // ========================================================================
  // Concurrency Settings
  // ========================================================================

  get concurrency() {
    return this.#concurrency;
  }

  set concurrency(value) {
    const clamped = Math.max(this.#minConcurrency, Math.min(this.#maxConcurrency, value));
    const changed = clamped !== this.#concurrency;
    this.#concurrency = clamped;
    if (changed) {
      this.#notifyListeners("concurrency", clamped);
    }
  }

  get minConcurrency() {
    return this.#minConcurrency;
  }

  get maxConcurrency() {
    return this.#maxConcurrency;
  }

  /**
   * Update bounds at runtime (e.g., from config hot-reload).
   */
  setConcurrencyBounds(min, max) {
    this.#minConcurrency = min;
    this.#maxConcurrency = max;
    // Re-clamp current value
    this.concurrency = this.#concurrency; // triggers clamp + notify
  }

  // ========================================================================
  // Performance Recording
  // ========================================================================

  /**
   * Record a tool call result.
   * @param {string} toolName
   * @param {number} durationMs
   * @param {boolean} success
   */
  recordCall(toolName, durationMs, success = true) {
    this.#stats.requests++;
    if (!success) this.#stats.errors++;
    this.#stats.totalDuration += durationMs;

    // Per-tool stats
    let toolEntry = this.#toolStats.get(toolName);
    if (!toolEntry) {
      toolEntry = { count: 0, totalDuration: 0, errors: 0 };
      this.#toolStats.set(toolName, toolEntry);
    }
    toolEntry.count++;
    toolEntry.totalDuration += durationMs;
    if (!success) toolEntry.errors++;

    // Slow request tracking (sliding window)
    if (durationMs > this.#slowRequestThresholdMs) {
      this.#slowRequests.push({
        tool: toolName,
        duration: durationMs,
        timestamp: Date.now(),
      });
      // Keep only the most recent entries
      if (this.#slowRequests.length > this.#maxSlowRequests) {
        this.#slowRequests.shift();
      }
    }
  }

  /**
   * Get aggregate performance stats (replaces global.perfStats usage).
   */
  getStats() {
    const uptime = Date.now() - this.#stats.startTime;

    return {
      requests: this.#stats.requests,
      errors: this.#stats.errors,
      totalDuration: this.#stats.totalDuration,
      startTime: this.#stats.startTime,
      uptime: Math.floor(uptime / 1000),
      uptimeMs: uptime,
      errorRate:
        this.#stats.requests > 0
          ? ((this.#stats.errors / this.#stats.requests) * 100).toFixed(2) + "%"
          : "0%",
      avgDuration:
        this.#stats.requests > 0
          ? Math.round(this.#stats.totalDuration / this.#stats.requests)
          : 0,
      requestsPerSecond:
        uptime > 0 ? (this.#stats.requests / (uptime / 1000)).toFixed(2) : "0.00",
      concurrency: this.#concurrency,
      concurrencyMin: this.#minConcurrency,
      concurrencyMax: this.#maxConcurrency,
    };
  }

  /**
   * Get per-tool call statistics.
   */
  getToolStats() {
    const result = {};
    for (const [name, entry] of this.#toolStats) {
      result[name] = { ...entry };
    }
    return result;
  }

  /**
   * Get recent slow requests.
   * @param {number} [count=10] - Number of recent entries to return
   */
  getSlowRequests(count = 10) {
    return this.#slowRequests.slice(-count);
  }

  /**
   * Calculate slow request ratio for auto-tuner.
   * Uses a sliding window of the last `windowMs` milliseconds.
   */
  getSlowRatio() {
    const now = Date.now();
    const windowMs = DEFAULTS.windowMs;
    const recentSlow = this.#slowRequests.filter(
      (r) => now - r.timestamp < windowMs,
    ).length;
    const totalRecent = this.#stats.requests;

    if (totalRecent === 0) return 0;
    return recentSlow / totalRecent;
  }

  // ========================================================================
  // Backward Compatibility: perfStats proxy for auto-tuner.js
  // ========================================================================

  #setupPerfStatsProxy() {
    // Some external code accesses global.perfStats directly (e.g., auto-tuner).
    // This proxy maps those accesses to our internal state.
    const manager = this;
    this.perfStats = {
      get requests() {
        return manager.#stats.requests;
      },
      get errors() {
        return manager.#stats.errors;
      },
      get totalDuration() {
        return manager.#stats.totalDuration;
      },
      get slowRequests() {
        return manager.#slowRequests;
      },
      get startTime() {
        return manager.#stats.startTime;
      },
    };
  }

  // ========================================================================
  // Listeners
  // ========================================================================

  /**
   * Register a listener for concurrency changes.
   * @param {Function} listener - Called with (newConcurrency, oldConcurrency)
   * @returns {number} listenerId
   */
  onConcurrencyChange(listener) {
    const id = ++this.#listenerIdCounter;
    this.#listeners.set(id, listener);
    return id;
  }

  /**
   * Remove a change listener.
   */
  offConcurrencyChange(id) {
    this.#listeners.delete(id);
  }

  #notifyListeners(type, value) {
    for (const [id, listener] of this.#listeners) {
      try {
        listener(value, this.#concurrency);
      } catch (e) {
        logger.error("Concurrency change listener error", {
          listenerId: id,
          error: e.message,
        });
      }
    }
  }

  // ========================================================================
  // Reset
  // ========================================================================

  reset() {
    this.#stats = {
      requests: 0,
      errors: 0,
      totalDuration: 0,
      startTime: Date.now(),
    };
    this.#toolStats.clear();
    this.#slowRequests = [];
    logger.info("ConcurrencyManager stats reset");
  }
}

// ============================================================================
// Singleton Export
// ============================================================================
let defaultInstance = null;

/**
 * Get or create the default ConcurrencyManager singleton.
 * Allows config-manager to initialize it with proper bounds.
 */
export function getConcurrencyManager(options = {}) {
  if (!defaultInstance) {
    defaultInstance = new ConcurrencyManager(options);
  }
  return defaultInstance;
}

export default getConcurrencyManager;
