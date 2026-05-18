MCP Server for Kali Linux

Brief: MCP Server focusing on terminal tooling and secure command execution.

Quick start:
1. Install dependencies: npm install
2. Copy config: cp config.json config.local.json or use .env
3. Run: npm start

Notes:
- This repository intentionally omits node_modules and runtime logs. If you see node_modules/ or logs/, they should be removed before publishing.
- Replace placeholders in LICENSE and package.json (author, repository) before publishing.

Configuration:
- See config.json for defaults. Sensitive values should be placed in .env and not committed.

Contributing:
See CONTRIBUTING.md

License: MIT (see LICENSE)
