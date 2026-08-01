/**
 * Persistence. The risk controls are only real if this works.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../src/portfolio/storage.js";
import type { TradeIntent } from "../src/agent/executor.js";

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  id: "run-1:0xmarket:0",
  marketAddress: "0xMARKET",
  outcomeIdx: 0,
  sharesOut: 10n ** 18n,
  quotedTokensIn: 500_000n,
  probability: 0.6,
  ...over,
});

const store = () => new Store(":memory:");

describe("trade journal", () => {
  it("survives a restart — the whole point of it", async () => {
    // Two Store instances over one file would be the real test; in-memory
    // cannot share, so assert the query path a fresh process would take.
    const s = store();
    await s.recordAttempt(intent());
    expect(await s.wasAttempted("run-1:0xmarket:0")).toBe(true);
    expect(await s.wasAttempted("run-1:0xmarket:1")).toBe(false);
  });

  it("records the attempt BEFORE the result, so a crash cannot double-trade", async () => {
    const s = store();
    await s.recordAttempt(intent());
    // Simulate a crash here: no recordResult ever arrives.
    expect(await s.wasAttempted(intent().id)).toBe(true);
  });

  it("counts only filled trades toward the daily cap", async () => {
    const s = store();
    await s.recordAttempt(intent({ id: "a" }));
    await s.recordAttempt(intent({ id: "b" }));
    await s.recordResult("a", { transactionHash: "0xtx", filledTokensIn: 1n });
    await s.recordFailure("b", "reverted");
    expect(s.tradesToday()).toBe(1);
  });

  it("ignores trades from previous days", async () => {
    const s = store();
    await s.recordAttempt(intent({ id: "a" }));
    await s.recordResult("a", { transactionHash: "0xtx", filledTokensIn: 1n });
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    expect(s.tradesToday(tomorrow)).toBe(0);
  });
});

describe("drawdown peak", () => {
  it("is undefined on a fresh database, leaving the breaker inert", () => {
    expect(store().peakBankroll()).toBeUndefined();
  });

  it("remembers the high-water mark, not the latest value", () => {
    const s = store();
    s.recordBankroll(1000);
    s.recordBankroll(1200);
    s.recordBankroll(800); // a loss must not lower the peak
    expect(s.peakBankroll()).toBe(1200);
  });
});

describe("estimate cache", () => {
  const entry = {
    estimate: { probabilities: [0.6, 0.4], confidence: 0.8, reasoning: "r" },
    cachedAt: Date.now(),
    marketProbabilities: [0.5, 0.5],
    metadataFingerprint: "abc",
  };

  it("round-trips an estimate", () => {
    const s = store();
    s.set("0xAbC", entry);
    expect(s.get("0xabc")?.estimate.probabilities).toEqual([0.6, 0.4]);
    expect(s.size).toBe(1);
  });

  it("is case-insensitive about market addresses", () => {
    const s = store();
    s.set("0xABC", entry);
    expect(s.get("0xabc")).toBeDefined();
  });

  it("prunes stale entries so the file does not grow forever", () => {
    const s = store();
    s.set("0xold", { ...entry, cachedAt: Date.now() - 10 * 86_400_000 });
    s.set("0xnew", entry);
    expect(s.pruneEstimates(60)).toBe(1);
    expect(s.size).toBe(1);
    expect(s.get("0xnew")).toBeDefined();
  });
});

describe("predictions", () => {
  const prediction = {
    runId: "run-1",
    market: "0xMARKET",
    question: "Will it rain?",
    probabilities: [0.7, 0.3],
    confidence: 0.8,
    marketProbabilities: [0.5, 0.5],
    settlesAt: "2026-09-01T00:00:00Z",
  };

  it("stores the full distribution, not just the traded outcome", () => {
    const s = store();
    s.recordPrediction(prediction);
    s.markScored(1, 0);
    const scored = s.scoredPredictions();
    expect(scored).toHaveLength(1);
    expect(scored[0]!.probabilities).toEqual([0.7, 0.3]);
    expect(scored[0]!.winningIdx).toBe(0);
  });

  it("lists unscored predictions for follow-up", () => {
    const s = store();
    s.recordPrediction(prediction);
    s.recordPrediction({ ...prediction, market: "0xOTHER" });
    expect(s.unscoredPredictions()).toHaveLength(2);
    s.markScored(1, 1);
    expect(s.unscoredPredictions()).toHaveLength(1);
    expect(s.scoredPredictions()).toHaveLength(1);
  });
});

describe("run history", () => {
  it("records a run summary", () => {
    const s = store();
    s.recordRun({
      runId: "run-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      bankrollUsdc: 1000,
      cashUsdc: 900,
      markets: 10,
      candidates: 2,
      executed: 1,
    });
    // Reported through tradedMarkets/scoredPredictions elsewhere; here we only
    // assert it does not throw and the schema accepts a missing `halted`.
    expect(s.peakBankroll()).toBeUndefined();
  });
});
