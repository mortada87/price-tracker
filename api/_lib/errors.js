// Map thrown errors to HTTP responses the dashboard can surface.

import { kvEnvPresent } from "./redis.js";

export function respondError(res, err) {
    console.error("[api]", err);

    if (err?.code === "KV_NOT_CONFIGURED" || err?.message === "KV_NOT_CONFIGURED") {
        res.status(503).json({
            error: "Storage not configured",
            hint:
                "In the Vercel project: Storage → Create Database → Upstash Redis → " +
                "Connect to this project, then Redeploy. " +
                "KV_REST_API_URL and KV_REST_API_TOKEN must appear under Environment Variables.",
            kvConfigured: false,
        });
        return;
    }

    res.status(500).json({
        error: err?.message || "internal error",
        kvConfigured: kvEnvPresent(),
    });
}

export { kvEnvPresent };
