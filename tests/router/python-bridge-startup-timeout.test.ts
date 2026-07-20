import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PYTHON_BRIDGE_STARTUP_TIMEOUT_MS,
  PythonBridgeDaemon,
} from '../../src/router/PythonBridgeDaemon';

function configuredTimeout(bridge: PythonBridgeDaemon): number {
  return (bridge as unknown as { startupTimeoutMs: number }).startupTimeoutMs;
}

test('Python bridge keeps cold-start timeout separate from calculate timeout', () => {
  const bridge = new PythonBridgeDaemon('quant_engine/daemon.py');
  assert.equal(PYTHON_BRIDGE_STARTUP_TIMEOUT_MS, 15_000);
  assert.equal(configuredTimeout(bridge), 15_000);
});

test('Python bridge accepts an explicit cold-start timeout', () => {
  const bridge = new PythonBridgeDaemon({
    scriptPath: 'quant_engine/daemon.py',
    startupTimeoutMs: 30_000,
  });
  assert.equal(configuredTimeout(bridge), 30_000);
});

test('Python bridge rejects invalid cold-start timeouts before spawning', () => {
  for (const startupTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new PythonBridgeDaemon({
        scriptPath: 'quant_engine/daemon.py',
        startupTimeoutMs,
      }),
      /startupTimeoutMs must be a positive integer/,
    );
  }
});
