// Background loop. Owns the single `setTimeout` that drives recurring checks.
// We use setTimeout (not setInterval) so that `nextCheckAt` and the actual
// wake-up always agree, even if the user changes `checkEvery` mid-loop.

import { runExtraction } from "./scraper.js";
import { notifyPriceHit, notifyPriceChange } from "./notifier.js";

function lastKnownPrice(checks) {
    for (let i = checks.length - 1; i >= 0; i--) {
        if (checks[i].price != null) return checks[i].price;
    }
    return null;
}

function logNotifyResult(store, result, label) {
    if (result.reason === "not-configured") {
        store.appendLog(
            "📨 Notifier not configured (set SLACK_WEBHOOK_URL or TELEGRAM_*)",
            "warn",
        );
        return;
    }
    const parts = Object.entries(result.channels).map(([name, r]) =>
        r.ok ? `${name}✓` : `${name}✗(${r.reason})`,
    );
    store.appendLog(`📨 ${label}: ${parts.join(" ")}`, result.ok ? "info" : "warn");
}

export class Scheduler {
    constructor(store) {
        this.store = store;
        this._timer = null;
        this._inFlight = null;
    }

    isRunning() {
        return this.store.state.status.isRunning;
    }

    async start() {
        if (this.isRunning()) return;
        const { checkEvery, strategy, backend } = this.store.state.config;
        this.store.setStatus({ isRunning: true, alert: false });
        this.store.appendLog(
            `▶ Started — every ${checkEvery} min via ${
                strategy === "meta" ? "meta tag" : `LLM (${backend})`
            }`,
            "info",
        );
        await this.runCheck("scheduled");
        this._scheduleNext();
    }

    stop() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (!this.isRunning()) return;
        this.store.setStatus({ isRunning: false, nextCheckAt: null });
        this.store.appendLog("⏸ Paused", "info");
    }

    // Reset the next-wake-up after a config change while running.
    rearm() {
        if (!this.isRunning()) return;
        this._scheduleNext();
    }

    // Manual "Check Now". Reuses the same in-flight guard as the loop.
    async checkNow() {
        await this.runCheck("manual");
        if (this.isRunning()) this._scheduleNext();
    }

    async runCheck(origin = "scheduled") {
        // Coalesce overlapping checks (manual click during a scheduled run).
        if (this._inFlight) return this._inFlight;
        this._inFlight = this._doCheck(origin).finally(() => {
            this._inFlight = null;
        });
        return this._inFlight;
    }

    async _doCheck(origin) {
        const { config } = this.store.state;
        this.store.setStatus({ loading: true });
        this.store.appendLog(
            origin === "manual"
                ? "Manual check — fetching…"
                : "Fetching interismo.ch…",
            "info",
        );

        try {
            const { price, method } = await runExtraction(config);
            const tgt = Number(config.targetPrice);
            const hit = price != null && !Number.isNaN(tgt) && price <= tgt;
            const prevAlert = this.store.state.status.alert;
            const previousPrice = lastKnownPrice(this.store.state.checks);
            const moved = price != null && previousPrice != null && price !== previousPrice;
            const direction = moved ? (price > previousPrice ? "up" : "down") : null;

            this.store.appendCheck({ price, method, hit });

            // Edge-trigger hit notify on transition into hit (matches Vercel path).
            let didHitNotify = false;
            if (hit) {
                this.store.setStatus({ alert: true });
                this.store.appendLog(
                    `🎯 TARGET HIT! CHF ${price.toFixed(2)} [${method}]`,
                    "alert",
                );
                if (!prevAlert) {
                    didHitNotify = true;
                    notifyPriceHit({
                        price,
                        targetPrice: tgt,
                        productUrl: config.productUrl,
                        method,
                    })
                        .then((res) => logNotifyResult(this.store, res, "hit"))
                        .catch(() => {
                            /* already logged inside notifier */
                        });
                }
            } else if (prevAlert) {
                this.store.setStatus({ alert: false });
            }

            // Any up/down vs previous check — skip when we already sent a fresh hit.
            if (moved && !didHitNotify) {
                const arrow = direction === "up" ? "▲" : "▼";
                const delta = Math.abs(price - previousPrice);
                this.store.appendLog(
                    `${arrow} Price ${direction}: CHF ${previousPrice.toFixed(2)} → ${price.toFixed(2)} (Δ ${delta.toFixed(2)}) [${method}]`,
                    "alert",
                );
                notifyPriceChange({
                    price,
                    previousPrice,
                    direction,
                    targetPrice: tgt,
                    productUrl: config.productUrl,
                    method,
                })
                    .then((res) => logNotifyResult(this.store, res, "change"))
                    .catch(() => {
                        /* already logged inside notifier */
                    });
            } else if (!hit && price != null) {
                this.store.appendLog(
                    `✓ CHF ${price.toFixed(2)} [${method}]`,
                    "success",
                );
            } else if (price == null) {
                this.store.appendLog(`⚠ Price not found [${method}]`, "warn");
            }

            this.store.setStatus({ lastCheckAt: Date.now() });
        } catch (err) {
            this.store.appendLog(`✗ ${err.message}`, "error");
        } finally {
            this.store.setStatus({ loading: false });
        }
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        const ms = Math.max(1, this.store.state.config.checkEvery) * 60 * 1000;
        const nextCheckAt = Date.now() + ms;
        this.store.setStatus({ nextCheckAt });
        this._timer = setTimeout(() => {
            this._timer = null;
            if (!this.isRunning()) return;
            this.runCheck("scheduled").then(() => {
                if (this.isRunning()) this._scheduleNext();
            });
        }, ms);
    }
}
