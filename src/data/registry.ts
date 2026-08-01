/**
 * Evidence collection.
 *
 * Without this the LLM answers from training data alone, which for a question
 * like "Will BTC reach $110,000 by end of 2027?" means it does not know what
 * BTC costs today. That is a far larger source of error than anything in the
 * pricing maths — a perfectly calibrated model reasoning from a stale price is
 * still wrong.
 *
 * Design rules, learned the hard way from the LLM layer:
 *   - every fetcher is individually failure-tolerant. A dead API degrades the
 *     context; it must never abort a run.
 *   - everything is cached and rate-limited, because this runs on a cron.
 *   - sources are chosen by market category, so a tennis question does not
 *     burn a crypto API call.
 *   - no key required for the defaults. Optional keys unlock more.
 */

import type { Market } from "../sdk/port.js";
import type { Evidence } from "../ai/estimator.js";
import type { EvidenceProvider } from "../agent/trader.js";
import type { Logger } from "../utils/logger.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

export interface Source {
  name: string;
  /** Categories this source is useful for; empty means "any". */
  categories: string[];
  /** Return a short factual block, or null if it has nothing relevant. */
  fetch(market: Market, ctx: SourceContext): Promise<string | null>;
}

export interface SourceContext {
  now: Date;
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  logger?: Logger | undefined;
  keys: { newsApi?: string | undefined };
}

/** Extract likely asset tickers from a question. */
export function detectAssets(question: string): string[] {
  const map: Record<string, string> = {
    bitcoin: "bitcoin",
    btc: "bitcoin",
    ethereum: "ethereum",
    eth: "ethereum",
    solana: "solana",
    sol: "solana",
    "pi network": "pi-network",
    ripple: "ripple",
    xrp: "ripple",
    dogecoin: "dogecoin",
    doge: "dogecoin",
    cardano: "cardano",
    ada: "cardano",
    bnb: "binancecoin",
    avalanche: "avalanche-2",
    chainlink: "chainlink",
    polkadot: "polkadot",
    litecoin: "litecoin",
  };
  const text = question.toLowerCase();
  const found = new Set<string>();
  for (const [needle, id] of Object.entries(map)) {
    // Word-boundary match so "sol" does not fire on "solar".
    if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
      found.add(id);
    }
  }
  return [...found];
}

/**
 * Live crypto prices from CoinGecko's public endpoint. No key required.
 *
 * This is the single highest-value source: most Delphi markets are price
 * thresholds, and a threshold question is trivial to answer correctly once you
 * know the current price and nearly impossible without it.
 */
export const cryptoSource: Source = {
  name: "coingecko",
  categories: ["crypto"],
  async fetch(market, ctx) {
    const question = market.metadata?.question ?? "";
    const ids = detectAssets(question);
    if (ids.length === 0) return null;

    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}` +
      `&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;

    const data = await ctx.fetchJson<
      Record<string, { usd?: number; usd_24h_change?: number; usd_market_cap?: number }>
    >(url);

    const lines: string[] = [];
    for (const [id, v] of Object.entries(data)) {
      if (typeof v.usd !== "number") continue;
      const change =
        typeof v.usd_24h_change === "number"
          ? ` (${v.usd_24h_change >= 0 ? "+" : ""}${v.usd_24h_change.toFixed(2)}% 24h)`
          : "";
      const cap =
        typeof v.usd_market_cap === "number"
          ? `, market cap $${(v.usd_market_cap / 1e9).toFixed(1)}B`
          : "";
      lines.push(`  ${id}: $${v.usd.toLocaleString("en-US")}${change}${cap}`);
    }
    if (lines.length === 0) return null;
    return `CURRENT PRICES (live, as of ${ctx.now.toISOString()}):\n${lines.join("\n")}`;
  },
};

/** Recent headlines, when a NEWS_API_KEY is configured. */
export const newsSource: Source = {
  name: "newsapi",
  categories: [],
  async fetch(market, ctx) {
    if (!ctx.keys.newsApi) return null;
    const question = market.metadata?.question;
    if (!question) return null;

    // Strip market boilerplate down to something searchable.
    const query = question
      .replace(/^will\s+/i, "")
      .replace(/\?$/, "")
      .split(/\s+/)
      .slice(0, 8)
      .join(" ");

    const url =
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}` +
      `&sortBy=publishedAt&pageSize=5&language=en`;

    const data = await ctx.fetchJson<{
      articles?: { title: string; publishedAt: string; source?: { name?: string } }[];
    }>(url, { headers: { "X-Api-Key": ctx.keys.newsApi } });

    const articles = (data.articles ?? []).slice(0, 5);
    if (articles.length === 0) return null;

    const lines = articles.map(
      (a) =>
        `  [${a.publishedAt.slice(0, 10)}] ${a.title}` +
        (a.source?.name ? ` (${a.source.name})` : ""),
    );
    return `RECENT HEADLINES:\n${lines.join("\n")}`;
  },
};

/**
 * Time context. Cheap, always available, and genuinely useful: models are
 * routinely wrong about what "now" is relative to a deadline.
 */
export const timeSource: Source = {
  name: "clock",
  categories: [],
  async fetch(market, ctx) {
    if (!market.settlesAt) return null;
    const settles = new Date(market.settlesAt);
    if (Number.isNaN(settles.getTime())) return null;
    const days = (settles.getTime() - ctx.now.getTime()) / 86_400_000;
    return (
      `TIMING: today is ${ctx.now.toISOString().slice(0, 10)}. ` +
      `This market resolves ${settles.toISOString().slice(0, 10)}, ` +
      `which is ${days.toFixed(1)} days away.`
    );
  },
};

export const DEFAULT_SOURCES: Source[] = [timeSource, cryptoSource, newsSource];

export interface RegistryOptions {
  sources?: Source[];
  logger?: Logger | undefined;
  newsApiKey?: string | undefined;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** Cache lifetime for a source response, ms. */
  cacheTtlMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Gathers evidence for a market from whichever sources match its category.
 * Failures are swallowed per-source and reported in the summary, so the agent
 * always knows what it was and was not told.
 */
export class EvidenceRegistry implements EvidenceProvider {
  private readonly cache = new Map<string, { at: number; value: string | null }>();
  private readonly sources: Source[];

  constructor(private readonly options: RegistryOptions = {}) {
    this.sources = options.sources ?? DEFAULT_SOURCES;
  }

  async gather(market: Market): Promise<Evidence> {
    const now = this.options.now?.() ?? new Date();
    const category = (market.category ?? "").toLowerCase();
    const applicable = this.sources.filter(
      (s) => s.categories.length === 0 || s.categories.includes(category),
    );

    const ctx: SourceContext = {
      now,
      logger: this.options.logger,
      keys: { newsApi: this.options.newsApiKey },
      fetchJson: (url, init) => this.fetchJson(url, init),
    };

    const results = await mapWithConcurrency(applicable, 3, async (source) => {
      const key = `${source.name}:${market.id}`;
      const cached = this.cache.get(key);
      const ttl = this.options.cacheTtlMs ?? 10 * 60_000;
      if (cached && now.getTime() - cached.at < ttl) {
        return { name: source.name, value: cached.value, ok: true };
      }
      try {
        const value = await source.fetch(market, ctx);
        this.cache.set(key, { at: now.getTime(), value });
        return { name: source.name, value, ok: true };
      } catch (err) {
        this.options.logger?.debug("evidence source failed", {
          source: source.name,
          market: market.id,
          error: err instanceof Error ? err.message.slice(0, 120) : String(err),
        });
        return { name: source.name, value: null, ok: false };
      }
    });

    const blocks: string[] = [];
    const sources: string[] = [];
    const failed: string[] = [];

    for (const r of results) {
      if (!r.ok) {
        failed.push(r.name);
        continue;
      }
      if (r.value) {
        blocks.push(r.value);
        sources.push(r.name);
      }
    }

    // Telling the model what we could NOT find is as important as what we could:
    // it should lower its confidence rather than confabulate.
    if (failed.length > 0) {
      blocks.push(
        `NOTE: these sources were unavailable this run: ${failed.join(", ")}. ` +
          `Treat the evidence above as incomplete.`,
      );
    }

    return { summary: blocks.join("\n\n"), sources };
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? 8000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The signal alone is not enough: a transport that ignores it (or a body
    // that stalls without erroring) would hang the whole run. Race the deadline
    // independently, same as the LLM client.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const request = (async () => {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return (await res.json()) as T;
    })();

    try {
      return await Promise.race([request, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
