import { randomUUID } from 'crypto';
import type { ObservableAgentEvent, RawObservableEvent } from './contracts';
import { digestCommand, redactValue } from './redaction';

export interface EventNormalizerOptions {
  defaultRunId?: string;
  now?: () => Date;
  createId?: () => string;
}

export function createEventNormalizer(options: EventNormalizerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const defaultRunId = options.defaultRunId ?? 'unassigned';

  return (raw: RawObservableEvent): ObservableAgentEvent => {
    if (!raw.source) throw new Error('Observable event source is required');
    if (!raw.action || raw.action.trim().length === 0) {
      throw new Error('Observable event action is required');
    }

    const timestampValue = raw.timestamp ?? now();
    const timestamp = new Date(timestampValue).toISOString();
    const redacted = redactValue({
      target: raw.target,
      cwd: raw.cwd,
      before: raw.before,
      after: raw.after,
      result: raw.result,
    });

    const event: ObservableAgentEvent = {
      schemaVersion: '1.0',
      eventId: raw.eventId ?? createId(),
      runId: raw.runId ?? defaultRunId,
      taskId: raw.taskId,
      timestamp,
      actor: raw.actor ?? 'system',
      source: raw.source,
      action: raw.action.trim(),
      target: redacted.value.target,
      cwd: redacted.value.cwd,
      riskClass: raw.riskClass ?? 'R0_READ_ONLY',
      evidenceLevel: raw.evidenceLevel ?? 'UNVERIFIED',
      approvalId: raw.approvalId,
      commandDigest: raw.commandDigest ?? (raw.command ? digestCommand(raw.command) : undefined),
      before: redacted.value.before,
      after: redacted.value.after,
      result: redacted.value.result,
      redactions: redacted.redactions.length > 0 ? redacted.redactions : undefined,
    };

    return event;
  };
}
