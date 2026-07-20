import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestCommand, redactText, redactValue } from '../../src/observability/redaction';

test('redactText removes bearer and inline secrets', () => {
  const result = redactText('Authorization: Bearer abc.def token=hello safe=value');
  assert.equal(result.value.includes('abc.def'), false);
  assert.equal(result.value.includes('hello'), false);
  assert.match(result.value, /<REDACTED>/);
});

test('redactValue is recursive and does not mutate input', () => {
  const input = { nested: { apiKey: 'secret-value', safe: 'ok' } };
  const result = redactValue(input);
  assert.equal(result.value.nested.apiKey, '<REDACTED>');
  assert.equal(result.value.nested.safe, 'ok');
  assert.equal(input.nested.apiKey, 'secret-value');
});

test('command digest is stable without retaining command content', () => {
  const first = digestCommand('git status --short');
  const second = digestCommand('git status --short');
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes('git status'), false);
});
