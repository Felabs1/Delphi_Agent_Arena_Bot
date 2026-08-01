/**
 * What the agent is forbidden from doing, regardless of how good the edge looks.
 */

import { describe, expect, it } from "vitest";
import {
  checkMarketEligible,
  checkPortfolio,
  checkTrade,
  correlationKey,
  type ExposureSnapshot,
  type RiskLimits,
} from "../src/agent/risk.js";

const limits = (over: Partial<RiskLimits> = {}): RiskLimits => ({
  maxExposurePerMarket: 0.1,
  maxExposurePerCorrelatedGroup: 0.2,
  maxTotalExposure: 0.6,
  maxDailyTrades: 30,
  maxDrawdown: 0.25,
  ...over,
});

const snapshot = (over: Partial<ExposureSnapshot> = {}): ExposureSnapshot => ({
  bankrollUsdc: 1000,
  peakBankrollUsdc: 1000,
  perMarket: new Map(),
  perCorrelationKey: new Map(),
  tradesToday: 0,
  ...over,
});

describe("drawdown circuit breaker", () => {
  it("allows trading while inside the limit", () => {
    const s = snapshot({ bankrollUsdc: 800, peakBankrollUsdc: 1000 }); // -20%
    expect(checkPortfolio(s, limits()).allowed).toBe(true);
  });

  it("halts once drawdown reaches the limit", () => {
    const s = snapshot({ bankrollUsdc: 740, peakBankrollUsdc: 1000 }); // -26%
    const v = checkPortfolio(s, limits());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/drawdown/);
  });

  it("is inert on a fresh book where peak equals current", () => {
    expect(checkPortfolio(snapshot(), limits()).allowed).toBe(true);
  });
});

describe("daily trade cap", () => {
  it("blocks once the cap is reached", () => {
    const v = checkPortfolio(
      snapshot({ tradesToday: 30 }),
      limits({ maxDailyTrades: 30 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/daily trade cap/);
  });
});

describe("exposure caps", () => {
  it("blocks a trade that would breach the per-market cap", () => {
    const s = snapshot({ perMarket: new Map([["0xaaa", 80]]) });
    const v = checkTrade(
      { marketAddress: "0xAAA", correlationKey: "k", costUsdc: 30 },
      s,
      limits({ maxExposurePerMarket: 0.1 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/market exposure/);
  });

  it("is case-insensitive about market addresses", () => {
    const s = snapshot({ perMarket: new Map([["0xaaa", 99]]) });
    const v = checkTrade(
      { marketAddress: "0xAAA", correlationKey: "k", costUsdc: 5 },
      s,
      limits({ maxExposurePerMarket: 0.1 }),
    );
    expect(v.allowed).toBe(false);
  });

  it("blocks correlated over-concentration across different markets", () => {
    const s = snapshot({
      perMarket: new Map([["0xaaa", 90], ["0xbbb", 90]]),
      perCorrelationKey: new Map([["crypto:btc-100k", 190]]),
    });
    const v = checkTrade(
      { marketAddress: "0xccc", correlationKey: "crypto:btc-100k", costUsdc: 30 },
      s,
      limits({ maxExposurePerMarket: 0.5, maxExposurePerCorrelatedGroup: 0.2 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/correlated/);
  });

  it("blocks a trade that would breach total exposure", () => {
    const s = snapshot({
      perMarket: new Map([["0xa", 200], ["0xb", 200], ["0xc", 190]]),
    });
    const v = checkTrade(
      { marketAddress: "0xd", correlationKey: "k", costUsdc: 50 },
      s,
      limits({ maxExposurePerMarket: 0.5, maxTotalExposure: 0.6 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/total exposure/);
  });

  it("allows a trade that fits every cap", () => {
    expect(
      checkTrade(
        { marketAddress: "0xa", correlationKey: "k", costUsdc: 50 },
        snapshot(),
        limits(),
      ).allowed,
    ).toBe(true);
  });
});

describe("market eligibility", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  const eligible = {
    status: "open",
    settlesAt: "2026-08-10T00:00:00Z",
    verifiable: true,
    hasMetadata: true,
    hasPrices: true,
  };

  it("accepts a well-formed open market inside the window", () => {
    expect(checkMarketEligible(eligible, limits(), now).allowed).toBe(true);
  });

  it("rejects markets that settle after the competition closes", () => {
    const v = checkMarketEligible(
      eligible,
      limits({ tradingWindowEnd: new Date("2026-08-05T00:00:00Z") }),
      now,
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/after competition close/);
  });

  it("rejects non-open markets", () => {
    expect(
      checkMarketEligible({ ...eligible, status: "settled" }, limits(), now)
        .allowed,
    ).toBe(false);
  });

  it("rejects markets with no metadata or no prices", () => {
    expect(
      checkMarketEligible({ ...eligible, hasMetadata: false }, limits(), now)
        .allowed,
    ).toBe(false);
    expect(
      checkMarketEligible({ ...eligible, hasPrices: false }, limits(), now)
        .allowed,
    ).toBe(false);
  });

  it("rejects markets already past settlement", () => {
    expect(
      checkMarketEligible(
        { ...eligible, settlesAt: "2026-07-01T00:00:00Z" },
        limits(),
        now,
      ).allowed,
    ).toBe(false);
  });

  it("rejects markets settling too soon to be worth the gas", () => {
    const v = checkMarketEligible(
      { ...eligible, settlesAt: "2026-08-01T01:00:00Z" },
      limits({ minHoursToSettlement: 6 }),
      now,
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/minimum/);
  });

  it("can require verifiable settlement", () => {
    expect(
      checkMarketEligible(
        { ...eligible, verifiable: false },
        limits({ requireVerifiable: true }),
        now,
      ).allowed,
    ).toBe(false);
    expect(
      checkMarketEligible({ ...eligible, verifiable: false }, limits(), now)
        .allowed,
    ).toBe(true);
  });

  it("rejects an unparseable settlement date rather than trading blind", () => {
    expect(
      checkMarketEligible({ ...eligible, settlesAt: "soon" }, limits(), now)
        .allowed,
    ).toBe(false);
  });
});

describe("correlation key", () => {
  it("groups two phrasings of the same underlying event", () => {
    const a = correlationKey(
      "Will BTC be above $100,000 on January 1?",
      "crypto",
    );
    const b = correlationKey(
      "Will BTC have hit $100,000 by January 1?",
      "crypto",
    );
    expect(a).toBe(b);
  });

  it("separates genuinely different events", () => {
    const btc = correlationKey("Will BTC be above $100,000?", "crypto");
    const eth = correlationKey("Will ETH be above $5,000?", "crypto");
    expect(btc).not.toBe(eth);
  });

  it("separates identical questions in different categories", () => {
    expect(correlationKey("Will X win?", "politics")).not.toBe(
      correlationKey("Will X win?", "sports"),
    );
  });
});
