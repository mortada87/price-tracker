// GET /api/state — full snapshot for the dashboard.

import { requireAuth } from "./_lib/auth.js";
import { snapshot } from "./_lib/store.js";
import { notifierStatus, notifierConfigured } from "./_lib/notifier.js";

async function handler(req, res) {
    const data = await snapshot();
    res.json({
        ...data,
        meta: {
            notifierConfigured: notifierConfigured(),
            notifiers: notifierStatus(),
            anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
            authRequired: Boolean(process.env.ACCESS_TOKEN),
            // Cron cadence on Vercel is fixed in vercel.json. Surface the
            // actual schedule so the UI can stop pretending checkEvery is
            // dynamic when running on Vercel Hobby.
            cronSchedule: process.env.VERCEL ? "daily (Hobby tier)" : null,
            serverTime: Date.now(),
        },
    });
}

export default requireAuth(handler);
