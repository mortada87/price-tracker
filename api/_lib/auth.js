// Shared auth guard for every /api/* function.
//
// Mirrors the Express middleware in `server/index.js`: when `ACCESS_TOKEN`
// is set, requests must present the token either as `?token=<value>` or as
// `Authorization: Bearer <value>`. When the env var is empty, the guard is
// a no-op so local `vercel dev` runs are friction-free.

function tokenFromRequest(req) {
    // `req.query.token` exists when Vercel parses the query string.
    if (req.query && typeof req.query.token === "string") return req.query.token;

    // Fallback: parse the URL manually (works for raw `Request`-like inputs).
    try {
        const url = new URL(req.url, "http://localhost");
        const t = url.searchParams.get("token");
        if (t) return t;
    } catch { /* ignore */ }

    const auth = req.headers?.authorization || req.headers?.get?.("authorization");
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return auth.slice("Bearer ".length);
    }
    return "";
}

// Returns `true` if the request is authorised. Lets the caller decide how
// to respond (so we can keep the public `/api/health` endpoint open).
export function isAuthorised(req) {
    const expected = process.env.ACCESS_TOKEN || "";
    if (!expected) return true;
    return tokenFromRequest(req) === expected;
}

// Convenience wrapper for the common case "401 if missing token".
export function requireAuth(handler) {
    return async function (req, res) {
        if (!isAuthorised(req)) {
            res.status(401).json({ error: "missing or invalid token" });
            return;
        }
        return handler(req, res);
    };
}
