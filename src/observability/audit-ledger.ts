import { promises as fs } from 'fs';
import * as path from 'path';
import type { ObservableAgentEvent } from './contracts';

export interface AuditLedgerOptions {
  rootDir?: string;
  onError?: (error: Error, event: ObservableAgentEvent) => void;
}

export interface AuditLedger {
  readonly rootDir: string;
  append(event: ObservableAgentEvent): Promise<string>;
  flush(): Promise<void>;
}

function utcDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid event timestamp: ${timestamp}`);
  return date.toISOString().slice(0, 10);
}

export function createAuditLedger(options: AuditLedgerOptions = {}): AuditLedger {
  const rootDir = path.resolve(options.rootDir ?? '.runtime-observability');
  let queue: Promise<unknown> = Promise.resolve();

  async function write(event: ObservableAgentEvent): Promise<string> {
    const eventsDir = path.join(rootDir, 'events');
    const filePath = path.join(eventsDir, `${utcDate(event.timestamp)}.jsonl`);
    try {
      await fs.mkdir(eventsDir, { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
      return filePath;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      options.onError?.(error, event);
      throw error;
    }
  }

  return {
    rootDir,
    append(event) {
      const operation = queue.then(() => write(event));
      queue = operation.catch(() => undefined);
      return operation;
    },
    async flush() {
      await queue;
    },
  };
}
