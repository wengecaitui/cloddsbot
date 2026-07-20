import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventNormalizer } from '../../src/observability/event-normalizer';
import { createObservableStateProjector } from '../../src/observability/state-projector';

test('state projector records counts and bounded recent IDs', () => {
  let id = 0;
  const normalize = createEventNormalizer({ createId: () => `e${++id}`, defaultRunId: 'run' });
  const projector = createObservableStateProjector(2);
  projector.apply(normalize({ source: 'git', action: 'status', actor: 'hermes' }));
  projector.apply(normalize({ source: 'filesystem', action: 'modify', actor: 'hermes', riskClass: 'R1_REVERSIBLE_WORKSPACE_WRITE' }));
  projector.apply(normalize({ source: 'git', action: 'commit', actor: 'codex', riskClass: 'R2_STATEFUL_OPERATION' }));

  const snapshot = projector.snapshot();
  assert.equal(snapshot.totalEvents, 3);
  assert.equal(snapshot.countsBySource.git, 2);
  assert.equal(snapshot.countsByActor.hermes, 2);
  assert.deepEqual(snapshot.recentEventIds, ['e2', 'e3']);
});

test('snapshot does not expose mutable projector state', () => {
  const normalize = createEventNormalizer({ createId: () => 'e1' });
  const projector = createObservableStateProjector();
  projector.apply(normalize({ source: 'runtime', action: 'health' }));
  const snapshot = projector.snapshot();
  snapshot.recentEventIds.length = 0;
  assert.deepEqual(projector.snapshot().recentEventIds, ['e1']);
});
