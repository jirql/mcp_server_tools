#!/usr/bin/env node
/**
 * Verify MCP tools schema generation
 */

import { initializeTools } from './tools.js';

console.log('=== MCP Tool Schema Validation ===\n');

const mockSessionManager = {
  createSession: () => ({ pid: 12345, state: 'running', getInfo: () => ({}) }),
  getSession: () => null,
  kill: () => {},
  count: () => 0,
  listSessions: () => [],
  killAll: () => {}
};

const config = { terminal: { max_sessions: 20 } };

const tools = initializeTools(mockSessionManager, config);

// Convert to MCP format
const mcpTools = Object.entries(tools).map(([key, tool]) => ({
  name: `mcp__mcp__${key}`, // MCP client auto-prefixes
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }
}));

console.log('Generated MCP Tools:\n');
mcpTools.forEach(tool => {
  console.log(`\n🔧 ${tool.function.name}`);
  console.log(`   Description: ${tool.function.description.substring(0, 80)}...`);
  console.log(`   Required: ${JSON.stringify(tool.function.parameters.required || [])}`);
});

// Validate schema structure
console.log('\n=== Schema Validation ===');

let allValid = true;
for (const [key, tool] of Object.entries(tools)) {
  const required = tool.inputSchema.required;
  
  if (!required) {
    console.log(`❌ ${key}: missing 'required' array`);
    allValid = false;
    continue;
  }
  
  if (!Array.isArray(required)) {
    console.log(`❌ ${key}: 'required' is not an array, got ${typeof required}`);
    allValid = false;
    continue;
  }
  
  // Check for boolean values in required fields
  for (const propKey of Object.keys(tool.inputSchema.properties || {})) {
    const prop = tool.inputSchema.properties[propKey];
    if (prop.required === true) {
      console.log(`❌ ${key}.properties.${propKey}: 'required' cannot be boolean, move to schema.required[]`);
      allValid = false;
      continue;
    }
  }
  
  console.log(`✅ ${key}: Schema valid`);
}

console.log('\n=== Summary ===');
if (allValid) {
  console.log('✅ All schemas are valid! Ready for MCP client.');
} else {
  console.log('❌ Some schemas have issues. Please fix the errors above.');
  process.exit(1);
}
