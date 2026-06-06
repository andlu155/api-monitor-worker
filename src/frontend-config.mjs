export function buildDiscoveredModelChoices(existingModels = [], discoveredModels = []) {
  const existingKeys = new Set(existingModels.map(modelKey));
  const seen = new Set();

  return discoveredModels
    .filter((model) => String(model?.name || '').trim())
    .map((model) => {
      const normalized = normalizeDiscoveredModel(model);
      const key = modelKey(normalized);
      if (seen.has(key)) return null;
      seen.add(key);
      const exists = existingKeys.has(key);
      return { key, model: normalized, exists, selected: exists };
    })
    .filter(Boolean)
    .sort(compareDiscoveredChoices);
}

export function mergeSelectedDiscoveredModels(existingModels = [], choices = []) {
  const merged = existingModels.map((model) => ({ ...model }));
  const existingKeys = new Set(merged.map(modelKey));
  let nextOrder = nextSortOrder(merged);

  choices.forEach((choice) => {
    if (!choice?.selected) return;
    const model = normalizeDiscoveredModel(choice.model || {});
    const key = modelKey(model);
    if (!model.name || existingKeys.has(key)) return;
    merged.push({ ...model, enabled: model.enabled !== false, sortOrder: nextOrder });
    existingKeys.add(key);
    nextOrder += 10;
  });

  return merged;
}

export function appendManualModel(models = [], defaults = {}) {
  return [
    ...models,
    {
      name: '',
      provider: defaults.provider || 'OTHER',
      channel: defaults.channel || 'DEFAULT',
      enabled: true,
      sortOrder: nextSortOrder(models),
    },
  ];
}

export function summarizeDiscoveredModelChoices(choices = []) {
  return choices.reduce((summary, choice) => {
    summary.total += 1;
    if (choice?.exists) summary.existing += 1;
    else summary.fresh += 1;
    if (!choice?.exists && choice?.selected) summary.pendingAdd += 1;
    return summary;
  }, { total: 0, existing: 0, fresh: 0, pendingAdd: 0 });
}

export function modelKey(model = {}) {
  return `${String(model.name || '').trim()}_${String(model.channel || 'DEFAULT').trim()}`;
}

function normalizeDiscoveredModel(model) {
  return {
    name: String(model.name || '').trim(),
    provider: model.provider || 'OTHER',
    channel: model.channel || 'DEFAULT',
    enabled: model.enabled !== false,
    sortOrder: model.sortOrder,
  };
}

function nextSortOrder(models) {
  const values = models.map((model) => Number(model.sortOrder) || 0);
  return Math.max(0, ...values) + 10;
}

function compareDiscoveredChoices(left, right) {
  if (left.exists !== right.exists) return left.exists ? 1 : -1;
  return String(left.model.name || '').localeCompare(String(right.model.name || ''));
}
