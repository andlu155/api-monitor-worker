export const CONFIG_KV_KEY = 'monitor_config';
export const LATEST_STATUS_KV_KEY = 'latest_status';
export const HISTORY_STATUS_KV_KEY = 'history_status';

export const DEFAULT_PROVIDER_ORDER = {
  OPENAI: 10,
  GOOGLE: 20,
  DEEPSEEK: 30,
  MINIMAXAI: 40,
  ANTHROPIC: 50,
  MIDJOURNEY: 60,
  OTHER: 999,
};

export const DEFAULT_MODELS = [
  { name: 'gpt-3.5-turbo', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
  { name: 'gpt-4', provider: 'OPENAI', channel: 'DEFAULT', enabled: true, sortOrder: 20 },
  { name: 'gpt-4-turbo', provider: 'OPENAI', channel: 'PLUS', enabled: true, sortOrder: 30 },
  { name: 'gpt-4o', provider: 'OPENAI', channel: 'VIP', enabled: true, sortOrder: 40 },
  { name: 'gemini-pro', provider: 'GOOGLE', channel: 'GEMINI', enabled: true, sortOrder: 10 },
  { name: 'gemini-1.5-pro', provider: 'GOOGLE', channel: 'GEMINI', enabled: true, sortOrder: 20 },
  { name: 'deepseek-chat', provider: 'DEEPSEEK', channel: 'DEFAULT', enabled: true, sortOrder: 10 },
  { name: 'claude-3-haiku-20240307', provider: 'ANTHROPIC', channel: 'CLAUDE', enabled: true, sortOrder: 10 },
  { name: 'claude-3-sonnet-20240229', provider: 'ANTHROPIC', channel: 'CLAUDE', enabled: true, sortOrder: 20 },
  { name: 'claude-3-opus-20240229', provider: 'ANTHROPIC', channel: 'CLAUDE', enabled: true, sortOrder: 30 },
  { name: 'mj-chat', provider: 'MIDJOURNEY', channel: 'FAST', enabled: true, sortOrder: 10 },
];

export function buildDefaultConfig(env = {}) {
  return normalizeConfig({
    targetApiUrl: env.TARGET_API_URL || '',
    apiKey: env.API_KEY || '',
    pollIntervalMinutes: toInt(env.POLL_INTERVAL, 1, 1, 1440),
    requestTimeoutMs: toInt(env.REQUEST_TIMEOUT_MS, 10000, 1000, 60000),
    maxModelsToPing: toInt(env.MAX_MODELS_TO_PING, 20, 1, 200),
    maxConcurrency: toInt(env.MAX_CONCURRENCY, 5, 1, 50),
    thresholds: {
      warnLatencyMs: toInt(env.WARN_LATENCY_MS, 3000, 1, 60000),
      errorLatencyMs: toInt(env.ERROR_LATENCY_MS, 10000, 1, 120000),
    },
    models: DEFAULT_MODELS,
  });
}

export function mergeConfigUpdate(currentConfig, update = {}) {
  const current = normalizeConfig(currentConfig || {});
  const next = {
    ...current,
    targetApiUrl: pickString(update.targetApiUrl, current.targetApiUrl),
    pollIntervalMinutes: pickNumber(update.pollIntervalMinutes, current.pollIntervalMinutes),
    requestTimeoutMs: pickNumber(update.requestTimeoutMs, current.requestTimeoutMs),
    maxModelsToPing: pickNumber(update.maxModelsToPing, current.maxModelsToPing),
    maxConcurrency: pickNumber(update.maxConcurrency, current.maxConcurrency),
    thresholds: {
      ...current.thresholds,
      ...(isPlainObject(update.thresholds) ? update.thresholds : {}),
    },
    models: Array.isArray(update.models) ? update.models : current.models,
  };

  if (typeof update.apiKey === 'string' && update.apiKey.trim()) {
    next.apiKey = update.apiKey.trim();
  }

  return normalizeConfig(next);
}

export function sanitizeConfig(config) {
  const normalized = normalizeConfig(config || {});
  const { apiKey, ...safeConfig } = normalized;
  return {
    ...safeConfig,
    apiKeyMasked: maskSecret(apiKey),
    hasApiKey: Boolean(apiKey),
  };
}

export function normalizeConfig(config = {}) {
  const warnLatencyMs = toInt(config.thresholds?.warnLatencyMs, 3000, 1, 60000);
  const errorLatencyMs = Math.max(
    warnLatencyMs,
    toInt(config.thresholds?.errorLatencyMs, 10000, 1, 120000),
  );

  return {
    targetApiUrl: typeof config.targetApiUrl === 'string' ? config.targetApiUrl.trim() : '',
    apiKey: typeof config.apiKey === 'string' ? config.apiKey.trim() : '',
    pollIntervalMinutes: toInt(config.pollIntervalMinutes, 1, 1, 1440),
    requestTimeoutMs: toInt(config.requestTimeoutMs, 10000, 1000, 60000),
    maxModelsToPing: toInt(config.maxModelsToPing, 20, 1, 200),
    maxConcurrency: toInt(config.maxConcurrency, 5, 1, 50),
    thresholds: {
      warnLatencyMs,
      errorLatencyMs,
    },
    models: sortConfiguredModels(normalizeModels(config.models)),
  };
}

export async function runHealthCheck({
  config,
  historyData = {},
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const activeConfig = normalizeConfig(config || {});

  if (!activeConfig.targetApiUrl || !activeConfig.apiKey) {
    throw new Error('TARGET_API_URL or API_KEY is missing.');
  }

  let modelsToMonitor = activeConfig.models.filter((model) => model.enabled);
  if (modelsToMonitor.length === 0) {
    modelsToMonitor = await discoverModels({ config: activeConfig, fetchImpl });
  }

  modelsToMonitor = sortConfiguredModels(modelsToMonitor).slice(0, activeConfig.maxModelsToPing);

  const statuses = await mapWithConcurrency(
    modelsToMonitor,
    activeConfig.maxConcurrency,
    (model) => pingModel({ model, config: activeConfig, historyData, fetchImpl, now }),
  );

  return { statuses, historyData };
}

export async function discoverModels({ config, fetchImpl = fetch } = {}) {
  const activeConfig = normalizeConfig(config || {});

  if (!activeConfig.targetApiUrl || !activeConfig.apiKey) {
    throw new Error('TARGET_API_URL or API_KEY is missing.');
  }

  try {
    const response = await fetchImpl(`${trimTrailingSlash(activeConfig.targetApiUrl)}/models`, {
      headers: {
        Authorization: `Bearer ${activeConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: createTimeoutSignal(activeConfig.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`获取模型失败: HTTP ${response.status}`);
    }

    const modelsData = await response.json();
    return normalizeModels((modelsData.data || []).map((model, index) => ({
      name: model.id,
      provider: inferProvider(model.id),
      channel: 'DEFAULT',
      enabled: true,
      sortOrder: (index + 1) * 10,
    })));
  } catch (err) {
    throw new Error(err?.message || '获取模型失败');
  }
}

export function labelProvider(provider) {
  const labels = {
    OPENAI: 'OpenAI',
    ANTHROPIC: 'Anthropic',
    GOOGLE: 'Google',
    DEEPSEEK: 'DeepSeek',
    MINIMAXAI: 'MiniMax',
    MIDJOURNEY: 'Midjourney',
    OTHER: '其他',
  };
  return labels[normalizeProvider(provider)] || String(provider || '其他');
}

export function labelChannel(channel) {
  const labels = {
    DEFAULT: '默认渠道',
    PLUS: '增强渠道',
    VIP: '高级渠道',
    CLAUDE: 'Claude 渠道',
    GEMINI: 'Gemini 渠道',
    FAST: '快速渠道',
  };
  return labels[String(channel || '').toUpperCase()] || String(channel || '默认渠道');
}

export function sortConfiguredModels(models = []) {
  return [...models].sort((left, right) => {
    const providerDelta = providerSortOrder(left.provider) - providerSortOrder(right.provider);
    if (providerDelta !== 0) return providerDelta;

    const modelDelta = numericSort(left.sortOrder, 9999) - numericSort(right.sortOrder, 9999);
    if (modelDelta !== 0) return modelDelta;

    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

export function formatForFrontend(statuses = []) {
  const modelMap = new Map();

  for (const result of statuses) {
    if (!modelMap.has(result.name)) {
      modelMap.set(result.name, {
        name: result.name,
        provider: result.provider,
        channels: [],
        sortOrder: result.sortOrder,
      });
    }

    modelMap.get(result.name).channels.push({
      name: result.channel,
      latency: result.latency,
      availability: result.availability,
      ping: result.latency,
      status: result.status,
      history: result.history,
      error: result.error || '',
    });
  }

  return sortConfiguredModels(Array.from(modelMap.values()));
}

export function createStatusPayload({ statuses = [], config, urlOverride = '' }) {
  const safeConfig = sanitizeConfig(config || {});
  return {
    models: formatForFrontend(statuses),
    url: safeConfig.targetApiUrl || urlOverride || '',
    interval: safeConfig.pollIntervalMinutes,
    configSummary: {
      pollIntervalMinutes: safeConfig.pollIntervalMinutes,
      requestTimeoutMs: safeConfig.requestTimeoutMs,
      maxModelsToPing: safeConfig.maxModelsToPing,
      maxConcurrency: safeConfig.maxConcurrency,
      thresholds: safeConfig.thresholds,
      configuredModels: safeConfig.models.length,
      enabledModels: safeConfig.models.filter((model) => model.enabled).length,
      hasApiKey: safeConfig.hasApiKey,
    },
  };
}

export function inferProvider(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.includes('deepseek')) return 'DEEPSEEK';
  if (lower.includes('minimaxai') || lower.includes('minimax')) return 'MINIMAXAI';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'ANTHROPIC';
  if (lower.includes('gemini') || lower.includes('palm')) return 'GOOGLE';
  if (lower.includes('midjourney') || lower.startsWith('mj-')) return 'MIDJOURNEY';
  if (lower.includes('gpt') || lower.includes('dall-e') || lower.includes('whisper')) return 'OPENAI';
  return 'OTHER';
}

async function pingModel({ model, config, historyData, fetchImpl, now }) {
  const start = now();
  let success = false;
  let latency = 0;
  let status = 'error';
  let error = '';

  try {
    const response = await fetchImpl(`${trimTrailingSlash(config.targetApiUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: createTimeoutSignal(config.requestTimeoutMs),
    });

    latency = Math.max(0, now() - start);
    if (response.ok) {
      success = true;
      status = latency >= config.thresholds.errorLatencyMs
        ? 'error'
        : latency >= config.thresholds.warnLatencyMs
          ? 'warn'
          : 'success';
    } else {
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    latency = Math.max(0, now() - start);
    error = err?.name === 'AbortError' ? 'Request timeout' : (err?.message || 'Request failed');
  }

  const modelKey = `${model.name}_${model.channel}`;
  if (!historyData[modelKey]) historyData[modelKey] = { history: [] };

  const item = { timestamp: now(), latency, success, status };
  if (error) item.error = error;
  historyData[modelKey].history.push(item);
  if (historyData[modelKey].history.length > 60) {
    historyData[modelKey].history.shift();
  }

  const history = historyData[modelKey].history;
  const availability = history.length > 0
    ? Number(((history.filter((entry) => entry.success).length / history.length) * 100).toFixed(2))
    : 0;

  return {
    name: model.name,
    provider: model.provider,
    channel: model.channel,
    sortOrder: model.sortOrder,
    latency,
    status,
    availability,
    history,
    error,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

function normalizeModels(models) {
  const source = Array.isArray(models) ? models : DEFAULT_MODELS;
  return source
    .map((model) => ({
      name: typeof model.name === 'string' ? model.name.trim() : '',
      provider: normalizeProvider(model.provider || inferProvider(model.name || '')),
      channel: typeof model.channel === 'string' && model.channel.trim()
        ? model.channel.trim()
        : 'DEFAULT',
      enabled: model.enabled !== false,
      sortOrder: numericSort(model.sortOrder, 9999),
    }))
    .filter((model) => model.name);
}

function providerSortOrder(provider) {
  return DEFAULT_PROVIDER_ORDER[normalizeProvider(provider)] ?? 900;
}

function normalizeProvider(provider) {
  return String(provider || 'OTHER').trim().toUpperCase() || 'OTHER';
}

function numericSort(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maskSecret(secret = '') {
  if (!secret) return '';
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

function pickString(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback;
}

function pickNumber(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
