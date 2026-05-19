// Coffee Price Sentinel — backend entry point.
//
// Responsibilities:
//   • Load persisted state from data.json
//   • Run the scheduled scrape/LLM loop in the background
//   • Expose a small REST API for the React frontend
//   • Stream live updates over Server-Sent Events
//   • Serve the built React bundle so a single ngrok tunnel covers everything
//
// Designed to run continuously (e.g. via `node index.js`, pm2, systemd …) —
// no browser tab required.

import "dotenv/config";

import express from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StateStore } from "./state.js";
import { Scheduler } from "./scheduler.js";
import { notifierConfigured, notifierStatus, notifyPriceHit } from "./notifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");

const PORT = Number(process.env.PORT) || 3000;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";

const store = new StateStore();
await store.load();

const scheduler = new Scheduler(store);

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// ── Auth ───────────────────────────────────────────────────────────────────
// When `ACCESS_TOKEN` is set, every /api/* request must present the same
// token, either as `?token=…` (so `EventSource` can authenticate — it can't
// set custom headers) or as `Authorization: Bearer …`.
//
// When the env var is empty, auth is disabled — convenient for local dev,
// but boot prints a warning so it's hard to ship-it-by-accident.

function tokenFromRequest(req) {
    if (typeof req.query.token === "string") return req.query.token;
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
    return "";
}

if (ACCESS_TOKEN) {
    app.use("/api", (req, res, next) => {
        if (tokenFromRequest(req) === ACCESS_TOKEN) return next();
        res.status(401).json({ error: "missing or invalid token" });
    });
}

// ── REST endpoints ──────────────────────────────────────────────────────────

app.get("/api/state", (_req, res) => {
    res.json({
        ...store.snapshot(),
        meta: {
            notifierConfigured: notifierConfigured(),
            notifiers: notifierStatus(),
            anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
            authRequired: Boolean(ACCESS_TOKEN),
            serverTime: Date.now(),
        },
    });
});

app.post("/api/config", (req, res) => {
    const updated = store.updateConfig(req.body || {});
    store.appendLog("⚙ Configuration updated", "info");
    // If `checkEvery` changed while running, restart the next-wake-up timer.
    scheduler.rearm();
    res.json(updated);
});

app.post("/api/start", async (_req, res) => {
    try {
        await scheduler.start();
        res.json({ ok: true, status: store.state.status });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post("/api/stop", (_req, res) => {
    scheduler.stop();
    res.json({ ok: true, status: store.state.status });
});

app.post("/api/check-now", async (_req, res) => {
    try {
        await scheduler.checkNow();
        res.json({ ok: true, status: store.state.status });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post("/api/alert/dismiss", (_req, res) => {
    store.clearAlert();
    res.json({ ok: true, status: store.state.status });
});

// Sends a "test" notification through every configured channel without
// mutating the price history. Useful to verify the Slack/Telegram wiring
// when the actual target hasn't been hit yet.
app.post("/api/notifier/test", async (_req, res) => {
    const { config, checks } = store.state;
    const lastPrice = checks.length ? checks[checks.length - 1].price : null;
    const result = await notifyPriceHit({
        price: lastPrice ?? 6.75,
        targetPrice: config.targetPrice,
        productUrl: config.productUrl,
        method: "manual test",
        test: true,
    });

    if (result.reason === "not-configured") {
        store.appendLog("🧪 Test: no notifier configured", "warn");
    } else {
        const parts = Object.entries(result.channels).map(([n, r]) =>
            r.ok ? `${n}✓` : `${n}✗(${r.reason})`,
        );
        store.appendLog(`🧪 Test notification: ${parts.join(" ")}`, result.ok ? "info" : "warn");
    }

    res.json(result);
});

// ── Server-Sent Events ──────────────────────────────────────────────────────
//
// Each connected client gets the current state snapshot as the first event,
// then receives incremental `log` / `check` / `status` / `config` events.

app.get("/api/stream", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Initial snapshot.
    send("state", store.snapshot());

    const onLog = (entry) => send("log", entry);
    const onCheck = (entry) => send("check", entry);
    const onStatus = (status) => send("status", status);
    const onConfig = (config) => send("config", config);

    store.on("log", onLog);
    store.on("check", onCheck);
    store.on("status", onStatus);
    store.on("config", onConfig);

    // Heartbeat so proxies don't close the idle connection.
    const heartbeat = setInterval(() => {
        res.write(`: ping ${Date.now()}\n\n`);
    }, 25000);

    req.on("close", () => {
        clearInterval(heartbeat);
        store.off("log", onLog);
        store.off("check", onCheck);
        store.off("status", onStatus);
        store.off("config", onConfig);
    });
});

// ── Health check ────────────────────────────────────────────────────────────
// Intentionally unauthenticated — useful for ngrok / uptime probes.

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        isRunning: store.state.status.isRunning,
        checks: store.state.checks.length,
        uptime: process.uptime(),
        authRequired: Boolean(ACCESS_TOKEN),
    });
});

// 404 for any unmatched API route (must come BEFORE static + SPA fallback).
app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
});

// ── Static frontend + SPA fallback ──────────────────────────────────────────
// If `dist/` exists (i.e. the user ran `vite build`), serve it on the same
// port. Otherwise the backend still works as a pure API — useful in dev when
// you run Vite separately on :5173.

const hasFrontendBuild = existsSync(path.join(DIST_DIR, "index.html"));
if (hasFrontendBuild) {
    app.use(express.static(DIST_DIR, { maxAge: "1h", index: false }));
    app.use((_req, res) => {
        res.sendFile(path.join(DIST_DIR, "index.html"));
    });
}

// ── Boot ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
    console.log(`[server] Coffee Price Sentinel listening on http://localhost:${PORT}`);
    const channels = Object.entries(notifierStatus()).filter(([, on]) => on).map(([n]) => n);
    console.log(
        `[server] Notifier: ${channels.length ? `active (${channels.join(", ")})` : "disabled (set SLACK_WEBHOOK_URL or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`,
    );
    console.log(
        `[server] Auth:     ${ACCESS_TOKEN ? "ACCESS_TOKEN required on /api/*" : "DISABLED — set ACCESS_TOKEN before exposing publicly!"}`,
    );
    console.log(
        `[server] Frontend: ${hasFrontendBuild ? `serving ${DIST_DIR}` : `no build found (run \`npm run build\` from project root, then restart)`}`,
    );
    console.log(
        `[server] Loaded ${store.state.checks.length} checks, ${store.state.logs.length} logs from data.json`,
    );
});

// Graceful shutdown — flush pending state writes.
async function shutdown(signal) {
    console.log(`[server] received ${signal}, shutting down…`);
    scheduler.stop();
    try {
        await store.flush();
    } catch (err) {
        console.warn("[server] flush failed:", err.message);
    }
    server.close(() => process.exit(0));
    // Hard timeout in case sockets linger.
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
