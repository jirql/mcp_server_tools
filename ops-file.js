/**
 * File Operations Library
 * Unified file read/write/list/delete/transfer operations
 */

import { readFile, writeFile, readdir, stat, mkdir, rm, open } from 'fs/promises';
import { pickUserAgent, spawnCurlSecure } from './traffic-core.js';
import { validatePath } from './security.js';
import { getNetworkQueue } from './performance-optimizer.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024;

function parseCurlOutput(raw) {
  const parts = raw.split(/\r?\n\r?\n/);
  const headerLines = [];
  let body = raw;
  let headerEnd = -1;
  let httpCode = 0;
  let httpStatusLine = '';

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('HTTP/')) {
      headerEnd = i;
      const match = parts[i].match(/HTTP\/\d+\.?\d*\s+(\d+)/);
      if (match) httpCode = parseInt(match[1]);
      httpStatusLine = parts[i];
    }
  }

  if (headerEnd >= 0) {
    const headerBlock = parts.slice(0, headerEnd + 1).join('\r\n\r\n');
    body = parts.slice(headerEnd + 1).join('\r\n\r\n');
    for (const line of headerBlock.split(/\r?\n/)) {
      if (!line.startsWith('HTTP/')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          headerLines.push({ key: line.substring(0, colonIdx).trim(), value: line.substring(colonIdx + 1).trim() });
        }
      }
    }
  }

  const headers = {};
  for (const h of headerLines) {
    headers[h.key] = h.value;
  }

  return { headers, body, httpCode, httpStatusLine };
}

export const fileOps = {
  /**
   * Read file content
   */
  async read(filePath, encoding, maxSize) {
    try {
      const path = validatePath(filePath);
      const stats = await stat(path);

      if (stats.size > (maxSize || MAX_FILE_SIZE)) {
        return { success: false, error: `File too large (${stats.size} bytes)` };
      }

      const content = await readFile(path, encoding || 'utf8');
      return {
        success: true,
        content: [{ type: "text", text: content }],
        size: stats.size
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Write file content
   */
  async write(filePath, content, encoding, append, createDir) {
    try {
      const path = validatePath(filePath);

      if (createDir) {
        const dir = path.substring(0, path.lastIndexOf('/'));
        try { await mkdir(dir, { recursive: true }); } catch (e) {}
      }

      const flag = append ? 'a' : 'w';
      await writeFile(path, content, { encoding: encoding || 'utf8', flag });

      return {
        success: true,
        path: path,
        bytesWritten: content.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * List directory contents
   */
  async list(dirPath, showHidden, recursive) {
    try {
      const path = validatePath(dirPath || '.');

      if (recursive) {
        return { success: false, error: 'Recursive listing disabled' };
      }

      const items = await readdir(path, { withFileTypes: true });
      const filtered = showHidden
        ? items
        : items.filter(item => !item.name.startsWith('.'));

      const result = await Promise.all(filtered.map(async item => {
        const fullPath = path + '/' + item.name;
        let s = null;
        try { s = await stat(fullPath); } catch (e) {}

        return {
          name: item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: s?.size || 0,
          modified: s?.mtime?.toISOString()
        };
      }));

      return {
        success: true,
        items: result,
        count: result.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Delete file or directory
   */
  async delete(filePath) {
    try {
      const path = validatePath(filePath);
      await rm(path, { recursive: false });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Download file as base64
   */
  async download(filePath, offset, chunkSize) {
    try {
      const path = validatePath(filePath);
      const stats = await stat(path);

      if (stats.isDirectory()) {
        return { success: false, error: 'Path is a directory' };
      }

      const buffer = await readFile(path);
      const chunk = buffer.slice(offset || 0, (offset || 0) + (chunkSize || 1048576));
      const base64Data = chunk.toString('base64');

      return {
        success: true,
        path: path,
        data: base64Data,
        encoding: 'base64',
        fileSize: stats.size
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Upload file from base64
   */
  async upload(filePath, data, offset, append) {
    try {
      const path = validatePath(filePath);
      const buffer = Buffer.from(data, 'base64');

      const fh = await open(path, append ? 'a' : 'w');
      try {
        await fh.write(buffer, 0, buffer.length, offset || 0);
      } finally {
        await fh.close();
      }

      const stats = await stat(path);
      return {
        success: true,
        path: path,
        bytesWritten: buffer.length,
        totalSize: stats.size
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Fetch URL content with enhanced response
   * Returns headers, auto-parses JSON, supports auth + chunked responses
   * @param {string} url - Target URL
   * @param {string} method - HTTP method
   * @param {object} headers - Request headers
   * @param {string|object} requestBody - Request body
   * @param {number} timeout - Timeout in seconds
   * @param {number} retry - Retry count
   * @param {string} uaMode - User agent mode
   * @param {string} tlsProfile - TLS fingerprint profile (chrome110, firefox117, etc.)
   * @param {number} chunkStart - Byte offset for chunked reading (default: 0)
   * @param {number} chunkSize - Max chunk size in bytes (default: 50000)
   * @param {string} referenceId - Reference ID for cross-tool linkage (optional)
   */
  async fetchUrl(url, method, headers, requestBody, timeout, retry, uaMode, tlsProfile, chunkStart, chunkSize, referenceId) {
    // Route through NetworkRequestQueue for concurrent request limiting
    const networkQueue = getNetworkQueue();

    return networkQueue.enqueue(
      'fetch',
      async () => {
        const maxRetries = Math.min(retry || 0, 3);
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const result = await spawnCurlSecure(url, {
              method: method || 'GET',
              headers: headers || {},
              requestBody: requestBody || null,
              timeout: timeout || 60,
              uaProfile: uaMode || 'chrome',
              tlsProfile: tlsProfile || 'auto'
            });

            if (result.code !== 0 && !result.stdout) {
              throw new Error(`curl error (exit ${result.code}): ${result.stderr || 'connection failed'}`);
            }

            const rawOutput = result.stdout;
            const parsed = parseCurlOutput(rawOutput);
            const { headers: responseHeaders, body: responseBody, httpCode } = parsed;

            if (httpCode === 0 && result.code !== 0) {
              throw new Error(`curl error (exit ${result.code}): ${result.stderr || 'connection failed'}`);
            }

            let parsedBody = null;
            const contentType = (responseHeaders['content-type'] || responseHeaders['Content-Type'] || '').toLowerCase();
            if (contentType.includes('json')) {
              try { parsedBody = JSON.parse(responseBody); } catch (e) { parsedBody = null; }
            } else {
              try { parsedBody = JSON.parse(responseBody); } catch (e) { parsedBody = null; }
            }

            // Chunk support
            const start = chunkStart || 0;
            const size = chunkSize || 50000;
            const totalLength = responseBody.length;

            let chunkBody = responseBody;
            let chunkInfo = null;

            if (start > 0 || size < totalLength) {
              const end = Math.min(start + size, totalLength);
              const isLastChunk = end >= totalLength;
              const currentChunk = Math.floor(start / size) + 1;
              const totalChunks = Math.ceil(totalLength / size);

              chunkBody = responseBody.slice(start, end);
              chunkInfo = {
                currentChunk,
                totalChunks,
                chunkStart: start,
                chunkEnd: end - 1,
                totalSize: totalLength,
                isLastChunk,
                nextStart: isLastChunk ? null : end
              };
            }

            // Calculate content length remaining
            const contentLength = parseInt(responseHeaders['content-length'] || responseHeaders['Content-Length'] || '0', 10);
            const isLargeContent = totalLength > 100000; // > 100KB

            return {
              success: true,
              status: httpCode,
              statusOk: httpCode >= 200 && httpCode < 300,
              headers: responseHeaders,
              body: chunkBody,
              parsedBody,
              contentType,
              chunk: chunkInfo,
              isLargeContent,
              totalLength,
              contentLength: isNaN(contentLength) ? null : contentLength,
              attempt: attempt + 1,
              time: Date.now(),
              tlsProfile: tlsProfile || 'auto',
              referenceId: referenceId || null  // Add reference ID for cross-tool linkage
            };
          } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
        }

        return { success: false, error: lastError?.message || 'Request failed', referenceId: referenceId || null };
      },
      {
        priority: 0,
        maxRetries: 1, // NetworkRequestQueue retry is additive to internal retries
        toolName: 'fetch',
        referenceId: referenceId || undefined,
      },
    );
  }
};

// Export fetchUrlChunked as a separate utility function
export async function fetchUrlChunked(url, chunkSize = 50000, referenceId) {
  // First get the size
  const headResult = await fileOps.fetchUrl(url, 'HEAD', {}, null, 30, 0, 'chrome', 'auto', 0, 1000, referenceId);
  
  if (!headResult.success) {
    return headResult;
  }

  const totalLength = headResult.totalLength || 0;
  const chunks = [];
  let offset = 0;
  let chunkNum = 1;

  while (offset < totalLength) {
    const chunkResult = await fileOps.fetchUrl(url, 'GET', {}, null, 30, 0, 'chrome', 'auto', offset, chunkSize, referenceId);
    
    if (!chunkResult.success) {
      return {
        success: false,
        error: chunkResult.error,
        chunks: chunks,
        chunkNumber: chunkNum - 1,
        totalChunks: chunks.length
      };
    }

    chunks.push({
      chunkNumber: chunkNum++,
      content: chunkResult.body,
      offset,
      length: chunkResult.body.length,
      isLastChunk: !!chunkResult.chunk?.isLastChunk
    });

    if (chunkResult.chunk?.isLastChunk || chunkResult.body.length === 0) {
      break;
    }

    offset += chunkSize;
  }

  const fullContent = chunks.map(c => c.content).join('');
  
  return {
    success: true,
    chunked: true,
    totalLength,
    chunks,
    chunkNumber: chunkNum - 1,
    totalChunks: chunks.length,
    fullContent: totalLength > 0 ? fullContent : null,
    referenceId: referenceId || null
  };
}
