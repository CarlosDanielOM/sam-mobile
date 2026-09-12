import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SYSTEM_PROMPT, effectivePrompt } from './agents.ts';

test('empty stored prompt falls back to the agent default', () => {
  assert.equal(effectivePrompt(undefined, DEFAULT_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT);
  assert.equal(effectivePrompt('   ', DEFAULT_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT);
  assert.equal(effectivePrompt('Be terse.', DEFAULT_SYSTEM_PROMPT), 'Be terse.');
});
