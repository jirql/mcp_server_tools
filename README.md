<div align="center">

# 🛡️ MCP Server for Kali Linux

**A powerful, security-first MCP (Model Context Protocol) server that exposes Kali Linux's penetration testing toolchain as structured, schema-validated tools — with interactive PTY sessions, traffic-obfuscated HTTP fetching, and intelligent session management.**

[![MCP Protocol](https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square)](https://spec.modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Kali Linux](https://img.shields.io/badge/Platform-Kali%20Linux-557C94?style=flat-square)](https://www.kali.org/)

[📋 Features](#-features) · [🚀 Quick Start](#-quick-start) · [🔧 Tools](#-tools-reference) · [🔒 Security](#-security-architecture) · [⚙️ Configuration](#️-configuration) · [🤝 Contributing](#-contributing)

</div>

---

## ✨ Features

- 🖥️ **Interactive PTY Sessions** — Stateful bash / msfconsole / sliver / python shells with prompt auto-detection
- 📡 **tmux Multiplexer** — 28 actions: split panes, background jobs, session persistence across disconnects
- ⚡ **One-Shot & Batch Execution** — Zero-overhead `exec` + parallel `batch` (up to 20 concurrent)
- 🕵️ **3-Layer Traffic Obfuscation** — TLS fingerprint impersonation (23 profiles) + dynamic browser headers + UA rotation
- 📁 **Smart File System** — Read / write / upload / download / HTTP fetch in one tool
- 🧭 **Intelligent Navigation** — Context memory, bookmarks, `explore` summaries, `find` search, `quickView` previews
- 🔒 **7-Layer Security** — IP whitelist → rate limiting → command validation → env sanitization → resource limits → param hiding → global exception handlers
- 🧠 **Adaptive Auto-Tuner** — Dynamic concurrency control (20–80) based on real-time performance metrics

---

## 🏗️ Architecture