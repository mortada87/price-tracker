// GET /api/health — unauthenticated liveness probe. Useful for uptime
// monitors and quick "is the deployment alive" checks.

import { getStatus, getChecks } from "./_lib/store.js";
import { kvEnvPresent } from "./_lib/redis.js";
import { respondError } from "./_lib/errors.js";

export default async function handler(_req, res) {
    try {
        if (!kvEnvPresent()) {
            res.status(503).json({
                ok: false,
                kvConfigured: false,
                error: "Storage not configured",
                hint: "Connect Upstash Redis in Vercel Storage, then redeploy.",
            });
            return;
        }
        const [status, checks] = await Promise.all([getStatus(), getChecks()]);
        res.json({
            ok: true,
            isRunning: status.isRunning,
            checks: checks.length,
            lastCheckAt: status.lastCheckAt,
            authRequired: Boolean(process.env.ACCESS_TOKEN),
            kvConfigured: true,
            cron: Boolean(process.env.VERCEL),
        });
    } catch (e) {
        respondError(res, e);
    }
}
