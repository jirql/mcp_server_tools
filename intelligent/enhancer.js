/**
 * Intelligent Command Enhancer - 智能命令增强器
 * 最小侵入式自动增强命令，自动添加 UA、TLS 指纹等
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { uaPool } from './ua-pool.js';
import { reporter } from './reporter.js';

const CURL_IMPERSONATE_DIR = join(__dirname, '..', 'curl-impersonate');

const TLS_PROFILES = {
  chrome: {
    default: 'chrome131',
    versions: ['chrome99', 'chrome100', 'chrome101', 'chrome104', 'chrome107', 'chrome110', 'chrome116', 'chrome120', 'chrome131'],
  },
  firefox: {
    default: 'firefox133',
    versions: ['firefox91esr', 'firefox95', 'firefox98', 'firefox100', 'firefox102', 'firefox109', 'firefox117', 'firefox133'],
  },
  edge: {
    default: 'chrome131',
    versions: ['edge99', 'edge101'],
  },
  safari: {
    default: 'safari17',
    versions: ['safari15_3', 'safari15_5', 'safari17'],
  },
};

class IntelligentEnhancer {
  constructor() {
    this.enabled = true;
    this.config = {
      autoUA: true,
      autoTLS: true,
      autoBinary: true,
      autoParamHide: false,  // 暂时禁用，需要配置文件支持
      randomUA: true,
    };
  }

  isEnabled() {
    return this.enabled;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  setConfig(config) {
    this.config = { ...this.config, ...config };
  }

  classify(command) {
    const trimmed = command.trim();

    if (/^curl\s/i.test(trimmed)) return 'curl';
    if (/^wget\s/i.test(trimmed)) return 'wget';
    if (/^nmap\s/i.test(trimmed)) return 'nmap';
    if (/^python.*requests?/i.test(trimmed)) return 'python';
    if (/^fetch\s/i.test(trimmed)) return 'fetch';
    if (/^httpie\s/i.test(trimmed)) return 'httpie';

    return 'unknown';
  }

  needsEnhancement(command) {
    const type = this.classify(command);
    if (type === 'unknown') return false;

    const trimmed = command.trim();

    switch (type) {
      case 'curl':
        return this.needsCurlEnhancement(trimmed);
      case 'wget':
        return this.needsWgetEnhancement(trimmed);
      case 'nmap':
        return this.needsNmapEnhancement(trimmed);
      default:
        return false;
    }
  }

  needsCurlEnhancement(cmd) {
    if (!this.config.autoUA && !this.config.autoTLS && !this.config.autoBinary) {
      return false;
    }

    const hasUA = /(-A|--user-agent)\s/i.test(cmd);
    const hasBinaryOverride = /curl_(chrome|firefox|edge|safari)/i.test(cmd);
    const hasTLSProfile = /--tls-profile/i.test(cmd);

    if (this.config.autoUA && !hasUA) return true;
    if (this.config.autoBinary && !hasBinaryOverride) return true;
    if (this.config.autoTLS && !hasTLSProfile) return true;

    return false;
  }

  needsWgetEnhancement(cmd) {
    if (!this.config.autoUA) return false;
    return !/(--user-agent|-U)\s/i.test(cmd);
  }

  needsNmapEnhancement(cmd) {
    if (!this.config.autoUA) return false;
    return !/(--script-args|--script).*http.user-agent/i.test(cmd);
  }

  enhance(command, options = {}) {
    if (!this.enabled) {
      return {
        original: command,
        enhanced: command,
        fullCommand: command,
        changes: [],
        type: this.classify(command),
      };
    }

    const type = this.classify(command);
    let enhanced = command;
    let fullCommand = command;
    let changes = [];

    switch (type) {
      case 'curl': {
        const result = this.enhanceCurl(command, options);
        enhanced = result.enhanced;
        fullCommand = result.fullCommand;
        changes = result.changes;
        break;
      }
      case 'wget': {
        const result = this.enhanceWget(command, options);
        enhanced = result.enhanced;
        fullCommand = result.fullCommand;
        changes = result.changes;
        break;
      }
      case 'nmap': {
        const result = this.enhanceNmap(command, options);
        enhanced = result.enhanced;
        fullCommand = result.fullCommand;
        changes = result.changes;
        break;
      }
      default:
        fullCommand = command;
    }

    return {
      original: command,
      enhanced,
      fullCommand,
      changes,
      type,
    };
  }

  enhanceCurl(command, options = {}) {
    const changes = [];
    let enhanced = command.trim();

    const tlsProfile = options.tlsProfile || 'chrome';
    const tlsVersion = options.tlsVersion || TLS_PROFILES.chrome.default;
    const ua = options.ua || (this.config.randomUA ? uaPool.getRandomDesktop() : uaPool.get('chrome'));

    if (this.config.autoBinary) {
      const hasBinaryOverride = /curl_(chrome|firefox|edge|safari)/i.test(enhanced);
      if (!hasBinaryOverride) {
        const curlBinary = join(CURL_IMPERSONATE_DIR, `curl_${tlsVersion}`);
        enhanced = enhanced.replace(/^curl\s+/i, `${curlBinary} `);
        changes.push({
          type: 'binary',
          before: 'curl',
          after: `curl_${tlsVersion}`,
          reason: `使用 curl-impersonate 增强 TLS 指纹 (${tlsVersion})`,
        });
      }
    }

    if (this.config.autoUA) {
      const hasUA = /(-A|--user-agent)\s/i.test(enhanced);
      if (!hasUA) {
        enhanced += ` -A "${ua}"`;
        changes.push({
          type: 'user_agent',
          before: null,
          after: ua,
          reason: '随机浏览器 UA 模拟真实用户',
        });
      }
    }

    if (this.config.autoParamHide) {
      const hasParamHide = /--config\s/i.test(enhanced);
      if (!hasParamHide) {
        enhanced += " --config /tmp/.curl_enhanced";
        changes.push({
          type: 'param_hide',
          before: null,
          after: true,
          reason: '隐藏命令行参数防止 ps/aux 泄露',
        });
      }
    }

    return {
      enhanced,
      fullCommand: enhanced,
      changes,
    };
  }

  enhanceWget(command, options = {}) {
    const changes = [];
    let enhanced = command.trim();

    const ua = options.ua || uaPool.get('chrome');

    if (this.config.autoUA) {
      const hasUA = /(-U|--user-agent)\s/i.test(enhanced);
      if (!hasUA) {
        enhanced += ` -U "${ua}"`;
        changes.push({
          type: 'user_agent',
          before: null,
          after: ua,
          reason: '添加浏览器 UA 模拟真实用户',
        });
      }
    }

    return {
      enhanced,
      fullCommand: enhanced,
      changes,
    };
  }

  enhanceNmap(command, options = {}) {
    const changes = [];
    let enhanced = command.trim();

    const ua = options.ua || uaPool.get('chrome');

    if (this.config.autoUA) {
      const hasScriptArgs = /--script-args.*http.user-agent/i.test(enhanced);
      if (!hasScriptArgs) {
        const scriptArgsIndex = enhanced.indexOf('--script-args');
        if (scriptArgsIndex === -1) {
          enhanced += ` --script-args http.user-agent="${ua}"`;
        }
        changes.push({
          type: 'user_agent',
          before: null,
          after: ua,
          reason: '在 HTTP 脚本中添加浏览器 UA',
        });
      }
    }

    return {
      enhanced,
      fullCommand: enhanced,
      changes,
    };
  }

  process(command, options = {}) {
    const classified = this.classify(command);
    
    if (classified === 'unknown' || !this.needsEnhancement(command)) {
      return {
        result: reporter.noEnhancementReport(command),
        type: classified,
        needsExecution: false,
      };
    }

    const enhanced = this.enhance(command, options);

    if (enhanced.changes.length === 0) {
      return {
        result: reporter.noEnhancementReport(command, '命令无需增强'),
        type: classified,
        needsExecution: false,
      };
    }

    const report = reporter.buildReport(
      enhanced.original,
      enhanced.enhanced,
      enhanced.changes
    );

    return {
      result: report,
      type: classified,
      enhancedCommand: enhanced.fullCommand,
      needsExecution: true,
    };
  }
}

export const enhancer = new IntelligentEnhancer();
export { IntelligentEnhancer, TLS_PROFILES };
