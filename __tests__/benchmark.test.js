/**
 * Performance Benchmark Suite
 * Uses test() with timing measurement
 */

import test from 'node:test';
import { strictEqual } from 'node:assert';
import { initializeTools, getToolsList } from '../tools.js';
import * as security from '../security.js';

const mockSM = {
  sessions: [],
  createSession: (id) => ({ pid: Date.now(), state: 'running', id }),
  getSession: (id) => null,
  kill: () => {},
  killAll: () => {},
  count: () => 0,
  listSessions: () => [],
  getResourceStats: () => ({ totalSessions: 0, maxSessions: 20, totalMemoryBytes: 0, totalMemoryMB: 0 })
};

const config = { terminal: { max_sessions: 10 }, security: { allowed_ips: ['127.0.0.1'] } };

// Warmup
initializeTools(mockSM, config);

test('Tool initialization - should be <10ms', () => {
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    initializeTools(mockSM, config);
  }
  const avg = (performance.now() - start) / 100;
  console.log(`\n  Avg init time: ${avg.toFixed(3)}ms`);
  strictEqual(avg < 10, true, `Init too slow: ${avg}ms`);
});

test('getToolsList - should be <1ms', () => {
  const tools = initializeTools(mockSM, config);
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    getToolsList(tools);
  }
  const avg = (performance.now() - start) / 1000;
  console.log(`\n  Avg list gen: ${avg.toFixed(3)}ms`);
  strictEqual(avg < 1, true, `List too slow: ${avg}ms`);
});

test('Command validation - safe commands <0.5ms', () => {
  const commands = [
    'ls -la /tmp', 'cat /etc/hostname', 'echo hello',
    'grep pattern file.txt', 'nmap -p 80 localhost'
  ];
  
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    for (const cmd of commands) {
      security.validateCommand(cmd);
    }
  }
  const avg = (performance.now() - start) / 5000;
  console.log(`\n  Avg validate: ${avg.toFixed(3)}ms per cmd`);
  strictEqual(avg < 0.5, true, `Validate too slow: ${avg}ms`);
});

test('Path validation - should be <0.1ms', () => {
  const paths = ['/tmp/test.txt', '/home/user/data.json', '/var/log/syslog'];
  
  const start = performance.now();
  for (let i = 0; i < 10000; i++) {
    for (const path of paths) {
      security.validatePath(path);
    }
  }
  const avg = (performance.now() - start) / 30000;
  console.log(`\n  Avg path val: ${avg.toFixed(3)}ms per path`);
  strictEqual(avg < 0.1, true, `Path val too slow: ${avg}ms`);
});

console.log('\n🔬 Performance Benchmarks Complete\n');
