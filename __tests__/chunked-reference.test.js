/**
 * 测试用例：分段读取与上下文引用功能
 * 验证改进：1. 大内容分段 2. referenceId 3. JSON 格式优化
 */

import { fileOps } from './ops-file.js';

// 模拟测试环境
const TEST_URL = 'https://httpbin.org/html'; // 约 5KB，适合测试
const LARGE_URL = 'https://httpbin.org/html?size=2'; // 更大的响应

describe('File Operations - Chunked Reading & ReferenceId', () => {
  
  describe('fetchUrl - 分段读取功能', () => {
    
    test('基础 fetch 返回结构化数据', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto');
      
      expect(result.success).toBe(true);
      expect(typeof result.status).toBe('number');
      expect(typeof result.body).toBe('string');
    });

    test('chunkStart=0 返回完整内容', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 1000);
      
      expect(result.success).toBe(true);
      expect(result.chunk).toBeNull(); // 无需分段
      expect(result.totalLength).toBeGreaterThan(0);
      expect(result.isLargeContent).toBe(false);
    });

    test('chunkStart=1000 返回分段内容', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 1000, 500);
      
      expect(result.success).toBe(true);
      expect(result.chunk).toHaveProperty('currentChunk');
      expect(result.chunk).toHaveProperty('totalChunks');
      expect(result.chunk.nextStart).toBeGreaterThanOrEqual(0);
    });

    test('大文件自动识别', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 100);
      
      // 虽然 100 字节很小，但验证 chunkInfo 结构
      if (result.totalLength > 100000) {
        expect(result.isLargeContent).toBe(true);
      } else {
        expect(result.isLargeContent).toBe(false);
      }
    });

    test('referenceId 附加到响应', async () => {
      const refId = 'test_ref_001';
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 50000, refId);
      
      expect(result.success).toBe(true);
      expect(result.referenceId).toBe(refId);
    });

  });

  describe('cross-tool linkage', () => {
    
    test('referenceId 一致性跨多次调用', async () => {
      const refId = 'cross_tool_test_001';
      
      const call1 = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 50000, refId);
      const call2 = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 50000, 50000, refId);
      
      expect(call1.referenceId).toBe(refId);
      expect(call2.referenceId).toBe(refId);
      expect(call1.referenceId).toBe(call2.referenceId);
    });

    test('无 referenceId 返回 null', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto');
      
      expect(result.referenceId).toBeNull();
    });

  });

  describe('JSON 结构优化', () => {
    
    test('chunkInfo 独立对象', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 1000);
      
      // chunk 应该是独立对象或 null，不是内嵌在 body 中
      if (result.chunk !== null) {
        expect(result.chunk).toMatchObject({
          currentChunk: expect.any(Number),
          totalChunks: expect.any(Number),
          nextStart: expect.any(Number)
        });
      }
    });

    test('length 字段分离', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 1000);
      
      expect(result).toHaveProperty('totalLength');
      expect(result).toHaveProperty('contentLength');
      expect(typeof result.totalLength).toBe('number');
      expect(typeof result.contentLength).toBe('number');
    });

  });

  describe('edge cases', () => {
    
    test('chunkStart 超出范围返回空', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 1000000, 50000);
      
      expect(result.success).toBe(true);
      expect(result.body).toBe('');
      expect(result.totalLength).toBeGreaterThan(0);
    });

    test('chunkSize 太小返回多个分段', async () => {
      const chunks = [];
      let offset = 0;
      
      do {
        const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', offset, 100);
        
        chunks.push(result.body);
        offset = result.chunk?.nextStart || offset + 100;
        
      } while (offset < (result.totalLength || 10000));
      
      expect(chunks.length).toBeGreaterThan(1);
    });

    test('最后一个分段的 isLastChunk 标记', async () => {
      const result = await fileOps.fetchUrl(TEST_URL, 'GET', {}, null, 30, 0, 'chrome', 'auto', 10000, 100);
      
      if (result.chunk) {
        expect(result.chunk).toHaveProperty('isLastChunk');
      }
    });

  });

});

// 快速测试示例
async function quickTest() {
  console.log('=== 快速测试示例 ===\n');
  
  // 测试 1: 分段读取
  console.log('测试 1: 分段读取大文件');
  const chunk1 = await fileOps.fetchUrl(
    'https://httpbin.org/html',
    'GET',
    {},
    null,
    30,
    0,
    'chrome',
    'auto',
    0,
    1000
  );
  console.log('  - totalLength:', chunk1.totalLength);
  console.log('  - isLargeContent:', chunk1.isLargeContent);
  console.log('  - chunkInfo:', JSON.stringify(chunk1.chunk, null, 2));
  
  // 测试 2: referenceId
  console.log('\n测试 2: referenceId 传递');
  const ref = 'test_ref_20260211';
  const r1 = await fileOps.fetchUrl('https://httpbin.org/html', 'GET', {}, null, 30, 0, 'chrome', 'auto', 0, 50000, ref);
  const r2 = await fileOps.fetchUrl('https://httpbin.org/html', 'GET', {}, null, 30, 0, 'chrome', 'auto', 5000, 50000, ref);
  console.log('  - refId consistency:', r1.referenceId === r2.referenceId ? '✅' : '❌');
  console.log('  - referenceId:', r1.referenceId);
  
  // 测试 3: 分段拼接
  console.log('\n测试 3: 分段内容拼接验证');
  const fullContent = [];
  let offset = 0;
  do {
    const chunk = await fileOps.fetchUrl(
      'https://httpbin.org/html',
      'GET',
      {},
      null,
      30,
      0,
      'chrome',
      'auto',
      offset,
      1000
    );
    fullContent.push(chunk.body);
    offset = chunk.chunk?.nextStart || offset + 1000;
  } while (offset < (chunk.totalLength || 10000) && chunk.body.length > 0);
  
  console.log('  - 分段数量:', fullContent.length);
  console.log('  - 拼接完整长度:', fullContent.join('').length);
  console.log('  - 原始 contentLength:', chunk1.totalLength);
  console.log('  - 匹配:', fullContent.join('').length === chunk1.totalLength ? '✅ 匹配' : '❌ 不匹配');
  
  console.log('\n=== 全部测试完成 ===\n');
}

// 运行测试
if (typeof require !== 'undefined' && require.main === module) {
  quickTest().catch(console.error);
}

export { quickTest };
