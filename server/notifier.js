// Out-of-band notifications for price events.
//
// Two event kinds:
//   • hit    — scraped price is at/below target (edge-triggered by caller)
//   • change — price moved up or down vs the previous check
//
// Each event fans out in parallel to every channel that is configured
// via env vars; channels with missing credentials are silently skipped.
// Currently supported:
//
//   • Slack    — incoming webhook URL (zero-auth, just a POST endpoint)
//   • Telegram — Bot API (bot token + chat id)
//
// When NO channel is configured we still log to stdout so events never
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

function formatChange(payload) {
    const dir = payload.direction === "up" ? "up" : "down";
    const arrow = dir === "up" ? "▲" : "▼";
    const prev = Number(payload.previousPrice).toFixed(2);
    const cur = payload.price.toFixed(2);
    const delta = Math.abs(payload.price - Number(payload.previousPrice)).toFixed(2);
    return { dir, arrow, prev, cur, delta };
}

function telegramText(payload) {
    if (payload.test) {
        return [
            "🧪 Coffee Price Sentinel — test notification",
            `Price: CHF ${payload.price.toFixed(2)} (target CHF ${Number(payload.targetPrice).toFixed(2)})`,
            `Method: ${payload.method}`,
            payload.productUrl,
        ].join("\n");
    }
    if (payload.kind === "change") {
        const { arrow, prev, cur, delta, dir } = formatChange(payload);
        return [
            `${arrow} Bialetti CLASSICO — price moved ${dir}!`,
            `CHF ${prev} → CHF ${cur} (${arrow} CHF ${delta})`,
            `Target: CHF ${Number(payload.targetPrice).toFixed(2)}`,
            `Method: ${payload.method}`,
            payload.productUrl,
        ].join("\n");
    }
    return [
        "☕ Bialetti CLASSICO — target hit!",
        `Price: CHF ${payload.price.toFixed(2)} (target CHF ${Number(payload.targetPrice).toFixed(2)})`,
        `Method: ${payload.method}`,
        payload.productUrl,
    ].join("\n");
}

function slackBlocks(payload) {
    const priceStr = payload.price.toFixed(2);
    const targetStr = Number(payload.targetPrice).toFixed(2);

    if (payload.test) {
        return {
            headerText: "🧪 Coffee Price Sentinel — test notification",
            fallbackText: `🧪 [TEST] Bialetti CLASSICO — CHF ${priceStr} (target CHF ${targetStr})`,
            fields: [
                { type: "mrkdwn", text: `*Price*\nCHF ${priceStr}` },
                { type: "mrkdwn", text: `*Target*\nCHF ${targetStr}` },
                { type: "mrkdwn", text: `*Method*\n${payload.method}` },
                { type: "mrkdwn", text: `*Source*\ninterismo.ch` },
            ],
            context: "_This is a test — no real price event. Triggered from the dashboard._",
        };
    }

    if (payload.kind === "change") {
        const { arrow, prev, cur, delta, dir } = formatChange(payload);
        return {
            headerText: `${arrow} Bialetti CLASSICO — price ${dir}`,
            fallbackText: `${arrow} Bialetti CLASSICO — CHF ${prev} → CHF ${cur} (${arrow} CHF ${delta})`,
            fields: [
                { type: "mrkdwn", text: `*Was*\nCHF ${prev}` },
                { type: "mrkdwn", text: `*Now*\nCHF ${cur}` },
                { type: "mrkdwn", text: `*Change*\n${arrow} CHF ${delta}` },
                { type: "mrkdwn", text: `*Target*\nCHF ${targetStr}` },
            ],
            context: null,
        };
    }

    return {
        headerText: "🎯 Bialetti CLASSICO — target hit!",
        fallbackText: `☕ Bialetti CLASSICO — CHF ${priceStr} (target CHF ${targetStr})`,
        fields: [
            { type: "mrkdwn", text: `*Price*\nCHF ${priceStr}` },
            { type: "mrkdwn", text: `*Target*\nCHF ${targetStr}` },
            { type: "mrkdwn", text: `*Method*\n${payload.method}` },
            { type: "mrkdwn", text: `*Source*\ninterismo.ch` },
        ],
        context: null,
    };
}

// ── Per-channel senders ────────────────────────────────────────────────────

async function sendTelegram(payload) {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: telegramText(payload),
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

async function sendSlack(payload) {
    const { headerText, fallbackText, fields, context } = slackBlocks(payload);

    const blocks = [
        {
            type: "header",
            text: { type: "plain_text", text: headerText, emoji: true },
        },
        { type: "section", fields },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "☕ Buy on interismo.ch", emoji: true },
                    url: payload.productUrl,
                    style: "primary",
                },
            ],
        },
    ];

    if (context) {
        blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: context }],
        });
    }

    try {
        const res = await fetch(SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: fallbackText, blocks }),
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

async function fanOut(payload) {
    const tasks = [];
    if (slackConfigured()) tasks.push(["slack", sendSlack(payload)]);
    if (telegramConfigured()) tasks.push(["telegram", sendTelegram(payload)]);

    if (tasks.length === 0) {
        const line = payload.kind === "change"
            ? `☕ PRICE ${payload.direction?.toUpperCase()} CHF ${Number(payload.previousPrice).toFixed(2)} → ${payload.price.toFixed(2)} | ${payload.method} | ${payload.productUrl}`
            : `☕ TARGET HIT CHF ${payload.price.toFixed(2)} (target CHF ${Number(payload.targetPrice).toFixed(2)}) | ${payload.method} | ${payload.productUrl}`;
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

// ── Public entry points ────────────────────────────────────────────────────

export async function notifyPriceHit(payload) {
    return fanOut({ ...payload, kind: "hit" });
}

export async function notifyPriceChange(payload) {
    return fanOut({ ...payload, kind: "change" });
}
