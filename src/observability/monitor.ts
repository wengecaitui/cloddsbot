import type {
  ObservableAgentEvent,
  ObservableEventSink,
  ObservableEventSourceAdapter,
  RawObservableEvent,
} from './contracts';
import type { AuditLedger } from './audit-ledger';
import type { ObservableStateProjector } from './state-projector';
import { createEventNormalizer } from './event-normalizer';

export interface ObservableMonitorOptions {
  sources?: ObservableEventSourceAdapter[];
  ledger?: AuditLedger;
  projector: ObservableStateProjector;
  defaultRunId?: string;
  onEvent?: (event: ObservableAgentEvent) => void | Promise<void>;
  onError?: (error: Error, context: string) => void;
}

export interface ObservableMonitor {
  readonly isRunning: boolean;
  readonly sink: ObservableEventSink;
  start(): Promise<void>;
  stop(): Promise<void>;
  ingest(event: RawObservableEvent): Promise<ObservableAgentEvent>;
}

export function createObservableMonitor(options: ObservableMonitorOptions): ObservableMonitor {
  const sources = [...(options.sources ?? [])];
  const normalize = createEventNormalizer({ defaultRunId: options.defaultRunId });
  let running = false;
  let operationQueue: Promise<unknown> = Promise.resolve();

  async function process(raw: RawObservableEvent): Promise<ObservableAgentEvent> {
    const event = normalize(raw);
    if (options.ledger) await options.ledger.append(event);
    options.projector.apply(event);
    await options.onEvent?.(event);
    return event;
  }

  function ingest(raw: RawObservableEvent): Promise<ObservableAgentEvent> {
    const operation = operationQueue.then(() => process(raw));
    operationQueue = operation.catch(() => undefined);
    return operation;
  }

  const sink: ObservableEventSink = {
    async emit(raw): Promise<void> {
      await ingest(raw);
    },
  };

  return {
    get isRunning() { return running; },
    sink,
    async start() {
      if (running) return;
      const started: ObservableEventSourceAdapter[] = [];
      try {
        for (const source of sources) {
          await source.start(sink);
          started.push(source);
        }
        running = true;
      } catch (cause) {
        for (const source of started.reverse()) {
          try { await source.stop(); } catch { /* best-effort startup rollback */ }
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        options.onError?.(error, 'monitor.start');
        throw error;
      }
    },
    async stop() {
      if (!running) return;
      const failures: Error[] = [];
      for (const source of [...sources].reverse()) {
        try { await source.stop(); } catch (cause) {
          failures.push(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
      running = false;
      await operationQueue;
      await options.ledger?.flush();
      if (failures.length > 0) {
        const error = new AggregateError(failures, 'One or more observable sources failed to stop');
        options.onError?.(error, 'monitor.stop');
        throw error;
      }
    },
    ingest,
  };
}
