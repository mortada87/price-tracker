// GET /api/cron/check — Vercel Cron entry point.
//
// vercel.json schedules this to run once a day (the Hobby-tier limit).
// We accept the request only if it carries:
//   • Vercel's automatic `Authorization: Bearer ${CRON_SECRET}` header
//     (set when the user defines CRON_SECRET in the Vercel dashboard); OR
//   • our regular `ACCESS_TOKEN` (so manual tests with `curl` still work).
//
// If neither secret is configured, we accept any caller — convenient for
// `vercel dev` but you'll want to set at least one in production.

import { runCheck } from "../_lib/check.js";
import { getStatus, appendLog, setStatus } from "../_lib/store.js";

function isAuthorisedCron(req) {
    const cronSecret = process.env.CRON_SECRET || "";
    const accessToken = process.env.ACCESS_TOKEN || "";

    const auth = req.headers?.authorization || "";
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice("Bearer ".length)
        : "";

    const queryToken =
        (req.query && typeof req.query.token === "string" && req.query.token) || "";

    if (cronSecret && bearer === cronSecret) return true;
    if (accessToken && (bearer === accessToken || queryToken === accessToken)) return true;
    if (!cronSecret && !accessToken) return true; // dev mode

    return false;
}

export default async function handler(req, res) {
    if (!isAuthorisedCron(req)) {
        res.status(401).json({ error: "unauthorised" });
        return;
    }

    const status = await getStatus();
    if (!status.isRunning) {
        // Loop is paused — don't scrape, don't log noise.
        res.json({ ok: true, skipped: "isRunning=false" });
        return;
    }

    await appendLog("⏰ Cron tick", "info");
    const result = await runCheck();
    // Rough hint for the dashboard countdown (Hobby = once daily at 09:00 UTC).
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(9, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    await setStatus({ nextCheckAt: next.getTime(), isRunning: true });
    res.json(result);
}
