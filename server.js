const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const configFile = process.env.CONFIG_FILE || path.join(__dirname, 'data', 'config.json');
const statusFile = process.env.STATUS_FILE || path.join(__dirname, 'data', 'status.json');
const adminPassword = process.env.ADMIN_PASSWORD || '';

let monitorCorePromise = import('./src/monitor-core.mjs');
let statusStorePromise = import('./src/status-store.mjs');
let intervalTimer = null;
let latestStatus = [];
let historyStatus = {};
const sessions = new Map();

app.use(express.json({ limit: '1mb' }));

async function core() {
    return monitorCorePromise;
}

async function statusStore() {
    return statusStorePromise;
}

async function loadConfig() {
    const { buildDefaultConfig, mergeConfigUpdate } = await core();
    const defaults = buildDefaultConfig(process.env);

    if (!fs.existsSync(configFile)) {
        await saveRawConfig(defaults);
        return defaults;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        return mergeConfigUpdate(defaults, parsed);
    } catch (err) {
        console.error(`读取配置失败，将使用环境变量默认值: ${err.message}`);
        return defaults;
    }
}

async function saveConfig(update) {
    const { mergeConfigUpdate } = await core();
    const current = await loadConfig();
    const next = mergeConfigUpdate(current, update);
    await saveRawConfig(next);
    scheduleHealthCheck(next);
    return next;
}

async function saveRawConfig(config) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function createToken() {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + 2 * 60 * 60 * 1000);
    return token;
}

function requireAdmin(req, res, next) {
    if (!adminPassword) {
        return res.status(503).json({ error: 'ADMIN_PASSWORD 未配置，配置管理不可用。' });
    }

    const header = req.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expiresAt = sessions.get(token);

    if (!expiresAt || expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return res.status(401).json({ error: '请先登录管理员账号。' });
    }

    next();
}

async function performHealthCheck() {
    const { runHealthCheck } = await core();
    const { saveStatusSnapshot } = await statusStore();
    const config = await loadConfig();
    console.log(`Starting API Health Check... (Interval: ${config.pollIntervalMinutes}m)`);

    const result = await runHealthCheck({
        config,
        historyData: historyStatus,
        fetchImpl: fetch,
    });

    latestStatus = result.statuses;
    historyStatus = result.historyData;
    saveStatusSnapshot(statusFile, {
        latestStatus,
        historyStatus,
        lastCheckedAt: Date.now(),
    });
    return { config, statuses: latestStatus };
}

function scheduleHealthCheck(config, options = {}) {
    if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
    }

    const interval = Math.max(1, Number(config.pollIntervalMinutes) || 1);
    const intervalMs = interval * 60 * 1000;
    intervalTimer = setInterval(() => {
        performHealthCheck().catch((err) => {
            console.error(`定时检测失败: ${err.message}`);
        });
    }, intervalMs);

    if (typeof intervalTimer.unref === 'function') {
        intervalTimer.unref();
    }

    if (options.runImmediately) {
        performHealthCheck().catch((err) => {
            console.error(`首次检测失败: ${err.message}`);
        });
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

app.use('/assets', express.static(path.join(__dirname, 'src', 'assets'), {
    immutable: true,
    maxAge: '1y',
}));

app.post('/api/admin/login', (req, res) => {
    if (!adminPassword) {
        return res.status(503).json({ error: 'ADMIN_PASSWORD 未配置，配置管理不可用。' });
    }

    if (!req.body || req.body.password !== adminPassword) {
        return res.status(401).json({ error: '管理员密码错误。' });
    }

    res.json({ token: createToken(), expiresInSeconds: 7200 });
});

app.get('/api/config', requireAdmin, async (req, res) => {
    const { sanitizeConfig } = await core();
    res.json({ config: sanitizeConfig(await loadConfig()) });
});

app.put('/api/config', requireAdmin, async (req, res) => {
    const { sanitizeConfig } = await core();
    const config = await saveConfig(req.body || {});
    res.json({ config: sanitizeConfig(config) });
});

app.post('/api/check-now', requireAdmin, async (req, res) => {
    try {
        const { sanitizeConfig } = await core();
        const result = await performHealthCheck();
        res.json({
            ok: true,
            checkedAt: new Date().toISOString(),
            count: result.statuses.length,
            config: sanitizeConfig(result.config),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/models/discover', requireAdmin, async (req, res) => {
    try {
        const { discoverModels, mergeConfigUpdate } = await core();
        const config = mergeConfigUpdate(await loadConfig(), req.body || {});
        const models = await discoverModels({ config, fetchImpl: fetch });
        res.json({ models });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', async (req, res) => {
    const { createStatusPayload } = await core();
    const config = await loadConfig();

    if (!latestStatus || latestStatus.length === 0) {
        return res.json({
            ...createStatusPayload({ statuses: [], config }),
            error: `系统启动中，请等待 ${config.pollIntervalMinutes} 分钟后定时任务执行，或登录后点击立即检测。`,
        });
    }

    res.json(createStatusPayload({ statuses: latestStatus, config }));
});

loadConfig()
    .then((config) => {
        return Promise.all([Promise.resolve(config), statusStore()]);
    })
    .then(([config, store]) => {
        const snapshot = store.loadStatusSnapshot(statusFile);
        latestStatus = snapshot.latestStatus;
        historyStatus = snapshot.historyStatus;

        app.listen(port, () => {
            console.log(`API Monitor listening at http://localhost:${port}`);
            console.log(`Health check interval is scheduled (${config.pollIntervalMinutes}m).`);
            scheduleHealthCheck(config, { runImmediately: true });
        });
    })
    .catch((err) => {
        console.error(`启动失败: ${err.message}`);
        process.exit(1);
    });
