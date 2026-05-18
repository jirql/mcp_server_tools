/**
 * Performance Optimizer - Network Request Queue & Concurrency Control
 *
 * Provides a dedicated concurrent request queue for network-bound operations
 * (HTTP fetches, port scans, etc.) that can be parallelized more aggressively
 * than CPU-bound operations.
 *
 * Features:
 * - Per-tool concurrency limits
 * - Smart prioritization (interactive > background)
 * - Sliding window rate limiting
 * - Integration with ConcurrencyManager for global backpressure
 * - Exponential backoff on errors
 * - Automatic cleanup of expired/stale items (memory leak prevention)
 */
import { createLogger } from "./utils-logger.js";
import { getConcurrencyManager } from "./concurrency-manager.js";

const logger = createLogger("PERF-OPT");

// ============================================================================
// Defaults
// ============================================================================
const DEFAULTS = {
  maxConcurrent: 10,
  maxQueueSize: 100,
  perToolLimit: 5,
  retryBaseDelayMs: 1000,
  maxRetries: 3,
  queueTimeoutMs: 30000,
  cleanupIntervalMs: 60000,   // How often to scan for stale items
  maxStaleEntries: 500,        // Max tracked entries before forced cleanup
};

/**
 * Clean a reference to help GC reclaim memory.
 * Nulllifies promise control callbacks after settlement.
 */
function nullifyPromiseRefs(item) {
  item._resolve = null;
  item._reject = null;
  item._promise = null;
  item.taskFn = null;
  item.options = null;
}

// ============================================================================
// Queue Item
// ============================================================================
class QueueItem {
  constructor(toolName, taskFn, priority = 0, options = {}) {
    this.id = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    this.toolName = toolName;
    this.taskFn = taskFn;
    this.priority = priority;
    this.options = options;
    this.enqueuedAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.retries = 0;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.state = "queued"; // queued | running | completed | failed | timedout | disposed
    this.result = null;
    this.error = null;

    // Promise control
    this._resolve = null;
    this._reject = null;
    this._promise = null;
  }

  toPromise() {
    if (!this._promise) {
      this._promise = new Promise((resolve, reject) => {
        this._resolve = resolve;
        this._reject = reject;
      });
    }
    return this._promise;
  }

  resolve(value) {
    if (this._isSettled()) return;
    this.state = "completed";
    this.completedAt = Date.now();
    this.result = value;
    if (this._resolve) this._resolve(value);
    nullifyPromiseRefs(this);
  }

  reject(error) {
    if (this._isSettled()) return;
    this.state = "failed";
    this.completedAt = Date.now();
    this.error = error;
    if (this._reject) this._reject(error);
    nullifyPromiseRefs(this);
  }

  timeout() {
    if (this._isSettled()) return;
    this.state = "timedout";
    this.completedAt = Date.now();
    this.error = new Error(`Queue item timed out after ${DEFAULTS.queueTimeoutMs}ms`);
    if (this._reject) this._reject(this.error);
    nullifyPromiseRefs(this);
  }

  /** Free all references for GC. Call after the item is fully processed. */
  dispose() {
    this.state = "disposed";
    this.result = null;
    this.error = null;
    this.taskFn = null;
    this.options = null;
    nullifyPromiseRefs(this);
  }

  get age() {
    return Date.now() - this.enqueuedAt;
  }

  get isExpired() {
    return this.age > DEFAULTS.queueTimeoutMs;
  }

  /** True if the item has been settled (resolved/rejected/timedout) */
  _isSettled() {
    return (
      this.state === "completed" ||
      this.state === "failed" ||
      this.state === "timedout" ||
      this.state === "disposed"
    );
  }
}

// ============================================================================
// NetworkRequestQueue
// ============================================================================
export class NetworkRequestQueue {
  #queue = [];
  #totalRunning = 0;
  #options;
  #processing = false;
  #concurrencyManager;
  #perToolRunning = new Map();
  #cleanupTimer = null;
  #shutdown = false;

  // Stats
  #stats = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    timedout: 0,
    retries: 0,
    cleaned: 0,   // Count of items cleaned by cleanup()
  };

  constructor(options = {}) {
    this.#options = {
      maxConcurrent: options.maxConcurrent ?? DEFAULTS.maxConcurrent,
      maxQueueSize: options.maxQueueSize ?? DEFAULTS.maxQueueSize,
      perToolLimit: options.perToolLimit ?? DEFAULTS.perToolLimit,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
      cleanupIntervalMs: options.cleanupIntervalMs ?? DEFAULTS.cleanupIntervalMs,
      maxStaleEntries: options.maxStaleEntries ?? DEFAULTS.maxStaleEntries,
    };
    this.#concurrencyManager = options.concurrencyManager ?? getConcurrencyManager();

    // Start periodic cleanup to prevent memory leaks
    this.#startCleanupTimer();
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Enqueue a network task.
   *
   * @param {string} toolName - Tool type for per-tool limiting (e.g. "fetch", "portScan")
   * @param {Function} taskFn - Async function to execute
   * @param {object} [options]
   * @param {number} [options.priority=0] - Higher = more urgent
   * @param {number} [options.maxRetries=3] - Max retry attempts
   * @returns {Promise} Resolves with task result
   */
  enqueue(toolName, taskFn, options = {}) {
    if (this.#shutdown) {
      return Promise.reject(new Error("NetworkRequestQueue is shut down"));
    }

    // Enforce max queue size
    if (this.#queue.length >= this.#options.maxQueueSize) {
      return Promise.reject(
        new Error(`Network queue full (max ${this.#options.maxQueueSize})`),
      );
    }

    const priority = options.priority ?? 0;
    const item = new QueueItem(toolName, taskFn, priority, options);
    const promise = item.toPromise();

    this.#stats.enqueued++;

    // Insert sorted by priority (descending)
    const insertIndex = this.#queue.findIndex((q) => q.priority < priority);
    if (insertIndex === -1) {
      this.#queue.push(item);
    } else {
      this.#queue.splice(insertIndex, 0, item);
    }

    // Start processing (non-blocking)
    setImmediate(() => this.#process());

    return promise;
  }

  /**
   * Get queue statistics.
   */
  getStats() {
    return {
      ...this.#stats,
      queued: this.#queue.length,
      running: this.#totalRunning,
      maxConcurrent: this.#options.maxConcurrent,
      maxQueueSize: this.#options.maxQueueSize,
      perToolLimit: this.#options.perToolLimit,
      perToolRunning: Object.fromEntries(this.#perToolRunning),
      cleanupIntervalMs: this.#options.cleanupIntervalMs,
      shutdown: this.#shutdown,
    };
  }

  /**
   * Drain all pending items (reject them).
   */
  drain() {
    const items = this.#queue.splice(0);
    for (const item of items) {
      item.reject(new Error("Queue drained"));
      this.#stats.failed++;
      item.dispose();
    }
    this.#perToolRunning.clear();
    logger.info("NetworkRequestQueue drained", { drained: items.length });
  }

  /**
   * Reset statistics.
   */
  resetStats() {
    this.#stats = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      timedout: 0,
      retries: 0,
      cleaned: 0,
    };
  }

  /**
   * Clean up stale/expired items from the queue.
   * This is called automatically by the cleanup timer but can also be called manually.
   *
   * Frees memory by:
   * 1. Removing expired items from the queue (rejecting them)
   * 2. Disposing completed item references
   * 3. Limiting perToolRunning map size
   */
  cleanup() {
    const now = Date.now();
    const queueLenBefore = this.#queue.length;
    let cleaned = 0;
    let expiredRemoved = 0;

    // 1. Remove expired items from the queue (those sitting too long)
    const remaining = [];
    for (const item of this.#queue) {
      if (item.isExpired && item.state === "queued") {
        item.timeout();
        this.#stats.timedout++;
        expiredRemoved++;
        cleaned++;
        item.dispose();
      } else {
        remaining.push(item);
      }
    }
    this.#queue = remaining;

    // 2. Bound the perToolRunning map — remove stale zero-count entries
    for (const [tool, count] of this.#perToolRunning) {
      if (count <= 0) {
        this.#perToolRunning.delete(tool);
        cleaned++;
      }
    }

    // 3. If perToolRunning is still too large, trim oldest entries
    if (this.#perToolRunning.size > this.#options.maxStaleEntries) {
      const entries = Array.from(this.#perToolRunning.entries());
      const toRemove = entries.slice(0, entries.length - this.#options.maxStaleEntries);
      for (const [tool] of toRemove) {
        this.#perToolRunning.delete(tool);
        cleaned++;
      }
    }

    if (cleaned > 0 || expiredRemoved > 0) {
      this.#stats.cleaned += cleaned;
      logger.debug("NetworkRequestQueue cleanup", {
        removedExpired: expiredRemoved,
        removedStale: cleaned - expiredRemoved,
        queueBefore: queueLenBefore,
        queueAfter: this.#queue.length,
      });
    }
  }

  /**
   * Shutdown the queue: stop processing, drain items, stop cleanup timer.
   */
  shutdown() {
    this.#shutdown = true;
    this.#stopCleanupTimer();
    this.drain();
    logger.info("NetworkRequestQueue shut down");
  }

  // ========================================================================
  // Cleanup Timer
  // ========================================================================

  #startCleanupTimer() {
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      try {
        if (!this.#shutdown) {
          this.cleanup();
        }
      } catch (e) {
        logger.error("NetworkRequestQueue cleanup error", { error: e.message });
      }
    }, this.#options.cleanupIntervalMs);
    this.#cleanupTimer.unref?.();
  }

  #stopCleanupTimer() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  // ========================================================================
  // Internal Processing
  // ========================================================================

  #process() {
    if (this.#processing) return;
    this.#processing = true;

    while (this.#canProcessMore()) {
      const item = this.#dequeueNext();
      if (!item) break;

      // Check if item expired in queue
      if (item.isExpired) {
        item.timeout();
        this.#stats.timedout++;
        item.dispose();
        continue;
      }

      this.#executeItem(item);
    }

    this.#processing = false;
  }

  #canProcessMore() {
    if (this.#totalRunning >= this.#options.maxConcurrent) return false;

    // Respect global concurrency hint from ConcurrencyManager
    const globalConc = this.#concurrencyManager?.concurrency ?? 50;
    const globalRatio = globalConc / 80;
    const effectiveLimit = Math.max(
      2,
      Math.round(this.#options.maxConcurrent * globalRatio),
    );
    if (this.#totalRunning >= effectiveLimit) return false;

    return this.#queue.length > 0;
  }

  #dequeueNext() {
    // Try to find an item whose tool type hasn't hit its per-tool limit
    for (let i = 0; i < this.#queue.length; i++) {
      const item = this.#queue[i];
      const toolRunning = this.#perToolRunning.get(item.toolName) || 0;
      if (toolRunning < this.#options.perToolLimit) {
        this.#queue.splice(i, 1);
        return item;
      }
    }
    // Fallback: take the first item to prevent starvation
    if (this.#queue.length > 0) {
      return this.#queue.shift();
    }
    return null;
  }

  async #executeItem(item) {
    item.state = "running";
    item.startedAt = Date.now();
    this.#totalRunning++;

    const toolRunning = this.#perToolRunning.get(item.toolName) || 0;
    this.#perToolRunning.set(item.toolName, toolRunning + 1);

    try {
      const result = await item.taskFn();
      item.resolve(result);
      this.#stats.completed++;
      this.#concurrencyManager?.recordCall(item.toolName, item.age, true);
      // After resolve(), promise refs are already nullified via nullifyPromiseRefs
    } catch (error) {
      // Retry logic
      if (item.retries < item.maxRetries && this.#isRetryable(error)) {
        item.retries++;
        this.#stats.retries++;
        const delay = this.#options.retryBaseDelayMs * Math.pow(2, item.retries - 1);
        logger.debug("Network request retry", {
          toolName: item.toolName,
          attempt: item.retries,
          delayMs: delay,
          error: error.message,
        });
        // Re-enqueue with backoff
        setTimeout(() => {
          this.#stats.enqueued++;
          this.#queue.push(item);
          setImmediate(() => this.#process());
        }, delay);
      } else {
        item.reject(error);
        this.#stats.failed++;
        this.#concurrencyManager?.recordCall(item.toolName, item.age, false);
      }
    } finally {
      this.#totalRunning--;
      const currentToolRunning = this.#perToolRunning.get(item.toolName) || 1;
      this.#perToolRunning.set(item.toolName, Math.max(0, currentToolRunning - 1));
      setImmediate(() => this.#process());
    }
  }

  #isRetryable(error) {
    if (!error) return false;
    const msg = (error.message || "").toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("enetunreach") ||
      msg.includes("5") ||
      msg.includes("etimedout") ||
      msg.includes("socket") ||
      msg.includes("network")
    );
  }
}

// ============================================================================
// Singleton Export
// ============================================================================
let defaultInstance = null;

export function getNetworkQueue(options = {}) {
  if (!defaultInstance) {
    defaultInstance = new NetworkRequestQueue(options);
  }
  return defaultInstance;
}

export default getNetworkQueue;
