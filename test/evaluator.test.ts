/**
 * What the agent is allowed to consider a tradeable edge.
 */

import { describe, expect, it } from "vitest";
import { evaluate, evPerTokenPerDay } from "../src/agent/evaluator.js";
import {
  SHARE_SCALE,
  costToBuy,
  impliedProbabilities,
  isqrt,
  shares,
  sumTerm36,
} from "../src/agent/dpm.js";
import type { DpmState } from "../src/sdk/port.js";

const NO_HAIRCUT = { creatorHaircut: 0, feeToPoolFraction: 1 };

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

const quote = (state: DpmState, idx: number, n: bigint) =>
  costToBuy(state, idx, n);

describe("breakeven probability", () => {
  it("converges to the market's implied probability at vanishing size and zero fee", () => {
    const state = makeState([1000, 1000]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const n = shares(0.01);

    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.5,
      payoutModel: NO_HAIRCUT,
    });

    expect(ev.breakevenProbability).toBeCloseTo(marketProb, 4);
  });

  it("rises above the implied probability as size grows (slippage costs you)", () => {
    const state = makeState([1000, 1000]);
    const marketProb = impliedProbabilities(state.supplies)[0]!;

    const small = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: shares(1),
      tokensIn: quote(state, 0, shares(1)),
      probability: 0.5,
      payoutModel: NO_HAIRCUT,
    });
    const large = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: shares(400),
      tokensIn: quote(state, 0, shares(400)),
      probability: 0.5,
      payoutModel: NO_HAIRCUT,
    });

    expect(small.breakevenProbability).toBeGreaterThanOrEqual(marketProb - 1e-6);
    expect(large.breakevenProbability).toBeGreaterThan(small.breakevenProbability);
  });

  it("rises further with a trading fee", () => {
    const free = makeState([1000, 1000]);
    const fee = makeState([1000, 1000], { tradingFee: 0.03 });
    const n = shares(50);

    const a = evaluate({
      state: free,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(free, 0, n),
      probability: 0.5,
      payoutModel: NO_HAIRCUT,
    });
    const b = evaluate({
      state: fee,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(fee, 0, n),
      probability: 0.5,
      payoutModel: NO_HAIRCUT,
    });

    expect(b.breakevenProbability).toBeGreaterThan(a.breakevenProbability);
  });
});

describe("naive edge vs real edge", () => {
  it("reports a positive naive edge that is actually a losing trade", () => {
    // Thin market, chunky size, real fee: the classic trap. Gensyn's reference
    // compute-edge.ts would green-light this; the EV engine must not.
    const state = makeState([40, 160], { tradingFee: 0.02 });
    const marketProb = impliedProbabilities(state.supplies)[0]!;
    const ourProb = marketProb + 0.1;
    const n = shares(120);

    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: ourProb,
      payoutModel: NO_HAIRCUT,
    });

    expect(ev.naiveEdge).toBeCloseTo(0.1, 6);
    expect(ev.naiveEdge).toBeGreaterThan(0); // looks good
    expect(ev.realEdge).toBeLessThan(0); // is not good
    expect(ev.ev).toBeLessThan(0);
  });

  it("agrees with the naive edge when size is tiny and fees are zero", () => {
    const state = makeState([1000, 1000]);
    const n = shares(0.01);
    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.62,
      payoutModel: NO_HAIRCUT,
    });
    expect(ev.realEdge).toBeCloseTo(ev.naiveEdge, 3);
  });
});

describe("expected value", () => {
  it("is never positive for a correctly-priced market", () => {
    // A fair market must not hand out free money. Slippage means the honest
    // answer is "zero or slightly negative" — and it must never be positive,
    // or the agent would trade noise. The 1e-3 floor is 6-decimal USDC
    // quantization on a 1-share probe, not model error.
    const state = makeState([1200, 800, 400]);
    const probs = impliedProbabilities(state.supplies);
    const n = shares(1);

    for (let i = 0; i < 3; i++) {
      const ev = evaluate({
        state,
        outcomeIdx: i,
        sharesOut: n,
        tokensIn: quote(state, i, n),
        probability: probs[i]!,
        payoutModel: NO_HAIRCUT,
      });
      expect(ev.evPerToken).toBeLessThan(1e-3);
      expect(ev.evPerToken).toBeGreaterThan(-1e-2);
    }
  });

  it("is concave in size — there is an interior optimum", () => {
    const state = makeState([200, 800]);
    const probs = impliedProbabilities(state.supplies);
    const ourProb = Math.min(0.95, probs[0]! + 0.25);

    const evAt = (n: number) =>
      evaluate({
        state,
        outcomeIdx: 0,
        sharesOut: shares(n),
        tokensIn: quote(state, 0, shares(n)),
        probability: ourProb,
        payoutModel: NO_HAIRCUT,
      }).ev;

    const sizes = [1, 5, 20, 60, 150, 400, 1000, 3000];
    const evs = sizes.map(evAt);
    const peak = evs.indexOf(Math.max(...evs));

    // The optimum is not at either extreme: sizing rules that only clamp a
    // maximum cannot find it.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(sizes.length - 1);
    expect(evs.at(-1)!).toBeLessThan(evs[peak]!);
  });

  it("uses a payout that falls as our own position grows", () => {
    const state = makeState([500, 500]);
    const small = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: shares(1),
      tokensIn: quote(state, 0, shares(1)),
      probability: 0.7,
      payoutModel: NO_HAIRCUT,
    });
    const large = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: shares(500),
      tokensIn: quote(state, 0, shares(500)),
      probability: 0.7,
      payoutModel: NO_HAIRCUT,
    });
    expect(large.payoutPerShare).toBeLessThan(small.payoutPerShare);
    expect(small.payoutPerShare).not.toBeCloseTo(1, 2); // never assume 1 USDC
  });

  it("shrinks when the creator haircut is applied", () => {
    const state = makeState([500, 500]);
    const n = shares(20);
    const common = {
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.7,
    };
    const gross = evaluate({ ...common, payoutModel: NO_HAIRCUT });
    const net = evaluate({
      ...common,
      payoutModel: { creatorHaircut: 0.05, feeToPoolFraction: 1 },
    });
    expect(net.ev).toBeLessThan(gross.ev);
    expect(net.breakevenProbability).toBeGreaterThan(gross.breakevenProbability);
  });

  it("accounts for settlement failure returning capital pro-rata", () => {
    const state = makeState([500, 500]);
    const n = shares(20);
    const common = {
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.75,
      payoutModel: NO_HAIRCUT,
    };
    const certain = evaluate({ ...common, failureProbability: 0 });
    const risky = evaluate({ ...common, failureProbability: 0.15 });

    expect(risky.grossIfFailed).toBeGreaterThan(0);
    // A winning bet is worth less when 15% of the time nobody wins.
    expect(risky.ev).toBeLessThan(certain.ev);
  });
});

describe("capital velocity", () => {
  it("prefers a smaller edge that settles sooner", () => {
    const state = makeState([500, 500]);
    const n = shares(10);
    const base = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.7,
      payoutModel: NO_HAIRCUT,
    });

    const now = new Date("2026-08-01T00:00:00Z");
    const soon = new Date("2026-08-03T00:00:00Z"); // 2 days
    const later = new Date("2026-09-01T00:00:00Z"); // 31 days

    expect(evPerTokenPerDay(base, soon, now)).toBeGreaterThan(
      evPerTokenPerDay(base, later, now),
    );
  });

  it("falls back to raw EV per token when there is no settlement date", () => {
    const state = makeState([500, 500]);
    const n = shares(10);
    const ev = evaluate({
      state,
      outcomeIdx: 0,
      sharesOut: n,
      tokensIn: quote(state, 0, n),
      probability: 0.7,
      payoutModel: NO_HAIRCUT,
    });
    expect(evPerTokenPerDay(ev, null)).toBe(ev.evPerToken);
  });
});
