import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefaultConfig,
  mergeConfigUpdate,
  sanitizeConfig,
  runHealthCheck,
  discoverModels,
  labelProvider,
  labelChannel,
  inferProvider,
  shouldRunScheduledCheck,
  sortConfiguredModels,
} from '../src/monitor-core.mjs';

test('builds a usable default config from environment values', () => {
  const config = buildDefaultConfig({
    TARGET_API_URL: 'https://example.test/v1',
    API_KEY: 'sk-live-secret',
    POLL_INTERVAL: '5',
  });

  assert.equal(config.targetApiUrl, 'https://example.test/v1');
  assert.equal(config.apiKey, 'sk-live-secret');
  assert.equal(config.pollIntervalMinutes, 5);
  assert.equal(config.requestTimeoutMs, 10000);
  assert.equal(config.maxModelsToPing, 20);
  assert.equal(config.thresholds.warnLatencyMs, 3000);
  assert.equal(config.thresholds.errorLatencyMs, 10000);
  assert.ok(config.providers.some((provider) => provider.id === 'OPENAI' && provider.label === 'OpenAI'));
  assert.ok(config.channels.some((channel) => channel.id === 'DEFAULT' && channel.label === '默认渠道'));
  assert.deepEqual(config.homeImage, {
    enabled: false,
    url: '/assets/api-monitor-hero.png',
  });
});

test('sanitizeConfig masks sensitive values without exposing the real API key', () => {
  const sanitized = sanitizeConfig(
    buildDefaultConfig({
      TARGET_API_URL: 'https://example.test/v1',
      API_KEY: 'sk-1234567890abcdef',
    }),
  );

  assert.equal(sanitized.apiKey, undefined);
  assert.equal(sanitized.apiKeyMasked, 'sk-1***********cdef');
  assert.ok(Array.isArray(sanitized.providers));
  assert.ok(Array.isArray(sanitized.channels));
});

test('mergeConfigUpdate preserves custom provider and channel options', () => {
  const current = buildDefaultConfig({
    TARGET_API_URL: 'https://example.test/v1',
    API_KEY: 'sk-test',
  });

  const merged = mergeConfigUpdate(current, {
    providers: [
      { id: 'OPENAI', label: 'OpenAI' },
      { id: 'LOCAL', label: '本地供应商' },
    ],
    channels: [
      { id: 'DEFAULT', label: '默认渠道' },
      { id: 'BACKUP', label: '备用渠道' },
    ],
    models: [
      { name: 'local-model', provider: 'LOCAL', channel: 'BACKUP', enabled: true, sortOrder: 10 },
    ],
  });

  assert.deepEqual(merged.providers, [
    { id: 'OPENAI', label: 'OpenAI' },
    { id: 'LOCAL', label: '本地供应商' },
  ]);
  assert.deepEqual(merged.channels, [
    { id: 'DEFAULT', label: '默认渠道' },
    { id: 'BACKUP', label: '备用渠道' },
  ]);
  assert.equal(labelProvider('LOCAL', merged.providers), '本地供应商');
  assert.equal(labelChannel('BACKUP', merged.channels), '备用渠道');
});

test('mergeConfigUpdate preserves homepage image settings', () => {
  const merged = mergeConfigUpdate(buildDefaultConfig(), {
    homeImage: {
      enabled: true,
      url: ' https://example.test/hero.png ',
    },
  });

  assert.deepEqual(merged.homeImage, {
    enabled: true,
    url: 'https://example.test/hero.png',
  });
});

test('legacy model providers and channels are added to option lists', () => {
  const merged = mergeConfigUpdate(buildDefaultConfig(), {
    providers: [],
    channels: [],
    models: [
      { name: 'custom-model', provider: 'CUSTOMAI', channel: 'EDGE', enabled: true, sortOrder: 10 },
    ],
  });

  assert.deepEqual(merged.providers, [{ id: 'CUSTOMAI', label: 'CUSTOMAI' }]);
  assert.deepEqual(merged.channels, [{ id: 'EDGE', label: 'EDGE' }]);
});

test('mergeConfigUpdate preserves existing API key when submitted value is empty', () => {
  const current = buildDefaultConfig({
    TARGET_API_URL: 'https://old.test/v1',
    API_KEY: 'sk-existing-secret',
  });

  const merged = mergeConfigUpdate(current, {
    targetApiUrl: 'https://new.test/v1',
    apiKey: '',
    pollIntervalMinutes: 10,
    models: [
      { name: 'gpt-4o', provider: 'OPENAI', channel: 'VIP', enabled: true },
    ],
  });

  assert.equal(merged.targetApiUrl, 'https://new.test/v1');
  assert.equal(merged.apiKey, 'sk-existing-secret');
  assert.equal(merged.pollIntervalMinutes, 10);
  assert.deepEqual(merged.models, [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'VIP', enabled: true, sortOrder: 9999 },
  ]);
});

test('runHealthCheck skips disabled models and classifies latency using configured thresholds', async () => {
  const config = mergeConfigUpdate(
    buildDefaultConfig({
      TARGET_API_URL: 'https://example.test/v1',
      API_KEY: 'sk-test',
    }),
    {
      thresholds: { warnLatencyMs: 50, errorLatencyMs: 100 },
      requestTimeoutMs: 500,
      models: [
        { name: 'fast-model', provider: 'OPENAI', channel: 'DEFAULT', enabled: true },
        { name: 'off-model', provider: 'OPENAI', channel: 'DEFAULT', enabled: false },
      ],
    },
  );

  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const results = await runHealthCheck({
    config,
    historyData: {},
    fetchImpl,
    now: (() => {
      const values = [1_000, 1_075, 1_075];
      return () => values.shift() ?? 1_075;
    })(),
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].body.model, 'fast-model');
  assert.equal(results.statuses.length, 1);
  assert.equal(results.statuses[0].status, 'warn');
  assert.equal(results.statuses[0].latency, 75);
  assert.equal(results.statuses[0].availability, 100);
});

test('discoverModels fetches model ids and infers providers for configuration import', async () => {
  const config = buildDefaultConfig({
    TARGET_API_URL: 'https://example.test/v1',
    API_KEY: 'sk-test',
  });

  const models = await discoverModels({
    config,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://example.test/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer sk-test');
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o' },
            { id: 'claude-3-5-sonnet' },
            { id: 'gemini-1.5-pro' },
          ],
        }),
      };
    },
  });

  assert.deepEqual(models, [
    { name: 'gpt-4o', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
    { name: 'claude-3-5-sonnet', provider: 'ANTHROPIC', channel: 'DEFAULT', enabled: true, sortOrder: 20 },
    { name: 'gemini-1.5-pro', provider: 'GOOGLE', channel: 'DEFAULT', enabled: true, sortOrder: 30 },
  ]);
});

test('labels provider and channel values in Chinese for display', () => {
  assert.equal(labelProvider('OPENAI'), 'OpenAI');
  assert.equal(labelProvider('DEEPSEEK'), 'DeepSeek');
  assert.equal(labelProvider('MINIMAXAI'), 'MiniMax');
  assert.equal(labelProvider('OTHER'), '其他');
  assert.equal(labelChannel('DEFAULT'), '默认渠道');
  assert.equal(labelChannel('VIP'), '高级渠道');
});

test('infers deepseek and minimaxai providers from model names', () => {
  assert.equal(inferProvider('deepseek-chat'), 'DEEPSEEK');
  assert.equal(inferProvider('minimaxai-abcd'), 'MINIMAXAI');
});

test('sorts configured models by provider order then model order', () => {
  const models = sortConfiguredModels([
    { name: 'z-1', provider: 'OPENAI', sortOrder: 20 },
    { name: 'a-1', provider: 'DEEPSEEK', sortOrder: 10 },
    { name: 'b-1', provider: 'GOOGLE', sortOrder: 5 },
    { name: 'c-1', provider: 'OPENAI', sortOrder: 5 },
    { name: 'd-1', provider: 'MINIMAXAI', sortOrder: 1 },
  ]);

  assert.deepEqual(models.map((model) => model.name), [
    'c-1',
    'z-1',
    'b-1',
    'a-1',
    'd-1',
  ]);
});

test('sorts multi-channel model entries by model order then channel order', () => {
  const config = mergeConfigUpdate(buildDefaultConfig(), {
    channels: [
      { id: 'VIP', label: '高级渠道' },
      { id: 'DEFAULT', label: '默认渠道' },
      { id: 'BACKUP', label: '备用渠道' },
    ],
    models: [
      { name: 'later', provider: 'OPENAI', channel: 'DEFAULT', sortOrder: 20 },
      { name: 'first', provider: 'OPENAI', channel: 'BACKUP', sortOrder: 10 },
      { name: 'first', provider: 'OPENAI', channel: 'VIP', sortOrder: 10 },
      { name: 'first', provider: 'OPENAI', channel: 'DEFAULT', sortOrder: 10 },
    ],
  });

  assert.deepEqual(config.models.map((model) => `${model.name}:${model.channel}`), [
    'first:VIP',
    'first:DEFAULT',
    'first:BACKUP',
    'later:DEFAULT',
  ]);
});

test('scheduled checks run only when the configured interval has elapsed', () => {
  const minute = 60_000;

  assert.equal(shouldRunScheduledCheck({
    lastCheckedAt: 0,
    now: 59 * minute,
    intervalMinutes: 59,
  }), true);

  assert.equal(shouldRunScheduledCheck({
    lastCheckedAt: 59 * minute,
    now: 60 * minute,
    intervalMinutes: 59,
  }), false);

  assert.equal(shouldRunScheduledCheck({
    lastCheckedAt: 59 * minute,
    now: 118 * minute,
    intervalMinutes: 59,
  }), true);
});

test('scheduled checks run when there is no previous check timestamp', () => {
  assert.equal(shouldRunScheduledCheck({
    lastCheckedAt: null,
    now: 1_000,
    intervalMinutes: 59,
  }), true);
});
