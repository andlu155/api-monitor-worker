import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendManualModel,
  buildDiscoveredModelChoices,
  mergeSelectedDiscoveredModels,
  summarizeDiscoveredModelChoices,
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
  const existingChoice = choices.find((choice) => choice.model.name === 'gpt-4o');
  const newChoice = choices.find((choice) => choice.model.name === 'gpt-4.1');

  assert.equal(choices.length, 2);
  assert.equal(existingChoice.exists, true);
  assert.equal(existingChoice.selected, true);
  assert.equal(newChoice.exists, false);
  assert.equal(newChoice.selected, false);
});

test('new discovered models are listed before already configured models', () => {
  const choices = buildDiscoveredModelChoices(
    [{ name: 'configured-model', provider: 'OPENAI', channel: 'DEFAULT' }],
    [
      { name: 'configured-model', provider: 'OPENAI', channel: 'DEFAULT' },
      { name: 'new-model', provider: 'OPENAI', channel: 'DEFAULT' },
    ],
  );

  assert.equal(choices[0].model.name, 'new-model');
  assert.equal(choices[0].exists, false);
  assert.equal(choices[1].model.name, 'configured-model');
  assert.equal(choices[1].exists, true);
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

test('discovered model summary separates existing, new, and pending additions', () => {
  const summary = summarizeDiscoveredModelChoices([
    { exists: true, selected: true },
    { exists: false, selected: false },
    { exists: false, selected: true },
    { exists: false, selected: true },
  ]);

  assert.deepEqual(summary, {
    total: 4,
    existing: 1,
    fresh: 3,
    pendingAdd: 2,
  });
});
