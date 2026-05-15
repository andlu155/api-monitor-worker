import html from './index.html';
import { HERO_IMAGE_BASE64 } from './hero-image.js';
import {
    CONFIG_KV_KEY,
    HISTORY_STATUS_KV_KEY,
    LATEST_STATUS_KV_KEY,
    buildDefaultConfig,
    createStatusPayload,
    discoverModels,
    mergeConfigUpdate,
    runHealthCheck,
    sanitizeConfig,
    shouldRunScheduledCheck,
} from './monitor-core.mjs';

const SESSION_PREFIX = 'admin_session:';
const LAST_CHECK_AT_KV_KEY = 'last_check_at';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/') {
            return htmlResponse(html);
        }

        if (url.pathname === '/assets/api-monitor-hero.png') {
            return imageResponse(HERO_IMAGE_BASE64, 'image/png');
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/login') {
            return handleLogin(request, env);
        }

        if (url.pathname === '/api/config') {
            const auth = await requireAdmin(request, env);
            if (auth) return auth;

            if (request.method === 'GET') {
                const config = await loadConfig(env);
                return jsonResponse({ config: sanitizeConfig(config) });
            }

            if (request.method === 'PUT') {
                const current = await loadConfig(env);
                const body = await request.json().catch(() => ({}));
                const next = mergeConfigUpdate(current, body);
                await saveConfig(env, next);
                return jsonResponse({ config: sanitizeConfig(next) });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/check-now') {
            const auth = await requireAdmin(request, env);
            if (auth) return auth;

            try {
                const result = await performHealthCheck(env);
                return jsonResponse({
                    ok: true,
                    checkedAt: new Date().toISOString(),
                    count: result.statuses.length,
                    config: sanitizeConfig(result.config),
                });
            } catch (err) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/models/discover') {
            const auth = await requireAdmin(request, env);
            if (auth) return auth;

            try {
                const current = await loadConfig(env);
                const body = await request.json().catch(() => ({}));
                const config = mergeConfigUpdate(current, body);
                const models = await discoverModels({ config, fetchImpl: fetch });
                return jsonResponse({ models });
            } catch (err) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        if (url.pathname === '/api/status') {
            try {
                const config = await loadConfig(env);
                const statuses = await readJson(env, LATEST_STATUS_KV_KEY, []);

                if (!statuses || statuses.length === 0) {
                    return jsonResponse({
                        ...createStatusPayload({ statuses: [], config }),
                        error: '正在等待定时任务 (Cron) 首次运行并抓取数据，请稍后刷新，或登录后点击立即检测。',
                    });
                }

                return jsonResponse(createStatusPayload({ statuses, config }));
            } catch (err) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        return new Response('Not Found', { status: 404 });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(performScheduledHealthCheck(env));
    },
};

async function handleLogin(request, env) {
    if (!env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'ADMIN_PASSWORD 未配置，配置管理不可用。' }, 503);
    }

    const body = await request.json().catch(() => ({}));
    if (!body || body.password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: '管理员密码错误。' }, 401);
    }

    const token = crypto.randomUUID();
    if (env.MONITOR_KV) {
        await env.MONITOR_KV.put(`${SESSION_PREFIX}${token}`, '1', { expirationTtl: 7200 });
    }

    return jsonResponse({ token, expiresInSeconds: 7200 });
}

async function requireAdmin(request, env) {
    if (!env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'ADMIN_PASSWORD 未配置，配置管理不可用。' }, 503);
    }

    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !env.MONITOR_KV) {
        return jsonResponse({ error: '请先登录管理员账号。' }, 401);
    }

    const session = await env.MONITOR_KV.get(`${SESSION_PREFIX}${token}`);
    if (!session) {
        return jsonResponse({ error: '请先登录管理员账号。' }, 401);
    }

    return null;
}

async function performHealthCheck(env) {
    const config = await loadConfig(env);
    const historyData = await readJson(env, HISTORY_STATUS_KV_KEY, {});
    const result = await runHealthCheck({
        config,
        historyData,
        fetchImpl: fetch,
    });

    if (env.MONITOR_KV) {
        await env.MONITOR_KV.put(LATEST_STATUS_KV_KEY, JSON.stringify(result.statuses));
        await env.MONITOR_KV.put(HISTORY_STATUS_KV_KEY, JSON.stringify(result.historyData));
        await env.MONITOR_KV.put(LAST_CHECK_AT_KV_KEY, String(Date.now()));
    }

    return { config, statuses: result.statuses };
}

async function performScheduledHealthCheck(env) {
    const config = await loadConfig(env);
    const lastCheckedAt = await readText(env, LAST_CHECK_AT_KV_KEY, '');

    if (!shouldRunScheduledCheck({
        lastCheckedAt: Number(lastCheckedAt),
        now: Date.now(),
        intervalMinutes: config.pollIntervalMinutes,
    })) {
        return { skipped: true, config };
    }

    return performHealthCheck(env);
}

async function loadConfig(env) {
    const defaults = buildDefaultConfig(env);
    const stored = await readJson(env, CONFIG_KV_KEY, null);
    return stored ? mergeConfigUpdate(defaults, stored) : defaults;
}

async function saveConfig(env, config) {
    if (!env.MONITOR_KV) {
        throw new Error('MONITOR_KV 未绑定，无法保存配置。');
    }
    await env.MONITOR_KV.put(CONFIG_KV_KEY, JSON.stringify(config));
}

async function readJson(env, key, fallback) {
    if (!env.MONITOR_KV) return fallback;
    const value = await env.MONITOR_KV.get(key);
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function readText(env, key, fallback) {
    if (!env.MONITOR_KV) return fallback;
    const value = await env.MONITOR_KV.get(key);
    return value || fallback;
}

function htmlResponse(body) {
    return new Response(body, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
}

function imageResponse(base64, contentType) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new Response(bytes, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
