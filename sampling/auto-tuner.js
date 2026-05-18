/**
 * Auto-Tuner — Adaptive Concurrency Adjustment (P0-1 Refactored)
 *
 * Uses ConcurrencyManager instead of global.perfStats / global.requestQueue.
 * Periodically adjusts the main request queue concurrency based on:
 * - Slow request ratio (sliding window)
 * - Average request duration
 * - Current system load
 *
 * Integrates with ConfigManager for runtime configuration.
 */
import { createLogger } from "../utils-logger.js";
import { getConcurrencyManager } from "../concurrency-manager.js";
import configManager from "../config-manager.js";

const logger = createLogger("AUTO_TUNER");

// ============================================================================
// Tuner Configuration (from config-manager with fallbacks)
// ============================================================================
const CONFIG = {
  SLOW_REQUEST_MS: 3000,
  SLOW_RATIO_HIGH: 0.15,
  get ADJUST_INTERVAL_MS() {
    return configManager.getConcurrencyAdjustIntervalMs();
  },
  get CONCURRENCY_MIN() {
    return configManager.getConcurrencyMin();
  },
  get CONCURRENCY_MAX() {
    return configManager.getConcurrencyMax();
  },
};

// Reference to the concurrency manager (set during init)
let concManager = null;

/**
 * Initialize the tuner with a ConcurrencyManager instance.
 * Called once during server startup.
 */
export function initAutoTuner(concurrencyManager) {
  concManager = concurrencyManager;
}

/**
 * Get the active ConcurrencyManager instance.
 */
function getManager() {
  if (!concManager) {
    concManager = getConcurrencyManager();
  }
  return concManager;
}

/**
 * Auto-adjust concurrency based on current performance metrics.
 * Lowers concurrency when slow request ratio is high;
 * raises it when the system is underloaded.
 */
export function autoAdjustConcurrency() {
  const manager = getManager();
  const stats = manager.getStats();
  const slowRatio = manager.getSlowRatio();

  // Calculate target concurrency: linear map within configured range
  const minC = manager.minConcurrency;
  const maxC = manager.maxConcurrency;
  let targetConcurrency = maxC;

  if (slowRatio > CONFIG.SLOW_RATIO_HIGH) {
    // High slow ratio → aggressively reduce
    targetConcurrency = Math.max(
      minC,
      Math.floor(maxC * (1 - slowRatio)),
    );
  } else {
    // Low slow ratio → cautiously increase
    const loadFactor = 1 - slowRatio;
    targetConcurrency = Math.min(
      maxC,
      Math.floor(minC + (maxC - minC) * loadFactor),
    );
  }

  const oldConcurrency = manager.concurrency;
  if (targetConcurrency !== oldConcurrency) {
    logger.info("Auto‑tune concurrency", {
      old: oldConcurrency,
      new: targetConcurrency,
      slowRatio: (slowRatio * 100).toFixed(2) + "%",
      totalRequests: stats.requests,
    });
    manager.concurrency = targetConcurrency;
  }
}

/**
 * Recommend a timeout for a specific tool.
 * Adjusts base timeout based on the current slow request ratio.
 *
 * @param {string} toolName
 * @returns {number} Recommended timeout in seconds
 */
export function getRecommendedTimeout(toolName) {
  const baseTimeouts = {
    terminal: 30,
    tmux: 60,
    execute: 120,
    file: 60,
    system: 30,
    path: 20,
    session: 20,
  };
  const base = baseTimeouts[toolName] ?? 60;
  const manager = getManager();
  const slowRatio = manager.getSlowRatio();

  // Add up to 30 extra seconds based on slow ratio
  const extra = Math.min(30, Math.round(slowRatio * 10) * 5);
  return base + extra;
}

/**
 * Start the periodic auto-tuner.
 * Called once during server startup.
 */
export function startAutoTuner() {
  const manager = getManager();
  const interval = CONFIG.ADJUST_INTERVAL_MS;

  logger.info("Auto‑tuner started", {
    intervalMs: interval,
    minConcurrency: manager.minConcurrency,
    maxConcurrency: manager.maxConcurrency,
    initialConcurrency: manager.concurrency,
  });

  setInterval(() => {
    try {
      autoAdjustConcurrency();
    } catch (e) {
      logger.error("Auto‑tuner error", { error: e.message });
    }
  }, interval);

  // Listen for concurrency changes from other sources (e.g., manual override)
  manager.onConcurrencyChange((newVal) => {
    logger.debug("Concurrency changed", { new: newVal });
  });
}
