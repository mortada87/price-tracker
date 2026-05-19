// Out-of-band notifications for price hits.
//
// Each price-hit fans out in parallel to every channel that is configured
// via env vars; channels with missing credentials are silently skipped.
// Currently supported:
//
//   • Slack    — incoming webhook URL (zero-auth, just a POST endpoint)
//   • Telegram — Bot API (bot token + chat id)
//
// When NO channel is configured we still log to stdout so price hits never
// vanish, and the API exposes per-channel status so the UI can show what's
// wired up.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const telegramConfigured = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const slackConfigured = () => Boolean(SLACK_WEBHOOK_URL);

export function notifierStatus() {
    return {
        telegram: telegramConfigured(),
        slack: slackConfigured(),
    };
}

// Kept for compatibility with existing callers — true iff any channel is on.
export function notifierConfigured() {
    const s = notifierStatus();
    return s.telegram || s.slack;
}

// ── Per-channel senders ────────────────────────────────────────────────────

async function sendTelegram({ price, targetPrice, productUrl, method, test }) {
    const text = [
        test
            ? "🧪 Coffee Price Sentinel — test notification"
            : "☕ Bialetti CLASSICO — target hit!",
        `Price: CHF ${price.toFixed(2)} (target CHF ${Number(targetPrice).toFixed(2)})`,
        `Method: ${method}`,
        productUrl,
    ].join("\n");

    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text,
                    disable_web_page_preview: false,
                }),
            },
        );
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 160) };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: "exception", detail: err.message };
    }
}

async function sendSlack({ price, targetPrice, productUrl, method, test }) {
    const priceStr = price.toFixed(2);
    const targetStr = Number(targetPrice).toFixed(2);

    const headerText = test
        ? "🧪 Coffee Price Sentinel — test notification"
        : "🎯 Bialetti CLASSICO — target hit!";

    // Fallback plain text for notifications / clients that can't render blocks.
    const fallbackText = `${test ? "🧪 [TEST] " : "☕ "}Bialetti CLASSICO — CHF ${priceStr} (target CHF ${targetStr})`;

    const blocks = [
        {
            type: "header",
            text: { type: "plain_text", text: headerText, emoji: true },
        },
        {
            type: "section",
            fields: [
                { type: "mrkdwn", text: `*Price*\nCHF ${priceStr}` },
                { type: "mrkdwn", text: `*Target*\nCHF ${targetStr}` },
                { type: "mrkdwn", text: `*Method*\n${method}` },
                { type: "mrkdwn", text: `*Source*\ninterismo.ch` },
            ],
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "☕ Buy on interismo.ch", emoji: true },
                    url: productUrl,
                    style: "primary",
                },
            ],
        },
    ];

    if (test) {
        blocks.push({
            type: "context",
            elements: [
                { type: "mrkdwn", text: "_This is a test — no real price hit. Triggered from the dashboard._" },
            ],
        });
    }

    const payload = { text: fallbackText, blocks };

    try {
        const res = await fetch(SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 160) };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: "exception", detail: err.message };
    }
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function notifyPriceHit(payload) {
    const tasks = [];
    if (slackConfigured()) tasks.push(["slack", sendSlack(payload)]);
    if (telegramConfigured()) tasks.push(["telegram", sendTelegram(payload)]);

    if (tasks.length === 0) {
        const line = `☕ TARGET HIT CHF ${payload.price.toFixed(2)} (target CHF ${Number(payload.targetPrice).toFixed(2)}) | ${payload.method} | ${payload.productUrl}`;
        console.log(`[notifier] (no channel configured) ${line}`);
        return { ok: false, reason: "not-configured", channels: {} };
    }

    const settled = await Promise.allSettled(tasks.map(([, p]) => p));
    const channels = {};
    tasks.forEach(([name], i) => {
        const r = settled[i];
        channels[name] = r.status === "fulfilled"
            ? r.value
            : { ok: false, reason: "exception", detail: r.reason?.message };
        if (!channels[name].ok) {
            console.warn(`[notifier] ${name} failed: ${channels[name].reason}${channels[name].detail ? ` — ${channels[name].detail}` : ""}`);
        }
    });
    const anyOk = Object.values(channels).some((r) => r.ok);
    return { ok: anyOk, channels };
}
