// Lazy Upstash Redis client for Vercel serverless functions.
//
// Vercel's Storage → Upstash integration injects either:
//   KV_REST_API_URL + KV_REST_API_TOKEN
// or:
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

import { Redis } from "@upstash/redis";

let _client = null;

export function kvEnvPresent() {
    return Boolean(
        (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
        (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
    );
}

export function getRedis() {
    if (_client) return _client;

    if (!kvEnvPresent()) {
        const err = new Error("KV_NOT_CONFIGURED");
        err.code = "KV_NOT_CONFIGURED";
        throw err;
    }

    // Prefer explicit env vars (works with both Vercel KV and direct Upstash).
    _client = new Redis({
        url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return _client;
}
