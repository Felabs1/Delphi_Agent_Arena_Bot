/**
 * The DPM model's own consistency.
 *
 * These are not tests of our code so much as tests of our *understanding* of
 * Delphi's market mechanism. If any of them break, the EV engine is computing
 * against a market that does not exist and nothing downstream can be trusted.
 */

import { describe, expect, it } from "vitest";
import {
  SHARE_SCALE,
  costToBuy,
  deriveK,
  impliedProbabilities,
  isqrt,
  payoutPerShare,
  proceedsFromSell,
  shares,
  spotPrice,
  sumTerm36,
  toUsdc,
} from "../src/agent/dpm.js";
import type { DpmState } from "../src/sdk/port.js";

function makeState(
  supplyCounts: number[],
  opts: { k?: number; tradingFee?: number; refund?: number } = {},
): DpmState {
  const supplies = supplyCounts.map((n) => shares(n));
  const st = sumTerm36(supplies);
  const k = BigInt(Math.round((opts.k ?? 1) * 1e18)); // WAD, as on-chain
  return {
    marketAddress: "0xmarket",
    outcomeCount: supplies.length,
    k,
    tradingFee: BigInt(Math.round((opts.tradingFee ?? 0) * 1e18)),
    tradingDeadline: 0n,
    settlementDeadline: 0n,
    pool: (k * isqrt(st)) / 10n ** 30n,
    initialPool: 0n,
    tradingFees: 0n,
    refund: BigInt(Math.round((opts.refund ?? 0) * 1e6)),
    sumTerm36: st,
    supplies,
    creatorSharesPerOutcome: 0n,
  };
}

describe("integer square root", () => {
  it("is exact on perfect squares and floors otherwise", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(144n)).toBe(12n);
    expect(isqrt(143n)).toBe(11n);
    expect(isqrt((10n ** 30n) ** 2n)).toBe(10n ** 30n);
  });

  it("rejects negative input rather than returning nonsense", () => {
    expect(() => isqrt(-1n)).toThrow(RangeError);
  });
});

describe("implied probabilities", () => {
  it("are q_i^2 / sum(q^2) and sum to 1", () => {
    const probs = impliedProbabilities([shares(1200), shares(800), shares(400)]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // 1200^2 / (1200^2 + 800^2 + 400^2) = 1440000/2240000
    expect(probs[0]).toBeCloseTo(1440000 / 2240000, 6);
  });

  it("are NOT the normalised supplies (that would be a linear parimutuel)", () => {
    const supplies = [shares(1200), shares(800), shares(400)];
    const probs = impliedProbabilities(supplies);
    const linear = 1200 / 2400;
    expect(probs[0]).not.toBeCloseTo(linear, 3);
  });
});

describe("price / probability / payout identities", () => {
  const state = makeState([1200, 800, 400]);
  const probs = impliedProbabilities(state.supplies);

  it("satisfies price_i * payout_i = k^2", () => {
    const kFloat = Number(state.k) / 1e18;
    for (let i = 0; i < 3; i++) {
      const price = toUsdc(spotPrice(state, i));
      const payout = toUsdc(payoutPerShare(state.pool, state.supplies[i]!));
      expect(price * payout).toBeCloseTo(kFloat * kFloat, 4);
    }
  });

  it("satisfies prob_i = (price_i / k)^2 — probability is the SQUARE of normalised price", () => {
    const kFloat = Number(state.k) / 1e18;
    for (let i = 0; i < 3; i++) {
      const price = toUsdc(spotPrice(state, i));
      expect((price / kFloat) ** 2).toBeCloseTo(probs[i]!, 5);
    }
  });

  it("prices a fair market to zero marginal edge", () => {
    for (let i = 0; i < 3; i++) {
      const price = toUsdc(spotPrice(state, i));
      const payout = toUsdc(payoutPerShare(state.pool, state.supplies[i]!));
      expect(probs[i]! * payout - price).toBeCloseTo(0, 5);
    }
  });

  it("recovers k from pool and supplies", () => {
    const rel =
      Math.abs(Number(deriveK(state.pool, state.sumTerm36) - state.k)) /
      Number(state.k);
    expect(rel).toBeLessThan(1e-6);
  });
});

describe("payout is NOT 1 USDC per share", () => {
  it("pays long shots far more than 1 and favourites less", () => {
    const state = makeState([1200, 800, 400]);
    const longShot = toUsdc(payoutPerShare(state.pool, state.supplies[2]!));
    const favourite = toUsdc(payoutPerShare(state.pool, state.supplies[0]!));

    expect(longShot).toBeGreaterThan(3);
    expect(favourite).toBeLessThan(1.5);
    expect(longShot).toBeGreaterThan(favourite);
  });

  it("would make every outcome look negative-EV if payout were assumed to be 1", () => {
    // This is the concrete failure mode of the README's original LMSR math and
    // of any agent that reads spot price as a probability.
    const state = makeState([1200, 800, 400]);
    const probs = impliedProbabilities(state.supplies);
    for (let i = 0; i < 3; i++) {
      const price = toUsdc(spotPrice(state, i));
      const naiveEv = probs[i]! * 1.0 - price;
      expect(naiveEv).toBeLessThan(0); // "never trade anything"
      const trueEv =
        probs[i]! * toUsdc(payoutPerShare(state.pool, state.supplies[i]!)) -
        price;
      expect(trueEv).toBeCloseTo(0, 5); // actually fair
    }
  });
});

describe("cost curve", () => {
  const state = makeState([1200, 800, 400]);

  it("charges more than the marginal price (slippage is real)", () => {
    const n = 100;
    const cost = toUsdc(costToBuy(state, 0, shares(n)));
    const avg = cost / n;
    expect(avg).toBeGreaterThan(toUsdc(spotPrice(state, 0)));
  });

  it("is convex — average price rises with size", () => {
    const avgAt = (n: number) => toUsdc(costToBuy(state, 0, shares(n))) / n;
    expect(avgAt(500)).toBeGreaterThan(avgAt(100));
    expect(avgAt(100)).toBeGreaterThan(avgAt(10));
  });

  it("keeps the pool identity pool' = k*sqrt(sumTerm') after a buy", () => {
    const n = shares(100);
    const cost = costToBuy(state, 0, n);
    const newSupplies = [state.supplies[0]! + n, state.supplies[1]!, state.supplies[2]!];
    const expectedPool = (state.k * isqrt(sumTerm36(newSupplies))) / 10n ** 30n;
    expect(toUsdc(state.pool + cost)).toBeCloseTo(toUsdc(expectedPool), 5);
  });

  it("grosses the trading fee up as base/(1-fee), not base*(1+fee)", () => {
    // Verified against live testnet quotes: the naive `base*(1+fee)` under-
    // charges by fee/(1-fee) — 0.04% at the 2% fee every market uses. Small,
    // but systematic and always in the direction that overstates our edge.
    const free = costToBuy(makeState([1200, 800, 400]), 0, shares(100));
    const fee2pct = costToBuy(
      makeState([1200, 800, 400], { tradingFee: 0.02 }),
      0,
      shares(100),
    );
    expect(toUsdc(fee2pct)).toBeCloseTo(toUsdc(free) / 0.98, 4);
    expect(toUsdc(fee2pct)).toBeGreaterThan(toUsdc(free) * 1.02);
  });

  it("returns less on a sell than it cost to buy (round-trip loses)", () => {
    const n = shares(100);
    const cost = costToBuy(state, 0, n);
    const after = makeState([1200 + 100, 800, 400]);
    const proceeds = proceedsFromSell(after, 0, n);
    expect(toUsdc(proceeds)).toBeLessThanOrEqual(toUsdc(cost) + 1e-6);
  });
});

describe("payout basis: which pool you pass", () => {
  // Measured out-of-sample against every settled testnet market (0.0000%
  // median, 0.0001% worst), predicting from state at the block BEFORE
  // settlement. Two regimes, same underlying law:
  //
  //   open   (pre-settlement, pool still holds the creator's cut):
  //            payout = pool / totalSupply(winner)
  //   settled (post-settlement, creator already paid out):
  //            payout = pool / (totalSupply(winner) - creatorShares)
  //
  // Mixing them — a live pool with the creator subtraction — double-counts the
  // creator. On a market where the creator holds most of the supply that
  // overstated payout by 37x, which is exactly how a bad trade looks good.
  it("uses the simple ratio for a live market", () => {
    // Real numbers from 0xd82af8b4..., pre-settlement.
    const pool = 224_771_000n;
    const supply = shares(20.7678);
    expect(toUsdc(payoutPerShare(pool, supply))).toBeCloseTo(10.8231, 3);
  });

  it("uses the creator-adjusted ratio for an already-settled market", () => {
    // Same market after settlement: pool is net, creator no longer shares.
    const poolAfter = 221_163_800n;
    const supply = shares(20.7678);
    const creator = shares(0.3333);
    expect(toUsdc(payoutPerShare(poolAfter, supply, creator))).toBeCloseTo(
      10.8231,
      3,
    );
  });

  it("defaults to the live regime, so trading code cannot double-count", () => {
    const pool = 100_000_000n;
    const supply = shares(50);
    expect(payoutPerShare(pool, supply)).toBe(
      payoutPerShare(pool, supply, 0n),
    );
  });

  it("returns zero rather than dividing by a non-positive denominator", () => {
    expect(payoutPerShare(1_000_000n, shares(1), shares(1))).toBe(0n);
    expect(payoutPerShare(1_000_000n, 0n)).toBe(0n);
  });
});

describe("self-dilution", () => {
  it("lowers the payout per share as you buy more of an outcome", () => {
    const state = makeState([1200, 800, 400]);
    const before = toUsdc(payoutPerShare(state.pool, state.supplies[0]!));

    const n = shares(300);
    const cost = costToBuy(state, 0, n);
    const after = toUsdc(payoutPerShare(state.pool + cost, state.supplies[0]! + n));

    expect(after).toBeLessThan(before);
  });
});
