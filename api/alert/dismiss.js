// POST /api/alert/dismiss — clear the in-memory "target hit" banner flag.

import { requireAuth } from "../_lib/auth.js";
import { clearAlert, getStatus } from "../_lib/store.js";

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }
    await clearAlert();
    const status = await getStatus();
    res.json({ ok: true, status });
}

export default requireAuth(handler);
