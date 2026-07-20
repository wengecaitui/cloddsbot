import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventNormalizer } from '../../src/observability/event-normalizer';

test('normalizer supplies safe defaults and redacts payloads', () => {
  const normalize = createEventNormalizer({
    defaultRunId: 'run-1',
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    createId: () => 'event-1',
  });
  const event = normalize({
    source: 'log',
    action: ' line.observed ',
    command: 'token=secret command',
    after: { authorization: 'Bearer secret' },
  });
  assert.equal(event.eventId, 'event-1');
  assert.equal(event.runId, 'run-1');
  assert.equal(event.action, 'line.observed');
  assert.equal(event.riskClass, 'R0_READ_ONLY');
  assert.equal(event.evidenceLevel, 'UNVERIFIED');
  assert.equal((event.after as { authorization: string }).authorization, '<REDACTED>');
  assert.match(event.commandDigest!, /^sha256:/);
});

test('normalizer rejects missing actions and invalid timestamps', () => {
  const normalize = createEventNormalizer();
  assert.throws(() => normalize({ source: 'git', action: ' ' }), /action is required/);
  assert.throws(
    () => normalize({ source: 'git', action: 'status', timestamp: 'not-a-date' }),
    /Invalid time value/,
  );
});
