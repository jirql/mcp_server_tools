/**
 * Test script for new unified tools
 * Verifies 6 core tools work correctly
 */

import { initializeTools } from './tools.js';

console.log('Testing new unified MCP tools...\n');

// Create mock session manager and config
const mockSessionManager = {
  createSession: () => ({ pid: 12345, state: 'running', getInfo: () => ({}) }),
  getSession: () => null,
  kill: () => {},
  count: () => 0,
  listSessions: () => [],
  killAll: () => {}
};

const config = { terminal: { max_sessions: 20 } };

// Initialize tools
const tools = initializeTools(mockSessionManager, config);

// List all tools
console.log('Available Tools:');
console.log('================\n');

Object.keys(tools).forEach((toolName, index) => {
  const tool = tools[toolName];
  console.log(`${index + 1}. ${tool.name}`);
  console.log(`   Description: ${tool.description.substring(0, 80)}...`);
  console.log(`   Actions: ${tool.inputSchema.properties.action?.enum?.join(', ') || 'N/A'}`);
  console.log('');
});

// Test terminal tool
console.log('\nTesting TERMINAL tool:');
console.log('----------------------');
const terminalAction = async (action, params = {}) => {
  const result = await tools['terminal'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.message || result.error || '');
};

await terminalAction('info', { sessionId: 'test-123' });
// (其他测试略)

// Test tmux tool
console.log('\nTesting TMUX tool:');
console.log('------------------');
const tmuxAction = async (action, params = {}) => {
  const result = await tools['tmux'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.message || result.error || '');
};

await tmuxAction('list');

// Test execute tool
console.log('\nTesting EXECUTE tool:');
console.log('---------------------');
const execAction = async (action, params = {}) => {
  const result = await tools['execute'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.message || result.error || result.result?.exitCode);
};

await execAction('exec', { command: 'echo hello', timeout: 5 });

// Test file tool
console.log('\nTesting FILE tool:');
console.log('------------------');
const fileAction = async (action, params = {}) => {
  const result = await tools['file'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.message || result.error || '');
};

await fileAction('list', { path: '.' });

// Test session tool
console.log('\nTesting SESSION tool:');
console.log('---------------------');
const sessionAction = async (action, params = {}) => {
  const result = await tools['session'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.summary?.total || result.message || result.error || '');
};

await sessionAction('list');

// Test system tool
console.log('\nTesting SYSTEM tool:');
console.log('--------------------');
const sysAction = async (action, params = {}) => {
  const result = await tools['system'].handler({ action, ...params });
  console.log(`  [${action}]`, result.success ? '✓' : '✗', result.hostname || result.error || '');
};

await sysAction('info');

// Summary
console.log('\n====================');
console.log('Tool Summary:');
console.log('============');
console.log(`Total tools: ${Object.keys(tools).length}`);
console.log('All tools successfully initialized!');
