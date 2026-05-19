// In-memory state with debounced JSON persistence, plus a tiny event bus
// so the scheduler and the SSE endpoint can react to mutations.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");

const MAX_LOGS = 200;
const MAX_CHECKS = 2000;

const DEFAULT_STATE = {
    config: {
        productUrl:
            "https://www.interismo.ch/fr-CH/bialetti/cafe-perfetto-moka-classico-250-g?sai=52284",
        targetPrice: 6.0,
        checkEvery: 30, // minutes
        strategy: "meta", // "meta" | "llm"
        backend: "anthropic", // "anthropic" | "ollama"
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "llama3",
    },
    checks: [], // { ts, price, hit, method }
    logs: [], // { ts, msg, type }
    status: {
        isRunning: false,
        loading: false,
        alert: false,
        nextCheckAt: null,
        lastCheckAt: null,
    },
};

// Deep-clone defaults so reset doesn't mutate the constant.
function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

export class StateStore extends EventEmitter {
    constructor() {
        super();
        this.state = cloneDefaults();
        this._writeTimer = null;
    }

    async load() {
        try {
            const raw = await fs.readFile(DATA_FILE, "utf8");
            const parsed = JSON.parse(raw);
            // Merge so newly added defaults appear in old saves.
            this.state = {
                config: { ...DEFAULT_STATE.config, ...(parsed.config || {}) },
                checks: Array.isArray(parsed.checks) ? parsed.checks : [],
                logs: Array.isArray(parsed.logs) ? parsed.logs : [],
                status: {
                    ...DEFAULT_STATE.status,
                    ...(parsed.status || {}),
                    // Don't trust persisted runtime flags — the scheduler is the
                    // sole authority for these on startup.
                    isRunning: false,
                    loading: false,
                    nextCheckAt: null,
                },
            };
        } catch (err) {
            if (err.code !== "ENOENT") {
                console.warn("[state] failed to load data.json:", err.message);
            }
            this.state = cloneDefaults();
            await this._persistNow();
        }
    }

    snapshot() {
        return JSON.parse(JSON.stringify(this.state));
    }

    // ── mutators ────────────────────────────────────────────────────────────

    updateConfig(patch) {
        const cleaned = sanitizeConfig(patch);
        this.state.config = { ...this.state.config, ...cleaned };
        this.emit("config", this.state.config);
        this._scheduleWrite();
        return this.state.config;
    }

    setStatus(patch) {
        this.state.status = { ...this.state.status, ...patch };
        this.emit("status", this.state.status);
        this._scheduleWrite();
        return this.state.status;
    }

    appendLog(msg, type = "info") {
        const entry = { ts: Date.now(), msg, type };
        this.state.logs.unshift(entry);
        if (this.state.logs.length > MAX_LOGS) {
            this.state.logs.length = MAX_LOGS;
        }
        this.emit("log", entry);
        this._scheduleWrite();
        return entry;
    }

    appendCheck({ price, method, hit }) {
        const entry = { ts: Date.now(), price, method, hit: !!hit };
        this.state.checks.push(entry);
        if (this.state.checks.length > MAX_CHECKS) {
            this.state.checks.splice(0, this.state.checks.length - MAX_CHECKS);
        }
        this.emit("check", entry);
        this._scheduleWrite();
        return entry;
    }

    clearAlert() {
        if (this.state.status.alert) {
            this.setStatus({ alert: false });
        }
    }

    // ── persistence ─────────────────────────────────────────────────────────

    _scheduleWrite() {
        if (this._writeTimer) return;
        // Debounce ~400ms — bursts of mutations during a check collapse into one write.
        this._writeTimer = setTimeout(() => {
            this._writeTimer = null;
            this._persistNow().catch((err) =>
                console.warn("[state] persist failed:", err.message),
            );
        }, 400);
    }

    async _persistNow() {
        const tmp = `${DATA_FILE}.tmp`;
        const json = JSON.stringify(this.state, null, 2);
        await fs.writeFile(tmp, json, "utf8");
        await fs.rename(tmp, DATA_FILE);
    }

    async flush() {
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = null;
        }
        await this._persistNow();
    }
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
    if (patch.strategy === "meta" || patch.strategy === "llm") {
        out.strategy = patch.strategy;
    }
    if (patch.backend === "anthropic" || patch.backend === "ollama") {
        out.backend = patch.backend;
    }
    if (typeof patch.ollamaUrl === "string" && patch.ollamaUrl.trim()) {
        out.ollamaUrl = patch.ollamaUrl.trim();
    }
    if (typeof patch.ollamaModel === "string" && patch.ollamaModel.trim()) {
        out.ollamaModel = patch.ollamaModel.trim();
    }
    return out;
}
