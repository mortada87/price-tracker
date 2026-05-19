// POST /api/start — flip the `isRunning` flag in KV.
// On Vercel the actual scheduling is done by Vercel Cron (vercel.json).
// This flag just gates the cron handler so the user can pause checks
// from the dashboard without redeploying.

import { requireAuth } from "./_lib/auth.js";
import { setStatus, appendLog } from "./_lib/store.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + (next.getUTCHours() >= 9 ? 1 : 0));
    next.setUTCHours(9, 0, 0, 0);
    const status = await setStatus({
        isRunning: true,
        alert: false,
        nextCheckAt: next.getTime(),
    });
    await appendLog("▶ Started — Vercel Cron will check daily (~09:00 UTC)", "info");
    res.json({ ok: true, status });
}

export default requireAuth(handler);
