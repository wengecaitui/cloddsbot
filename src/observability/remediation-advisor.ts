import type { ObservableAlert } from './alert-engine';

export type RemediationPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type RemediationStatus = 'VERIFY_FIRST' | 'REVIEW_REQUIRED' | 'APPROVAL_REQUIRED';

export interface RemediationRecommendation {
  schemaVersion: '1.0';
  recommendationId: string;
  alertId: string;
  ruleId: string;
  priority: RemediationPriority;
  status: RemediationStatus;
  title: string;
  diagnosis: string;
  possibleImpact: string;
  steps: string[];
  verification: string[];
  requiresApproval: boolean;
  autoFixAvailable: false;
  evidenceEventId: string;
  updatedAt: string;
}

export interface RemediationAdvisor {
  recommend(alert: ObservableAlert): RemediationRecommendation | undefined;
  snapshot(): RemediationRecommendation[];
}

export function createRemediationAdvisor(maxRecommendations = 100): RemediationAdvisor {
  if (!Number.isInteger(maxRecommendations) || maxRecommendations <= 0) {
    throw new Error('maxRecommendations must be a positive integer');
  }
  const recommendations = new Map<string, RemediationRecommendation>();

  function build(alert: ObservableAlert): RemediationRecommendation | undefined {
    const base = {
      schemaVersion: '1.0' as const,
      recommendationId: `recommendation:${alert.alertId}`,
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      autoFixAvailable: false as const,
      evidenceEventId: alert.eventId,
      updatedAt: alert.lastSeenAt,
    };
    if (alert.ruleId === 'runtime-unhealthy') return {
      ...base, priority: 'HIGH', status: 'VERIFY_FIRST', requiresApproval: false,
      title: '先定位哪一项运行检查失败',
      diagnosis: '监控确认进程、端口或健康接口至少一项异常，但这还不足以确定根因。',
      possibleImpact: 'Dashboard 数据可能停止更新，Hermes Gateway 或渠道连接可能不可用。',
      steps: ['查看“系统健康”中标红的具体项目。', '只读检查 Gateway PID、8642/60825 端口和 /health。', '查看同一时间附近的 Hermes ERROR 日志。', '确认根因后再决定是否重启对应进程。'],
      verification: ['健康接口恢复 HTTP 200。', '目标端口重新处于监听状态。', '连续两个监控周期不再产生 runtime.degraded。'],
    };
    if (alert.ruleId === 'hermes-log-error') return {
      ...base, priority: alert.severity === 'critical' ? 'HIGH' : 'MEDIUM', status: 'REVIEW_REQUIRED', requiresApproval: false,
      title: '检查错误上下文，避免按关键词盲修',
      diagnosis: '日志出现错误、异常、崩溃或超时关键词；单行日志可能是根因，也可能只是后续症状。',
      possibleImpact: '对应工具、任务或渠道可能失败，也可能已经自动重试恢复。',
      steps: ['打开该告警关联的事件证据。', '按时间和任务 ID 查找前后日志。', '确认错误是否重复、是否自动恢复、影响哪个模块。', '形成最小修复方案后再修改代码或配置。'],
      verification: ['复现路径不再出现相同错误。', '相关定向测试通过。', 'Hermes 后续任务或工具调用成功完成。'],
    };
    if (alert.ruleId === 'git-head-changed') return {
      ...base, priority: 'MEDIUM', status: alert.approval === 'ID_PRESENT' ? 'VERIFY_FIRST' : 'APPROVAL_REQUIRED', requiresApproval: alert.approval !== 'ID_PRESENT',
      title: '确认 Git 版本变化是否符合当前任务',
      diagnosis: '监控观察到 HEAD 变化，但不能仅凭版本变化确认执行者和业务意图。',
      possibleImpact: '正在进行的工作可能基于新的代码基线，存在并发覆盖或验证失真的风险。',
      steps: ['只读查看最新提交摘要和作者时间。', '比较 HEAD、upstream 与工作树。', '确认提交是否属于当前批准范围。', '若存在未知并发修改，停止覆盖并报告冲突。'],
      verification: ['HEAD 与预期基线一致。', '工作树中的文件归属清楚。', '审批引用或用户确认已记录。'],
    };
    if (alert.ruleId === 'approval-missing') return {
      ...base, priority: alert.severity === 'critical' ? 'HIGH' : 'MEDIUM', status: 'APPROVAL_REQUIRED', requiresApproval: true,
      title: '高风险动作先补充审批证据',
      diagnosis: `${alert.riskClass} 事件没有可观察的 approvalId；这不证明未授权，但证据链不完整。`,
      possibleImpact: '继续执行可能超出批准边界，后续无法可靠审计责任和范围。',
      steps: ['暂停同类高风险动作。', '确认用户批准的具体范围和目标。', '记录 approvalId 或等价审批证据。', '重新核对操作前状态后再执行。'],
      verification: ['事件包含可追踪的审批引用。', '审批范围覆盖目标、动作和风险等级。', '执行后的 diff 与批准范围一致。'],
    };
    if (alert.severity === 'info') return undefined;
    return {
      ...base, priority: alert.severity === 'critical' ? 'HIGH' : 'MEDIUM', status: 'REVIEW_REQUIRED', requiresApproval: false,
      title: '先核实证据，再决定是否整改',
      diagnosis: alert.message,
      possibleImpact: '当前规则没有足够信息自动确定影响范围。',
      steps: ['查看关联事件和目标。', '确认是否持续发生。', '识别最小影响范围。', '选择可回滚的最小修复。'],
      verification: ['相关告警不再重复。', '定向验证通过。'],
    };
  }

  return {
    recommend(alert) {
      const recommendation = build(alert);
      if (!recommendation) return undefined;
      recommendations.set(recommendation.recommendationId, recommendation);
      while (recommendations.size > maxRecommendations) {
        recommendations.delete(recommendations.keys().next().value as string);
      }
      return structuredClone(recommendation);
    },
    snapshot() { return structuredClone([...recommendations.values()]); },
  };
}
