import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObservableEventSink, ObservableEventSourceAdapter } from '../../src/observability/contracts';
import { createObservableMonitor } from '../../src/observability/monitor';
import { createObservableStateProjector } from '../../src/observability/state-projector';

class FakeSource implements ObservableEventSourceAdapter {
  readonly name = 'fake';
  starts = 0;
  stops = 0;
  sink?: ObservableEventSink;
  start(sink: ObservableEventSink) { this.starts += 1; this.sink = sink; }
  stop() { this.stops += 1; }
}

test('monitor lifecycle is idempotent and projects ingested events', async () => {
  const source = new FakeSource();
  const projector = createObservableStateProjector();
  const monitor = createObservableMonitor({ sources: [source], projector, defaultRunId: 'run' });
  await monitor.start();
  await monitor.start();
  assert.equal(source.starts, 1);
  await source.sink!.emit({ source: 'process', action: 'started', evidenceLevel: 'VERIFIED_OBSERVED' });
  assert.equal(projector.snapshot().totalEvents, 1);
  await monitor.stop();
  await monitor.stop();
  assert.equal(source.stops, 1);
});

test('monitor stops already started sources when startup fails', async () => {
  const first = new FakeSource();
  const broken: ObservableEventSourceAdapter = {
    name: 'broken',
    start() { throw new Error('start failed'); },
    stop() {},
  };
  const monitor = createObservableMonitor({
    sources: [first, broken],
    projector: createObservableStateProjector(),
  });
  await assert.rejects(monitor.start(), /start failed/);
  assert.equal(first.stops, 1);
  assert.equal(monitor.isRunning, false);
});
