/**
 * Traffic Core - 最小侵入式流量伪装引擎
 * 仅替换 ops-file.js 中的 UA 生成和 curl 调用，不动框架其他逻辑
 */

import { spawn } from "child_process";
import { writeFile, unlink, access, stat } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// curl-impersonate 检测与配置
// ============================================================================

const CURL_IMPERSONATE_MAP = {
  chrome99: "curl_chrome99",
  chrome100: "curl_chrome100",
  chrome101: "curl_chrome101",
  chrome104: "curl_chrome104",
  chrome107: "curl_chrome107",
  chrome110: "curl_chrome110",
  chrome116: "curl_chrome116",
  chrome120: "curl_chrome120",
  chrome131: "curl_chrome131",
  edge99: "curl_edge99",
  edge101: "curl_edge101",
  firefox91esr: "curl_ff91esr",
  firefox95: "curl_ff95",
  firefox98: "curl_ff98",
  firefox100: "curl_ff100",
  firefox102: "curl_ff102",
  firefox109: "curl_ff109",
  firefox117: "curl_ff117",
  firefox133: "curl_ff133",
  safari15_3: "curl_safari15_3",
  safari15_5: "curl_safari15_5",
  safari17: "curl_safari17_0",
};

// ====== P2 修复：二进制路径缓存（避免重复 fs.access）======
const BINARY_CACHE = new Map();

async function detectCurlImpersonate(profile) {
  // 先查缓存
  const cached = BINARY_CACHE.get(profile);
  if (cached !== undefined) return cached;

  const binaryName = CURL_IMPERSONATE_MAP[profile];
  if (!binaryName) {
    BINARY_CACHE.set(profile, null);
    return null;
  }

  const projectCurlDir = join(__dirname, "curl-impersonate");

  const paths = [
    join(projectCurlDir, binaryName),
    join(projectCurlDir, "curl-impersonate-chrome"),
    join(projectCurlDir, "curl-impersonate-ff"),
    `/usr/local/bin/${binaryName}`,
    `/usr/bin/${binaryName}`,
    `${process.env.HOME}/.local/bin/${binaryName}`,
    binaryName,
  ];

  for (const p of paths) {
    try {
      await access(p);
      BINARY_CACHE.set(profile, p);
      return p;
    } catch {
      continue;
    }
  }
  BINARY_CACHE.set(profile, null);
  return null;
}

// ============================================================================
// 1. 动态 UA 生成引擎（替代静态 UA_POOL）
// ============================================================================

const UA_TEMPLATES = {
  chrome: {
    template:
      "Mozilla/5.0 ({os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36",
    os: [
      "Windows NT 10.0; Win64; x64",
      "Windows NT 10.0; Win64; x64; ARM64",
      "Macintosh; Intel Mac OS X 10_15_7",
      "Macintosh; Apple Mac OS X 10_15_7",
      "X11; Linux x86_64",
      "X11; CrOS x86_64 14541.0.0",
    ],
    versionRange: { min: 120, max: 133 },
    buildPattern: (major) =>
      `${major}.0.${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 100)}`,
  },
  firefox: {
    template:
      "Mozilla/5.0 ({os}; rv:{version}) Gecko/20100101 Firefox/{version}",
    os: [
      "Windows NT 10.0; Win64; x64",
      "Macintosh; Intel Mac OS X 10.15",
      "X11; Linux x86_64",
    ],
    versionRange: { min: 120, max: 133 },
    buildPattern: (major) => `${major}.${Math.floor(Math.random() * 10)}`,
  },
  edge: {
    template:
      "Mozilla/5.0 ({os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVer} Safari/537.36 Edg/{edgeVer}",
    os: [
      "Windows NT 10.0; Win64; x64",
      "Macintosh; Intel Mac OS X 10_15_7",
      "X11; Linux x86_64",
    ],
    versionRange: { min: 120, max: 133 },
    buildPattern: (major) => {
      const chrome = `${major}.0.${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 100)}`;
      const edge = `${major}.0.${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 100)}`;
      return { chromeVer: chrome, edgeVer: edge };
    },
  },
  safari: {
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15",
    os: ["Macintosh; Intel Mac OS X 10_15_7"],
    versionRange: { min: 16, max: 17 },
    buildPattern: (major) => `${major}.${Math.floor(Math.random() * 10)}`,
  },
};

function generateUA(profile = "chrome") {
  const config = UA_TEMPLATES[profile];
  if (!config) return generateUA("chrome");

  const os = config.os[Math.floor(Math.random() * config.os.length)];
  const major =
    Math.floor(
      Math.random() * (config.versionRange.max - config.versionRange.min + 1),
    ) + config.versionRange.min;

  const versionData = config.buildPattern(major);

  if (typeof versionData === "object") {
    return config.template
      .replace("{os}", os)
      .replace("{chromeVer}", versionData.chromeVer)
      .replace("{edgeVer}", versionData.edgeVer);
  }

  return config.template.replace("{os}", os).replace(/{version}/g, versionData);
}

// ============================================================================
// 2. 浏览器级 Header 生成
// ============================================================================

function getBrowserHeaders(profile) {
  const acceptLanguage = [
    "zh-CN,zh;q=0.9,en;q=0.8",
    "en-US,en;q=0.9,zh-CN;q=0.8",
    "ja-JP,ja;q=0.9,en;q=0.8",
    "ko-KR,ko;q=0.9,en;q=0.8",
    "de-DE,de;q=0.9,en;q=0.8",
  ];

  const secChUa = {
    chrome: `"Not_A Brand";v="8", "Chromium";v="${Math.floor(Math.random() * 20 + 110)}", "Google Chrome";v="${Math.floor(Math.random() * 20 + 110)}"`,
    edge: `"Not_A Brand";v="8", "Chromium";v="${Math.floor(Math.random() * 20 + 110)}", "Microsoft Edge";v="${Math.floor(Math.random() * 20 + 110)}"`,
    firefox: null,
    safari: null,
  };

  const platform = {
    chrome: ['"Windows"', '"macOS"', '"Linux"'],
    edge: ['"Windows"', '"macOS"', '"Linux"'],
    firefox: ['"Windows"', '"macOS"', '"Linux"'],
    safari: ['"macOS"'],
  };

  const headers = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language":
      acceptLanguage[Math.floor(Math.random() * acceptLanguage.length)],
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Connection: "keep-alive",
  };

  if (secChUa[profile]) {
    headers["Sec-Ch-Ua"] = secChUa[profile];
    headers["Sec-Ch-Ua-Mobile"] = "?0";
    headers["Sec-Ch-Ua-Platform"] =
      platform[profile][Math.floor(Math.random() * platform[profile].length)];
  }

  return headers;
}

function mergeHeaders(browserHeaders, userHeaders) {
  const result = { ...browserHeaders };

  if (userHeaders) {
    for (const [key, value] of Object.entries(userHeaders)) {
      const lowerKey = key.toLowerCase();
      const existingKey = Object.keys(result).find(
        (k) => k.toLowerCase() === lowerKey,
      );

      if (existingKey) {
        result[existingKey] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

// ====== ConfigPool：配置文件池（避免每次创建/删除）======
class ConfigPool {
  #pool = new Map(); // hash → { config, file, lastUsed }

  get(hash, content) {
    const entry = this.#pool.get(hash);
    if (entry && entry.config === content) {
      entry.lastUsed = Date.now();
      return entry.file;
    }
    return null;
  }

  async put(hash, content) {
    const suffix = Array.from(
      { length: 8 },
      () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
    ).join("");
    const file = join(tmpdir(), `.mcp_cfg_${suffix}`);
    await writeFile(file, content, { mode: 0o600 });
    this.#pool.set(hash, { config: content, file, lastUsed: Date.now() });
    return file;
  }

  async cleanup(maxAge = 120000) {
    const now = Date.now();
    for (const [hash, entry] of this.#pool) {
      if (now - entry.lastUsed > maxAge) {
        await unlink(entry.file).catch(() => {});
        this.#pool.delete(hash);
      }
    }
  }
}

const configPool = new ConfigPool();

// ====== TLS Session 缓存目录======
const TLS_CACHE_DIR = join(tmpdir(), ".mcp_tls_sessions");
try {
  if (!existsSyncSync(TLS_CACHE_DIR))
    mkdirSync(TLS_CACHE_DIR, { recursive: true });
} catch {
  /* 忽略错误 */
}

// ============================================================================
// 3. 参数隐藏：使用 --config 文件（修复 JSON 转义问题）
// ============================================================================

/**
 * 构建 curl config 内容，返回 { configContent, tempDataFile }
 * - 若有 requestBody，写入临时文件并通过 --data-binary @file 传递（解决转义问题）
 * - 若有 tlsProfile，附加 --tls-session-file 支持 TLS 复用
 */
async function buildCurlConfig(
  url,
  method,
  headers,
  requestBody,
  timeout,
  uaProfile,
  useImpersonate,
  tlsProfile,
) {
  const configLines = [];
  let tempDataFile = null;

  configLines.push("silent");
  configLines.push("include");
  configLines.push(`connect-timeout = ${Math.min(timeout || 10, 30)}`);
  configLines.push(`max-time = ${Math.min(timeout || 60, 300)}`);
  configLines.push("location");
  // P5 修复：TCP keepalive
  configLines.push("tcp-nodelay");
  configLines.push("keepalive-time 30");
  configLines.push("keepalive-interval 10");

  if (method && method !== "GET") {
    configLines.push(`request = "${method}"`);
  }

  if (!useImpersonate) {
    const ua = generateUA(uaProfile || "chrome");
    configLines.push(`user-agent = "${ua}"`);
  }

  let mergedHeaders;
  if (useImpersonate) {
    mergedHeaders = headers || {};
  } else {
    const browserHeaders = getBrowserHeaders(uaProfile || "chrome");
    mergedHeaders = mergeHeaders(browserHeaders, headers);
  }

  for (const [key, value] of Object.entries(mergedHeaders)) {
    configLines.push(`header = "${key}: ${value}"`);
  }

  // ====== P1 修复：requestBody 写入临时文件，使用 --data-binary ======
  if (requestBody) {
    const body =
      typeof requestBody === "string"
        ? requestBody
        : JSON.stringify(requestBody);
    const randomSuffix = Array.from(
      { length: 12 },
      () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
    ).join("");
    tempDataFile = join(tmpdir(), `.mcp_body_${randomSuffix}`);
    await writeFile(tempDataFile, body, { mode: 0o600 });
    configLines.push(`data-binary = "@${tempDataFile}"`);
    configLines.push("ignore-content-length");
  }

  // ====== P4 修复：TLS Session 文件复用 ======
  if (tlsProfile && tlsProfile !== "auto") {
    const hostname = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "unknown";
      }
    })();
    const safeName = hostname.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
    const sessionFile = join(TLS_CACHE_DIR, `${safeName}.session`);
    configLines.push(`tls-session-file = "${sessionFile}"`);
  }

  configLines.push(`url = "${url}"`);

  return { configContent: configLines.join("\n"), tempDataFile };
}

// ============================================================================
// 4. 安全 curl 执行（参数隐藏 + 自动清理 + 配置池 + TLS 缓存）
// ============================================================================

export async function spawnCurlSecure(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    requestBody = null,
    timeout = 60,
    uaProfile = "chrome",
    tlsProfile = "auto",
  } = options;

  let curlBinary = "curl";
  let useImpersonate = false;

  if (tlsProfile && tlsProfile !== "auto") {
    const impersonatePath = await detectCurlImpersonate(tlsProfile);
    if (impersonatePath) {
      curlBinary = impersonatePath;
      useImpersonate = true;
    }
  }

  // ====== P3 修复：使用配置池 ======
  const { configContent, tempDataFile } = await buildCurlConfig(
    url,
    method,
    headers,
    requestBody,
    timeout,
    uaProfile,
    useImpersonate,
    tlsProfile,
  );

  // 生成 config hash
  const configHash = `${url}|${method}|${JSON.stringify(headers)}|${tlsProfile}`;
  let configFile = configPool.get(configHash, configContent);
  if (!configFile) {
    configFile = await configPool.put(configHash, configContent);
  }

  let result;
  try {
    const child = spawn(curlBinary, ["--config", configFile], {
      timeout: (timeout || 60) * 1000,
    });

    result = await collectCurlOutput(child, (timeout || 60) * 1000);
  } finally {
    // ====== P3 修复：configFile 不再立即删除，由池管理 ======
    // ====== P1 修复：清理临时 body 文件 ======
    if (tempDataFile) {
      await unlink(tempDataFile).catch(() => {});
    }
    // 定期清理配置池（每 100 次调用清理一次）
    if (Math.random() < 0.01) {
      configPool.cleanup(120000).catch(() => {});
    }
  }

  return result;
}

function collectCurlOutput(child, timeoutMs) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const doResolve = () => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        code: child.exitCode || 0,
      });
    };

    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        doResolve();
      }, 2000);
    }, timeoutMs);

    child.stdout.on("data", (data) => stdoutChunks.push(data));
    child.stderr.on("data", (data) => stderrChunks.push(data));
    child.on("error", () => {
      clearTimeout(timer);
      doResolve();
    });
    child.on("close", () => {
      clearTimeout(timer);
      doResolve();
    });
  });
}

// ============================================================================
// 5. 兼容层：保持原有 pickUserAgent 接口
// ============================================================================

export function pickUserAgent(mode) {
  switch (mode) {
    case "chrome":
      return generateUA("chrome");
    case "firefox":
      return generateUA("firefox");
    case "edge":
      return generateUA("edge");
    case "safari":
      return generateUA("safari");
    case "mobile":
      return generateUA("chrome"); // 回退到chrome，可扩展
    case "bot":
      return "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    case "random":
      return generateUA(
        ["chrome", "firefox", "edge", "safari"][Math.floor(Math.random() * 4)],
      );
    case "curl":
      return `curl/${Math.floor(Math.random() * 5 + 7)}.${Math.floor(Math.random() * 10)}`;
    default:
      return generateUA("chrome");
  }
}

// ============================================================================
// 6. 原有 spawnCurl 的兼容包装（保持接口不变）
// ============================================================================

export async function spawnCurlCompat(args, timeout) {
  // 防御性检查：确保 args 是数组
  if (!Array.isArray(args)) {
    return spawnCurlLegacy([], timeout);
  }

  // 解析原有 args 格式，提取关键参数
  let url = "";
  let method = "GET";
  let headers = {};
  let requestBody = null;
  let uaProfile = "chrome";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // 防御性检查：跳过非字符串元素
    if (typeof arg !== "string") continue;

    if (arg === "-X" && i + 1 < args.length) {
      const nextArg = args[++i];
      if (typeof nextArg === "string") method = nextArg;
    } else if (arg === "-H" && i + 1 < args.length) {
      const headerLine = args[++i];
      if (typeof headerLine === "string") {
        const colonIdx = headerLine.indexOf(":");
        if (colonIdx > 0) {
          headers[headerLine.substring(0, colonIdx).trim()] = headerLine
            .substring(colonIdx + 1)
            .trim();
        }
      }
    } else if (arg === "-A" && i + 1 < args.length) {
      const nextArg = args[++i];
      if (typeof nextArg === "string") headers["User-Agent"] = nextArg;
    } else if (arg === "-d" && i + 1 < args.length) {
      const nextArg = args[++i];
      if (typeof nextArg === "string") requestBody = nextArg;
    } else if (
      !arg.startsWith("-") &&
      (arg.startsWith("http://") || arg.startsWith("https://"))
    ) {
      url = arg;
    }
  }

  // 如果 args 中没有 URL，说明是旧格式调用，直接回退
  if (!url) {
    return spawnCurlLegacy(args, timeout);
  }

  return spawnCurlSecure(url, {
    method,
    headers,
    requestBody,
    timeout: (timeout || 60000) / 1000,
    uaProfile,
  });
}

// ============================================================================
// 7. TLS Profile 检测状态查询（供外部调用）
// ============================================================================

export async function getTlsProfileStatus() {
  const results = {};
  for (const profile of Object.keys(CURL_IMPERSONATE_MAP)) {
    const path = await detectCurlImpersonate(profile);
    results[profile] = {
      available: !!path,
      path: path || null,
    };
  }
  return results;
}

// 保留原有 spawnCurl 实现作为后备
function spawnCurlLegacy(args, timeout) {
  return new Promise((resolve) => {
    const child = spawn("curl", args, { timeout });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (data) => stdoutChunks.push(data));
    child.stderr.on("data", (data) => stderrChunks.push(data));
    child.on("error", () =>
      resolve({ stdout: "", stderr: "spawn error", code: -1 }),
    );
    child.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        code,
      }),
    );

    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }
    }, timeout);
  });
}
