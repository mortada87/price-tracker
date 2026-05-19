// POST /api/stop — pause the cron handler by clearing `isRunning`.

import { requireAuth } from "./_lib/auth.js";
import { setStatus, appendLog } from "./_lib/store.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }
    const status = await setStatus({ isRunning: false, nextCheckAt: null });
    await appendLog("⏸ Paused — cron will skip until you press Start", "info");
    res.json({ ok: true, status });
}

export default requireAuth(handler);
