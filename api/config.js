// POST /api/config — patch the persistent config.

import { requireAuth } from "./_lib/auth.js";
import { setConfig, appendLog } from "./_lib/store.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }
    const updated = await setConfig(req.body || {});
    await appendLog("⚙ Configuration updated", "info");
    res.json(updated);
}

export default requireAuth(handler);
