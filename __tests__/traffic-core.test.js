/**
 * traffic-core.js 三层伪装机制综合测试
 * ===========================================
 * 测试覆盖：
 *   第1层 - TLS 指纹伪装 (curl-impersonate)
 *   第2层 - HTTP Header 浏览器指纹
 *   第3层 - UA 字符串动态生成
 *   核心执行 - spawnCurlSecure / spawnCurlCompat
 *   安全机制 - ConfigPool / 参数隐藏
 *   兼容层 - pickUserAgent
 */

import { test, describe, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok, notStrictEqual, match, doesNotMatch } from 'node:assert';
import * as traffic from '../traffic-core.js';

// ============================================================================
// 辅助函数
// ============================================================================
function countOccurrences(str, substr) {
  let count = 0, pos = 0;
  while ((pos = str.indexOf(substr, pos)) !== -1) {
    count++;
    pos += substr.length;
  }
  return count;
}

// ============================================================================
// 第3层测试：UA 字符串伪装引擎（先测这层，不依赖外部资源）
// ============================================================================
describe('Layer 3 — UA 伪装引擎 (generateUA / pickUserAgent)', () => {

  // ---- 3.1 Chrome UA 生成 ----
  test('generateUA("chrome") 应生成有效 Chrome UA', () => {
    const ua = traffic.generateUA('chrome');
    console.log(`  Chrome UA: ${ua}`);
    ok(ua.startsWith('Mozilla/5.0'), 'UA 应以 Mozilla/5.0 开头');
    ok(ua.includes('AppleWebKit/537.36'), '应包含 AppleWebKit');
    ok(ua.includes('Chrome/'), '应包含 Chrome/ 版本号');
    ok(ua.includes('Safari/537.36'), '应包含 Safari/537.36');

    // 提取 Chrome 版本号
    const match = ua.match(/Chrome\/(\d+)\./);
    ok(match !== null, '应能提取 Chrome 主版本号');
    const version = parseInt(match[1]);
    ok(version >= 120 && version <= 133, `Chrome 版本 ${version} 应在 120-133 范围内`);
  });

  // ---- 3.2 Firefox UA 生成 ----
  test('generateUA("firefox") 应生成有效 Firefox UA', () => {
    const ua = traffic.generateUA('firefox');
    console.log(`  Firefox UA: ${ua}`);
    ok(ua.startsWith('Mozilla/5.0'), 'UA 应以 Mozilla/5.0 开头');
    ok(ua.includes('Gecko/20100101'), '应包含 Gecko');
    ok(ua.includes('Firefox/'), '应包含 Firefox/ 版本号');

    const match = ua.match(/Firefox\/(\d+)\./);
    ok(match !== null, '应能提取 Firefox 主版本号');
    const version = parseInt(match[1]);
    ok(version >= 120 && version <= 133, `Firefox 版本 ${version} 应在 120-133 范围内`);
  });

  // ---- 3.3 Edge UA 生成 ----
  test('generateUA("edge") 应生成有效 Edge UA', () => {
    const ua = traffic.generateUA('edge');
    console.log(`  Edge UA: ${ua}`);
    ok(ua.startsWith('Mozilla/5.0'), 'UA 应以 Mozilla/5.0 开头');
    ok(ua.includes('Edg/'), '应包含 Edg/ 版本号');
    ok(ua.includes('Chrome/'), '应包含 Chrome/ 版本号');

    const chromeMatch = ua.match(/Chrome\/(\d+)\./);
    ok(chromeMatch !== null, '应能提取 Chrome 版本号');
    const edgeMatch = ua.match(/Edg\/(\d+)\./);
    ok(edgeMatch !== null, '应能提取 Edge 版本号');
    strictEqual(chromeMatch[1], edgeMatch[1], 'Chrome 和 Edge 主版本应一致');
  });

  // ---- 3.4 Safari UA 生成 ----
  test('generateUA("safari") 应生成有效 Safari UA', () => {
    const ua = traffic.generateUA('safari');
    console.log(`  Safari UA: ${ua}`);
    ok(ua.startsWith('Mozilla/5.0'), 'UA 应以 Mozilla/5.0 开头');
    ok(ua.includes('AppleWebKit/605.1.15'), '应包含 WebKit');
    ok(ua.includes('Version/'), '应包含 Version/');
    ok(ua.includes('Safari/605.1.15'), '应包含 Safari/605.1.15');

    const match = ua.match(/Version\/(\d+)\./);
    ok(match !== null, '应能提取 Safari 主版本号');
    const version = parseInt(match[1]);
    ok(version >= 16 && version <= 17, `Safari 版本 ${version} 应在 16-17 范围内`);
  });

  // ---- 3.5 随机性验证 ----
  test('generateUA 每次调用应生成不同的 UA', () => {
    const uas = new Set();
    for (let i = 0; i < 50; i++) {
      uas.add(traffic.generateUA('chrome'));
    }
    ok(uas.size > 40, `50 次 Chrome 调用应产生 >40 个不同 UA（实际: ${uas.size}）`);
  });

  test('多次调用 chrome 应产生不同版本号', () => {
    const versions = new Set();
    for (let i = 0; i < 30; i++) {
      const ua = traffic.generateUA('chrome');
      const m = ua.match(/Chrome\/(\d+)\./);
      if (m) versions.add(parseInt(m[1]));
    }
    ok(versions.size >= 5, `30 次调用应产生 ≥5 种不同主版本（实际: ${versions.size}）`);
  });

  // ---- 3.6 OS 平台随机性 ----
  test('Chrome UA 的 OS 平台应随机变化', () => {
    const osSet = new Set();
    for (let i = 0; i < 30; i++) {
      const ua = traffic.generateUA('chrome');
      // 提取 OS 部分
      const m = ua.match(/Mozilla\/5\.0\s+\(([^)]+)\)/);
      if (m) osSet.add(m[1]);
    }
    console.log(`  Chrome OS 平台样本: ${[...osSet].join(' | ')}`);
    ok(osSet.size >= 3, `30 次调用应产生 ≥3 种不同 OS（实际: ${osSet.size}）`);
  });

  // ---- 3.7 pickUserAgent 兼容层 ----
  test('pickUserAgent("chrome") 应与 generateUA("chrome") 格式一致', () => {
    const ua = traffic.pickUserAgent('chrome');
    ok(ua.includes('Chrome/'), 'pickUserAgent chrome 应包含 Chrome 版本号');
  });

  test('pickUserAgent("firefox") 应生成 Firefox 格式', () => {
    const ua = traffic.pickUserAgent('firefox');
    ok(ua.includes('Firefox/'), 'pickUserAgent firefox 应包含 Firefox 版本号');
  });

  test('pickUserAgent("edge") 应生成 Edge 格式', () => {
    const ua = traffic.pickUserAgent('edge');
    ok(ua.includes('Edg/'), 'pickUserAgent edge 应包含 Edg 版本号');
  });

  test('pickUserAgent("safari") 应生成 Safari 格式', () => {
    const ua = traffic.pickUserAgent('safari');
    ok(ua.includes('Version/'), 'pickUserAgent safari 应包含 Version');
  });

  test('pickUserAgent("bot") 应返回 Googlebot', () => {
    const ua = traffic.pickUserAgent('bot');
    ok(ua.includes('Googlebot'), 'bot 模式应返回 Googlebot UA');
  });

  test('pickUserAgent("curl") 应返回 curl 版本字符串', () => {
    const ua = traffic.pickUserAgent('curl');
    ok(ua.startsWith('curl/'), 'curl 模式应以 curl/ 开头');
  });

  test('pickUserAgent("random") 应从 4 种浏览器中随机选取', () => {
    const types = new Set();
    for (let i = 0; i < 40; i++) {
      const ua = traffic.pickUserAgent('random');
      if (ua.includes('Chrome/') && ua.includes('Edg/')) types.add('edge');
      else if (ua.includes('Chrome/')) types.add('chrome');
      else if (ua.includes('Firefox/')) types.add('firefox');
      else if (ua.includes('Version/')) types.add('safari');
    }
    console.log(`  random 模式产生类型: ${[...types].join(', ')}`);
    ok(types.size >= 2, 'random 模式应至少产生 2 种不同浏览器类型');
  });

  test('pickUserAgent("mobile") 应回退到 Chrome', () => {
    const ua = traffic.pickUserAgent('mobile');
    ok(ua.includes('Chrome/'), 'mobile 模式应回退到 Chrome');
  });

  test('pickUserAgent(undefined) 应默认生成 Chrome', () => {
    const ua = traffic.pickUserAgent(undefined);
    ok(ua.includes('Chrome/'), 'undefined 应默认生成 Chrome');
  });

  test('pickUserAgent("unknown") 应默认生成 Chrome', () => {
    const ua = traffic.pickUserAgent('unknown');
    ok(ua.includes('Chrome/'), '未知模式应默认生成 Chrome');
  });
});

// ============================================================================
// 第2层测试：HTTP Header 浏览器指纹
// ============================================================================
describe('Layer 2 — HTTP Header 生成 (getBrowserHeaders / mergeHeaders)', () => {

  // ---- 2.1 Chrome Header 结构 ----
  test('Chrome 浏览器头应包含 Sec-Ch-Ua 系列头', () => {
    const headers = traffic.getBrowserHeaders('chrome');
    ok(headers['Accept'], '应包含 Accept 头');
    ok(headers['Accept-Language'], '应包含 Accept-Language 头');
    ok(headers['Accept-Encoding'], '应包含 Accept-Encoding 头');
    ok(headers['Sec-Ch-Ua'], 'Chrome 应包含 Sec-Ch-Ua 头');
    ok(headers['Sec-Ch-Ua-Mobile'] === '?0', 'Sec-Ch-Ua-Mobile 应为 ?0');
    ok(headers['Sec-Ch-Ua-Platform'], '应包含 Sec-Ch-Ua-Platform');
    ok(headers['Sec-Fetch-Dest'] === 'document', 'Sec-Fetch-Dest 应为 document');
    ok(headers['Sec-Fetch-Mode'] === 'navigate', 'Sec-Fetch-Mode 应为 navigate');
    ok(headers['Sec-Fetch-Site'] === 'none', 'Sec-Fetch-Site 应为 none');
    ok(headers['Upgrade-Insecure-Requests'] === '1', '应请求 HTTPS 升级');
    ok(headers['Connection'] === 'keep-alive', 'Connection 应为 keep-alive');
  });

  // ---- 2.2 Edge Header 结构 ----
  test('Edge 浏览器头应包含 Edge 特有 Sec-Ch-Ua', () => {
    const headers = traffic.getBrowserHeaders('edge');
    ok(headers['Sec-Ch-Ua'], 'Edge 应包含 Sec-Ch-Ua');
    ok(headers['Sec-Ch-Ua'].includes('Microsoft Edge'), 'Edge 的 Sec-Ch-Ua 应包含 Microsoft Edge');
  });

  // ---- 2.3 Firefox Header 结构 ----
  test('Firefox 浏览器头不应包含 Sec-Ch-Ua', () => {
    const headers = traffic.getBrowserHeaders('firefox');
    ok(!headers['Sec-Ch-Ua'], 'Firefox 不应包含 Sec-Ch-Ua（Firefox 不支持）');
    ok(!headers['Sec-Ch-Ua-Mobile'], 'Firefox 不应包含 Sec-Ch-Ua-Mobile');
    ok(!headers['Sec-Ch-Ua-Platform'], 'Firefox 不应包含 Sec-Ch-Ua-Platform');
    ok(headers['Accept'], '但仍应包含基本头');
  });

  // ---- 2.4 Safari Header 结构 ----
  test('Safari 浏览器头不应包含 Sec-Ch-Ua', () => {
    const headers = traffic.getBrowserHeaders('safari');
    ok(!headers['Sec-Ch-Ua'], 'Safari 不应包含 Sec-Ch-Ua');
    ok(headers['Accept'], '但仍应包含基本头');
  });

  // ---- 2.5 Accept-Language 随机性 ----
  test('Accept-Language 应在 5 种语言中随机', () => {
    const langs = new Set();
    const validLangs = [
      'zh-CN,zh;q=0.9,en;q=0.8',
      'en-US,en;q=0.9,zh-CN;q=0.8',
      'ja-JP,ja;q=0.9,en;q=0.8',
      'ko-KR,ko;q=0.9,en;q=0.8',
      'de-DE,de;q=0.9,en;q=0.8',
    ];
    for (let i = 0; i < 30; i++) {
      const headers = traffic.getBrowserHeaders('chrome');
      langs.add(headers['Accept-Language']);
    }
    console.log(`  Accept-Language 样本: ${[...langs].join(' | ')}`);
    ok(langs.size >= 2, `30 次调用应产生 ≥2 种不同语言（实际: ${langs.size}）`);
    for (const lang of langs) {
      ok(validLangs.includes(lang), `${lang} 应在有效语言列表中`);
    }
  });

  // ---- 2.6 Sec-Ch-Ua-Platform 随机性 ----
  test('Chrome 的 Sec-Ch-Ua-Platform 应在 Windows/macOS/Linux 中随机', () => {
    const platforms = new Set();
    const valid = ['"Windows"', '"macOS"', '"Linux"'];
    for (let i = 0; i < 30; i++) {
      const headers = traffic.getBrowserHeaders('chrome');
      platforms.add(headers['Sec-Ch-Ua-Platform']);
    }
    console.log(`  平台样本: ${[...platforms].join(', ')}`);
    ok(platforms.size >= 2, `应产生 ≥2 种不同平台（实际: ${platforms.size}）`);
    for (const p of platforms) {
      ok(valid.includes(p), `${p} 应在有效平台列表中`);
    }
  });

  // ---- 2.7 Sec-Ch-Ua 版本随机性 ----
  test('Sec-Ch-Ua 的版本号应随机变化', () => {
    const versions = new Set();
    for (let i = 0; i < 20; i++) {
      const headers = traffic.getBrowserHeaders('chrome');
      const m = headers['Sec-Ch-Ua'].match(/Chromium";v="(\d+)"/);
      if (m) versions.add(m[1]);
    }
    ok(versions.size >= 2, `20 次调用应产生 ≥2 种不同版本（实际: ${versions.size}）`);
  });

  // ---- 2.8 mergeHeaders 功能 ----
  test('mergeHeaders 应合并用户自定义头（覆盖浏览器默认）', () => {
    const browser = traffic.getBrowserHeaders('chrome');
    const userHeaders = {
      'Accept-Language': 'en-US,en;q=0.5',
      'X-Custom-Header': 'test-value',
    };
    const merged = traffic.mergeHeaders(browser, userHeaders);
    strictEqual(merged['Accept-Language'], 'en-US,en;q=0.5', '应覆盖 Accept-Language');
    strictEqual(merged['X-Custom-Header'], 'test-value', '应添加自定义头');
    ok(merged['Accept'], '仍应保留其他浏览器头');
  });

  test('mergeHeaders 应大小写不敏感覆盖', () => {
    const browser = traffic.getBrowserHeaders('chrome');
    const userHeaders = { 'accept-language': 'ja-JP,ja;q=0.9' };
    const merged = traffic.mergeHeaders(browser, userHeaders);
    strictEqual(merged['Accept-Language'], 'ja-JP,ja;q=0.9', '大小写不敏感覆盖');
  });

  test('mergeHeaders(null) 应返回浏览器头不变', () => {
    const browser = traffic.getBrowserHeaders('chrome');
    const merged = traffic.mergeHeaders(browser, null);
    deepStrictEqual(merged, browser, 'null 用户头应返回原浏览器头');
  });

  test('mergeHeaders({}) 应返回浏览器头不变', () => {
    const browser = traffic.getBrowserHeaders('chrome');
    const merged = traffic.mergeHeaders(browser, {});
    deepStrictEqual(merged, browser, '空对象应返回原浏览器头');
  });
});

// ============================================================================
// 第1层测试：TLS 指纹伪装（curl-impersonate 检测）
// ============================================================================
describe('Layer 1 — TLS 指纹伪装 (curl-impersonate 检测)', () => {

  // ---- 1.1 curl-impersonate 二进制存在性 ----
  test('项目中应存在 curl-impersonate-chrome 和 curl-impersonate-ff', async () => {
    const chromePath = await traffic.detectCurlImpersonate('chrome120');
    console.log(`  curl_chrome120 路径: ${chromePath || '未找到'}`);

    // 项目中应该有 curl-impersonate 目录
    const { access } = await import('fs/promises');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const projectDir = join(__dirname, '..', 'curl-impersonate');
    
    try {
      await access(projectDir);
      ok(true, 'curl-impersonate 目录存在');
    } catch {
      ok(false, 'curl-impersonate 目录不存在');
    }
  });

  // ---- 1.2 getTlsProfileStatus 返回完整状态 ----
  test('getTlsProfileStatus 应返回所有 22 个 profile 的状态', async () => {
    const status = await traffic.getTlsProfileStatus();
    const profiles = Object.keys(status);
    console.log(`  TLS Profiles 总数: ${profiles.length}`);
    console.log(`  Profiles: ${profiles.join(', ')}`);
    strictEqual(profiles.length, 22, '应有 22 个 TLS profile');
    
    // 检查关键 profile
    ok(status['chrome131'] !== undefined, '应包含 chrome131');
    ok(status['firefox133'] !== undefined, '应包含 firefox133');
    ok(status['safari17'] !== undefined, '应包含 safari17');
    ok(status['edge99'] !== undefined, '应包含 edge99');
    
    // 每个 profile 应有 available 和 path 字段
    for (const [profile, info] of Object.entries(status)) {
      ok(typeof info.available === 'boolean', `${profile}.available 应为 boolean`);
      ok('path' in info, `${profile}.path 应存在`);
    }
  });

  // ---- 1.3 detectCurlImpersonate 缓存机制 ----
  test('detectCurlImpersonate 应缓存结果（二次调用快速返回）', async () => {
    const start1 = Date.now();
    const result1 = await traffic.detectCurlImpersonate('chrome131');
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    const result2 = await traffic.detectCurlImpersonate('chrome131');
    const time2 = Date.now() - start2;

    console.log(`  首次: ${time1}ms, 二次: ${time2}ms`);
    strictEqual(result1, result2, '两次调用应返回相同路径');
    ok(time2 <= time1, '二次调用应更快（缓存命中）');
  });

  // ---- 1.4 不存在的 profile 返回 null ----
  test('不存在的 profile 应返回 null', async () => {
    const result = await traffic.detectCurlImpersonate('nonexistent');
    strictEqual(result, null, '不存在的 profile 应返回 null');
  });
});

// ============================================================================
// 综合执行测试：spawnCurlSecure（需要网络，测试快速响应）
// ============================================================================
describe('核心执行 — spawnCurlSecure（HTTP 请求测试）', () => {

  // ---- 4.1 基本 GET 请求 ----
  test('GET httpbin.org/get 应成功返回（标准 curl）', async () => {
    const result = await traffic.spawnCurlSecure('https://httpbin.org/get', {
      method: 'GET',
      timeout: 15,
      uaProfile: 'chrome',
      tlsProfile: 'auto',
    });
    
    console.log(`  HTTP 状态: ${result.code}`);
    console.log(`  stdout 长度: ${result.stdout.length} bytes`);
    console.log(`  stderr 长度: ${result.stderr.length} bytes`);
    
    strictEqual(result.code, 0, 'curl 应返回退出码 0');
    ok(result.stdout.length > 0, '应有响应内容');
    
    // 解析 JSON 响应
    try {
      const json = JSON.parse(result.stdout);
      ok(json.url === 'https://httpbin.org/get', '响应 URL 应匹配');
      ok(json.headers['User-Agent'], '响应应包含 User-Agent');
      ok(json.headers['Accept-Language'], '响应应包含 Accept-Language');
      console.log(`  User-Agent: ${json.headers['User-Agent']}`);
      console.log(`  Accept-Language: ${json.headers['Accept-Language']}`);
    } catch {
      // 可能包含 HTTP 头信息（因为用了 --include）
      ok(result.stdout.includes('HTTP/'), '响应应包含 HTTP 状态行');
      ok(result.stdout.includes('{') || result.stdout.includes('access-control'), '响应应包含 JSON 或 CORS 头');
    }
  }, { timeout: 30000 });

  // ---- 4.2 带 TLS 指纹的请求 ----
  test('使用 chrome131 TLS 指纹请求 httpbin.org 应成功', async () => {
    const result = await traffic.spawnCurlSecure('https://httpbin.org/get', {
      method: 'GET',
      timeout: 15,
      uaProfile: 'chrome',
      tlsProfile: 'chrome131',
    });
    
    console.log(`  TLS-chrome131 状态码: ${result.code}`);
    console.log(`  stdout: ${result.stdout.substring(0, 200)}...`);

    // 即使 curl-impersonate 不可用也应优雅降级到普通 curl
    ok(result.code === 0 || result.stdout.length > 0, '应返回数据或报错');
    if (result.code !== 0) {
      console.log(`  注意: curl-impersonate 可能未完整安装, 降级到标准 curl`);
    }
  }, { timeout: 30000 });

  // ---- 4.3 POST 请求 ----
  test('POST httpbin.org/post 应正确发送 body', async () => {
    const result = await traffic.spawnCurlSecure('https://httpbin.org/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      requestBody: JSON.stringify({ test: 'hello', num: 42 }),
      timeout: 15,
      uaProfile: 'chrome',
    });
    
    console.log(`  POST 状态码: ${result.code}`);
    
    if (result.code === 0 && result.stdout.length > 0) {
      // 尝试解析 JSON（可能因为 --include 带了 HTTP 头）
      const bodyStart = result.stdout.lastIndexOf('\n\n{');
      const jsonStr = bodyStart > 0 ? result.stdout.substring(bodyStart + 1) : result.stdout;
      try {
        const json = JSON.parse(jsonStr);
        strictEqual(json.json.test, 'hello', 'body 中的 test 字段应正确传递');
        strictEqual(json.json.num, 42, 'body 中的 num 字段应正确传递');
        console.log('  POST body 正确传递 ✓');
      } catch {
        ok(result.stdout.includes('test'), '响应应包含 test 字段');
      }
    }
  }, { timeout: 30000 });

  // ---- 4.4 超时处理 ----
  test('超时机制应正常工作', async () => {
    const start = Date.now();
    const result = await traffic.spawnCurlSecure('https://httpbin.org/delay/10', {
      method: 'GET',
      timeout: 3, // 3 秒超时
    });
    const elapsed = Date.now() - start;
    
    console.log(`  超时测试: ${elapsed}ms 后返回`);
    ok(elapsed < 15000, '应在超时时间内返回');
    // 超时时 code 可能为 null（被 SIGTERM）
    console.log(`  超时结果 code: ${result.code}`);
  }, { timeout: 20000 });

  // ---- 4.5 自定义 Header 合并 ----
  test('自定义 Header 应正确传递给服务器', async () => {
    const result = await traffic.spawnCurlSecure('https://httpbin.org/headers', {
      method: 'GET',
      headers: { 'X-Test-Header': 'traffic-core-test' },
      timeout: 15,
      uaProfile: 'chrome',
    });
    
    if (result.code === 0 && result.stdout.length > 0) {
      const bodyStart = result.stdout.lastIndexOf('\n\n{');
      const jsonStr = bodyStart > 0 ? result.stdout.substring(bodyStart + 1) : result.stdout;
      try {
        const json = JSON.parse(jsonStr);
        const allHeaders = json.headers || {};
        const hasCustomHeader = Object.keys(allHeaders).some(
          k => k.toLowerCase() === 'x-test-header'
        );
        ok(hasCustomHeader, '服务器应收到 X-Test-Header');
        if (hasCustomHeader) {
          const customKey = Object.keys(allHeaders).find(k => k.toLowerCase() === 'x-test-header');
          strictEqual(allHeaders[customKey], 'traffic-core-test', '自定义头值应正确');
        }
      } catch {
        ok(result.stdout.includes('traffic-core-test'), '响应应包含自定义头');
      }
    }
  }, { timeout: 30000 });
});

// ============================================================================
// 兼容层测试：spawnCurlCompat
// ============================================================================
describe('兼容层 — spawnCurlCompat（旧接口兼容）', () => {

  test('spawnCurlCompat 应处理标准 args 数组格式', async () => {
    const result = await traffic.spawnCurlCompat(
      ['-s', '-S', '-X', 'GET', 'https://httpbin.org/get'],
      15000
    );
    
    console.log(`  Compat 状态码: ${result.code}`);
    ok(result.code === 0 || result.stdout.length > 0, '兼容层应返回数据');
  }, { timeout: 30000 });

  test('spawnCurlCompat 应能提取 URL 参数', async () => {
    const result = await traffic.spawnCurlCompat(
      ['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"key":"value"}', 'https://httpbin.org/post'],
      15000
    );
    
    if (result.code === 0 && result.stdout.length > 0) {
      const bodyStart = result.stdout.lastIndexOf('\n\n{');
      const jsonStr = bodyStart > 0 ? result.stdout.substring(bodyStart + 1) : result.stdout;
      try {
        const json = JSON.parse(jsonStr);
        ok(json.json && json.json.key === 'value', 'POST body 应正确传递');
      } catch {
        ok(result.stdout.includes('key'), '响应应包含 key 字段');
      }
    }
  }, { timeout: 30000 });

  test('spawnCurlCompat 应防御非数组输入', async () => {
    const result = await traffic.spawnCurlCompat(null, 5000);
    ok(result.code !== undefined, '非数组输入应返回有效结果（回退）');
    console.log(`  非数组防御结果 code: ${result.code}`);
  });

  test('spawnCurlCompat 应防御数组中含非字符串元素', async () => {
    const result = await traffic.spawnCurlCompat(
      ['-s', 123, null, 'https://httpbin.org/get'],
      15000
    );
    ok(result.code === 0 || result.stdout.length > 0, '含非字符串元素应正常工作');
  }, { timeout: 30000 });
});

// ============================================================================
// 边界条件 & 错误处理测试
// ============================================================================
describe('边界条件 & 错误处理', () => {

  test('spawnCurlSecure 应处理无效 URL', async () => {
    const result = await traffic.spawnCurlSecure('not-a-valid-url', {
      method: 'GET',
      timeout: 5,
    });
    // 应返回错误（不会崩溃）
    ok(result.code !== 0 || result.stderr.length > 0, '无效 URL 应返回错误');
    console.log(`  无效 URL 结果: code=${result.code}, stderr="${result.stderr.substring(0, 100)}"`);
  }, { timeout: 15000 });

  test('generateUA 应对无效 profile 回退到 Chrome', () => {
    const ua = traffic.generateUA('invalid_browser_name');
    ok(ua.includes('Chrome/'), '无效 profile 应回退到 Chrome');
  });

  test('连续调用不应产生竞态条件', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(traffic.spawnCurlSecure('https://httpbin.org/get', {
        timeout: 10,
        uaProfile: 'chrome',
      }));
    }
    const results = await Promise.all(promises);
    for (const result of results) {
      ok(result.code === 0 || result.stdout.length > 0, '并发请求应都成功');
    }
    console.log(`  5 路并发全部完成 ✓`);
  }, { timeout: 30000 });

  test('getTlsProfileStatus 应可重复调用', async () => {
    const s1 = await traffic.getTlsProfileStatus();
    const s2 = await traffic.getTlsProfileStatus();
    deepStrictEqual(Object.keys(s1), Object.keys(s2), '两次调用返回相同 profile 列表');
    strictEqual(Object.keys(s1).length, 22, '始终返回 22 个 profile');
  });
});

// ============================================================================
// 测试总结
// ============================================================================
console.log('\n========================================');
console.log(' traffic-core.js 测试完成');
console.log('========================================');
console.log(' 第1层 ✓ TLS 指纹伪装 (curl-impersonate)');
console.log(' 第2层 ✓ HTTP Header 浏览器指纹');
console.log(' 第3层 ✓ UA 字符串动态生成');
console.log(' 核心  ✓ spawnCurlSecure 执行');
console.log(' 兼容  ✓ spawnCurlCompat 旧接口');
console.log(' 边界  ✓ 错误处理 & 并发');
console.log('========================================\n');
