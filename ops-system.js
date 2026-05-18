/**
 * System Information Library
 * System info, network info, port scan
 */

import { spawn, exec } from 'child_process';
import { getNetworkQueue } from './performance-optimizer.js';

export const systemOps = {
  /**
   * Get system information
   */
  async info() {
    try {
      const [hostname, uptime, users, memInfo, diskInfo] = await Promise.all([
        execPromise('hostname', { timeout: 5000 }),
        execPromise('uptime -p 2>/dev/null || uptime', { timeout: 5000 }),
        execPromise('who', { timeout: 5000 }),
        execPromise('free -h', { timeout: 5000 }),
        execPromise('df -h / | tail -1', { timeout: 5000 })
      ]);
      
      return {
        success: true,
        hostname: hostname.stdout.trim(),
        uptime: uptime.stdout.trim(),
        users: users.stdout.trim(),
        memory: memInfo.stdout.trim(),
        disk: diskInfo.stdout.trim()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Get network information
   */
  async network() {
    try {
      const [interfaces, routes, dns] = await Promise.all([
        execPromise('ip addr show', { timeout: 5000 }),
        execPromise('ip route', { timeout: 5000 }),
        execPromise('cat /etc/resolv.conf 2>/dev/null || echo "N/A"', { timeout: 5000 })
      ]);
      
      return {
        success: true,
        interfaces: interfaces.stdout.trim(),
        routes: routes.stdout.trim(),
        dns: dns.stdout.trim()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Port scan using nmap
   */
  async portScan(target, ports) {
    const networkQueue = getNetworkQueue();

    return networkQueue.enqueue(
      'portScan',
      () => {
        return new Promise((resolve) => {
          try {
            const child = spawn('nmap', ['-p', ports || '21,22,80,443', '--open', '-T5', target], { timeout: 30000 });
            const stdoutChunks = [];
            const stderrChunks = [];
            let settled = false;

            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                if (!child.killed) child.kill('SIGTERM');
                resolve({
                  success: false,
                  error: 'Scan timed out'
                });
              }
            }, 30000);

            child.stdout.on('data', (d) => stdoutChunks.push(d));
            child.stderr.on('data', (d) => stderrChunks.push(d));

            child.on('close', (code) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const stdout = Buffer.concat(stdoutChunks).toString();
              const stderr = Buffer.concat(stderrChunks).toString();
              resolve({
                success: true,
                target: target,
                ports: ports,
                result: (stdout || stderr).trim(),
                code: code
              });
            });

            child.on('error', (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({
                success: false,
                error: err.message
              });
            });
          } catch (error) {
            resolve({ success: false, error: error.message });
          }
        });
      },
      {
        priority: 0,
        maxRetries: 1,
      },
    );
  }
};

async function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { ...options, encoding: 'buffer' });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (data) => stdoutChunks.push(data));
    child.stderr.on('data', (data) => stderrChunks.push(data));
    child.on('error', reject);

    child.on('close', (code) => {
      const stdout = stdoutChunks.length > 0 ? Buffer.concat(stdoutChunks).toString() : '';
      const stderr = stderrChunks.length > 0 ? Buffer.concat(stderrChunks).toString() : '';
      resolve({ stdout, stderr, code });
    });

    if (options.timeout) {
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        }
      }, options.timeout);
    }
  });
}
