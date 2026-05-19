// Vercel-native state store, backed by an Upstash Redis instance connected
// through Vercel's Marketplace KV integration.
//
// Replaces `server/state.js` in the serverless deployment. The shape it
// exposes is intentionally identical (config, status, checks, logs) so
// the rest of the API layer is a thin wrapper.

import { getRedis } from "./redis.js";

const MAX_LOGS = 200;
const MAX_CHECKS = 500; // ~40 KB at ~80 bytes/check — well below KV limits.

const KEYS = {
    config: "state:config",
    status: "state:status",
    checks: "state:checks",
    logs:   "state:logs",
};

const DEFAULT_CONFIG = {
    productUrl:
        "https://www.interismo.ch/fr-CH/bialetti/cafe-perfetto-moka-classico-250-g?sai=52284",
    targetPrice: 6.0,
    checkEvery: 1440, // minutes — DISPLAY-ONLY on Hobby (cron is fixed daily).
    strategy: "meta", // "meta" | "llm"
    backend: "anthropic", // "anthropic" | "ollama"
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "llama3",
};

const DEFAULT_STATUS = {
    isRunning: false,
    loading: false,
    alert: false,
    nextCheckAt: null,
    lastCheckAt: null,
};

// ── helpers ────────────────────────────────────────────────────────────────
// @upstash/redis auto-(de)serialises JSON for `get`/`set` of objects, but
// keeps list items as strings — so we parse them defensively.

function parseEntry(x) {
    if (x == null) return null;
    if (typeof x === "string") {
        try { return JSON.parse(x); } catch { return null; }
    }
    return x;
}

// ── config ─────────────────────────────────────────────────────────────────

export async function getConfig() {
    const stored = await getRedis().get(KEYS.config);
    return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

export async function setConfig(patch) {
    const cur = await getConfig();
    const next = { ...cur, ...sanitizeConfig(patch) };
    await getRedis().set(KEYS.config, next);
    return next;
}

function sanitizeConfig(patch) {
    const out = {};
    if (typeof patch.productUrl === "string" && patch.productUrl.trim()) {
        out.productUrl = patch.productUrl.trim();
    }
    if (patch.targetPrice !== undefined) {
        const n = Number(patch.targetPrice);
        if (!Number.isNaN(n) && n >= 0) out.targetPrice = n;
    }
    if (patch.checkEvery !== undefined) {
        const n = Number(patch.checkEvery);
        if (Number.isInteger(n) && n >= 1 && n <= 24 * 60) out.checkEvery = n;
    }
    if (patch.strategy === "meta" || patch.strategy === "llm") out.strategy = patch.strategy;
    if (patch.backend === "anthropic" || patch.backend === "ollama") out.backend = patch.backend;
    if (typeof patch.ollamaUrl === "string" && patch.ollamaUrl.trim()) {
        out.ollamaUrl = patch.ollamaUrl.trim();
    }
    if (typeof patch.ollamaModel === "string" && patch.ollamaModel.trim()) {
        out.ollamaModel = patch.ollamaModel.trim();
    }
    return out;
}

// ── status ─────────────────────────────────────────────────────────────────

export async function getStatus() {
    const stored = await getRedis().get(KEYS.status);
    return { ...DEFAULT_STATUS, ...(stored || {}) };
}

export async function setStatus(patch) {
    const cur = await getStatus();
    const next = { ...cur, ...patch };
    await getRedis().set(KEYS.status, next);
    return next;
}

// ── logs ───────────────────────────────────────────────────────────────────
// Stored newest-first (LPUSH at index 0) to match the in-memory model where
// the React app expects `logs[0]` to be the most recent entry.

export async function appendLog(msg, type = "info") {
    const entry = { ts: Date.now(), msg, type };
    await getRedis().lpush(KEYS.logs, JSON.stringify(entry));
    await getRedis().ltrim(KEYS.logs, 0, MAX_LOGS - 1);
    return entry;
}

export async function getLogs() {
    const items = await getRedis().lrange(KEYS.logs, 0, MAX_LOGS - 1);
    return items.map(parseEntry).filter(Boolean);
}

// ── checks ─────────────────────────────────────────────────────────────────
// Stored oldest-first (RPUSH at the tail) so the chart can iterate `checks`
// in chronological order without reversing.

export async function appendCheck({ price, method, hit }) {
    const entry = { ts: Date.now(), price, method, hit: !!hit };
    await getRedis().rpush(KEYS.checks, JSON.stringify(entry));
    // Keep only the most recent MAX_CHECKS entries.
    await getRedis().ltrim(KEYS.checks, -MAX_CHECKS, -1);
    return entry;
}

export async function getChecks() {
    const items = await getRedis().lrange(KEYS.checks, 0, -1);
    return items.map(parseEntry).filter(Boolean);
}

export async function clearAlert() {
    const cur = await getStatus();
    if (cur.alert) await setStatus({ alert: false });
}

// ── one-shot snapshot for GET /api/state ───────────────────────────────────

export async function snapshot() {
    const [config, status, checks, logs] = await Promise.all([
        getConfig(), getStatus(), getChecks(), getLogs(),
    ]);
    return { config, status, checks, logs };
}
