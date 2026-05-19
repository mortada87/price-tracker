// GET /api/state — full snapshot for the dashboard.

import { requireAuth } from "./_lib/auth.js";
import { snapshot } from "./_lib/store.js";
import { notifierStatus, notifierConfigured } from "./_lib/notifier.js";
import { kvEnvPresent } from "./_lib/redis.js";
import { maybeRunInitialCheck } from "./_lib/bootstrap.js";

async function handler(req, res) {
    if (req.method && req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    // First visit after deploy: no checks in KV yet → scrape once so the UI
    // isn't empty. Skipped once history exists or lastCheckAt is set.
    if (kvEnvPresent()) {
        try {
            await maybeRunInitialCheck();
        } catch (e) {
            console.warn("[api/state] initial check failed:", e.message);
        }
    }

    const data = await snapshot();
    res.json({
        ...data,
        meta: {
            notifierConfigured: notifierConfigured(),
            notifiers: notifierStatus(),
            anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
            authRequired: Boolean(process.env.ACCESS_TOKEN),
            kvConfigured: kvEnvPresent(),
            cronSchedule: process.env.VERCEL ? "daily (Hobby tier)" : null,
            serverTime: Date.now(),
        },
    });
}

export default requireAuth(handler);
