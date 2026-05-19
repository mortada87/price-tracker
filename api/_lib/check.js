// Single source of truth for "run one price check end-to-end".
// Used by both the Vercel cron handler and the manual /api/check-now route.

import { runExtraction } from "./scraper.js";
import { notifyPriceHit } from "./notifier.js";
import { getConfig, getStatus, setStatus, appendCheck, appendLog } from "./store.js";

export async function runCheck() {
    const config = await getConfig();
    await setStatus({ loading: true });
    await appendLog("Fetching interismo.ch…", "info");

    try {
        const { price, method } = await runExtraction(config);
        const tgt = Number(config.targetPrice);
        const hit = price != null && !Number.isNaN(tgt) && price <= tgt;
        const prev = await getStatus();
        await appendCheck({ price, method, hit });

        if (hit) {
            await appendLog(`🎯 TARGET HIT! CHF ${price.toFixed(2)} [${method}]`, "alert");
            // Edge-trigger: notify only on the transition into "hit", not every cron tick.
            if (!prev.alert) {
                await setStatus({ alert: true });
                const result = await notifyPriceHit({
                    price, targetPrice: tgt, productUrl: config.productUrl, method,
                });
                if (result.reason === "not-configured") {
                    await appendLog("📨 Notifier not configured (set SLACK_WEBHOOK_URL or TELEGRAM_*)", "warn");
                } else {
                    const parts = Object.entries(result.channels).map(([n, r]) =>
                        r.ok ? `${n}✓` : `${n}✗(${r.reason})`,
                    );
                    await appendLog(`📨 ${parts.join(" ")}`, result.ok ? "info" : "warn");
                }
            }
        } else {
            if (prev.alert) await setStatus({ alert: false });
        }

        if (!hit && price != null) {
            await appendLog(`✓ CHF ${price.toFixed(2)} [${method}]`, "success");
        } else {
            await appendLog(`⚠ Price not found [${method}]`, "warn");
        }

        await setStatus({ lastCheckAt: Date.now(), loading: false });
        return { ok: true, price, hit, method };
    } catch (e) {
        await appendLog(`✗ ${e.message}`, "error");
        await setStatus({ loading: false });
        return { ok: false, error: e.message };
    }
}
