/**
 * The whole loop, end to end, against a simulated DPM chain.
 *
 * fetch -> filter -> estimate -> EV -> risk -> quote -> execute -> report
 */

import { describe, expect, it } from "vitest";
import { runOnce, type TraderConfig } from "../src/agent/trader.js";
import { MemoryJournal } from "../src/agent/executor.js";
import { FakeDelphi, type FakeMarketSpec } from "../src/sdk/fake.js";
import { StaticEstimator, type MarketEstimate } from "../src/ai/estimator.js";
import { impliedProbabilities } from "../src/agent/dpm.js";
import type { Address } from "../src/sdk/port.js";

const NOW = new Date("2026-08-01T00:00:00Z");
const SOON = "2026-08-04T00:00:00Z";
const LATER = "2026-08-25T00:00:00Z";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";

const config = (over: Partial<TraderConfig> = {}): TraderConfig => ({
  runId: "run-1",
  marketLimit: 50,
  maxTradesPerRun: 10,
  dryRun: false,
  sizing: {
    maxPositionFraction: 0.2,
    maxShareOfMarket: 1, // exercised directly in its own test below
    kellyFraction: 0.4,
    minimumEdge: 0.03,
    minimumEvPerToken: 0.02,
    confidenceThreshold: 0.6,
    payoutModel: { creatorHaircut: 0, feeToPoolFraction: 1 },
  },
  risk: {
    maxExposurePerMarket: 0.25,
    maxExposurePerCorrelatedGroup: 0.4,
    maxTotalExposure: 0.9,
    maxDailyTrades: 30,
    maxDrawdown: 0.25,
  },
  executor: {
    slippageTolerance: 0.02,
    maxRequoteDrift: 0.05,
    minimumEvPerToken: 0.01,
    payoutModel: { creatorHaircut: 0, feeToPoolFraction: 1 },
  },
  ...over,
});

const estimate = (probabilities: number[], confidence = 0.9): MarketEstimate => ({
  probabilities,
  confidence,
  reasoning: "test",
});

function market(over: Partial<FakeMarketSpec> & { id: string }): FakeMarketSpec {
  return {
    question: "Will the thing happen?",
    outcomes: ["Yes", "No"],
    supplies: [200, 800],
    settlesAt: SOON,
    category: "crypto",
    ...over,
  };
}

describe("runOnce", () => {
  it("trades a mispriced market and reports what it did", async () => {
    const port = new FakeDelphi([market({ id: A })], 1000);
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.45, 0.55])]])),
      new MemoryJournal(),
      config(),
      undefined,
      NOW,
    );

    expect(report.marketsFetched).toBe(1);
    expect(report.marketsEvaluated).toBe(1);
    expect(report.executions).toHaveLength(1);
    expect(report.executions[0]!.result.status).toBe("executed");
    expect(port.trades).toHaveLength(1);
    expect(port.trades[0]!.outcomeIdx).toBe(0); // the underpriced side
  });

  it("leaves a fairly-priced market alone", async () => {
    const port = new FakeDelphi([market({ id: A })], 1000);
    const state = await port.getDpmState(A as Address);
    const fair = impliedProbabilities(state.supplies);

    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate(fair)]])),
      new MemoryJournal(),
      config(),
      undefined,
      NOW,
    );

    expect(report.executions).toHaveLength(0);
    expect(port.trades).toHaveLength(0);
    expect(report.skips.length).toBeGreaterThan(0);
  });

  it("skips markets settling after the competition closes", async () => {
    const port = new FakeDelphi(
      [market({ id: A, settlesAt: "2026-12-01T00:00:00Z" })],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.45, 0.55])]])),
      new MemoryJournal(),
      config({
        risk: {
          ...config().risk,
          tradingWindowEnd: new Date("2026-09-01T00:00:00Z"),
        },
      }),
      undefined,
      NOW,
    );

    expect(report.marketsEvaluated).toBe(0);
    expect(port.trades).toHaveLength(0);
    expect(report.skips[0]!.reason).toMatch(/after competition close/);
  });

  it("will not trade below the confidence threshold", async () => {
    const port = new FakeDelphi([market({ id: A })], 1000);
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.45, 0.55], 0.2)]])),
      new MemoryJournal(),
      config(),
      undefined,
      NOW,
    );
    expect(port.trades).toHaveLength(0);
    expect(report.skips.some((s) => /confidence/.test(s.reason))).toBe(true);
  });

  it("prefers the sooner-settling market when edges are comparable", async () => {
    const port = new FakeDelphi(
      [
        market({ id: A, settlesAt: LATER, question: "Alpha event?" }),
        market({ id: B, settlesAt: SOON, question: "Beta event?" }),
      ],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(
        new Map([
          [A, estimate([0.45, 0.55])],
          [B, estimate([0.45, 0.55])],
        ]),
      ),
      new MemoryJournal(),
      config({ maxTradesPerRun: 1 }),
      undefined,
      NOW,
    );

    expect(report.executions).toHaveLength(1);
    expect(report.executions[0]!.candidate.market.id.toLowerCase()).toBe(
      B.toLowerCase(),
    );
  });

  it("caps correlated exposure across separate markets on one event", async () => {
    const question = "Will BTC be above 100000 on January 1?";
    const port = new FakeDelphi(
      [
        market({ id: A, question }),
        market({ id: B, question: "Will BTC hit 100000 by January 1?" }),
        market({ id: C, question }),
      ],
      1000,
    );
    const answers = new Map([
      [A, estimate([0.45, 0.55])],
      [B, estimate([0.45, 0.55])],
      [C, estimate([0.45, 0.55])],
    ]);

    const report = await runOnce(
      port,
      new StaticEstimator(answers),
      new MemoryJournal(),
      config({
        sizing: { ...config().sizing, maxPositionFraction: 0.2 },
        // Each trade costs ~22 USDC of a 1000 bankroll, so a 4% group cap lets
        // the first through and blocks the rest.
        risk: { ...config().risk, maxExposurePerCorrelatedGroup: 0.04 },
      }),
      undefined,
      NOW,
    );

    // All three questions describe one event, so they share one cap.
    const keys = new Set(report.candidates.map((c) => c.correlationKey));
    expect(keys.size).toBe(1);

    expect(report.skips.some((s) => /correlated/.test(s.reason))).toBe(true);
    expect(
      report.executions.filter((e) => e.result.status === "executed").length,
    ).toBe(1);
  });

  it("never takes both sides of the same market", async () => {
    // Regression: a live run produced candidates for Yes AND No on one market.
    // They cannot both win. It happens in near-empty markets where the payout
    // model degenerates, so reproduce that: redeemable supply is tiny, which
    // makes every outcome look enormously profitable.
    const port = new FakeDelphi(
      [market({ id: A, supplies: [1.5, 1.5], creatorSharesPerOutcome: 1 })],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.5, 0.5])]])),
      new MemoryJournal(),
      // Cap disabled so both sides survive sizing and dedup is what stops them.
      config({ sizing: { ...config().sizing, maxShareOfMarket: 1 } }),
      undefined,
      NOW,
    );

    const perMarket = new Map<string, number>();
    for (const c of report.candidates) {
      const k = c.market.id.toLowerCase();
      perMarket.set(k, (perMarket.get(k) ?? 0) + 1);
    }
    for (const count of perMarket.values()) expect(count).toBe(1);
    expect(port.trades.length).toBeLessThanOrEqual(1);
  });

  it("refuses a market too thin to trade without becoming the market", async () => {
    // Redeemable supply is 0.01 shares, so even the smallest legal trade would
    // make us ~50% of the market — the regime that produced 1953 USDC/share
    // payouts and made both sides of a binary look profitable.
    const port = new FakeDelphi(
      [market({ id: A, supplies: [1.2, 1.2], creatorSharesPerOutcome: 1.19 })],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.9, 0.1])]])),
      new MemoryJournal(),
      config({ sizing: { ...config().sizing, maxShareOfMarket: 0.25 } }),
      undefined,
      NOW,
    );

    expect(port.trades).toHaveLength(0);
    expect(
      report.skips.some((s) => /too thin|redeemable supply/.test(s.reason)),
    ).toBe(true);
  });

  it("honours the per-run trade cap", async () => {
    const port = new FakeDelphi(
      [
        market({ id: A, question: "Alpha?" }),
        market({ id: B, question: "Beta?" }),
        market({ id: C, question: "Gamma?" }),
      ],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(
        new Map([
          [A, estimate([0.45, 0.55])],
          [B, estimate([0.45, 0.55])],
          [C, estimate([0.45, 0.55])],
        ]),
      ),
      new MemoryJournal(),
      config({ maxTradesPerRun: 2 }),
      undefined,
      NOW,
    );

    expect(report.executions).toHaveLength(2);
    expect(report.skips.some((s) => /max trades per run/.test(s.reason))).toBe(
      true,
    );
  });

  it("halts entirely when the drawdown breaker has tripped", async () => {
    const port = new FakeDelphi([market({ id: A })], 500);
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.45, 0.55])]])),
      new MemoryJournal(),
      config({ peakBankrollUsdc: 1000 }), // bankroll halved
      undefined,
      NOW,
    );

    expect(report.halted).toMatch(/drawdown/);
    expect(report.marketsFetched).toBe(0);
    expect(port.trades).toHaveLength(0);
  });

  it("executes nothing in dry-run mode but still produces candidates", async () => {
    const port = new FakeDelphi([market({ id: A })], 1000);
    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[A, estimate([0.45, 0.55])]])),
      new MemoryJournal(),
      config({ dryRun: true }),
      undefined,
      NOW,
    );

    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.executions[0]!.result.status).toBe("dry-run");
    expect(port.trades).toHaveLength(0);
  });

  it("reclaims settled capital before evaluating new trades", async () => {
    const port = new FakeDelphi(
      [
        market({ id: A, question: "Resolved already?" }),
        market({ id: B, question: "Still open?" }),
      ],
      100,
    );
    port.seedPosition(A, 0, 50);
    port.settle(A, 0);

    const report = await runOnce(
      port,
      new StaticEstimator(new Map([[B, estimate([0.45, 0.55])]])),
      new MemoryJournal(),
      config(),
      undefined,
      NOW,
    );

    expect(report.sweep.redeemed).toHaveLength(1);
    // Redemption landed before sizing, so the freed cash is spendable this pass.
    expect(report.cashUsdc).toBeGreaterThan(100);
  });

  it("never re-trades the same market/outcome within a run id", async () => {
    const port = new FakeDelphi([market({ id: A })], 1000);
    const journal = new MemoryJournal();
    const estimator = new StaticEstimator(
      new Map([[A, estimate([0.45, 0.55])]]),
    );

    await runOnce(port, estimator, journal, config(), undefined, NOW);
    const tradesAfterFirst = port.trades.length;

    // Same runId: a crashed cron tick replaying must not double up.
    await runOnce(port, estimator, journal, config(), undefined, NOW);
    expect(port.trades).toHaveLength(tradesAfterFirst);
  });

  it("records a reason for every market it declines", async () => {
    const port = new FakeDelphi(
      [
        market({ id: A, status: "settled" }),
        market({ id: B, settlesAt: "2026-07-01T00:00:00Z" }),
      ],
      1000,
    );
    const report = await runOnce(
      port,
      new StaticEstimator(new Map()),
      new MemoryJournal(),
      config(),
      undefined,
      NOW,
    );
    for (const skip of report.skips) {
      expect(skip.reason.length).toBeGreaterThan(0);
    }
    expect(report.skips.length).toBeGreaterThan(0);
  });
});
