// Stage 2B-1.7: Contracts tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  formatToolOutput,
  MAX_TOOL_CONTENT_CHARS,
  ToolInputValidationError,
} from '../../../src/runtime/tools/contracts';
import type { ToolSpec } from '../../../src/runtime/tools/contracts';

void describe('formatToolOutput', () => {
  void it('returns string unchanged', () => {
    const spec = {} as ToolSpec;
    assert.strictEqual(formatToolOutput(spec, 'hello'), 'hello');
  });

  void it('converts undefined to empty string', () => {
    const spec = {} as ToolSpec;
    assert.strictEqual(formatToolOutput(spec, undefined), '');
  });

  void it('JSON-serializes object', () => {
    const spec = {} as ToolSpec;
    assert.strictEqual(formatToolOutput(spec, { a: 1 }), '{"a":1}');
  });

  void it('JSON-serializes array', () => {
    const spec = {} as ToolSpec;
    assert.strictEqual(formatToolOutput(spec, [1, 2, 3]), JSON.stringify([1, 2, 3]));
  });

  void it('uses custom formatContent when provided', () => {
    const spec = { formatContent: (o: number) => `c:${o}` } as ToolSpec;
    assert.strictEqual(formatToolOutput(spec, 42), 'c:42');
  });

  void it('does not crash on circular reference', () => {
    const spec = {} as ToolSpec;
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    assert.doesNotThrow(() => formatToolOutput(spec, obj));
  });
});

void describe('MAX_TOOL_CONTENT_CHARS', () => {
  void it('equals 30000', () => {
    assert.strictEqual(MAX_TOOL_CONTENT_CHARS, 30_000);
  });
});

void describe('ToolInputValidationError', () => {
  void it('stores toolName and message', () => {
    const err = new ToolInputValidationError('my_tool', 'bad input');
    assert.ok(err.message.includes('my_tool'));
    assert.ok(err.message.includes('bad input'));
    assert.strictEqual(err.toolName, 'my_tool');
  });
});
