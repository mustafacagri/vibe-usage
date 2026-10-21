import assert from 'node:assert/strict';
import test from 'node:test';
import { displayOrder, normalizeProviderOrder, visibleProviders } from '../src/shared/catalog.ts';

test('the order work falls back in holds the tools that run it; the order the window shows holds every tool', () => {
  assert.deepEqual(normalizeProviderOrder(['cursor', 'copilot', 'nope']), ['cursor', 'claude', 'codex', 'antigravity']);
  assert.deepEqual(displayOrder({ providerOrder: ['cursor'] }), ['cursor', 'claude', 'codex', 'antigravity', 'copilot']);
  assert.deepEqual(displayOrder({ homeOrder: ['copilot', 'claude'], providerOrder: ['cursor'] }), [
    'copilot',
    'claude',
    'codex',
    'cursor',
    'antigravity'
  ]);
  assert.deepEqual(visibleProviders({ providerOrder: [], hiddenProviders: ['claude', 'copilot'] }), ['codex', 'cursor', 'antigravity']);
});
