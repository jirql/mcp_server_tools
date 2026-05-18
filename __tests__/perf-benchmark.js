/**
 * Comprehensive Performance Benchmark Suite
 *
 * Tests all critical paths across the MCP server framework:
 * - Chunked buffer (append, join, tail, split avoidance)
 * - NetworkRequestQueue (throughput, latency)
 * - DegradationTracker (overhead, bounded growth)
 * - ConfigManager (access latency, hot-reload)
 * - ConcurrencyManager (stats recording)
 * - Auto-tuner (execution time)
 * - ANSI stripping (throughput)
 * - String vs chunked memory comparison
 */
import { PTYSession } from "../session-manager.js";
import { getConcurrencyManager } from "../concurrency-manager.js";
import { getNetworkQueue } from "../performance-optimizer.js";
import { degradationTracker } from "../utils-error-handler.js";
import configManager from "../config-manager.js";

// ============================================================================
// Timing Utilities
// ============================================================================
function now() {
  return Number(process.hrtime.bigint()) / 1e6; // ms
}

function formatNs(durationNs) {
  if (durationNs < 1000) return `${durationNs.toFixed(1)} ns`;
  if (durationNs < 1e6) return `${(durationNs / 1000).toFixed(2)} μs`;
  if (durationNs < 1e9) return `${(durationNs / 1e6).toFixed(2)} ms`;
  return `${(durationNs / 1e9).toFixed(3)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function measure(fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  return {
    totalNs,
    avgNs: totalNs / iterations,
    ops: Math.round(iterations / (totalNs / 1e9)),
  };
}

function measureAsync(fn, iterations = 100) {
  return new Promise(async (resolve) => {
    // Warmup
    for (let i = 0; i < 10; i++) await fn();

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) await fn();
    const end = process.hrtime.bigint();
    const totalNs = Number(end - start);
    resolve({
      totalNs,
      avgNs: totalNs / iterations,
      ops: Math.round(iterations / (totalNs / 1e9)),
    });
  });
}

// ============================================================================
// 1. Chunked Buffer Benchmarks
// ============================================================================
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║         MCP Server — Full Performance Benchmark             ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log("");

async function benchmarkChunkedBuffer() {
  console.log("─".repeat(60));
  console.log("  [1] CHUNKED BUFFER");
  console.log("─".repeat(60));

  // Create a test buffer using the prototype methods
  function createBuffer() {
    const buf = {
      _outputChunks: [],
      _outputBytes: 0,
      _maxChunks: 80,
      _chunkTargetSize: 65536,
      _trimmedBytes: 0,
      _lastGCSize: 0,
      options: { maxOutputBufferSize: 5 * 1024 * 1024 },
      emit() {},
    };
    buf._appendOutput = PTYSession.prototype._appendOutput.bind(buf);
    buf._getOutput = PTYSession.prototype._getOutput.bind(buf);
    buf._getOutputTail = PTYSession.prototype._getOutputTail.bind(buf);
    buf._clearOutput = PTYSession.prototype._clearOutput.bind(buf);
    buf._trimOutput = PTYSession.prototype._trimOutput.bind(buf);
    return buf;
  }

  // 1a. Append small chunks (PTY typical: 64-256 bytes each)
  const smallData = [];
  for (let i = 0; i < 10000; i++) {
    smallData.push(`line ${i}: ${"A".repeat(60)}\n`);
  }
  const smallDataLen = smallData.reduce((s, d) => s + d.length, 0);

  const buf1 = createBuffer();
  const t1 = measure(() => {
    for (const d of smallData) buf1._appendOutput(d);
  }, 1);
  console.log(
    `  Append 10k × 64B chunks:  ${formatNs(t1.avgNs)} avg  (${formatBytes(smallDataLen)} total)`
  );

  // 1b. Join output
  const t2 = measure(() => buf1._getOutput(), 100);
  console.log(
    `  Join ${buf1._outputChunks.length} chunks → string: ${formatNs(t2.avgNs)} avg`
  );

  // 1c. Tail extraction (prompt detection path)
  const t3 = measure(() => buf1._getOutputTail(2048), 1000);
  console.log(
    `  getOutputTail(2KB):      ${formatNs(t3.avgNs)} avg`
  );

  // 1d. Append to large buffer (simulating steady-state)
  const buf2 = createBuffer();
  // Fill to ~3MB
  for (let i = 0; i < 50; i++) {
    buf2._appendOutput("A".repeat(65536));
  }
  console.log(`  Large buffer size: ${formatBytes(buf2._outputBytes)}, chunks: ${buf2._outputChunks.length}`);

  const t4 = measure(() => buf2._appendOutput("hello world\n"), 1000);
  console.log(
    `  Append 12B to 3MB buffer: ${formatNs(t4.avgNs)} avg`
  );

  // 1e. Clear
  const t5 = measure(() => buf2._clearOutput(), 1000);
  console.log(
    `  Clear buffer:            ${formatNs(t5.avgNs)} avg`
  );
  console.log("");
}

// ============================================================================
// 2. NetworkRequestQueue Benchmarks
// ============================================================================
async function benchmarkNetworkQueue() {
  console.log("─".repeat(60));
  console.log("  [2] NETWORK REQUEST QUEUE");
  console.log("─".repeat(60));

  const nq = getNetworkQueue({
    maxConcurrent: 10,
    perToolLimit: 5,
    maxQueueSize: 100,
  });

  // 2a. Enqueue throughput
  const t1 = await measureAsync(async () => {
    await nq.enqueue("test", async () => "ok", { priority: 0 });
  }, 200);
  nq.drain();
  console.log(
    `  Enqueue + execute:       ${formatNs(t1.avgNs)} avg`
  );

  // 2b. Queue with concurrent pressure
  const nq2 = getNetworkQueue({
    maxConcurrent: 5,
    perToolLimit: 3,
  });
  const t2Start = now();
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      nq2.enqueue("test", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return "ok";
      })
    );
  }
  await Promise.all(promises);
  const t2Dur = now() - t2Start;
  console.log(
    `  50 concurrent items (1ms each): ${t2Dur.toFixed(1)} ms total  (concurrency=5)`
  );
  nq2.drain();

  // 2c. Queue statistics overhead
  const t3 = measure(() => nq.getStats(), 10000);
  console.log(
    `  getStats():              ${formatNs(t3.avgNs)} avg`
  );

  // 2d. Enqueue rejected (queue full)
  const nq3 = getNetworkQueue({ maxQueueSize: 5 });
  // Fill the queue
  for (let i = 0; i < 5; i++) {
    nq3.enqueue("test", () => new Promise(() => {}));
  }
  const t4 = await measureAsync(async () => {
    try {
      await nq3.enqueue("test", async () => "overflow");
    } catch (e) {}
  }, 100);
  nq3.drain();
  console.log(
    `  Enqueue rejected (full): ${formatNs(t4.avgNs)} avg`
  );
  console.log("");
}

// ============================================================================
// 3. DegradationTracker Benchmarks
// ============================================================================
async function benchmarkDegradation() {
  console.log("─".repeat(60));
  console.log("  [3] DEGRADATION TRACKER");
  console.log("─".repeat(60));

  // Reset state
  degradationTracker.reset();

  // 3a. Record failure (new entry)
  const toolName = "bench_tool";
  const t1 = measure(() => degradationTracker.recordFailure(toolName, "action"), 1000);
  console.log(
    `  recordFailure():         ${formatNs(t1.avgNs)} avg`
  );

  // 3b. Record success
  const t2 = measure(() => degradationTracker.recordSuccess(toolName, "action"), 1000);
  console.log(
    `  recordSuccess():         ${formatNs(t2.avgNs)} avg`
  );

  // 3c. isDegraded check
  const t3 = measure(() => degradationTracker.isDegraded(toolName, "action"), 1000);
  console.log(
    `  isDegraded():            ${formatNs(t3.avgNs)} avg`
  );

  // 3d. getStatus
  const t4 = measure(() => degradationTracker.getStatus(toolName, "action"), 1000);
  console.log(
    `  getStatus():             ${formatNs(t4.avgNs)} avg`
  );

  // 3e. Map with 1000 entries (worst-case lookup)
  for (let i = 0; i < 1000; i++) {
    degradationTracker.recordFailure(`tool_${i}`, "action");
  }
  const t5 = measure(() => degradationTracker.recordSuccess(`tool_500`, "action"), 1000);
  console.log(
    `  recordSuccess (1000-entry map): ${formatNs(t5.avgNs)} avg`
  );

  // 3f. getAllStatus
  const t6 = measure(() => degradationTracker.getAllStatus(), 100);
  console.log(
    `  getAllStatus() (1000 entries): ${formatNs(t6.avgNs)} avg`
  );

  degradationTracker.reset();
  console.log("");
}

// ============================================================================
// 4. ConfigManager Benchmarks
// ============================================================================
function benchmarkConfig() {
  console.log("─".repeat(60));
  console.log("  [4] CONFIG MANAGER");
  console.log("─".repeat(60));

  const t1 = measure(() => configManager.get("server.port"), 10000);
  console.log(
    `  configManager.get('server.port'): ${formatNs(t1.avgNs)} avg`
  );

  const t2 = measure(() => configManager.getServerPort(), 10000);
  console.log(
    `  configManager.getServerPort():    ${formatNs(t2.avgNs)} avg`
  );

  const t3 = measure(() => configManager.getConcurrencyMin(), 10000);
  console.log(
    `  getConcurrencyMin():              ${formatNs(t3.avgNs)} avg`
  );

  const t4 = measure(() => configManager.getMaxSessions(), 10000);
  console.log(
    `  getMaxSessions():                 ${formatNs(t4.avgNs)} avg`
  );

  const t5 = measure(() => configManager.getAll(), 1000);
  console.log(
    `  getAll() (entire config):         ${formatNs(t5.avgNs)} avg`
  );
  console.log("");
}

// ============================================================================
// 5. ConcurrencyManager Benchmarks
// ============================================================================
function benchmarkConcurrency() {
  console.log("─".repeat(60));
  console.log("  [5] CONCURRENCY MANAGER");
  console.log("─".repeat(60));

  const cm = getConcurrencyManager({
    initialConcurrency: 50,
    minConcurrency: 20,
    maxConcurrency: 80,
  });

  const t1 = measure(() => cm.recordCall("test_tool", 100, true), 10000);
  console.log(
    `  recordCall():            ${formatNs(t1.avgNs)} avg`
  );

  const t2 = measure(() => cm.getStats(), 10000);
  console.log(
    `  getStats():              ${formatNs(t2.avgNs)} avg`
  );

  const t3 = measure(() => cm.getToolStats(), 10000);
  console.log(
    `  getToolStats():          ${formatNs(t3.avgNs)} avg`
  );

  const t4 = measure(() => cm.getSlowRatio(), 10000);
  console.log(
    `  getSlowRatio():          ${formatNs(t4.avgNs)} avg`
  );

  // Concurrency setter
  const t5 = measure(() => { cm.concurrency = 55; }, 10000);
  console.log(
    `  concurrency setter:      ${formatNs(t5.avgNs)} avg`
  );

  // Concurrency getter
  const t6 = measure(() => cm.concurrency, 10000);
  console.log(
    `  concurrency getter:      ${formatNs(t6.avgNs)} avg`
  );
  console.log("");
}

// ============================================================================
// 6. ANSI Stripping Benchmarks
// ============================================================================
function benchmarkAnsiStrip() {
  console.log("─".repeat(60));
  console.log("  [6] ANSI STRIPPING");
  console.log("─".repeat(60));

  const stripAnsi = PTYSession.prototype._stripAnsi;

  // Light ANSI (typical prompt)
  const lightText = "\x1b[32muser@host\x1b[0m:\x1b[34m~$\x1b[0m ";
  const t1 = measure(() => stripAnsi(lightText), 10000);
  console.log(
    `  Light ANSI (prompt):     ${formatNs(t1.avgNs)} avg  → "${stripAnsi(lightText)}"`
  );

  // Heavy ANSI (nmap output with colors)
  let heavyText = "";
  for (let i = 0; i < 100; i++) {
    heavyText += `\x1b[${31 + (i % 7)}mNmap scan result line ${i}\x1b[0m\n`;
  }
  const t2 = measure(() => stripAnsi(heavyText), 1000);
  console.log(
    `  Heavy ANSI (100 lines):  ${formatNs(t2.avgNs)} avg`
  );

  // Raw text (no ANSI) - best case
  const rawText = "A".repeat(10000);
  const t3 = measure(() => stripAnsi(rawText), 1000);
  console.log(
    `  Raw text (10KB, no ANSI):${formatNs(t3.avgNs)} avg`
  );
  console.log("");
}

// ============================================================================
// 7. Memory Comparison: String vs Chunked Buffer
// ============================================================================
async function benchmarkMemoryComparison() {
  console.log("─".repeat(60));
  console.log("  [7] MEMORY: STRING vs CHUNKED BUFFER");
  console.log("─".repeat(60));

  const APPEND_COUNT = 10000;
  const CHUNK_SIZE = 1024; // 1KB per append

  // --- OLD: Single string ---
  const oldStartMem = process.memoryUsage().heapUsed;
  let oldBuf = "";
  const oldStartTime = now();

  for (let i = 0; i < APPEND_COUNT; i++) {
    oldBuf += "A".repeat(CHUNK_SIZE);
    // Simulate trim at 5MB
    if (oldBuf.length > 5 * 1024 * 1024) {
      oldBuf = oldBuf.slice(Math.floor(oldBuf.length / 2));
    }
  }

  const oldTime = now() - oldStartTime;
  const oldEndMem = process.memoryUsage().heapUsed;

  // Force GC
  if (global.gc) {
    global.gc();
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- NEW: Chunked buffer ---
  const buf = {
    _outputChunks: [],
    _outputBytes: 0,
    _maxChunks: 80,
    _chunkTargetSize: 65536,
    _trimmedBytes: 0,
    _lastGCSize: 0,
    options: { maxOutputBufferSize: 5 * 1024 * 1024 },
    emit() {},
  };
  buf._appendOutput = PTYSession.prototype._appendOutput.bind(buf);
  buf._trimOutput = PTYSession.prototype._trimOutput.bind(buf);

  const newStartMem = process.memoryUsage().heapUsed;
  const newStartTime = now();

  for (let i = 0; i < APPEND_COUNT; i++) {
    buf._appendOutput("A".repeat(CHUNK_SIZE));
  }

  const newTime = now() - newStartTime;
  const newEndMem = process.memoryUsage().heapUsed;

  console.log(`  Appends: ${APPEND_COUNT} × ${formatBytes(CHUNK_SIZE)} each`);
  console.log(`  Old (string):  ${oldTime.toFixed(1)} ms, heap delta: ${formatBytes(oldEndMem - oldStartMem)}`);
  console.log(`  New (chunked): ${newTime.toFixed(1)} ms, heap delta: ${formatBytes(newEndMem - newStartMem)}`);
  console.log(`  Chunks at end: ${buf._outputChunks.length}, total bytes: ${formatBytes(buf._outputBytes)}`);
  console.log(`  Speedup: ${(oldTime / Math.max(newTime, 0.1)).toFixed(1)}x`);
  console.log("");
}

// ============================================================================
// 8. Auto-Tuner Simulation
// ============================================================================
function benchmarkAutoTuner() {
  console.log("─".repeat(60));
  console.log("  [8] AUTO-TUNER");
  console.log("─".repeat(60));

  const cm = getConcurrencyManager();
  const { autoAdjustConcurrency } = require ? {} : {};

  // Import auto-tuner functions
  import("../sampling/auto-tuner.js").then(({ autoAdjustConcurrency, getRecommendedTimeout }) => {
    // 8a. autoAdjustConcurrency
    // Prime with some data
    for (let i = 0; i < 100; i++) {
      cm.recordCall("terminal", i < 20 ? 5000 : 100, i < 20 ? false : true);
    }
    const t1 = measure(() => autoAdjustConcurrency(), 1000);
    console.log(
      `  autoAdjustConcurrency(): ${formatNs(t1.avgNs)} avg  (slowRatio=${(cm.getSlowRatio() * 100).toFixed(1)}%)`
    );

    // 8b. getRecommendedTimeout
    const t2 = measure(() => getRecommendedTimeout("terminal"), 10000);
    console.log(
      `  getRecommendedTimeout(): ${formatNs(t2.avgNs)} avg`
    );

    console.log("");
    runRemaining();
  });
}

// ============================================================================
// 9. End-to-End Tool Handler Chain
// ============================================================================
function benchmarkToolChain() {
  console.log("─".repeat(60));
  console.log("  [9] TOOL HANDLER CHAIN (withErrorHandling)");
  console.log("─".repeat(60));

  const { withErrorHandling } = require ? {} : {};
  import("../utils-error-handler.js").then(({ withErrorHandling }) => {
    // 9a. Success path
    const successHandler = withErrorHandling(async (p) => ({ success: true, data: p.value }), "bench", "success");
    const t1 = measure(() => successHandler({ value: "test" }), 500);
    console.log(
    );
  });
}

// ============================================================================
// Main runner
// ============================================================================
async function main() {
  try {
    // Static benchmarks
    benchmarkChunkedBuffer();

    // Queue benchmarks
    await benchmarkNetworkQueue();

    // Degradation benchmarks
    await benchmarkDegradation();

    // Config benchmarks
    benchmarkConfig();

    // Concurrency benchmarks
    benchmarkConcurrency();

    // ANSI strip benchmarks
    benchmarkAnsiStrip();

    // Memory comparison
    await benchmarkMemoryComparison();

    // Auto-tuner
    const { autoAdjustConcurrency, getRecommendedTimeout } = await import("../sampling/auto-tuner.js");
    const cm = getConcurrencyManager();
    cm.reset();

    // Prime with varied data
    for (let i = 0; i < 200; i++) {
      cm.recordCall(
        i % 2 === 0 ? "terminal" : "execute",
        i < 30 ? 4000 + Math.random() * 2000 : 100 + Math.random() * 500,
        i < 30 ? false : true
      );
    }

    const ta1 = measure(() => autoAdjustConcurrency(), 1000);
    console.log("─".repeat(60));
    console.log("  [8] AUTO-TUNER");
    console.log("─".repeat(60));
    console.log(
      `  autoAdjustConcurrency(): ${formatNs(ta1.avgNs)} avg  (slowRatio=${(cm.getSlowRatio() * 100).toFixed(1)}%)`
    );

    const ta2 = measure(() => getRecommendedTimeout("terminal"), 10000);
    console.log(
      `  getRecommendedTimeout(): ${formatNs(ta2.avgNs)} avg`
    );

    // withErrorHandling success path
    const { withErrorHandling } = await import("../utils-error-handler.js");
    const successHandler = withErrorHandling(
      async (p) => ({ success: true, data: p.value }),
      "bench",
      "success"
    );
    const te1 = measure(async () => {
      degradationTracker.reset();
      await successHandler({ value: "test" });
    }, 200);
    console.log("─".repeat(60));
    console.log("  [9] TOOL HANDLER CHAIN (withErrorHandling)");
    console.log("─".repeat(60));
    console.log(
      `  Success call (cold):     ${formatNs(te1.avgNs)} avg`
    );

    // Failure + degradation path
    const failHandler = withErrorHandling(
      async () => { throw new Error("benchmark error"); },
      "bench",
      "fail"
    );
    degradationTracker.reset();
    const te2 = await measureAsync(async () => {
      await failHandler({});
    }, 50);
    console.log(
      `  Failure call:            ${formatNs(te2.avgNs)} avg`
    );

    console.log("");
    console.log("─".repeat(60));
    console.log("  BENCHMARK COMPLETE");
    console.log("─".repeat(60));
  } catch (err) {
    console.error("Benchmark error:", err);
  }
}

main();
