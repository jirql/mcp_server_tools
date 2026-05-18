/**
 * Security Validation Module
 * Unified input validation for all tools
 */

const MAX_COMMAND_LENGTH = 16384;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 60;

const DANGEROUS_PATTERNS = [
  /;\s*rm\s+-rf\s+\//,
  />\s*\/dev\/(sd|hd|nvme)/,
  /mkfs\.\w+/,
  /dd\s+if=.*of=\/dev/,
  /:\(\)\{\s*:\|:\&\};:/,
  /curl\s+.*\|\s*(sh|bash|zsh)/i,
  /wget\s+.*\|\s*(sh|bash|zsh)/i,
  /python[23]?\s+-c\s+['"]/,
  /perl\s+-[e].*['"]/,
  /base64\s+-d.*\|\s*(sh|bash)/i,
  /chmod\s+777\s+/,
  /chown\s+\d+\s+\//,
  /mv\s+\/etc\//,
  /exec\s+\$0/,
  /\|\|\s*sh\b/,
  /&&\s*sh\b/,
  /`.*(rm\s+-rf|dd\s+|mkfs)/i,
  /\$\(.*(rm\s+-rf|dd\s+|mkfs)/i,
  /\/dev\/tcp\//,
  /\/dev\/udp\//,
  /sudo\s+rm\s+-rf\s+--no-preserve-root/
];

export function validateString(value, name, maxLength = 1024) {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} exceeds maximum length`);
  }
  if (value.length === 0) {
    throw new Error(`${name} cannot be empty`);
  }
  return value;
}

export function validateCommand(command) {
  const sanitized = validateString(command, 'command', MAX_COMMAND_LENGTH);

  if (sanitized.includes('\0')) {
    throw new Error('Command contains null bytes');
  }

  if (sanitized.includes('\n') || sanitized.includes('\r')) {
    throw new Error('Command cannot contain newlines');
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      throw new Error('Command contains dangerous operations and was blocked');
    }
  }

  return sanitized;
}

export function validatePath(inputPath) {
  if (!inputPath) return '.';
  const resolved = String(inputPath).startsWith('/') ? String(inputPath) : '.';
  
  const blockedPaths = ['/etc/shadow', '/etc/passwd', '/etc/sudoers', '/root/.ssh'];
  for (const blocked of blockedPaths) {
    if (resolved.startsWith(blocked)) {
      throw new Error(`Access to ${blocked} is not allowed`);
    }
  }
  
  return resolved;
}

export function validateShell(shell) {
  const allowedShells = ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'];
  if (!shell) return '/bin/bash';
  
  const resolved = allowedShells.find(s => shell === s || shell.endsWith(s));
  if (!resolved && !shell.startsWith('/usr/bin/') && !shell.startsWith('/bin/')) {
    throw new Error(`Shell '${shell}' is not in the allowed list`);
  }
  
  return shell;
}

export function validateTimeout(timeout) {
  const t = Number(timeout) || DEFAULT_TIMEOUT;
  return Math.min(Math.max(t, 1), 300);
}

export function sanitizeTmuxName(name) {
  if (!name) return null;
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '');
  if (sanitized.length === 0 || sanitized.length > 64) {
    throw new Error('Invalid tmux session name');
  }
  return sanitized;
}
