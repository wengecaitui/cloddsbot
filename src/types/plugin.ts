// src/types/plugin.ts
// Step 2A.6: Plugin contract (interface only — no runtime)
//
// This file defines the compile-time contract between the core engine and
// third-party indicator plugins.  It is NOT a loader, registry, or manager.
// Sprint 3 will provide the runtime loader that honours these interfaces.
//
// Future compatibility:
//   collector (Series[]) → IndicatorService → Plugin → IndicatorResult[]
//
// Plugins return the same discriminated union defined in Step 2A.4
// (types/indicators/index.ts → IndicatorResult).

import type { Series } from '../data/types';
import type { IndicatorResult } from '../types/indicators';

/** Plugin metadata — declared at import time, not modifiable at runtime. */
export interface PluginMeta {
  /** Unique plugin name (must not collide with built-in indicators). */
  name: string;
  /** SemVer string (e.g. "1.0.0"). */
  version: string;
  /** Optional human-readable description. */
  description?: string;
  /** Author string (e.g. "username" or "org-name"). */
  author?: string;
}

/**
 * Minimal indicator plugin interface.
 *
 * A plugin receives a Series[] array (the same shape that flows through
 * IndicatorService → PythonBridgeDaemon → daemon.py) and must return one
 * or more typed IndicatorResult values.
 *
 * The `calculate` method is the only required function.
 * No enable/disable, no dependency graph, no hot-reload.
 */
export interface IIndicatorPlugin {
  /** Static metadata describing this plugin. */
  meta: PluginMeta;

  /**
   * Compute indicator values from an OHLCV series.
   *
   * @param series  K-line array (most recent last).
   * @returns       One or more typed IndicatorResult values.
   *                Must use the existing discriminated union from Step 2A.4.
   */
  calculate(series: Series[]): Promise<IndicatorResult | IndicatorResult[]>;
}
