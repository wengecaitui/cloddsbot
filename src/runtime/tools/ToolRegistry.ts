// =============================================================================
// Stage 2B-1: ToolRegistry — 中央工具注册表
// =============================================================================
//
// Dependencies: contracts only (ToolSpec).
// NO import from: agents / gateway / cron / skills / trading / PythonBridge.
// =============================================================================

import type { ToolSpec } from './contracts';

/** Tool name pattern: starts with lowercase, 2-64 chars, a-z0-9_.- */
const NAME_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export interface ToolRegistry {
  register(spec: ToolSpec): void;
  get(name: string): ToolSpec | null;
  has(name: string): boolean;
  list(): string[];
  schemaList(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  freeze(): void;
  isFrozen(): boolean;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolSpec>();
  let frozen = false;

  return {
    register(spec: ToolSpec): void {
      if (frozen) {
        throw new Error(`ToolRegistry is frozen — cannot register '${spec.name}'`);
      }
      if (!NAME_RE.test(spec.name)) {
        throw new Error(`Invalid tool name '${spec.name}': must match ^[a-z][a-z0-9_.-]{1,63}$`);
      }
      if (tools.has(spec.name)) {
        throw new Error(`Tool '${spec.name}' is already registered`);
      }
      tools.set(spec.name, spec);
    },

    get(name: string): ToolSpec | null {
      const spec = tools.get(name);
      return spec ?? null;
    },

    has(name: string): boolean {
      return tools.has(name);
    },

    list(): string[] {
      return Array.from(tools.keys());
    },

    schemaList(): Array<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }> {
      const list: Array<{
        type: 'function';
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }> = [];
      tools.forEach((spec, name) => {
        if (spec.riskClass === 'LIVE_EXECUTION_DISABLED') return;
        list.push({
          type: 'function',
          function: {
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
          },
        });
      });
      return list;
    },

    freeze(): void {
      frozen = true;
    },

    isFrozen(): boolean {
      return frozen;
    },
  };
}
