// Run exactly one initial price check when the deployment has no history yet.
// Called from GET /api/state so the first dashboard load populates the chart
// without the user clicking ↻ Now.

import { runCheck } from "./check.js";
import { getChecks, getStatus } from "./store.js";
import { getRedis } from "./redis.js";

const BOOTSTRAP_KEY = "state:bootstrap-lock";

export async function maybeRunInitialCheck() {
    const [checks, status] = await Promise.all([getChecks(), getStatus()]);
    if (checks.length > 0 || status.lastCheckAt) return { ran: false, reason: "already-has-data" };

    // Only one concurrent bootstrap across tabs / parallel polls.
    const acquired = await getRedis().set(BOOTSTRAP_KEY, String(Date.now()), { nx: true });
    if (!acquired) return { ran: false, reason: "in-progress" };

    try {
        const result = await runCheck();
        return { ran: true, ...result };
    } catch (e) {
        // Release lock so a later poll can retry after a transient failure.
        await getRedis().del(BOOTSTRAP_KEY);
        throw e;
    }
}
