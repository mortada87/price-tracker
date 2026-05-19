// POST /api/notifier/test — fire a "test" notification through every
// configured channel without mutating the price history.

import { requireAuth } from "../_lib/auth.js";
import { getConfig, getChecks, appendLog } from "../_lib/store.js";
import { notifyPriceHit } from "../_lib/notifier.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    const config = await getConfig();
    const checks = await getChecks();
    const lastPrice = checks.length ? checks[checks.length - 1].price : null;

    const result = await notifyPriceHit({
        price: lastPrice ?? 6.75,
        targetPrice: config.targetPrice,
        productUrl: config.productUrl,
        method: "manual test",
        test: true,
    });

    if (result.reason === "not-configured") {
        await appendLog("🧪 Test: no notifier configured", "warn");
    } else {
        const parts = Object.entries(result.channels).map(([n, r]) =>
            r.ok ? `${n}✓` : `${n}✗(${r.reason})`,
        );
        await appendLog(`🧪 Test notification: ${parts.join(" ")}`, result.ok ? "info" : "warn");
    }

    res.json(result);
}

export default requireAuth(handler);
