// Single source of truth for "run one price check end-to-end".
// Used by both the Vercel cron handler and the manual /api/check-now route.

import { runExtraction } from "./scraper.js";
import { notifyPriceHit, notifyPriceChange } from "./notifier.js";
import { getConfig, getStatus, getChecks, setStatus, appendCheck, appendLog } from "./store.js";

function lastKnownPrice(checks) {
    for (let i = checks.length - 1; i >= 0; i--) {
        if (checks[i].price != null) return checks[i].price;
    }
    return null;
}

async function logNotifyResult(result, label) {
    if (result.reason === "not-configured") {
        await appendLog("📨 Notifier not configured (set SLACK_WEBHOOK_URL or TELEGRAM_*)", "warn");
        return;
    }
    const parts = Object.entries(result.channels).map(([n, r]) =>
        r.ok ? `${n}✓` : `${n}✗(${r.reason})`,
    );
    await appendLog(`📨 ${label}: ${parts.join(" ")}`, result.ok ? "info" : "warn");
}

export async function runCheck() {
    const config = await getConfig();
    await setStatus({ loading: true });
    await appendLog("Fetching interismo.ch…", "info");

    try {
        const { price, method } = await runExtraction(config);
        const tgt = Number(config.targetPrice);
        const hit = price != null && !Number.isNaN(tgt) && price <= tgt;
        const prev = await getStatus();
        const previousPrice = lastKnownPrice(await getChecks());
        const moved = price != null && previousPrice != null && price !== previousPrice;
        const direction = moved ? (price > previousPrice ? "up" : "down") : null;

        await appendCheck({ price, method, hit });

        // Edge-trigger: notify only on the transition into "hit", not every cron tick.
        let didHitNotify = false;
        if (hit) {
            await appendLog(`🎯 TARGET HIT! CHF ${price.toFixed(2)} [${method}]`, "alert");
            if (!prev.alert) {
                await setStatus({ alert: true });
                didHitNotify = true;
                const result = await notifyPriceHit({
                    price, targetPrice: tgt, productUrl: config.productUrl, method,
                });
                await logNotifyResult(result, "hit");
            }
        } else if (prev.alert) {
            await setStatus({ alert: false });
        }

        // Any up/down vs previous check — skip when we already sent a fresh hit
        // (the hit message covers that drop past the target).
        if (moved && !didHitNotify) {
            const arrow = direction === "up" ? "▲" : "▼";
            const delta = Math.abs(price - previousPrice);
            await appendLog(
                `${arrow} Price ${direction}: CHF ${previousPrice.toFixed(2)} → ${price.toFixed(2)} (Δ ${delta.toFixed(2)}) [${method}]`,
                "alert",
            );
            const result = await notifyPriceChange({
                price,
                previousPrice,
                direction,
                targetPrice: tgt,
                productUrl: config.productUrl,
                method,
            });
            await logNotifyResult(result, "change");
        } else if (!hit && price != null) {
            await appendLog(`✓ CHF ${price.toFixed(2)} [${method}]`, "success");
        } else if (price == null) {
            await appendLog(`⚠ Price not found [${method}]`, "warn");
        }

        await setStatus({ lastCheckAt: Date.now(), loading: false });
        return { ok: true, price, hit, moved: !!moved, direction, method };
    } catch (e) {
        await appendLog(`✗ ${e.message}`, "error");
        await setStatus({ loading: false });
        return { ok: false, error: e.message };
    }
}
