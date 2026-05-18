/**
 * Enhancement Reporter - 智能增强报告生成器
 * 生成结构化的增强报告，让 AI 清晰地了解命令被如何增强
 */

export class EnhancementReporter {
  constructor() {
    this.version = '1.0.0';
  }

  buildReport(original, enhanced, changes, executionResult = null) {
    const report = {
      applied: true,
      version: this.version,
      timestamp: new Date().toISOString(),
      changes: changes.map(change => this.formatChange(change)),
      original_command: original,
      actual_command: enhanced.fullCommand,
      summary: this.generateSummary(changes),
    };

    if (executionResult) {
      report.execution = {
        success: executionResult.success ?? true,
        exit_code: executionResult.code ?? 0,
        duration_ms: executionResult.duration ?? 0,
      };
    }

    return report;
  }

  formatChange(change) {
    const typeLabels = {
      binary: '🔄 二进制替换',
      user_agent: '🎭 UA 伪装',
      tls_fingerprint: '🔐 TLS 指纹',
      param_hide: '🔒 参数隐藏',
      encoding: '📦 编码处理',
      header: '📋 请求头',
    };

    const typeLabel = typeLabels[change.type] || `• ${change.type}`;

    return {
      type: change.type,
      label: typeLabel,
      before: change.before,
      after: change.after,
      reason: change.reason,
    };
  }

  generateSummary(changes) {
    if (changes.length === 0) {
      return '命令未被增强';
    }

    const types = changes.map(c => c.type);
    const summaries = [];

    if (types.includes('binary')) {
      summaries.push('已替换为 curl-impersonate 增强二进制');
    }
    if (types.includes('user_agent')) {
      summaries.push('已添加随机浏览器 UA');
    }
    if (types.includes('tls_fingerprint')) {
      summaries.push('已配置 TLS 指纹');
    }
    if (types.includes('param_hide')) {
      summaries.push('已启用参数隐藏保护');
    }
    if (types.includes('encoding')) {
      summaries.push('已处理编码问题');
    }

    return summaries.join(' | ');
  }

  buildHumanReadable(report) {
    const lines = [];

    lines.push('');
    lines.push('═'.repeat(60));
    lines.push('🛡️  智能增强报告');
    lines.push('═'.repeat(60));
    lines.push(`⏱️  时间: ${report.timestamp}`);
    lines.push(`📝 原命令: ${report.original_command}`);
    lines.push('');

    if (report.changes.length > 0) {
      lines.push('📊 增强项目:');
      for (const change of report.changes) {
        lines.push(`   ${change.label}`);
        if (change.before === null) {
          lines.push(`      + 新增: ${change.after}`);
        } else {
          lines.push(`      - 从: ${change.before}`);
          lines.push(`      + 改为: ${change.after}`);
        }
        lines.push(`      💡 原因: ${change.reason}`);
        lines.push('');
      }
    }

    lines.push('─'.repeat(60));
    lines.push('🚀 实际执行的命令:');
    lines.push(`   ${report.actual_command}`);
    lines.push('═'.repeat(60));
    lines.push('');

    if (report.execution) {
      lines.push(`✅ 执行结果: ${report.execution.success ? '成功' : '失败'} (退出码: ${report.execution.exit_code})`);
      if (report.execution.duration_ms) {
        lines.push(`⏱️  耗时: ${report.execution.duration_ms}ms`);
      }
    }

    return lines.join('\n');
  }

  noEnhancementReport(original, reason = '命令无需增强') {
    return {
      applied: false,
      version: this.version,
      timestamp: new Date().toISOString(),
      original_command: original,
      reason: reason,
      changes: [],
      summary: reason,
    };
  }
}

export const reporter = new EnhancementReporter();
