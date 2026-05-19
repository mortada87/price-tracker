// POST /api/check-now — manual one-shot check. Same code path as the cron
// handler, ignores the `isRunning` gate because the user explicitly asked.

import { requireAuth } from "./_lib/auth.js";
import { runCheck } from "./_lib/check.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }
    const result = await runCheck();
    if (result.ok) {
        res.json({ ok: true, price: result.price, hit: result.hit, method: result.method });
    } else {
        res.status(500).json({ ok: false, error: result.error });
    }
}

export default requireAuth(handler);
