# Coffee Price Sentinel ☕

Background-monitoring agent that watches the price of *Bialetti Café Perfetto Moka CLASSICO 250 g* on **interismo.ch** and alerts you when it drops below your target.

The project ships in **two deployment flavors** that share the React frontend:

| Flavor | Backend | Persistence | Scheduling | When to use |
|--------|---------|-------------|------------|-------------|
| **Vercel** (recommended) | Serverless functions under `api/` | Vercel KV (Upstash Redis) | Vercel Cron — 1×/day on Hobby, finer on Pro | Always-on, zero-ops, free for personal use |
| **Local + ngrok** | Long-running Node.js + Express in `server/` | `data.json` on disk | In-process `setTimeout` loop | When you want sub-second updates (SSE), arbitrary cadence, or run it on your own hardware |

The same React dashboard works against either backend — same API surface, same UI, just different transport (polling on Vercel, SSE locally).

**Full topology, component interactions, and runbooks:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Quick start (local dev)

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

## Deploy to Vercel (always-on, free tier)

The repository is laid out so a Vercel import "just works": Vite builds the
frontend, the `api/` directory becomes serverless functions, and `vercel.json`
schedules the cron. Step by step:

### 1. Provision a KV store

In your Vercel project: **Storage → Create Database → Marketplace → Upstash →
For Redis → Free**. Connect it to the project — Vercel injects
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, and friends automatically.

### 2. Set environment variables

In **Project → Settings → Environment Variables**, add:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ACCESS_TOKEN` | strongly recommended | Shared secret required on every `/api/*` request. Pick a long random string. |
| `CRON_SECRET` | optional | When set, Vercel adds `Authorization: Bearer $CRON_SECRET` to the daily cron request. Set it; you don't want randos triggering scrapes. |
| `SLACK_WEBHOOK_URL` | optional | Slack Incoming Webhook URL. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | optional | Telegram bot credentials. |
| `ANTHROPIC_API_KEY` | only if you pick the LLM strategy | — |

### 3. Import the repo

**Vercel dashboard → Add New → Project → Import** your GitHub repo.
Framework preset: Vite (auto-detected). No overrides needed.

### 4. First deploy

Push to `main`. Vercel builds the React app and registers the cron.
Hit `https://<your-project>.vercel.app/#token=<ACCESS_TOKEN>`, click **Start**,
and the next daily cron tick will start populating your history.

### Cadence caveat (Vercel Hobby)

Vercel Hobby caps cron at **1 trigger per day with ±59 min jitter**. The "CHECK
EVERY" pills in the UI become advisory: the actual cadence is whatever
`vercel.json`'s `crons[].schedule` says (default `0 9 * * *` = ~10:00 Swiss
time). To run more often, either upgrade to Pro ($20/mo, down to every minute)
or wire an external uptime monitor (cron-job.org, UptimeRobot) to ping
`/api/cron/check?token=$ACCESS_TOKEN` on your preferred schedule.

### Testing the cron manually

```bash
curl -X GET "https://<your-project>.vercel.app/api/cron/check" \
     -H "Authorization: Bearer $ACCESS_TOKEN"
```

If `isRunning` is true in KV, this runs a real check and fires notifications.

## Local + ngrok deployment (the original flavor)

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

The same surface is implemented by both flavors (Express routes locally, one
function per file on Vercel):

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET`  | `/api/state` | — | Full snapshot: config, checks history, recent logs, status, meta. |
| `POST` | `/api/config` | partial config | Updates target price, interval, strategy, LLM settings. |
| `POST` | `/api/start` | — | Sets `isRunning=true`. Local: starts the loop. Vercel: lets the cron actually do work. |
| `POST` | `/api/stop`  | — | Pauses the loop / gates the cron. |
| `POST` | `/api/check-now` | — | Forces an immediate price check. |
| `POST` | `/api/alert/dismiss` | — | Clears the in-memory "target hit" flag. |
| `POST` | `/api/notifier/test` | — | Fires a "this is a test" notification through every configured channel. |
| `GET`  | `/api/stream` | — | **SSE** — local only. Vercel uses 3 s polling against `/api/state`. |
| `GET`  | `/api/cron/check` | — | **Vercel only** — entry point for Vercel Cron. Manual triggers require the same Bearer token. |
| `GET`  | `/health` (local) / `/api/health` (Vercel) | — | Unauthenticated liveness probe. |

## Persistence

- **Local:** atomic, debounced writes to `server/data.json`. Restart-safe.
- **Vercel:** Upstash Redis (free tier). Inspectable from the Vercel dashboard
  → Storage → Data browser.

In both cases the loop is **not** auto-resumed on boot — you press Start so the
operator opts in explicitly.

## Architecture notes

- The backend is the **single source of truth**. The React app is a thin
  client that mirrors state via SSE (local) or polling (Vercel).
- Alerts are pushed server-side (Slack and/or Telegram), so they fire even if
  no browser tab is open.
- The scraper and notifier code is shared verbatim between `server/` and
  `api/_lib/` — only the state store and the transport differ.

## Layout

```
.
├── src/                 # React frontend (works against both backends)
│   └── App.jsx          # Dashboard: REST + polling (Vercel) / SSE (local)
├── api/                 # Vercel serverless functions — `vercel.json`
│   ├── state.js         #   wires these into routes automatically.
│   ├── config.js
│   ├── start.js, stop.js
│   ├── check-now.js
│   ├── health.js
│   ├── notifier/test.js
│   ├── alert/dismiss.js
│   ├── cron/check.js    # ← invoked daily by Vercel Cron
│   └── _lib/
│       ├── store.js     # KV-backed state (Upstash Redis)
│       ├── scraper.js   # = server/scraper.js
│       ├── notifier.js  # = server/notifier.js
│       ├── check.js     # shared "run one price check" pipeline
│       └── auth.js      # ACCESS_TOKEN guard
├── server/              # Local Node.js + Express backend (alt deploy)
│   ├── index.js         # Express app + routes + SSE
│   ├── scraper.js       # extractPriceFromMeta + extractPriceWithLLM
│   ├── state.js         # in-memory state + JSON persistence
│   ├── scheduler.js     # background loop driven by checkEvery
│   ├── notifier.js      # Telegram + Slack notifications
│   ├── data.json        # auto-created, gitignored
│   └── .env.example
├── vercel.json          # cron schedule + function timeouts
├── vite.config.js       # proxies /api → http://localhost:3000 in dev
└── package.json
```
