import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuditLedger } from '../../src/observability/audit-ledger';
import type { ObservableAgentEvent } from '../../src/observability/contracts';

function event(id: string): ObservableAgentEvent {
  return {
    schemaVersion: '1.0',
    eventId: id,
    runId: 'run-1',
    timestamp: '2026-07-16T01:02:03.000Z',
    actor: 'hermes',
    source: 'git',
    action: 'status.observed',
    riskClass: 'R0_READ_ONLY',
    evidenceLevel: 'VERIFIED_OBSERVED',
  };
}

test('ledger appends ordered JSONL records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodds-ledger-'));
  try {
    const ledger = createAuditLedger({ rootDir: root });
    await Promise.all([ledger.append(event('one')), ledger.append(event('two'))]);
    await ledger.flush();
    const content = await fs.readFile(path.join(root, 'events', '2026-07-16.jsonl'), 'utf8');
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.eventId), ['one', 'two']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ledger reports and rethrows write failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodds-ledger-error-'));
  const blockingFile = path.join(root, 'blocked');
  await fs.writeFile(blockingFile, 'not a directory');
  let observed: Error | undefined;
  const ledger = createAuditLedger({ rootDir: blockingFile, onError: error => { observed = error; } });
  try {
    await assert.rejects(ledger.append(event('broken')));
    assert.ok(observed);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
