/**
 * Session Management Library
 * Unified session listing, killing, control, stats
 */

import { SessionManager, SessionState } from './session-manager.js';

let sessionManager = null;

export function setSessionManager(sm) {
  sessionManager = sm;
}

export const sessionOps = {
  async list(includeDetails, statsMode, zombieThreshold, httpSessionId) {
    try {
      let sessions = sessionManager.listSessions();
      if (httpSessionId) {
        sessions = sessions.filter(s => s.ownerHttpSessionId === httpSessionId);
      }
      const now = Date.now();
      const thresholdMs = (zombieThreshold || 15) * 60 * 1000;
      
      const stats = {
        total: sessions.length,
        byState: {},
        zombies: [],
        recent: [],
        old: []
      };
      
      for (const session of sessions) {
        const shellName = session.shell.split('/').pop();
        stats.byState[shellName] = (stats.byState[shellName] || 0) + 1;
        
        const inactiveTime = now - session.lastActivity;
        const summary = {
          id: session.id,
          state: session.state,
          inactiveMinutes: Math.floor(inactiveTime / 60000),
          shell: shellName
        };
        
        if (inactiveTime > thresholdMs) {
          stats.zombies.push(summary);
        } else {
          stats.recent.push(summary);
        }
        
        const age = now - session.created;
        if (age > 86400000) {
          stats.old.push({ id: session.id, ageHours: Math.floor(age / 3600000) });
        }
      }
      
      if (statsMode) {
        return {
          success: true,
          statistics: stats,
          summary: {
            total: sessions.length,
            zombies: stats.zombies.length,
            recent: stats.recent.length,
            old: stats.old.length
          }
        };
      }
      
      return {
        success: true,
        sessions: includeDetails ? sessions : sessions.map(s => ({ id: s.id, state: s.state })),
        count: sessions.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async killAll(force) {
    try {
      if (!sessionManager || !sessionManager.killAll) {
        return { success: false, error: 'sessionManager not initialized' };
      }

      const count = sessionManager.count();
      sessionManager.killAll(force);

      return {
        success: true,
        message: `Killed ${count} sessions`,
        canCreateNew: sessionManager.isAvailable()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async reset() {
    try {
      if (!sessionManager || !sessionManager.reset) {
        return { success: false, error: 'sessionManager not initialized' };
      }

      if (sessionManager.isAvailable()) {
        return {
          success: true,
          message: 'SessionManager is already available',
          alreadyAvailable: true
        };
      }

      sessionManager.reset();
      return {
        success: true,
        message: 'SessionManager has been reset and is ready for new sessions'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async background(sessionId, command) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.markBackground(true);
      if (command) {
        session.startLongRunning(command);
      }
      
      return {
        success: true,
        sessionId: sessionId,
        isBackground: true
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async foreground(sessionId) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.markBackground(false);
      session.stopLongRunning();
      
      return {
        success: true,
        sessionId: sessionId,
        isBackground: false
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async stats(includeProcesses) {
    try {
      const stats = sessionManager.getResourceStats();
      const memUsage = process.memoryUsage();
      
      return {
        success: true,
        server: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024)
        },
        sessions: {
          total: stats.totalSessions,
          maxAllowed: stats.maxSessions
        },
        memory: {
          totalBytes: stats.totalMemoryBytes,
          totalMB: stats.totalMemoryMB
        },
        perSession: includeProcesses ? stats.sessions : undefined
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
