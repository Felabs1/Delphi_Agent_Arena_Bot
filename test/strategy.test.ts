/**
 * How much the agent is allowed to stake.
 */

import { describe, expect, it } from "vitest";
import {
  chooseSize,
  expectedLogGrowth,
  shrinkTowardMarket,
  smallestViableSize,
  type SizingConfig,
} from "../src/agent/strategy.js";
import { evaluate } from "../src/agent/evaluator.js";
import {
  SHARE_SCALE,
  costToBuy,
  impliedProbabilities,
  isqrt,
  shares,
  sumTerm36,
  toUsdc,
} from "../src/agent/dpm.js";
import type { DpmState } from "../src/sdk/port.js";

const NO_HAIRCUT = { creatorHaircut: 0, feeToPoolFraction: 1 };

function makeState(supplyCounts: number[], tradingFee = 0): DpmState {
  const supplies = supplyCounts.map((n) => shares(n));
  const st = sumTerm36(supplies);
  const k = 10n ** 18n; // WAD, as on-chain
  return {
    marketAddress: "0xmarket",
    outcomeCount: supplies.length,
    k,
    tradingFee: BigInt(Math.round(tradingFee * 1e18)),
    tradingDeadline: 0n,
    settlementDeadline: 0n,
    pool: (k * isqrt(st)) / 10n ** 30n,
    initialPool: 0n,
    tradingFees: 0n,
    refund: 0n,
    sumTerm36: st,
    supplies,
    creatorSharesPerOutcome: 0n,
  };
}

const quoter = (state: DpmState) => async (p: {
  marketAddress: `0x${string}`;
  outcomeIdx: number;
  sharesOut: bigint;
}) => ({ tokensIn: costToBuy(state, p.outcomeIdx, p.sharesOut) });

const baseConfig = (over: Partial<SizingConfig> = {}): SizingConfig => ({
  bankrollUsdc: 1000,
  availableUsdc: 1000,
  maxPositionFraction: 0.25,
  kellyFraction: 0.5,
  minimumEdge: 0.02,
  minimumEvPerToken: 0.01,
  confidenceThreshold: 0.6,
  payoutModel: NO_HAIRCUT,
  ...over,
});

describe("confidence shrinkage", () => {
  it("defers entirely to the market at zero confidence", () => {
    expect(shrinkTowardMarket(0.9, 0.3, 0)).toBeCloseTo(0.3, 9);
  });
  it("trusts the estimate fully at confidence 1", () => {
    expect(shrinkTowardMarket(0.9, 0.3, 1)).toBeCloseTo(0.9, 9);
  });
  it("interpolates in between", () => {
    expect(shrinkTowardMarket(0.9, 0.3, 0.5)).toBeCloseTo(0.6, 9);
  });
});

describe("expected log growth", () => {
  it("is positive for a genuinely favourable bet", () => {
    const state = makeState([200, 800]);
    const n = shares(20);
    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: costToBuy(state, 0, n),
      probability: 0.35,
      payoutModel: NO_HAIRCUT,
    });
    expect(expectedLogGrowth(ev, 1000, 0.35)).toBeGreaterThan(0);
  });

  it("refuses a stake that could wipe out the bankroll", () => {
    const state = makeState([200, 800]);
    const n = shares(2000);
    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: costToBuy(state, 0, n),
      probability: 0.9,
      payoutModel: NO_HAIRCUT,
    });
    // Cost exceeds the whole bankroll — no finite log utility.
    expect(expectedLogGrowth(ev, ev.cost * 0.5, 0.9)).toBeNull();
  });
});

describe("chooseSize", () => {
  it("refuses to trade below the confidence threshold", async () => {
    const state = makeState([200, 800]);
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: 0.9,
        confidence: 0.1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/confidence/);
  });

  it("refuses a fairly-priced market", async () => {
    const state = makeState([500, 500]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig(),
    );
    expect(out.ok).toBe(false);
  });

  it("takes a genuinely mispriced outcome", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.3,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.decision.evaluation.realEdge).toBeGreaterThan(0.02);
      expect(out.decision.evaluation.ev).toBeGreaterThan(0);
    }
  });

  it("never stakes more than the position cap", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const config = baseConfig({ maxPositionFraction: 0.05, bankrollUsdc: 1000 });
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.35,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      config,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.decision.evaluation.cost).toBeLessThanOrEqual(50);
  });

  it("respects available capital, not just the bankroll fraction", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.35,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig({ bankrollUsdc: 1000, availableUsdc: 7 }),
    );
    if (out.ok) expect(out.decision.evaluation.cost).toBeLessThanOrEqual(7);
  });

  it("bets less at half Kelly than at full Kelly", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const req = {
      state,
      outcomeIdx: 0,
      probability: marketProb + 0.3,
      confidence: 1,
      minShares: shares(0.01),
      quoteBuy: quoter(state),
    };
    const full = await chooseSize(req, baseConfig({ kellyFraction: 1 }));
    const half = await chooseSize(req, baseConfig({ kellyFraction: 0.5 }));

    expect(full.ok && half.ok).toBe(true);
    if (full.ok && half.ok) {
      expect(half.decision.sharesOut).toBeLessThan(full.decision.sharesOut);
    }
  });

  it("sizes a bigger edge larger than a smaller one", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const mk = (bump: number) =>
      chooseSize(
        {
          state,
          outcomeIdx: 0,
          probability: marketProb + bump,
          confidence: 1,
          minShares: shares(0.01),
          quoteBuy: quoter(state),
        },
        // Disable the market-share cap: this test is about edge -> size.
        baseConfig({ maxPositionFraction: 1, maxShareOfMarket: 1 }),
      );
    const small = await mk(0.12);
    const big = await mk(0.4);
    expect(small.ok && big.ok).toBe(true);
    if (small.ok && big.ok) {
      expect(big.decision.sharesOut).toBeGreaterThan(small.decision.sharesOut);
    }
  });

  it("sizes down when confidence is low, via shrinkage", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const mk = (confidence: number) =>
      chooseSize(
        {
          state,
          outcomeIdx: 0,
          probability: marketProb + 0.4,
          confidence,
          minShares: shares(0.01),
          quoteBuy: quoter(state),
        },
        // Disable the market-share cap: this test is about confidence -> size.
        baseConfig({ confidenceThreshold: 0.5, maxPositionFraction: 1, maxShareOfMarket: 1 }),
      );
    const sure = await mk(1);
    const unsure = await mk(0.6);
    expect(sure.ok && unsure.ok).toBe(true);
    if (sure.ok && unsure.ok) {
      expect(unsure.decision.sharesOut).toBeLessThan(sure.decision.sharesOut);
    }
  });

  it("does not go below the gateway minimum trade size", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const minShares = shares(5);
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.3,
        confidence: 1,
        minShares,
        quoteBuy: quoter(state),
      },
      baseConfig({ kellyFraction: 0.0001 }),
    );
    if (out.ok) expect(out.decision.sharesOut).toBeGreaterThanOrEqual(minShares);
  });

  it("reports why it declined instead of failing silently", async () => {
    const state = makeState([500, 500]);
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: 0.51,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig({ minimumEdge: 0.2 }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason.length).toBeGreaterThan(0);
  });

  it("declines when there is no capital", async () => {
    const state = makeState([200, 800]);
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: 0.9,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig({ availableUsdc: 0 }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/capital/);
  });

  it("keeps the chosen size at or below the EV-maximising size", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const probability = marketProb + 0.3;

    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability,
        confidence: 1,
        minShares: shares(0.01),
        quoteBuy: quoter(state),
      },
      baseConfig({ maxPositionFraction: 1, kellyFraction: 0.5 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Brute-force the EV peak and confirm we sit on the conservative side of it.
    let bestSize = 0;
    let bestEv = -Infinity;
    for (let n = 1; n <= 2000; n += 5) {
      const ev = evaluate({
        state,
        outcomeIdx: 0,
        sharesOut: shares(n),
        tokensIn: costToBuy(state, 0, shares(n)),
        probability,
        payoutModel: NO_HAIRCUT,
      }).ev;
      if (ev > bestEv) {
        bestEv = ev;
        bestSize = n;
      }
    }
    expect(toUsdc(out.decision.tokensIn)).toBeGreaterThan(0);
    expect(Number(out.decision.sharesOut) / 1e18).toBeLessThanOrEqual(bestSize);
  });
});

describe("gateway trade minimums", () => {
  // Regression: a live run skipped EVERY market. The ladder started at
  // MIN_SHARES_DELTA (1e-12 shares), which costs ~0.000002 USDC — under
  // MIN_TOKENS_DELTA (0.01 USDC) — so the first quote reverted with
  // TokensInBelowMin and took the whole market's analysis down with it.
  const MIN_SHARES = 1_000_000n; // 1e-12 shares, as the real gateway reports
  const MIN_TOKENS = 10_000n; // 0.01 USDC

  it("starts the search at a size that clears the TOKEN minimum", () => {
    const state = makeState([500, 500]);
    const size = smallestViableSize(state, 0, MIN_SHARES, MIN_TOKENS);
    const cost = costToBuy(state, 0, size);
    expect(cost).toBeGreaterThanOrEqual(MIN_TOKENS);
    expect(size).toBeGreaterThan(MIN_SHARES);
  });

  it("falls back to the share minimum when no token minimum is given", () => {
    const state = makeState([500, 500]);
    expect(smallestViableSize(state, 0, MIN_SHARES, undefined)).toBe(MIN_SHARES);
  });

  it("treats a reverting quote as an infeasible size, not a dead market", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    let rejections = 0;

    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.3,
        confidence: 1,
        minShares: MIN_SHARES,
        minTokens: MIN_TOKENS,
        quoteBuy: async (p) => {
          const tokensIn = costToBuy(state, p.outcomeIdx, p.sharesOut);
          if (tokensIn < MIN_TOKENS) {
            rejections++;
            throw new Error("execution reverted: TokensInBelowMin");
          }
          return { tokensIn };
        },
      },
      baseConfig(),
    );

    // It must still find a tradeable size rather than propagating the revert.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.decision.tokensIn).toBeGreaterThanOrEqual(MIN_TOKENS);
    }
  });

  it("never returns a size the gateway would reject as too small", async () => {
    const state = makeState([200, 800]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const out = await chooseSize(
      {
        state,
        outcomeIdx: 0,
        probability: marketProb + 0.3,
        confidence: 1,
        minShares: MIN_SHARES,
        minTokens: MIN_TOKENS,
        quoteBuy: quoter(state),
      },
      // Aggressive down-scaling must still clear the floor.
      baseConfig({ kellyFraction: 0.0001 }),
    );
    if (out.ok) expect(out.decision.tokensIn).toBeGreaterThanOrEqual(MIN_TOKENS);
  });
});
