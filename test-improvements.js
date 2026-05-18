#!/usr/bin/env node
/**
 * 快速测试：验证分段读取和 referenceId 功能
 */

import { fileOps } from './ops-file.js';

async function test() {
  console.log('=== MCP Server 改进功能测试 ===\n');
  
  // 测试 1: 基础 fetch (无分段)
  console.log('1️⃣ 基础 fetch (小文件):');
  const test1 = await fileOps.fetchUrl(
    'https://httpbin.org/html',
    'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 50000, 'test_001'
  );
  console.log('  ✅ Success:', test1.success);
  console.log('  📊 totalLength:', test1.totalLength, 'bytes');
  console.log('  🏷️  referenceId:', test1.referenceId);
  console.log('  📦 chunk:', test1.chunk ? JSON.stringify(test1.chunk) : 'none');
  console.log('');
  
  // 测试 2: 分段读取
  console.log('2️⃣ 分段读取 (chunkStart=1000):');
  const test2 = await fileOps.fetchUrl(
    'https://httpbin.org/html',
    'GET', {}, null, 30, 0, 'chrome', 'auto', 1000, 50000, 'test_002'
  );
  console.log('  ✅ Success:', test2.success);
  if (test2.chunk) {
    console.log('  📦 分段信息:', JSON.stringify(test2.chunk));
  }
  console.log('  🏷️  referenceId:', test2.referenceId);
  console.log('');
  
  // 测试 3: referenceId 跨多次调用
  console.log('3️⃣ ReferenceId 一致性测试:');
  const refId = 'cross_tool_linkage_v1';
  const call1 = await fileOps.fetchUrl(
    'https://httpbin.org/html', 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 1000, refId
  );
  const call2 = await fileOps.fetchUrl(
    'https://httpbin.org/html', 'GET', {}, null, 30, 0, 'chrome', 'auto', 5000, 1000, refId
  );
  const call3 = await fileOps.fetchUrl(
    'https://httpbin.org/html', 'GET', {}, null, 30, 0, 'chrome', 'auto', 10000, 1000, refId
  );
  console.log('  🏷️  Call1 ID:', call1.referenceId);
  console.log('  🏷️  Call2 ID:', call2.referenceId);
  console.log('  🏷️  Call3 ID:', call3.referenceId);
  console.log('  ✅ 所有调用使用相同 referenceId:', 
    call1.referenceId === call2.referenceId && call2.referenceId === call3.referenceId && call3.referenceId === refId ? 'YES' : 'NO');
  console.log('');
  
  // 测试 4: 大文件自动识别
  console.log('4️⃣ 大文件自动识别:');
  const test4 = await fileOps.fetchUrl(
    'https://httpbin.org/html',
    'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 100
  );
  console.log('  📊 totalLength:', test4.totalLength, 'bytes');
  console.log('  ⚠️  isLargeContent:', test4.isLargeContent ? 'YES (>100KB)' : 'NO');
  console.log('  📦 chunk:', test4.chunk ? JSON.stringify(test4.chunk) : 'none');
  console.log('');
  
  console.log('=== 测试完成 ===\n');
}

test().catch(console.error);
