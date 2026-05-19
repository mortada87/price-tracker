// GET /api/health — unauthenticated liveness probe. Useful for uptime
// monitors and quick "is the deployment alive" checks.

import { getStatus, getChecks } from "./_lib/store.js";

export default async function handler(_req, res) {
    try {
        const [status, checks] = await Promise.all([getStatus(), getChecks()]);
        res.json({
            ok: true,
            isRunning: status.isRunning,
            checks: checks.length,
            lastCheckAt: status.lastCheckAt,
            authRequired: Boolean(process.env.ACCESS_TOKEN),
            cron: Boolean(process.env.VERCEL),
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
}
