// Price extraction strategies, ported from the original React `App.jsx`.
// All HTTP calls happen here on the server — no CORS proxy required.

const USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";

async function fetchPageHtml(url) {
    const res = await fetch(url, {
        cache: "no-store",
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-CH,fr;q=0.9,en;q=0.8",
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
}

// Strategy 1: parse OG meta tag from HTML (no LLM).
export async function extractPriceFromMeta(productUrl) {
    const html = await fetchPageHtml(productUrl);

    // interismo.ch embeds price in OG meta: <meta property="product:price:amount" content="6.75">
    const m1 =
        html.match(
            /property=["']product:price:amount["']\s+content=["']([0-9]+[.,][0-9]+)["']/i,
        ) ||
        html.match(
            /content=["']([0-9]+[.,][0-9]+)["']\s+property=["']product:price:amount["']/i,
        );
    if (m1) {
        return {
            price: parseFloat(m1[1].replace(",", ".")),
            method: "OG meta tag",
            html,
        };
    }

    const m2 = html.match(/CHF\s*([0-9]+[.,][0-9]{2})/);
    if (m2) {
        return {
            price: parseFloat(m2[1].replace(",", ".")),
            method: "CHF pattern",
            html,
        };
    }

    return { price: null, method: "not found in HTML", html };
}

// Strategy 2: LLM reads the cleaned HTML text.
export async function extractPriceWithLLM({
    productUrl,
    backend,
    ollamaUrl,
    ollamaModel,
}) {
    const { html } = await extractPriceFromMeta(productUrl);
    const text = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .slice(0, 3500);

    const system =
        'You are a price extraction agent. Return ONLY this JSON: {"price": <number or null>}. No markdown.';
    const user = `Extract the current CHF price of "Bialetti Café Perfetto Moka CLASSICO 250g" from:\n\n${text}`;

    if (backend === "anthropic") {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(
                "ANTHROPIC_API_KEY missing — set it in server/.env to use the Anthropic backend.",
            );
        }
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 200,
                messages: [{ role: "user", content: `${system}\n\n${user}` }],
            }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`Anthropic HTTP ${res.status}: ${detail.slice(0, 160)}`);
        }
        const data = await res.json();
        const raw = data.content?.find((b) => b.type === "text")?.text || "{}";
        const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        return {
            price: parsed.price ?? null,
            method: "Anthropic claude-sonnet-4",
        };
    }

    // Ollama (local).
    const res = await fetch(`${ollamaUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: ollamaModel,
            stream: false,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama HTTP ${res.status}: ${detail.slice(0, 160)}`);
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return {
        price: parsed.price ?? null,
        method: `Ollama / ${ollamaModel}`,
    };
}

// Single entry point used by the scheduler.
export async function runExtraction(config) {
    if (config.strategy === "llm") {
        return extractPriceWithLLM({
            productUrl: config.productUrl,
            backend: config.backend,
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel,
        });
    }
    return extractPriceFromMeta(config.productUrl);
}
