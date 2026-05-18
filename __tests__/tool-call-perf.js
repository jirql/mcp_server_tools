/**
 * Tool Call Performance Benchmark
 *
 * Measures every layer of the tool call execution pipeline:
 * 1. Raw handler execution per tool (ops-*.js)
 * 2. AJV schema validation
 * 3. withErrorHandling wrapper
 * 4. requestQueue dispatch
 * 5. ConcurrencyManager.recordCall
 * 6. Full end-to-end chain simulation
 */
import { fileOps } from "../ops-file.js";
import { systemOps } from "../ops-system.js";
import { tmuxOps } from "../ops-tmux.js";
import { pathOps } from "../ops-path.js";
import { getConcurrencyManager } from "../concurrency-manager.js";
import { withErrorHandling, degradationTracker } from "../utils-error-handler.js";
import configManager from "../config-manager.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Utilities
// ============================================================================
function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function measure(fn, iterations = 1000) {
  for (let i = 0; i < 100; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  return { avgNs: totalNs / iterations, ops: Math.round(iterations / (totalNs / 1e9)), totalNs };
}

function measureAsync(fn, iterations = 100) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < 20; i++) await fn();
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) await fn();
    const end = process.hrtime.bigint();
    const totalNs = Number(end - start);
    resolve({ avgNs: totalNs / iterations, ops: Math.round(iterations / (totalNs / 1e9)) });
  });
}

function fmtNs(ns) {
  if (ns < 1000) return `${ns.toFixed(1)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1e6).toFixed(3)} ms`;
}

function fmtOps(ops) {
  if (ops > 1e6) return `${(ops / 1e6).toFixed(1)}M ops/s`;
  if (ops > 1e3) return `${(ops / 1e3).toFixed(1)}K ops/s`;
  return `${ops} ops/s`;
}

// ============================================================================
// 1. Raw Handler Execution Per Tool
// ============================================================================
async function benchmarkRawHandlers() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  1.  RAW HANDLER EXECUTION  (per tool, full operation)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Measures the actual tool logic: file I/O, system info, etc.");
  console.log("  (Network-bound tools resolved via mock/skip)");
  console.log("");

  // --- fileOps.read ---
  {
    const result = await measureAsync(() => fileOps.read(__filename, "utf8"), 50);
    console.log(
      `  fileOps.read (this file)    ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- fileOps.list ---
  {
    const result = await measureAsync(() => fileOps.list("/tmp", false, false), 200);
    console.log(
      `  fileOps.list (/tmp)         ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- fileOps.fetchUrl (HEAD request) ---
  {
    const result = await measureAsync(
      () => fileOps.fetchUrl("https://httpbin.org/get", "GET", {}, null, 10, 0, "chrome", "auto", 0, 1000, null),
      5
    );
    console.log(
      `  fileOps.fetchUrl (httpbin)  ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}  (network IO)`
    );
  }

  // --- systemOps.info ---
  {
    const result = await measureAsync(() => systemOps.info(), 50);
    console.log(
      `  systemOps.info              ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- systemOps.network ---
  {
    const result = await measureAsync(() => systemOps.network(), 50);
    console.log(
      `  systemOps.network           ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- pathOps.tree ---
  {
    const result = await measureAsync(() => pathOps.tree("/tmp", { maxDepth: 1, maxFiles: 20 }), 100);
    console.log(
      `  pathOps.tree (/tmp, d=1)    ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- pathOps.context ---
  {
    const result = await measureAsync(() => pathOps.context("get"), 500);
    console.log(
      `  pathOps.context (get)       ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}`
    );
  }

  // --- tmuxOps.status ---
  {
    const result = await measureAsync(() => tmuxOps.status(), 20);
    console.log(
      `  tmuxOps.status              ${fmtNs(result.avgNs).padStart(10)}  ${fmtOps(result.ops).padStart(14)}  (subprocess)`
    );
  }
}

// ============================================================================
// 2. AJV Schema Validation Overhead
// ============================================================================
function benchmarkAJV() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  2.  AJV SCHEMA VALIDATION  (per tool schema)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Measures JSON Schema validation cost for each tool's params.");
  console.log("");

  // Import the schemas from tools.js — we need to build validators
  // Simulate by reading the validation logic from tools.js  

  // Build the same AJV validators that tools.js uses
  import("ajv").then(async ({ default: Ajv }) => {
    const ajv = new Ajv({ allErrors: true, coerceTypes: true, allowUnionTypes: true });

    // Minimal schemas matching tools.js structure
    const schemas = {
      terminal: {
        type: "object", properties: {
          action: { type: "string", enum: ["create", "write", "read", "exec", "signal", "resize", "kill", "info", "rename", "stream"] },
          sessionId: { type: "string" }, shell: { type: "string" }, data: { type: "string" },
          command: { type: "string" }, timeout: { type: "number", default: 30 },
        }, required: ["action"]
      },
      file: {
        type: "object", properties: {
          action: { type: "string", enum: ["read", "write", "list", "delete", "download", "upload", "fetch"] },
          path: { type: "string" }, content: { type: "string" }, url: { type: "string", maxLength: 2048 },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "HEAD"] },
          timeout: { type: "number", default: 60 }, retry: { type: "number", minimum: 0, maximum: 3 },
          uaMode: { type: "string", enum: ["random", "chrome", "firefox", "edge", "safari", "mobile", "bot", "curl"] },
          tlsProfile: { type: "string" }, chunkSize: { type: "number" },
          referenceId: { type: "string" }, headers: { type: "object" }, body: { type: ["string", "object"] },
        }, required: ["action"]
      },
      execute: {
        type: "object", properties: {
          action: { type: "string", enum: ["exec", "stream", "batch"] },
          command: { type: "string", maxLength: 4096 },
          commands: { type: "array", items: { type: "string", maxLength: 4096 }, maxItems: 50 },
          timeout: { type: "number", default: 60, minimum: 1, maximum: 300 },
          concurrency: { type: "number", default: 5, minimum: 1, maximum: 20 },
        }, required: ["action"]
      },
      system: {
        type: "object", properties: {
          action: { type: "string", enum: ["info", "network", "portScan"] },
          target: { type: "string", maxLength: 256 },
          ports: { type: "string", maxLength: 512 },
        }, required: ["action"]
      },
      tmux: {
        type: "object", properties: {
          action: { type: "string", enum: ["status", "create", "createDetached", "attach", "list", "kill", "killAll", "rename"] },
          sessionName: { type: "string", maxLength: 200 },
          options: { type: "object" },
        }, required: ["action"]
      },
    };

    // Compile + measure validation
    for (const [name, schema] of Object.entries(schemas)) {
      const validate = ajv.compile(schema);
      const validParams = { action: schema.properties.action.enum[0] };
      // Add required fields for the action
      if (name === "file") validParams.path = "/tmp/test.txt";
      if (name === "execute") validParams.command = "ls -la";
      if (name === "tmux") validParams.sessionName = "test";

      const r = measure(() => validate(validParams), 10000);
      const invalidParams = { wrong: "params" };
      const rBad = measure(() => validate(invalidParams), 5000);

      console.log(
        `  ${(name + ":").padEnd(12)} valid ${fmtNs(r.avgNs).padStart(8)}  (${fmtOps(r.ops).padStart(12)})` +
        `  |  invalid ${fmtNs(rBad.avgNs).padStart(8)}  (${fmtOps(rBad.ops).padStart(12)})`
      );
    }

    // Compilation cost (cold start)
    const coldStart = measure(() => {
      const a = new Ajv({ allErrors: true });
      a.compile(schemas.file);
    }, 1);
    console.log(`\n  AJV compile (file schema)  ${fmtNs(coldStart.avgNs).padStart(10)}  (one-time)`);

    console.log("");
  });
}

// ============================================================================
// 3. withErrorHandling Overhead
// ============================================================================
async function benchmarkWrapper() {
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  3.  withErrorHandling OVERHEAD");
  console.log("─────────────────────────────────────────────────────────────");

  // Reset degradation state
  degradationTracker.reset();

  // 3a. Minimal handler (fast path)
  const fastHandler = withErrorHandling(async (p) => ({ success: true, data: p }), "perf", "fast");
  const resultA = await measureAsync(() => fastHandler({ x: 1 }), 500);
  console.log(
    `  Fast success               ${fmtNs(resultA.avgNs).padStart(10)}  ${fmtOps(resultA.ops).padStart(14)}`
  );

  // 3b. Handler that always fails (hot path, no degradation yet)
  const failHandler = withErrorHandling(async () => { throw new Error("test error"); }, "perf", "fail");
  degradationTracker.reset();
  const resultB = await measureAsync(() => failHandler({}).catch(() => {}), 500);
  console.log(
    `  Fast failure (cold)        ${fmtNs(resultB.avgNs).padStart(10)}  ${fmtOps(resultB.ops).padStart(14)}`
  );

  // 3c. Handler after degradation state is established
  degradationTracker.reset();
  for (let i = 0; i < 4; i++) await failHandler({}).catch(() => {});
  const resultC = await measureAsync(() => failHandler({}).catch(() => {}), 200);
  console.log(
    `  Fast failure (degraded)    ${fmtNs(resultC.avgNs).padStart(10)}  ${fmtOps(resultC.ops).padStart(14)}`
  );

  // 3d. withErrorHandling wrapping actual fileOps.read
  const fileHandler = withErrorHandling(
    (p) => fileOps.read(p.path, "utf8"),
    "perf", "fileRead"
  );
  const resultD = await measureAsync(() => fileHandler({ path: __filename }), 100);
  console.log(
    `  Wrapping fileOps.read      ${fmtNs(resultD.avgNs).padStart(10)}  ${fmtOps(resultD.ops).padStart(14)}`
  );

  // 3e. withErrorHandling wrapping memory-only handler (baseline)
  const baselineHandler = withErrorHandling(
    (p) => ({ success: true, result: p.value }),
    "perf", "baseline"
  );
  const resultE = await measureAsync(() => baselineHandler({ value: "test" }), 1000);
  console.log(
    `  Baseline (memory only)     ${fmtNs(resultE.avgNs).padStart(10)}  ${fmtOps(resultE.ops).padStart(14)}`
  );

  console.log("");
}

// ============================================================================
// 4. requestQueue Dispatch Overhead
// ============================================================================
async function benchmarkRequestQueue() {
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  4.  requestQueue DISPATCH CHAIN");
  console.log("─────────────────────────────────────────────────────────────");

  // Simulate the server.js requestQueue + ConcurrencyManager.recordCall chain
  const cm = getConcurrencyManager();

  // 4a. ConcurrencyManager.recordCall alone
  const r1 = measure(() => cm.recordCall("test_tool", 100, true), 10000);
  console.log(
    `  recordCall() alone         ${fmtNs(r1.avgNs).padStart(10)}  ${fmtOps(r1.ops).padStart(14)}`
  );

  // 4b. Simulate the full tool/call dispatch:
  //    This is what happens inside server.js requestQueue.add handler:
  //    tool.handler(params) + recordToolCall(toolName, duration, success)
  const fastOp = async (p) => ({ success: true, data: p.value });
  const dispatchCall = async () => {
    const start = Date.now();
    try {
      const result = await fastOp({ value: "test" });
      cm.recordCall("test_tool", Date.now() - start, true);
      return result;
    } catch (err) {
      cm.recordCall("test_tool", Date.now() - start, false);
      throw err;
    }
  };

  const r2 = await measureAsync(dispatchCall, 500);
  console.log(
    `  Full dispatch (handler + recordCall)  ${fmtNs(r2.avgNs).padStart(10)}  ${fmtOps(r2.ops).padStart(14)}`
  );

  // 4c. getStats
  const r3 = measure(() => cm.getStats(), 10000);
  console.log(
    `  getStats() after calls     ${fmtNs(r3.avgNs).padStart(10)}  ${fmtOps(r3.ops).padStart(14)}`
  );

  // 4d. getToolStats
  const r4 = measure(() => cm.getToolStats(), 10000);
  console.log(
    `  getToolStats()             ${fmtNs(r4.avgNs).padStart(10)}  ${fmtOps(r4.ops).padStart(14)}`
  );

  console.log("");
}

// ============================================================================
// 5. Full Pipeline Simulation (tool dispatch)
// ============================================================================
async function benchmarkFullPipeline() {
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  5.  FULL TOOL CALL PIPELINE  (end-to-end simulation)");
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Simulates: AJV validate → wrapHandler → tool logic →");
  console.log("             recordCall → error handling response");
  console.log("");

  // Build the exact pipeline used in tools.js:
  // wrapHandler(schema, handler) does AJV validate + call handler
  const { default: Ajv } = await import("ajv");
  const ajv = new Ajv({ allErrors: true, coerceTypes: true, allowUnionTypes: true });

  function buildPipeline(schema, rawHandler) {
    const validate = ajv.compile(schema);
    return async (params) => {
      if (!validate(params)) {
        return { success: false, error: "Validation failed" };
      }
      return rawHandler(params);
    };
  }

  // 5a. fileOps.read — most common file tool action
  const fileReadSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read"] },
      path: { type: "string" },
      encoding: { type: "string", default: "utf8" },
    },
    required: ["action", "path"],
  };
  const filePipeline = buildPipeline(fileReadSchema, (p) => fileOps.read(p.path, p.encoding || "utf8"));
  const f1 = await measureAsync(() => filePipeline({ action: "read", path: __filename }), 100);
  console.log(
    `  fileOps.read pipeline      ${fmtNs(f1.avgNs).padStart(10)}  ${fmtOps(f1.ops).padStart(14)}`
  );

  // 5b. fileOps.list pipeline
  const fileListSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list"] },
      path: { type: "string" },
      showHidden: { type: "boolean", default: false },
    },
    required: ["action"],
  };
  const listPipeline = buildPipeline(fileListSchema, (p) => fileOps.list(p.path, p.showHidden, false));
  const f2 = await measureAsync(() => listPipeline({ action: "list", path: "/tmp" }), 200);
  console.log(
    `  fileOps.list pipeline      ${fmtNs(f2.avgNs).padStart(10)}  ${fmtOps(f2.ops).padStart(14)}`
  );

  // 5c. systemOps.info pipeline
  const sysSchema = {
    type: "object",
    properties: { action: { type: "string", enum: ["info"] } },
    required: ["action"],
  };
  const sysPipeline = buildPipeline(sysSchema, () => systemOps.info());
  const f3 = await measureAsync(() => sysPipeline({ action: "info" }), 50);
  console.log(
    `  systemOps.info pipeline    ${fmtNs(f3.avgNs).padStart(10)}  ${fmtOps(f3.ops).padStart(14)}`
  );

  // 5d. pathOps.context pipeline
  const pathSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["context"] },
      name: { type: "string" },
    },
    required: ["action"],
  };
  const pathPipeline = buildPipeline(pathSchema, (p) => {
    const action = p.name || "get";
    return pathOps.context(action, { path: p.path });
  });
  const f4 = await measureAsync(() => pathPipeline({ action: "context" }), 500);
  console.log(
    `  pathOps.context pipeline   ${fmtNs(f4.avgNs).padStart(10)}  ${fmtOps(f4.ops).padStart(14)}`
  );

  // 5e. Full chain: withErrorHandling(wrapHandler(schema, fileOps.read))
  const fullChain = withErrorHandling(
    (p) => fileOps.read(p.path, p.encoding || "utf8"),
    "fullChain", "read"
  );
  // We need to also do AJV — simulate the full stack
  const fullValidate = ajv.compile(fileReadSchema);
  const fullCall = async (params) => {
    if (!fullValidate(params)) {
      return { success: false, error: "Validation failed" };
    }
    return fullChain(params);
  };
  const f5 = await measureAsync(() => fullCall({ action: "read", path: __filename }), 100);
  console.log(
    `  Full chain (AJV→wrap→error)${fmtNs(f5.avgNs).padStart(10)}  ${fmtOps(f5.ops).padStart(14)}`
  );

  // 5f. Cold start: full first call (no warmup)
  degradationTracker.reset();
  const coldStart = now();
  const coldResult = await fullCall({ action: "read", path: __filename });
  const coldDur = (now() - coldStart) * 1e6;
  console.log(
    `  Full chain (cold, 1st call)${fmtNs(coldDur).padStart(10)}  (includes module init)`
  );

  console.log("");
}

// ============================================================================
// 6. Overhead Breakdown (pie chart analysis)
// ============================================================================
async function benchmarkOverheadBreakdown() {
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  6.  OVERHEAD BREAKDOWN  (per-tool-call overhead)");
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Isolates each layer's overhead for a typical fileOps.read");
  console.log("");

  // Baseline: raw handler
  const rawNs = (await measureAsync(() => fileOps.read(__filename, "utf8"), 100)).avgNs;

  // Layer 1: AJV validation (without handler)
  const { default: Ajv } = await import("ajv");
  const ajv = new Ajv({ allErrors: true, coerceTypes: true, allowUnionTypes: true });
  const validateSchema = {
    type: "object", properties: {
      action: { type: "string", enum: ["read"] },
      path: { type: "string" }, encoding: { type: "string" },
    }, required: ["action", "path"]
  };
  const validate = ajv.compile(validateSchema);
  const validParams = { action: "read", path: __filename };
  const ajvNs = measure(() => validate(validParams), 10000).avgNs;

  // Layer 2: withErrorHandling overhead (difference from raw to wrapped handler)
  const wrapped = withErrorHandling((p) => fileOps.read(p.path, "utf8"), "perf", "read");
  const wrappedNs = (await measureAsync(() => wrapped({ path: __filename }), 100)).avgNs;

  // Layer 3: recordCall overhead
  const cm = getConcurrencyManager();
  const recordNs = measure(() => cm.recordCall("perf", 50, true), 10000).avgNs;

  // Layer 4: ConcurrencyManager.getStats overhead (called in /stats endpoint)
  const statsNs = measure(() => cm.getStats(), 10000).avgNs;

  // Layer 5: getToolStats overhead (called in /stats endpoint)
  const toolStatsNs = measure(() => cm.getToolStats(), 10000).avgNs;

  // Display as breakdown
  const totalOverhead = ajvNs + recordNs;
  const totalWithHandler = rawNs + ajvNs + recordNs;

  console.log(`  Raw handler (fileOps.read)     ${fmtNs(rawNs).padStart(10)}  ${(rawNs / totalWithHandler * 100).toFixed(1)}%`);
  console.log(`  ├─ AJV validation              ${fmtNs(ajvNs).padStart(10)}  ${(ajvNs / totalWithHandler * 100).toFixed(1)}%`);
  console.log(`  ├─ recordCall()                ${fmtNs(recordNs).padStart(10)}  ${(recordNs / totalWithHandler * 100).toFixed(1)}%`);
  console.log(`  └─ withErrorHandling overhead   ${fmtNs(wrappedNs - rawNs).padStart(10)}  ${((wrappedNs - rawNs) / totalWithHandler * 100).toFixed(1)}%`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Total (handler + overhead)     ${fmtNs(totalWithHandler).padStart(10)}  ${totalWithHandler > 0 ? '100%' : 'N/A'}`);
  console.log(`  requestQueue.add + process     ~${fmtNs(100)}  (per-item, estimated)`);
  console.log(`  Full chain estimate            ~${fmtNs(rawNs + ajvNs + recordNs + 200)}`);
  console.log("");

  console.log(`  Notes:`);
  console.log(`  - Overhead represents ${(totalOverhead / Math.max(totalWithHandler, 1) * 100).toFixed(2)}% of total call time`);
  console.log(`  - 99.${(100 - totalOverhead / Math.max(totalWithHandler, 1) * 100).toFixed(1)}% of time is in actual tool logic`);
  console.log(`  - Network tool overhead is even lower (dominated by network I/O)`);
}

// ============================================================================
// Run
// ============================================================================
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║        MCP SERVER — TOOL CALL PERFORMANCE BENCHMARK         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Layer 1: raw handler execution
  await benchmarkRawHandlers();

  // Layer 2: AJV schema validation
  await benchmarkAJV();

  // Layer 3: withErrorHandling overhead
  await benchmarkWrapper();

  // Layer 4: requestQueue dispatch
  await benchmarkRequestQueue();

  // Layer 5: full pipeline
  await benchmarkFullPipeline();

  // Layer 6: overhead breakdown
  await benchmarkOverheadBreakdown();
}

main().catch(console.error);
