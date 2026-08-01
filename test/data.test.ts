/**
 * Evidence collection. Network is stubbed — nothing here makes a real call.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EvidenceRegistry,
  cryptoSource,
  detectAssets,
  timeSource,
  type Source,
} from "../src/data/registry.js";
import { FakeDelphi } from "../src/sdk/fake.js";
import type { Market } from "../src/sdk/port.js";

const NOW = new Date("2026-08-02T00:00:00Z");

async function marketFor(question: string, category = "crypto"): Promise<Market> {
  const id = "0x00000000000000000000000000000000000000a1";
  const port = new FakeDelphi([
    {
      id,
      question,
      outcomes: ["Yes", "No"],
      supplies: [500, 500],
      category,
      settlesAt: "2026-09-01T00:00:00Z",
    },
  ]);
  return port.getMarket(id, true);
}

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

describe("asset detection", () => {
  it("finds tickers and full names", () => {
    expect(detectAssets("Will BTC reach $110000?")).toEqual(["bitcoin"]);
    expect(detectAssets("Will Ethereum close above $2100?")).toEqual(["ethereum"]);
    expect(detectAssets("Will the price of Pi Network reach $1?")).toContain(
      "pi-network",
    );
  });

  it("does not fire on substrings", () => {
    // "sol" must not match "solar"; this is why the matcher is word-bounded.
    expect(detectAssets("Will solar capacity double?")).toEqual([]);
  });

  it("returns nothing for a non-crypto question", () => {
    expect(detectAssets("Will the German Chancellor resign?")).toEqual([]);
  });
});

describe("crypto source", () => {
  it("reports the live price the model would otherwise be guessing", async () => {
    const market = await marketFor("Will BTC reach $110000 by 2027?");
    const value = await cryptoSource.fetch(market, {
      now: NOW,
      keys: {},
      fetchJson: (async () => ({
        bitcoin: { usd: 97234, usd_24h_change: -1.23, usd_market_cap: 1.9e12 },
      })) as <T>(u: string) => Promise<T>,
    });
    expect(value).toContain("97,234");
    expect(value).toContain("-1.23%");
  });

  it("returns null when no asset is recognised, rather than a useless call", async () => {
    const market = await marketFor("Will it rain in Lisbon?");
    const fetchJson = vi.fn();
    const value = await cryptoSource.fetch(market, {
      now: NOW,
      keys: {},
      fetchJson,
    });
    expect(value).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe("time source", () => {
  it("tells the model what 'now' is relative to the deadline", async () => {
    const market = await marketFor("Will BTC moon?");
    const value = await timeSource.fetch(market, {
      now: NOW,
      keys: {},
      fetchJson: (async () => ({})) as <T>(u: string) => Promise<T>,
    });
    expect(value).toContain("2026-08-02");
    expect(value).toContain("2026-09-01");
    expect(value).toMatch(/30\.0 days away/);
  });
});

describe("EvidenceRegistry", () => {
  const okSource = (name: string, text: string): Source => ({
    name,
    categories: [],
    fetch: async () => text,
  });
  const failingSource = (name: string): Source => ({
    name,
    categories: [],
    fetch: async () => {
      throw new Error("upstream exploded");
    },
  });

  it("combines sources into one evidence block", async () => {
    const registry = new EvidenceRegistry({
      sources: [okSource("a", "FACT A"), okSource("b", "FACT B")],
      now: () => NOW,
    });
    const evidence = await registry.gather(await marketFor("Will BTC moon?"));
    expect(evidence.summary).toContain("FACT A");
    expect(evidence.summary).toContain("FACT B");
    expect(evidence.sources).toEqual(["a", "b"]);
  });

  it("survives a dead source instead of aborting the run", async () => {
    const registry = new EvidenceRegistry({
      sources: [okSource("good", "FACT"), failingSource("bad")],
      now: () => NOW,
    });
    const evidence = await registry.gather(await marketFor("Will BTC moon?"));
    expect(evidence.summary).toContain("FACT");
    expect(evidence.sources).toEqual(["good"]);
  });

  it("tells the model which sources were unavailable", async () => {
    // Silently degrading would let the model confabulate with full confidence.
    const registry = new EvidenceRegistry({
      sources: [failingSource("newsapi")],
      now: () => NOW,
    });
    const evidence = await registry.gather(await marketFor("Will BTC moon?"));
    expect(evidence.summary).toContain("unavailable");
    expect(evidence.summary).toContain("newsapi");
  });

  it("only runs sources matching the market's category", async () => {
    const cryptoOnly: Source = {
      name: "crypto-only",
      categories: ["crypto"],
      fetch: async () => "CRYPTO",
    };
    const registry = new EvidenceRegistry({
      sources: [cryptoOnly],
      now: () => NOW,
    });
    const sports = await registry.gather(
      await marketFor("Will Sinner win?", "sports"),
    );
    expect(sports.sources).toEqual([]);

    const crypto = await registry.gather(
      await marketFor("Will BTC moon?", "crypto"),
    );
    expect(crypto.sources).toEqual(["crypto-only"]);
  });

  it("caches within the TTL so a cron does not hammer public APIs", async () => {
    let calls = 0;
    const counting: Source = {
      name: "counting",
      categories: [],
      fetch: async () => {
        calls++;
        return "FACT";
      },
    };
    const registry = new EvidenceRegistry({
      sources: [counting],
      now: () => NOW,
      cacheTtlMs: 60_000,
    });
    const market = await marketFor("Will BTC moon?");
    await registry.gather(market);
    await registry.gather(market);
    expect(calls).toBe(1);
  });

  it("gives up on a slow source rather than hanging the run", async () => {
    const registry = new EvidenceRegistry({
      sources: [
        {
          name: "slow",
          categories: [],
          fetch: (_m, ctx) => ctx.fetchJson("https://example.test/x"),
        },
      ],
      now: () => NOW,
      timeoutMs: 20,
      fetchImpl: (() =>
        new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    const evidence = await registry.gather(await marketFor("Will BTC moon?"));
    expect(evidence.summary).toContain("unavailable");
  }, 5000);

  it("reports an HTTP error as a source failure, not a crash", async () => {
    const registry = new EvidenceRegistry({
      sources: [
        {
          name: "broken",
          categories: [],
          fetch: (_m, ctx) => ctx.fetchJson("https://example.test/x"),
        },
      ],
      now: () => NOW,
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch,
    });
    const evidence = await registry.gather(await marketFor("Will BTC moon?"));
    expect(evidence.summary).toContain("unavailable");
  });

  it("passes parsed JSON through to the source", async () => {
    const registry = new EvidenceRegistry({
      sources: [cryptoSource],
      now: () => NOW,
      fetchImpl: (async () =>
        jsonResponse({ bitcoin: { usd: 100000 } })) as unknown as typeof fetch,
    });
    const evidence = await registry.gather(
      await marketFor("Will BTC reach $110000?"),
    );
    expect(evidence.summary).toContain("100,000");
  });
});
