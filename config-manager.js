/**
 * Config Manager - Centralized Configuration (P2-9)
 *
 * Single source of truth for all configuration values.
 * Eliminates scattered JSON.parse(readFileSync(...)) calls.
 * Supports typed getters, defaults, and runtime updates.
 */
import { readFileSync, existsSync, watchFile } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = join(__dirname, "config.json");

// ============================================================================
// Default configuration (used when config.json is missing or a key is absent)
// ============================================================================
const DEFAULTS = {
  server: {
    port: 10000,
    host: "0.0.0.0",
    name: "MCP Server for Kali Linux",
    version: "2025-11-25",
  },
  security: {
    allowed_ips: ["127.0.0.1"],
    rate_limit: {
      window_ms: 60000,
      max_requests: 200,
    },
  },
  terminal: {
    shell: "/bin/bash",
    args: ["-i"],
    env: {
      TERM: "xterm-256color",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      LANG: "en_US.UTF-8",
    },
    cols: 120,
    rows: 30,
    timeout: 3600,
    max_sessions: 20,
  },
  tmux: {
    path: "/usr/bin/tmux",
    default_session_prefix: "mcp_",
    max_sessions: 10,
  },
  performance: {
    concurrency: {
      min: 20,
      max: 80,
      initial: 50,
      adjust_interval_ms: 30000,
    },
    network_queue: {
      max_concurrent: 10,
      max_queue_size: 100,
      per_tool_limit: 5,
    },
    adapter_window_ms: 60000, // Sliding window for performance sampling
  },
};

// ============================================================================
// Config Manager Class
// ============================================================================
class ConfigManager {
  #config = null;
  #listeners = new Map();
  #listenerIdCounter = 0;

  constructor() {
    this.#load();
  }

  // ---- Loading / Reloading ----

  #load() {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = readFileSync(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        this.#config = this.#mergeDeep({}, DEFAULTS, parsed);
      } else {
        console.warn(`[CONFIG] config.json not found at ${CONFIG_PATH}, using defaults`);
        this.#config = this.#mergeDeep({}, DEFAULTS);
      }
    } catch (err) {
      console.error(`[CONFIG] Failed to load config.json: ${err.message}`);
      this.#config = this.#mergeDeep({}, DEFAULTS);
    }
  }

  /**
   * Deep merge: source objects override defaults.
   * Accepts multiple source objects (variadic).
   */
  #mergeDeep(target, ...sources) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of Object.keys(source)) {
        const val = source[key];
        if (val !== null && typeof val === "object" && !Array.isArray(val)) {
          target[key] = this.#mergeDeep(target[key] || {}, val);
        } else {
          target[key] = val;
        }
      }
    }
    return target;
  }

  /**
   * Hot-reload: re-read config.json from disk.
   * Notifies all registered listeners on change.
   */
  reload() {
    const oldConfig = this.#config;
    this.#load();
    const changedKeys = this.#diffKeys(oldConfig, this.#config);
    if (changedKeys.length > 0) {
      for (const [id, listener] of this.#listeners) {
        try {
          listener(this.#config, changedKeys);
        } catch (e) {
          console.error(`[CONFIG] Listener ${id} error: ${e.message}`);
        }
      }
    }
  }

  #diffKeys(oldObj, newObj, prefix = "") {
    const keys = [];
    for (const key of Object.keys(newObj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof newObj[key] === "object" && newObj[key] !== null && !Array.isArray(newObj[key])) {
        keys.push(...this.#diffKeys(oldObj?.[key] || {}, newObj[key], fullKey));
      } else if (oldObj?.[key] !== newObj[key]) {
        keys.push(fullKey);
      }
    }
    return keys;
  }

  // ---- Getters ----

  /**
   * Get a config value by dot-separated path.
   * @param {string} path - e.g. "server.port" or "terminal.max_sessions"
   * @param {*} [defaultVal] - Fallback if path is missing
   */
  get(path, defaultVal = undefined) {
    const parts = path.split(".");
    let current = this.#config;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return defaultVal;
      }
      current = current[part];
    }
    return current !== undefined ? current : defaultVal;
  }

  /** Get the entire config object (read-only snapshot) */
  getAll() {
    return this.#mergeDeep({}, this.#config);
  }

  // ---- Typed Convenience Getters ----

  getServerPort() {
    return this.get("server.port", DEFAULTS.server.port);
  }
  getServerHost() {
    return this.get("server.host", DEFAULTS.server.host);
  }
  getServerName() {
    return this.get("server.name", DEFAULTS.server.name);
  }
  getAllowedIPs() {
    return this.get("security.allowed_ips", DEFAULTS.security.allowed_ips);
  }
  getRateLimitWindowMs() {
    return this.get("security.rate_limit.window_ms", DEFAULTS.security.rate_limit.window_ms);
  }
  getRateLimitMaxRequests() {
    return this.get("security.rate_limit.max_requests", DEFAULTS.security.rate_limit.max_requests);
  }
  getMaxSessions() {
    return this.get("terminal.max_sessions", DEFAULTS.terminal.max_sessions);
  }
  getTerminalTimeout() {
    return this.get("terminal.timeout", DEFAULTS.terminal.timeout);
  }
  getConcurrencyMin() {
    return this.get("performance.concurrency.min", DEFAULTS.performance.concurrency.min);
  }
  getConcurrencyMax() {
    return this.get("performance.concurrency.max", DEFAULTS.performance.concurrency.max);
  }
  getConcurrencyInitial() {
    return this.get("performance.concurrency.initial", DEFAULTS.performance.concurrency.initial);
  }
  getConcurrencyAdjustIntervalMs() {
    return this.get("performance.concurrency.adjust_interval_ms", DEFAULTS.performance.concurrency.adjust_interval_ms);
  }
  getNetworkQueueMaxConcurrent() {
    return this.get("performance.network_queue.max_concurrent", DEFAULTS.performance.network_queue.max_concurrent);
  }
  getNetworkQueueMaxSize() {
    return this.get("performance.network_queue.max_queue_size", DEFAULTS.performance.network_queue.max_queue_size);
  }
  getNetworkQueuePerToolLimit() {
    return this.get("performance.network_queue.per_tool_limit", DEFAULTS.performance.network_queue.per_tool_limit);
  }

  // ---- Runtime Updates ----

  /**
   * Set a value at runtime (in-memory only, does NOT persist to disk).
   * @param {string} path - dot-separated path
   * @param {*} value - new value
   */
  set(path, value) {
    const parts = path.split(".");
    let current = this.#config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    const oldValue = current[lastKey];
    current[lastKey] = value;

    // Notify listeners of the change
    for (const [id, listener] of this.#listeners) {
      try {
        listener(this.#config, [path]);
      } catch (e) {
        console.error(`[CONFIG] Listener ${id} error: ${e.message}`);
      }
    }
  }

  // ---- Change Listeners ----

  /**
   * Register a change listener. Called with (newConfig, changedKeys).
   * @param {Function} listener
   * @returns {number} listenerId (use to unregister)
   */
  onChange(listener) {
    const id = ++this.#listenerIdCounter;
    this.#listeners.set(id, listener);
    return id;
  }

  /**
   * Remove a change listener.
   * @param {number} id
   */
  offChange(id) {
    this.#listeners.delete(id);
  }
}

// ============================================================================
// Singleton Export
// ============================================================================
const configManager = new ConfigManager();

export { configManager, ConfigManager, DEFAULTS };
export default configManager;
