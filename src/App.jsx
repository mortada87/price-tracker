import { useState, useEffect, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// All scraping, LLM, and scheduling now live in the Node.js backend
// (see `server/`). This component is purely a remote control + dashboard.

const API = "/api";
const TOKEN_KEY = "coffee-sentinel:access-token";

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatCountdown(s) {
    if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h ${String(m).padStart(2, "0")}m`;
    }
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}m ${String(sec).padStart(2, "0")}s`;
}

// Pre-set check intervals shown as pills in the CONFIGURATION panel.
// Any integer minute value in [1, 1440] is accepted by the backend, so
// these are conveniences rather than hard limits.
const INTERVAL_PRESETS = [
    { mins: 15,   label: "15 min" },
    { mins: 30,   label: "30 min" },
    { mins: 60,   label: "1 h"    },
    { mins: 360,  label: "6 h"    },
    { mins: 720,  label: "12 h"   },
    { mins: 1440, label: "24 h"   },
];

// ── Access token plumbing ──────────────────────────────────────────────────
// The token is provisioned once via the URL hash (`#token=…`), persisted to
// localStorage, and then appended as `?token=…` on every request. We use a
// query param instead of a header so the SSE `EventSource` — which cannot
// set custom headers — can authenticate the same way as `fetch`.

function readInitialToken() {
    if (typeof window === "undefined") return "";
    const hash = window.location.hash;
    if (hash.startsWith("#token=")) {
        const t = decodeURIComponent(hash.slice("#token=".length));
        try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode etc. */ }
        // Strip the token from the visible URL so it can't be screenshotted /
        // shared accidentally. The value still lives in localStorage.
        history.replaceState(null, "", window.location.pathname + window.location.search);
        return t;
    }
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

function withToken(url, token) {
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function apiGet(path, token) {
    const res = await fetch(withToken(`${API}${path}`, token));
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return res.json();
}
async function apiPost(path, body, token) {
    const res = await fetch(withToken(`${API}${path}`, token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}`);
    return res.json();
}

// ── UI atoms (unchanged)
const C = {
    bg: "#090500", card: "#0e0700", border: "#1e1000",
    gold: "#d4a853", amber: "#c07820", brown: "#8B4513",
    dim: "#5a3e26", text: "#e8d5b5", green: "#4a9c6a", red: "#c05050",
};

const pill = (active, label, onClick) => (
    <button onClick={onClick} style={{
        padding: "7px 13px", borderRadius: 20, fontSize: 11, cursor: "pointer",
        fontFamily: "'DM Mono', monospace", letterSpacing: "0.05em",
        background: active ? "#251200" : "transparent",
        border: `1px solid ${active ? C.amber : C.border}`,
        color: active ? C.gold : C.dim, transition: "all 0.15s",
    }}>{label}</button>
);

const StatBox = ({ label, value, hi }) => (
    <div style={{
        background: hi ? "#150900" : C.card, border: `1px solid ${hi ? C.brown : C.border}`,
        borderRadius: 10, padding: "11px 8px", textAlign: "center",
    }}>
        <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.12em", marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 14, color: hi ? C.gold : "#c9a96e", fontWeight: 500 }}>{value}</div>
    </div>
);

const CT = ({ active, payload, label, tgt }) => {
    if (!active || !payload?.length) return null;
    const v = payload[0]?.value;
    return (
        <div style={{ background: C.bg, border: `1px solid ${v <= tgt ? C.gold : C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 11, fontFamily: "'DM Mono', monospace", color: C.text }}>
            <div style={{ opacity: 0.4, marginBottom: 2 }}>{label}</div>
            <div style={{ fontWeight: 600 }}>{v != null ? `CHF ${v.toFixed(2)}` : "—"}</div>
            {v != null && v <= tgt && <div style={{ color: C.gold, marginTop: 2 }}>🎯 Target hit!</div>}
        </div>
    );
};

// ── MAIN
export default function App() {
    // Mirror of the backend state. The server is the source of truth; this
    // local state is hydrated on mount and kept in sync via SSE.
    const [config, setConfig] = useState(null);
    const [status, setStatus] = useState({ isRunning: false, loading: false, alert: false, nextCheckAt: null, lastCheckAt: null });
    const [checks, setChecks] = useState([]);
    const [logs, setLogs] = useState([]);
    const [meta, setMeta] = useState({ notifierConfigured: false, anthropicKeyConfigured: false });

    // UI-only state.
    const [now, setNow] = useState(() => Date.now());
    const [connError, setConnError] = useState(null);
    const [busy, setBusy] = useState(false); // disables buttons during an HTTP round-trip
    const [token, setToken] = useState(() => readInitialToken());
    const [needsToken, setNeedsToken] = useState(false);
    const [tokenInput, setTokenInput] = useState("");

    // ── Initial load + polling ────────────────────────────────────────────
    // Polls `/api/state` every few seconds. Replaces the SSE stream we used
    // when the backend was a long-running Express process — Vercel's
    // serverless functions can't hold an open connection long enough for
    // SSE to be reliable, so we accept ~3s latency in exchange for working
    // on any function timeout.
    useEffect(() => {
        if (needsToken) return undefined;

        let cancelled = false;
        let timer = null;

        const tick = async () => {
            if (cancelled) return;
            try {
                const data = await apiGet("/state", token);
                if (cancelled) return;
                setConfig(data.config);
                setStatus(data.status);
                setChecks(data.checks || []);
                setLogs(data.logs || []);
                setMeta(data.meta || {});
                setConnError(null);
            } catch (e) {
                if (cancelled) return;
                if (e.message === "unauthorized") {
                    clearToken();
                    setToken("");
                    setNeedsToken(true);
                    return; // stop polling — token prompt takes over
                }
                setConnError(e.message);
            } finally {
                // Visible tab → 3s; hidden → 30s. Saves KV reads when the
                // dashboard isn't being looked at.
                if (!cancelled) {
                    const delay = typeof document !== "undefined" && document.hidden ? 30000 : 3000;
                    timer = setTimeout(tick, delay);
                }
            }
        };

        tick();

        const onVis = () => {
            if (typeof document !== "undefined" && !document.hidden) {
                if (timer) { clearTimeout(timer); timer = null; }
                tick();
            }
        };
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", onVis);
        }

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVis);
            }
        };
    }, [token, needsToken]);

    // Tick once per second so the countdown updates from `status.nextCheckAt`.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    // ── Derived values ─────────────────────────────────────────────────────
    const last = checks[checks.length - 1];
    const cur = last?.price;
    const tgt = config ? Number(config.targetPrice) : NaN;
    const lowest = checks.reduce((m, c) => (c.price != null && c.price < m ? c.price : m), Infinity);
    const gap = cur != null && !isNaN(tgt) ? cur - tgt : null;
    const chart = useMemo(() => checks.map((c) => ({ time: formatTime(c.ts), price: c.price })), [checks]);

    const countdown = status.nextCheckAt
        ? Math.max(0, Math.round((status.nextCheckAt - now) / 1000))
        : null;

    // ── Server actions ─────────────────────────────────────────────────────
    const withBusy = useCallback(async (fn) => {
        setBusy(true);
        try { await fn(); }
        catch (e) { setConnError(e.message); }
        finally { setBusy(false); }
    }, []);

    const start = useCallback(() => withBusy(() => apiPost("/start", null, token)), [withBusy, token]);
    const stop = useCallback(() => withBusy(() => apiPost("/stop", null, token)), [withBusy, token]);
    const checkNow = useCallback(() => withBusy(() => apiPost("/check-now", null, token)), [withBusy, token]);

    // Test-alert button has its own state machine so the user sees
    // "Sending → Sent ✓" feedback even when the request is sub-second.
    const [testState, setTestState] = useState({ phase: "idle", detail: "" });
    const testAlert = useCallback(async () => {
        setTestState({ phase: "sending", detail: "" });
        try {
            const res = await apiPost("/notifier/test", null, token);
            if (res.ok) {
                setTestState({ phase: "success", detail: "" });
            } else {
                const failed = Object.entries(res.channels || {})
                    .filter(([, r]) => !r.ok)
                    .map(([n, r]) => `${n}: ${r.reason}`)
                    .join(", ");
                setTestState({ phase: "error", detail: failed || res.reason || "failed" });
            }
        } catch (e) {
            setTestState({ phase: "error", detail: e.message });
        } finally {
            setTimeout(() => setTestState({ phase: "idle", detail: "" }), 2500);
        }
    }, [token]);

    // Config edits POST to the backend. We update local config optimistically
    // for snappy UI; SSE will then echo the canonical value back.
    const saveConfig = useCallback((patch) => {
        setConfig((c) => (c ? { ...c, ...patch } : c));
        // fire-and-forget; we don't block the UI on this
        apiPost("/config", patch, token).catch((e) => setConnError(e.message));
    }, [token]);

    const submitToken = useCallback(() => {
        const t = tokenInput.trim();
        if (!t) return;
        try { localStorage.setItem(TOKEN_KEY, t); } catch { /* noop */ }
        setTokenInput("");
        setNeedsToken(false);
        setToken(t); // re-runs the load effect with the new credential
    }, [tokenInput]);

    // ── Render ─────────────────────────────────────────────────────────────
    const inStyle = (extra = {}) => ({
        background: "#060300", border: `1px solid ${C.border}`, borderRadius: 8,
        color: C.text, fontFamily: "'DM Mono', monospace", fontSize: 12,
        padding: "9px 12px", outline: "none", boxSizing: "border-box", ...extra,
    });

    if (needsToken) {
        return (
            <div style={{ minHeight: "100vh", background: `radial-gradient(ellipse at 20% 0%, #1a0900 0%, ${C.bg} 60%)`, color: C.text, fontFamily: "'DM Mono', monospace", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, width: "100%", maxWidth: 420 }}>
                    <div style={{ fontSize: 24, marginBottom: 12 }}>🔒</div>
                    <div style={{ fontSize: 14, color: C.gold, marginBottom: 8 }}>Access token required</div>
                    <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6, marginBottom: 16 }}>
                        The backend is protected. Paste your token below, or visit this page with{" "}
                        <code style={{ color: C.amber }}>#token=…</code> appended to the URL.
                    </div>
                    <input
                        type="password"
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submitToken(); }}
                        placeholder="paste token"
                        autoFocus
                        style={{ ...inStyle(), width: "100%", marginBottom: 10 }}
                    />
                    <button
                        onClick={submitToken}
                        disabled={!tokenInput.trim()}
                        style={{ width: "100%", padding: 11, background: `linear-gradient(135deg, ${C.brown}, ${C.amber})`, border: "none", borderRadius: 10, color: "#fff8ee", fontSize: 12, letterSpacing: "0.08em", fontFamily: "'DM Mono', monospace", cursor: tokenInput.trim() ? "pointer" : "not-allowed", opacity: tokenInput.trim() ? 1 : 0.5 }}
                    >
                        UNLOCK
                    </button>
                </div>
            </div>
        );
    }

    if (!config) {
        return (
            <div style={{ minHeight: "100vh", background: C.bg, color: C.dim, fontFamily: "'DM Mono', monospace", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>
                {connError ? `Backend unreachable — ${connError}` : "Loading from backend…"}
            </div>
        );
    }

    const { strategy, backend, ollamaUrl, ollamaModel, checkEvery, targetPrice } = config;
    const { isRunning: running, loading, alert } = status;
    const onVercel = Boolean(meta.cronSchedule);

    return (
        <div style={{ minHeight: "100vh", background: `radial-gradient(ellipse at 20% 0%, #1a0900 0%, ${C.bg} 60%)`, fontFamily: "'DM Mono', monospace", color: C.text, padding: "28px 16px", display: "flex", justifyContent: "center" }}>
            <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Playfair+Display:wght@700;900&display=swap" rel="stylesheet" />

            <div style={{ width: "100%", maxWidth: 640 }}>

                {/* HEADER */}
                <div style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                        <span style={{ fontSize: 26 }}>☕</span>
                        <div>
                            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 900, margin: 0, background: `linear-gradient(120deg, ${C.gold}, ${C.amber})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                                Coffee Price Sentinel
                            </h1>
                            <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.1em" }}>BIALETTI PERFETTO MOKA CLASSICO 250G · INTERISMO.CH{onVercel ? " · VERCEL" : " · LOCAL"}</div>
                        </div>
                    </div>

                    {/* Status */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${alert ? C.brown : C.border}`, borderRadius: 8, padding: "9px 14px", fontSize: 11 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: alert ? C.red : running ? C.green : C.border, boxShadow: (alert || running) ? `0 0 8px ${alert ? C.red : C.green}88` : "none" }} />
                        <span style={{ flex: 1, color: alert ? C.red : running ? C.green : C.dim }}>
                            {connError ? `⚠ ${connError}` :
                                alert ? `🎯 Target hit! CHF ${cur?.toFixed(2)} — buy now!` :
                                    loading ? "Fetching price from interismo.ch…" :
                                        running ? (onVercel
                                            ? `Monitoring — automatic check ${meta.cronSchedule || "daily"}${countdown != null ? ` (≈ ${formatCountdown(countdown)})` : ""}`
                                            : `Monitoring — next check in ${countdown != null ? formatCountdown(countdown) : "…"}`) :
                                            onVercel
                                                ? "Idle — press Start to enable daily cron checks"
                                                : "Idle — press Start to launch the backend loop"}
                        </span>
                        {checks.length > 0 && <span style={{ color: C.dim, fontSize: 10 }}>{checks.length} checks</span>}
                    </div>
                </div>

                {/* PRODUCT */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 12, display: "flex", alignItems: "center", gap: 14 }}>
                    <img src="https://mw.nice-cdn.com/upload/image/product/large/default/491425_aadc4e9e.256x256.jpg" alt="Bialetti" style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", border: `1px solid ${C.border}` }} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: C.text, marginBottom: 2 }}>Bialetti Café Perfetto Moka CLASSICO</div>
                        <div style={{ fontSize: 9, color: C.dim }}>250 g · Arabica/Robusta · interismo.ch</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 18, color: cur != null && !isNaN(tgt) && cur <= tgt ? C.green : C.gold, fontWeight: 500 }}>
                            CHF {cur != null ? cur.toFixed(2) : "—"}
                        </div>
                        <div style={{ fontSize: 9, color: C.dim }}>{cur != null ? "live price" : "no check yet"}</div>
                    </div>
                </div>

                {/* CONFIG */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 12 }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.14em", marginBottom: 16 }}>── CONFIGURATION</div>

                    <div style={{ display: "grid", gap: 14 }}>

                        {/* Target */}
                        <div>
                            <label style={{ fontSize: 9, color: C.dim, letterSpacing: "0.12em", display: "block", marginBottom: 6 }}>TARGET PRICE (CHF)</label>
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                <input
                                    type="number"
                                    value={targetPrice}
                                    onChange={(e) => saveConfig({ targetPrice: e.target.value })}
                                    placeholder="5.90"
                                    style={{ ...inStyle(), flex: 1, width: "auto" }}
                                />
                                {gap != null && (
                                    <span style={{ fontSize: 11, color: gap > 0 ? C.dim : C.green, whiteSpace: "nowrap" }}>
                                        {gap > 0 ? `▼ CHF ${gap.toFixed(2)} to go` : "✓ already met"}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Interval */}
                        <div>
                            <label style={{ fontSize: 9, color: C.dim, letterSpacing: "0.12em", display: "block", marginBottom: 6 }}>CHECK EVERY</label>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {INTERVAL_PRESETS.map(({ mins, label }) =>
                                    pill(checkEvery === mins, label, () => saveConfig({ checkEvery: mins }))
                                )}
                            </div>
                            {meta.cronSchedule && (
                                <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.6 }}>
                                    ⓘ On Vercel Hobby the actual cadence is <b style={{ color: C.text }}>{meta.cronSchedule}</b> (cron limit). Pills above are advisory — upgrade to Pro for finer control.
                                </div>
                            )}
                        </div>

                        {/* Extraction */}
                        <div>
                            <label style={{ fontSize: 9, color: C.dim, letterSpacing: "0.12em", display: "block", marginBottom: 6 }}>EXTRACTION METHOD</label>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {pill(strategy === "meta", "🏷 Meta tag (no LLM)", () => saveConfig({ strategy: "meta" }))}
                                {pill(strategy === "llm", "🤖 LLM (AI)", () => saveConfig({ strategy: "llm" }))}
                            </div>
                            <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.7 }}>
                                {strategy === "meta"
                                    ? <>Reads <code style={{ color: C.amber }}>product:price:amount</code> OG meta directly from HTML. Fast, free, zero AI cost. <span style={{ color: C.green }}>Recommended for this site.</span></>
                                    : "Backend fetches HTML → strips tags → sends cleaned text to LLM → parses JSON response."}
                            </div>
                        </div>

                        {/* LLM backend */}
                        {strategy === "llm" && (
                            <div style={{ background: "#060300", border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                                <label style={{ fontSize: 9, color: C.dim, letterSpacing: "0.12em", display: "block", marginBottom: 10 }}>LLM BACKEND</label>
                                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                                    {pill(backend === "anthropic", "☁ Anthropic API", () => saveConfig({ backend: "anthropic" }))}
                                    {pill(backend === "ollama", "🦙 Ollama (local)", () => saveConfig({ backend: "ollama" }))}
                                </div>

                                {backend === "ollama" ? (
                                    <div style={{ display: "grid", gap: 10 }}>
                                        <div>
                                            <label style={{ fontSize: 9, color: C.dim, display: "block", marginBottom: 5 }}>OLLAMA BASE URL</label>
                                            <input value={ollamaUrl} onChange={e => saveConfig({ ollamaUrl: e.target.value })} style={{ ...inStyle(), width: "100%" }} placeholder="http://localhost:11434" />
                                        </div>
                                        <div>
                                            <label style={{ fontSize: 9, color: C.dim, display: "block", marginBottom: 6 }}>MODEL</label>
                                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                                {["llama3", "mistral", "qwen2.5", "gemma3"].map(m => pill(ollamaModel === m, m, () => saveConfig({ ollamaModel: m })))}
                                            </div>
                                        </div>
                                        <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.8, background: "#0a0500", borderRadius: 8, padding: "10px 12px" }}>
                                            <div style={{ color: C.amber, marginBottom: 4 }}>Setup required (on the Node.js host):</div>
                                            <div>1. <code>ollama serve</code></div>
                                            <div>2. <code>ollama pull {ollamaModel}</code></div>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.7 }}>
                                        Uses <code style={{ color: C.amber }}>claude-sonnet-4</code>. Set <code style={{ color: C.amber }}>ANTHROPIC_API_KEY</code> in {onVercel ? "Vercel env vars" : <code>server/.env</code>}.
                                        {" "}
                                        <span style={{ color: meta.anthropicKeyConfigured ? C.green : "#b07c30" }}>
                                            {meta.anthropicKeyConfigured ? "✓ key detected" : "⚠ key missing"}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Notifier status */}
                        <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.7, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            {(() => {
                                const ns = meta.notifiers || {};
                                const on = Object.entries(ns).filter(([, v]) => v).map(([k]) => k);
                                const pretty = on.map(n => n[0].toUpperCase() + n.slice(1)).join(" + ");
                                return (
                                    <>
                                        <span>
                                            Alerts:{" "}
                                            <span style={{ color: on.length ? C.green : "#b07c30" }}>
                                                {on.length
                                                    ? `✓ Active via ${pretty}`
                                                    : `⚠ No channel configured — set SLACK_WEBHOOK_URL or TELEGRAM_* in ${onVercel ? "Vercel env vars" : "server/.env"}`}
                                            </span>
                                        </span>
                                        {on.length > 0 && (() => {
                                            const visual = {
                                                idle:    { label: "🧪 Test alert",     border: C.border, color: C.gold,  bg: "transparent" },
                                                sending: { label: "⏳ Sending…",       border: C.amber,  color: C.amber, bg: "#1a0c00" },
                                                success: { label: "✓ Sent to Slack",   border: C.green,  color: C.green, bg: "#0d1a0d" },
                                                error:   { label: "✗ Failed",          border: C.red,    color: C.red,   bg: "#1a0a0a" },
                                            }[testState.phase];
                                            const disabled = testState.phase === "sending";
                                            return (
                                                <>
                                                    <button
                                                        onClick={testAlert}
                                                        disabled={disabled}
                                                        title="Send a test notification through every configured channel"
                                                        style={{
                                                            padding: "5px 12px", borderRadius: 14, fontSize: 10,
                                                            fontFamily: "'DM Mono', monospace", letterSpacing: "0.05em",
                                                            background: visual.bg,
                                                            border: `1px solid ${visual.border}`,
                                                            color: visual.color,
                                                            cursor: disabled ? "wait" : "pointer",
                                                            transition: "all 0.2s ease",
                                                            minWidth: 110,
                                                        }}
                                                    >
                                                        {visual.label}
                                                    </button>
                                                    {testState.phase === "error" && testState.detail && (
                                                        <span style={{ fontSize: 10, color: C.red }}>{testState.detail}</span>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </>
                                );
                            })()}
                        </div>
                    </div>

                    {/* Controls */}
                    <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                        {!running
                            ? <button onClick={start} disabled={busy} style={{ flex: 1, padding: 13, background: `linear-gradient(135deg, ${C.brown}, ${C.amber})`, border: "none", borderRadius: 10, color: "#fff8ee", fontSize: 12, cursor: busy ? "not-allowed" : "pointer", letterSpacing: "0.08em", fontFamily: "'DM Mono', monospace", opacity: busy ? 0.6 : 1 }}>▶ START MONITORING</button>
                            : <button onClick={stop} disabled={busy} style={{ flex: 1, padding: 13, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 10, color: C.dim, fontSize: 12, cursor: busy ? "not-allowed" : "pointer", fontFamily: "'DM Mono', monospace", opacity: busy ? 0.6 : 1 }}>⏸ PAUSE</button>
                        }
                        <button onClick={checkNow} disabled={loading || busy} style={{ padding: "13px 18px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 10, color: (loading || busy) ? C.border : C.dim, fontSize: 12, cursor: (loading || busy) ? "not-allowed" : "pointer", fontFamily: "'DM Mono', monospace" }}>
                            {loading ? "…" : "↻ Now"}
                        </button>
                    </div>
                </div>

                {/* STATS */}
                {checks.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                        <StatBox label="CURRENT" value={cur != null ? `CHF ${cur.toFixed(2)}` : "—"} hi={alert} />
                        <StatBox label="TARGET" value={!isNaN(tgt) ? `CHF ${tgt.toFixed(2)}` : "—"} />
                        <StatBox label="LOWEST" value={isFinite(lowest) ? `CHF ${lowest.toFixed(2)}` : "—"} />
                        <StatBox label="CHECKS" value={checks.length} />
                    </div>
                )}

                {/* CHART */}
                {checks.length > 1 && (
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 8px 10px", marginBottom: 12 }}>
                        <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.14em", marginBottom: 10, paddingLeft: 8 }}>── PRICE HISTORY</div>
                        <ResponsiveContainer width="100%" height={140}>
                            <LineChart data={chart} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                                <XAxis dataKey="time" tick={{ fontSize: 9, fill: C.dim, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} />
                                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: C.dim, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} width={50} tickFormatter={v => `${v.toFixed(2)}`} />
                                <Tooltip content={<CT tgt={tgt} />} />
                                {!isNaN(tgt) && <ReferenceLine y={tgt} stroke={C.gold} strokeDasharray="4 3" strokeWidth={1} />}
                                <Line type="monotone" dataKey="price" stroke={C.amber} strokeWidth={2} dot={{ fill: C.gold, r: 3, strokeWidth: 0 }} activeDot={{ fill: C.gold, r: 5 }} connectNulls={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* LOG */}
                <div style={{ background: "#060200", border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, maxHeight: 200, overflowY: "auto" }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.14em", marginBottom: 8 }}>── AGENT LOG (server)</div>
                    {logs.length === 0
                        ? <div style={{ fontSize: 11, color: C.border }}>No entries yet.</div>
                        : logs.map((e, i) => (
                            <div key={`${e.ts}-${i}`} style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.5, color: { info: C.dim, success: C.green, alert: C.gold, warn: "#b07c30", error: C.red }[e.type] || C.dim }}>
                                <span style={{ opacity: 0.4, marginRight: 8 }}>{formatTime(e.ts)}</span>{e.msg}
                            </div>
                        ))
                    }
                </div>

                <div style={{ textAlign: "center", marginTop: 14, fontSize: 9, color: "#1e1000", letterSpacing: "0.06em" }}>
                    {onVercel
                        ? "VERCEL · SERVERLESS API · KV PERSISTENCE · DAILY CRON"
                        : "NODE.JS BACKEND · SSE LIVE STREAM · PERSISTS TO DATA.JSON · RUNS 24/7"}
                </div>
            </div>
            <style>{`input::placeholder{color:#1e1000}input:focus{border-color:#8B4513!important}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#2a1800;border-radius:4px}`}</style>
        </div>
    );
}
