// Stage 4A3-R3: Atomic transition helper — activeTransition set BEFORE any await.
import type { PaperRuntimeLifecycleSnapshot, PaperRuntimeLifecycleState, LifecycleOperation, ActiveTransition } from './PaperLifecycle';

/** Begin an atomic lifecycle transition. The activeTransition is set synchronously before any code executes. */
export function beginTransition(
  record: {
    activeTransition: ActiveTransition | null;
    state: PaperRuntimeLifecycleState;
  },
  operation: LifecycleOperation,
  execute: () => Promise<PaperRuntimeLifecycleSnapshot>,
): Promise<PaperRuntimeLifecycleSnapshot> {
  // Create promise synchronously — execute() runs in next microtask
  const promise = Promise.resolve().then(execute);
  const token: ActiveTransition = { operation, promise };
  record.activeTransition = token;
  // Chain cleanup — only clear if still this token
  return promise.then(
    result => { if (record.activeTransition === token) record.activeTransition = null; return result; },
    error => { if (record.activeTransition === token) record.activeTransition = null; throw error; },
  );
}
