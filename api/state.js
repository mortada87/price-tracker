// GET /api/state — full snapshot for the dashboard.

import { requireAuth } from "./_lib/auth.js";
import { snapshot } from "./_lib/store.js";
import { notifierStatus, notifierConfigured } from "./_lib/notifier.js";
import { kvEnvPresent } from "./_lib/redis.js";

async function handler(req, res) {
    if (req.method && req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
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
