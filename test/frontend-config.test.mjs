import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendManualModel,
  buildDiscoveredModelChoices,
  mergeSelectedDiscoveredModels,
} from '../src/frontend-config.mjs';

test('existing discovered models are selected by default and new models are not', () => {
  const existing = [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
  ];
  const discovered = [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT' },
    { name: 'gpt-4.1', provider: 'OPENAI', channel: 'DEFAULT' },
  ];

  const choices = buildDiscoveredModelChoices(existing, discovered);

  assert.equal(choices.length, 2);
  assert.equal(choices[0].exists, true);
  assert.equal(choices[0].selected, true);
  assert.equal(choices[1].exists, false);
  assert.equal(choices[1].selected, false);
});

test('only selected discovered models are merged and duplicates are skipped', () => {
  const existing = [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
  ];
  const choices = [
    { selected: true, exists: true, model: { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT' } },
    { selected: false, exists: false, model: { name: 'gpt-4.1', provider: 'OPENAI', channel: 'DEFAULT' } },
    { selected: true, exists: false, model: { name: 'claude-3-5', provider: 'ANTHROPIC', channel: 'ALT' } },
  ];

  const merged = mergeSelectedDiscoveredModels(existing, choices);

  assert.deepEqual(merged, [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
    { name: 'claude-3-5', provider: 'ANTHROPIC', channel: 'ALT', enabled: true, sortOrder: 20 },
  ]);
});

test('manual model append adds the blank model at the end with tail sort order', () => {
  const models = [
    { name: 'b-model', provider: 'GOOGLE', channel: 'DEFAULT', enabled: true, sortOrder: 20 },
    { name: 'a-model', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
  ];

  const appended = appendManualModel(models, { provider: 'OTHER', channel: 'DEFAULT' });

  assert.equal(appended.length, 3);
  assert.deepEqual(appended.slice(0, 2), models);
  assert.deepEqual(appended[2], {
    name: '',
    provider: 'OTHER',
    channel: 'DEFAULT',
    enabled: true,
    sortOrder: 30,
  });
});
