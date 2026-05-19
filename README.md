# Coffee Price Sentinel ☕

Background-monitoring agent that watches the price of *Bialetti Café Perfetto Moka CLASSICO 250 g* on **interismo.ch** and alerts you when it drops below your target.

The project is split into two pieces so the watcher keeps running even when the browser is closed:

| Piece | Path | Role |
|-------|------|------|
| **Backend** | `server/` | Node.js + Express service that scrapes the page, optionally consults an LLM, persists history to `data.json`, and pushes live updates via Server-Sent Events. Runs 24/7 without a browser tab. |
| **Frontend** | `src/` | Vite + React dashboard. Pure UI: fetches the current state, subscribes to the SSE stream, and POSTs button clicks back to the backend. |

## Quick start

```bash
# one-time
npm install
npm run server:install

# terminal 1 — backend (port 3000)
npm run server          # or `npm run server:dev` for auto-restart on edits

# terminal 2 — frontend (port 5173, proxies /api to localhost:3000)
npm run dev
```

Open <http://localhost:5173>, set your target price, click **Start Monitoring**. The backend now runs the loop in the background; closing the browser tab does **not** stop monitoring.

## Production / ngrok deployment (single port)

For "run it on my laptop and expose it via ngrok", everything collapses onto
the backend's port — no separate Vite dev server, no separate frontend host.

```bash
# 1. one-time: pick a strong access token, put it in server/.env
echo "ACCESS_TOKEN=$(node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\")" >> server/.env

# 2. build the React app, then start the backend (which serves dist/ on :3000)
npm run prod

# 3. in another shell — expose it
ngrok http --domain=your-reserved.ngrok-free.app 3000
```

Open the tunnel URL with your token in the hash:
`https://your-reserved.ngrok-free.app/#token=<the-value-from-server/.env>`

The frontend pulls the token out of the URL, saves it to `localStorage`, and
strips it from the address bar. You're good for the life of that browser
profile. To revoke, change `ACCESS_TOKEN` and restart the backend — anyone
holding the old token gets a 401 prompt and has to re-enter the new one.

`http://localhost:3000/health` is intentionally unauthenticated so ngrok and
uptime probes can check liveness.

## Backend configuration (`server/.env`)

Copy the template and fill in only what you need — everything else has sensible defaults.

```bash
cp server/.env.example server/.env
```

| Variable | Purpose |
|----------|---------|
| `PORT` | Backend HTTP port (default `3000`). |
| `ACCESS_TOKEN` | Shared secret required on every `/api/*` request. Leave empty to disable auth (dev only — never empty when exposed publicly). |
| `ANTHROPIC_API_KEY` | Required only if you pick **LLM → Anthropic** as the extraction strategy. |
| `SLACK_WEBHOOK_URL` | Optional. Slack Incoming Webhook URL — target hits are posted to the channel that webhook is bound to. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Optional. When both are set, target hits are also pushed to your Telegram chat. |

You can configure **either or both** channels — alerts fan out in parallel.
If no channel is configured, the backend just logs to stdout.

### Slack setup (1 minute)

1. In Slack, open the channel you want alerts in → click the channel name → **Integrations** → **Add an app** → search **"Incoming WebHooks"** → **Add to Slack**.
2. Pick the channel, click **Add Incoming WebHooks integration**, copy the URL (looks like `https://hooks.slack.com/services/T.../B.../xxx`).
3. Paste it into `server/.env` as `SLACK_WEBHOOK_URL=...`, restart the backend.

The message uses Block Kit and includes a clickable "Buy on interismo.ch" button.

### Telegram setup

1. Talk to `@BotFather`, run `/newbot`, copy the token.
2. Send any message to your new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your numeric chat id.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `server/.env`.

## Backend API

All endpoints live under `/api` (proxied by Vite in dev):

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET`  | `/api/state` | — | Full snapshot: config, checks history, recent logs, status, meta. |
| `POST` | `/api/config` | partial config | Updates target price, interval, strategy, LLM settings. Rearms the next-wake-up timer if running. |
| `POST` | `/api/start` | — | Starts the recurring check loop. |
| `POST` | `/api/stop`  | — | Pauses the loop. |
| `POST` | `/api/check-now` | — | Forces an immediate price check. |
| `POST` | `/api/alert/dismiss` | — | Clears the in-memory "target hit" flag. |
| `GET`  | `/api/stream` | — | **SSE.** Emits `state` (initial snapshot), then incremental `log`, `check`, `status`, `config` events. |
| `GET`  | `/api/health` | — | Liveness probe. |

## Persistence

State is written to `server/data.json` (atomic rename via a `.tmp` file, debounced ~400 ms). Restart-safe: history and logs survive process restarts; the loop is **not** auto-resumed on boot — press Start again so the user opts in.

## Architecture notes

- The backend is the **single source of truth**. The React app is a thin client that mirrors state via SSE.
- The browser `Notification` API is gone — alerts are pushed by the backend (Telegram) so they work with the tab closed.
- No more CORS proxies in Vite. The Node.js process fetches `interismo.ch` directly (with a real `User-Agent`), and Anthropic / Ollama calls also leave the server, not your browser.

## Layout

```
.
├── src/                 # React frontend
│   └── App.jsx          # Dashboard (REST + SSE client)
├── server/              # Node.js backend (independent npm package)
│   ├── index.js         # Express app + routes + SSE
│   ├── scraper.js       # extractPriceFromMeta + extractPriceWithLLM
│   ├── state.js         # in-memory state + JSON persistence
│   ├── scheduler.js     # background loop driven by checkEvery
│   ├── notifier.js      # Telegram notifications
│   ├── data.json        # auto-created, gitignored
│   └── .env.example
├── vite.config.js       # proxies /api → http://localhost:3000
└── package.json
```
