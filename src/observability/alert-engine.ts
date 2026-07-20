import { randomUUID } from 'crypto';
import { compareRiskClass, type ObservableAgentEvent, type RiskClass } from './contracts';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type ApprovalCorrelation = 'NOT_REQUIRED' | 'ID_PRESENT' | 'MISSING';

export interface ObservableAlert {
  schemaVersion: '1.0';
  alertId: string;
  ruleId: string;
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  eventId: string;
  action: string;
  target?: string;
  riskClass: RiskClass;
  approval: ApprovalCorrelation;
  approvalId?: string;
}

export interface AlertEngineOptions {
  maxAlerts?: number;
  dedupeWindowMs?: number;
  approvalRequiredAtOrAbove?: RiskClass;
  now?: () => Date;
  createId?: () => string;
  disabledRules?: string[];
}

export interface ObservableAlertEngine {
  evaluate(event: ObservableAgentEvent): ObservableAlert[];
  snapshot(): ObservableAlert[];
}

interface AlertCandidate {
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  message: string;
}

export function createObservableAlertEngine(options: AlertEngineOptions = {}): ObservableAlertEngine {
  const maxAlerts = options.maxAlerts ?? 200;
  const dedupeWindowMs = options.dedupeWindowMs ?? 60_000;
  const approvalThreshold = options.approvalRequiredAtOrAbove ?? 'R2_STATEFUL_OPERATION';
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const disabled = new Set(options.disabledRules ?? []);
  if (!Number.isInteger(maxAlerts) || maxAlerts <= 0) throw new Error('maxAlerts must be a positive integer');
  if (!Number.isInteger(dedupeWindowMs) || dedupeWindowMs < 0) throw new Error('dedupeWindowMs must be a non-negative integer');
  const alerts: ObservableAlert[] = [];

  function candidates(event: ObservableAgentEvent): AlertCandidate[] {
    const result: AlertCandidate[] = [];
    const requiresApproval = compareRiskClass(event.riskClass, approvalThreshold) >= 0;
    if (event.action === 'runtime.degraded' || (event.source === 'process' && event.result?.ok === false)) {
      result.push({ ruleId: 'runtime-unhealthy', severity: 'critical', title: 'Hermes 运行状态异常', message: event.result?.summary ?? '进程、端口或健康检查出现异常。' });
    }
    if (event.action === 'log.error') {
      result.push({ ruleId: 'hermes-log-error', severity: 'warning', title: 'Hermes 日志错误', message: 'Hermes 日志出现 ERROR、异常、崩溃或超时信号。' });
    }
    if (event.action === 'git.head_changed') {
      result.push({ ruleId: 'git-head-changed', severity: event.approvalId ? 'info' : 'warning', title: 'Git HEAD 已变化', message: event.approvalId ? '检测到具有关联审批的 HEAD 变化。' : '检测到未关联审批记录的 HEAD 变化。' });
    }
    if (requiresApproval && !event.approvalId) {
      result.push({
        ruleId: 'approval-missing',
        severity: compareRiskClass(event.riskClass, 'R3_DESTRUCTIVE_OR_SYSTEM_CHANGE') >= 0 ? 'critical' : 'warning',
        title: '高风险事件缺少审批关联',
        message: `${event.riskClass} 事件没有 approvalId，仅能确认可观察事件，不能确认已获批准。`,
      });
    } else if (requiresApproval && event.approvalId) {
      result.push({ ruleId: 'approval-correlated', severity: 'info', title: '审批已关联', message: `${event.riskClass} 事件关联审批 ${event.approvalId}。` });
    }
    return result.filter(item => !disabled.has(item.ruleId));
  }

  function correlation(event: ObservableAgentEvent): ApprovalCorrelation {
    if (compareRiskClass(event.riskClass, approvalThreshold) < 0) return 'NOT_REQUIRED';
    return event.approvalId ? 'ID_PRESENT' : 'MISSING';
  }

  return {
    evaluate(event) {
      const timestamp = now().toISOString();
      return candidates(event).map(candidate => {
        const fingerprint = `${candidate.ruleId}|${event.action}|${event.target ?? ''}`;
        const prior = [...alerts].reverse().find(alert => alert.fingerprint === fingerprint
          && new Date(timestamp).getTime() - new Date(alert.lastSeenAt).getTime() <= dedupeWindowMs);
        if (prior) {
          prior.lastSeenAt = timestamp;
          prior.occurrences += 1;
          prior.eventId = event.eventId;
          prior.message = candidate.message;
          prior.severity = candidate.severity;
          prior.title = candidate.title;
          prior.action = event.action;
          prior.target = event.target;
          prior.riskClass = event.riskClass;
          prior.approval = correlation(event);
          prior.approvalId = event.approvalId;
          return structuredClone(prior);
        }
        const alert: ObservableAlert = {
          schemaVersion: '1.0', alertId: createId(), ruleId: candidate.ruleId, fingerprint,
          severity: candidate.severity, title: candidate.title, message: candidate.message,
          firstSeenAt: timestamp, lastSeenAt: timestamp, occurrences: 1,
          eventId: event.eventId, action: event.action, target: event.target,
          riskClass: event.riskClass, approval: correlation(event), approvalId: event.approvalId,
        };
        alerts.push(alert);
        if (alerts.length > maxAlerts) alerts.shift();
        return structuredClone(alert);
      });
    },
    snapshot() { return structuredClone(alerts); },
  };
}
