import fs from 'node:fs';
import path from 'node:path';

export function loadStatusSnapshot(file) {
  if (!file || !fs.existsSync(file)) return emptySnapshot();

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      latestStatus: Array.isArray(parsed.latestStatus) ? parsed.latestStatus : [],
      historyStatus: isPlainObject(parsed.historyStatus) ? parsed.historyStatus : {},
      lastCheckedAt: Number.isFinite(Number(parsed.lastCheckedAt)) ? Number(parsed.lastCheckedAt) : 0,
    };
  } catch {
    return emptySnapshot();
  }
}

export function saveStatusSnapshot(file, snapshot) {
  if (!file) return;

  const next = {
    latestStatus: Array.isArray(snapshot.latestStatus) ? snapshot.latestStatus : [],
    historyStatus: isPlainObject(snapshot.historyStatus) ? snapshot.historyStatus : {},
    lastCheckedAt: Number.isFinite(Number(snapshot.lastCheckedAt)) ? Number(snapshot.lastCheckedAt) : Date.now(),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function emptySnapshot() {
  return {
    latestStatus: [],
    historyStatus: {},
    lastCheckedAt: 0,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
