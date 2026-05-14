# API Monitor Dashboard

一个用于监控 API（如 NewAPI 中转站）状态、延迟和连通性的可视化面板。看板支持 Cloudflare Workers、Docker 和原生 Node.js 部署，并提供管理员配置页。

## 功能

- API 模型连通性检测、延迟展示、可用率统计和 60 次历史状态条。
- 管理员配置页：目标 API、API Key、轮询间隔、请求超时、最大模型数、最大并发、延迟阈值、模型启停、供应商和渠道。
- 配置页可根据当前填写的目标 API URL 和 API Key 自动调用 `/models` 获取模型列表。
- `API_KEY` 在配置页脱敏显示；保存时留空表示不修改。
- `POST /api/check-now` 支持登录后手动触发一次检测。
- Worker 使用 Cloudflare KV 持久化配置；Node/Docker 使用本地 JSON 文件持久化配置。

## 环境变量

```env
TARGET_API_URL=https://your-api-url/v1
API_KEY=sk-your-api-key
ADMIN_PASSWORD=change-this-password
POLL_INTERVAL=5
REQUEST_TIMEOUT_MS=10000
MAX_MODELS_TO_PING=20
MAX_CONCURRENCY=5
WARN_LATENCY_MS=3000
ERROR_LATENCY_MS=10000
CONFIG_FILE=./data/config.json
```

`ADMIN_PASSWORD` 用于进入配置管理。公开部署时务必设置强密码。

## Docker Compose 部署

1. 复制 `.env.example` 为 `.env`，填写真实配置。

2. 启动服务：

```bash
docker-compose up -d
```

3. 打开 `http://你的服务器IP:3060`，点击右上角“配置”进入管理页。

## Node.js 部署

```bash
npm install
npm start
```

默认监听 `3000` 端口。配置文件默认写入 `data/config.json`，可通过 `CONFIG_FILE` 修改。

## Cloudflare Workers 部署

1. 创建 KV 并把 namespace id 写入 `wrangler.toml` 的 `MONITOR_KV`。

2. 设置密钥：

```bash
npx wrangler secret put TARGET_API_URL
npx wrangler secret put API_KEY
npx wrangler secret put ADMIN_PASSWORD
```

3. 部署：

```bash
npm install
npm run deploy
```

Cloudflare Cron 会自动按 `wrangler.toml` 中的计划触发检测。页面中的“立即检测”会直接调用 Worker 执行一次检测。

## API

- `GET /api/status`：公开看板数据，不返回明文 API Key。
- `POST /api/admin/login`：管理员登录，返回短期 token。
- `GET /api/config`：读取脱敏配置，需要 `Authorization: Bearer <token>`。
- `PUT /api/config`：保存配置，需要管理员 token。
- `POST /api/check-now`：立即检测，需要管理员 token。
- `POST /api/models/discover`：根据配置中的目标 API 和 API Key 自动获取模型列表，需要管理员 token。

## 测试

```bash
npm test
```
