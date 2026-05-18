const { spawnCurlSecure } = require('../traffic-core');

async function main() {
  // 测试1：POST 请求 + 参数隐藏
  console.log('=== 测试1: POST请求 + 参数隐藏 ===');
  try {
    const r1 = await spawnCurlSecure({
      url: 'https://httpbin.org/post',
      method: 'POST',
      headers: { 'X-Secret-Key': 'sk-abcdef123456' },
      body: JSON.stringify({username: 'admin', password: 'supersecret'}),
      uaMode: 'chrome',
      tlsProfile: 'auto',
      paramHide: true
    });
    const body1 = JSON.parse(r1.body);
    console.log('Status:', r1.status);
    console.log('UA:', body1.headers['User-Agent']);
    console.log('Content-Type:', body1.headers['Content-Type']);
    console.log('X-Secret-Key received:', body1.headers['X-Secret-Key']);
    console.log('Body received:', body1.data);
  } catch(e) { console.error('Error:', e.message); }

  // 测试2：检查参数隐藏 — 查看 curl 进程命令行
  console.log('\n=== 测试2: 参数隐藏验证 ===');
  try {
    // 用 spawnCurlSecure 并立即检查 /proc
    const promise = spawnCurlSecure({
      url: 'https://httpbin.org/get',
      method: 'GET',
      headers: {},
      uaMode: 'chrome',
      tlsProfile: 'auto',
      paramHide: true
    });
    
    // 延迟一下让进程启动
    await new Promise(r => setTimeout(r, 50));
    
    // 用 ps 查找 curl 进程
    const { execSync } = require('child_process');
    const ps = execSync('ps aux | grep "[c]url" || true').toString();
    console.log('Curl 进程列表:');
    console.log(ps);
    
    const result = await promise;
    console.log('Status:', result.status);
    console.log('(进程命令行中应无 URL 或 header 泄露)');
  } catch(e) { console.error('Error:', e.message); }

  // 测试3：不同浏览器 UA 一致性
  console.log('\n=== 测试3: 浏览器 UA 一致性 ===');
  for (const mode of ['chrome', 'firefox', 'edge', 'safari', 'random']) {
    try {
      const r = await spawnCurlSecure({
        url: 'https://httpbin.org/user-agent',
        method: 'GET',
        uaMode: mode,
        tlsProfile: 'auto',
        paramHide: true
      });
      const body = JSON.parse(r.body);
      console.log(`  ${mode}: ${body['user-agent']}`);
    } catch(e) { console.error(`  ${mode}: Error - ${e.message}`); }
  }

  // 测试4：spawnCurlCompat 兼容接口
  console.log('\n=== 测试4: spawnCurlCompat 兼容接口 ===');
  try {
    const fs = require('fs');
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), 'test_compat_' + Date.now() + '.tmp');
    
    const { spawnCurlCompat } = require('../traffic-core');
    const r4 = await spawnCurlCompat({
      url: 'https://httpbin.org/anything',
      method: 'GET',
      uaMode: 'firefox',
      paramHide: false   // 兼容模式不用隐藏
    });
    console.log('Status:', r4.status);
    console.log('Compat 模式可用');
  } catch(e) { console.error('Error:', e.message); }

  // 测试5：TLS Profile 状态
  console.log('\n=== 测试5: TLS Profile 状态 ===');
  const { getTlsProfileStatus } = require('../traffic-core');
  const status = getTlsProfileStatus();
  console.log('TLS Profile Status:', JSON.stringify(status, null, 2));
}

const path = require('path');
main().catch(console.error);
