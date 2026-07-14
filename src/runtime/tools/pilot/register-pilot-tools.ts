// Stage 2B-2B: register-pilot-tools — explicit registration helper
import type { ToolRegistry } from '../ToolRegistry';
import type { ToolSpec } from '../contracts';
import type { IndicatorCalculationPort } from './calculate-indicators-tool';
import { createCalculateIndicatorsTool } from './calculate-indicators-tool';

export interface PilotToolDependencies {
  indicatorCalculation: IndicatorCalculationPort;
}

export function registerPilotTools(registry: ToolRegistry, deps: PilotToolDependencies): void {
  registry.register(createCalculateIndicatorsTool(deps.indicatorCalculation) as ToolSpec);
}
