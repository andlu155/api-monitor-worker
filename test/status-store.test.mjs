import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadStatusSnapshot,
  saveStatusSnapshot,
} from '../src/status-store.mjs';

test('status snapshots persist latest statuses and history data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-monitor-status-'));
  const file = path.join(dir, 'status.json');
  const snapshot = {
    latestStatus: [
      { name: 'gpt-4o', channel: 'DEFAULT', latency: 123, status: 'success' },
    ],
    historyStatus: {
      'gpt-4o_DEFAULT': {
        history: [{ timestamp: 1_000, latency: 123, success: true, status: 'success' }],
      },
    },
    lastCheckedAt: 1_000,
  };

  saveStatusSnapshot(file, snapshot);

  assert.deepEqual(loadStatusSnapshot(file), snapshot);
});

test('missing or invalid status snapshots return empty defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-monitor-status-'));
  const file = path.join(dir, 'missing.json');

  assert.deepEqual(loadStatusSnapshot(file), {
    latestStatus: [],
    historyStatus: {},
    lastCheckedAt: 0,
  });

  fs.writeFileSync(file, '{bad json', 'utf8');

  assert.deepEqual(loadStatusSnapshot(file), {
    latestStatus: [],
    historyStatus: {},
    lastCheckedAt: 0,
  });
});
