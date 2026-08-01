/**
 * Position sizing.
 *
 * The README's default is `Base × Confidence × Edge`. That cannot work here:
 * under DPM the payout falls as you buy, so EV is concave in size and the
 * optimum is an interior point that a multiplicative rule never finds. It also
 * has no notion of bankroll, so it will happily size into ruin on a big edge.
 *
 * Instead:
 *   1. Shrink the raw estimate toward the market in proportion to confidence.
 *      A 0.6 estimate held with 0.5 confidence is not a 0.6 estimate.
 *   2. Grid-search real `quoteBuy` sizes and pick the one maximising expected
 *      log-wealth growth (Kelly), which is the correct objective for compounding
 *      a bankroll over a long competition.
 *   3. Scale by a fractional-Kelly factor, because our probabilities are
 *      estimates and full Kelly on a mis-estimated edge is how bankrolls die.
 *   4. Clamp to position/exposure caps and the gateway's minimum trade size.
 */

import { evaluate, type Evaluation } from "./evaluator.js";
import {
  SHARE_SCALE,
  impliedProbabilities,
  spotPrice,
  type PayoutModel,
} from "./dpm.js";
import type { Address, DpmState } from "../sdk/port.js";

export interface SizingConfig {
  /** Total capital the agent is managing, USDC. */
  bankrollUsdc: number;
  /** Spendable right now, USDC (bankroll minus what is already locked up). */
  availableUsdc: number;
  /** Cap on a single position as a fraction of bankroll. */
  maxPositionFraction: number;
  /** Fraction of full Kelly to actually bet. 0.25–0.5 is sane. */
  kellyFraction: number;
  /** Minimum `realEdge` required to trade. */
  minimumEdge: number;
  /** Minimum EV per USDC staked. */
  minimumEvPerToken: number;
  /** Minimum confidence required to trade at all. */
  confidenceThreshold: number;
  /**
   * Multiplier on reported confidence, from measured calibration. Below 1 when
   * the ensemble has been shown to be overconfident — this shrinks estimates
   * harder toward the market, which shrinks position sizes with them.
   */
  confidenceScale?: number;
  payoutModel?: PayoutModel;
  /** Assumed probability the market resolves to no winner. */
  failureProbability?: number;
  /** Number of candidate sizes to evaluate. */
  candidateCount?: number;
  /**
   * Largest fraction of a market's redeemable supply we're willing to become.
   *
   * Guards against near-empty markets, where the payout model degenerates into
   * "we capture the entire pool" — arithmetically true, but only if no one else
   * ever trades. Those are the markets that produce 1000+ USDC/share payouts
   * and make every outcome, including both sides of a binary, look profitable.
   */
  maxShareOfMarket?: number;
}

export interface SizingRequest {
  state: DpmState;
  outcomeIdx: number;
  /** Raw estimate from the AI layer, 0–1. */
  probability: number;
  /** 0–1. Drives shrinkage toward the market price. */
  confidence: number;
  minShares: bigint;
  /** Gateway MIN_TOKENS_DELTA — the smallest legal *cost*, 6-decimal. */
  minTokens?: bigint;
  quoteBuy: (p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
  }) => Promise<{ tokensIn: bigint }>;
}

export interface SizingDecision {
  sharesOut: bigint;
  tokensIn: bigint;
  evaluation: Evaluation;
  /** Post-shrinkage probability actually used for sizing. */
  effectiveProbability: number;
  /** Expected log-wealth growth rate at the chosen size. */
  kellyGrowth: number;
}

export type SizingOutcome =
  | { ok: true; decision: SizingDecision }
  | { ok: false; reason: string; best?: Evaluation };

/**
 * Shrink an estimate toward the market in proportion to how unsure we are.
 * confidence = 1 → trust the estimate; confidence = 0 → defer to the market.
 */
export function shrinkTowardMarket(
  probability: number,
  marketProbability: number,
  confidence: number,
): number {
  const c = Math.min(1, Math.max(0, confidence));
  return marketProbability + c * (probability - marketProbability);
}

export async function chooseSize(
  req: SizingRequest,
  config: SizingConfig,
): Promise<SizingOutcome> {
  const { state, outcomeIdx, minShares, quoteBuy } = req;
  const confidence = Math.min(
    1,
    Math.max(0, req.confidence * (config.confidenceScale ?? 1)),
  );

  if (confidence < config.confidenceThreshold) {
    return {
      ok: false,
      reason: `confidence ${confidence.toFixed(2)} < threshold ${config.confidenceThreshold}`,
    };
  }

  const marketProbability = impliedProbabilities(state.supplies)[outcomeIdx] ?? 0;
  const effectiveProbability = shrinkTowardMarket(
    req.probability,
    marketProbability,
    confidence,
  );

  const budget = Math.min(
    config.availableUsdc,
    config.bankrollUsdc * config.maxPositionFraction,
  );
  if (budget <= 0) return { ok: false, reason: "no capital available" };

  let best: SizingDecision | null = null;
  let bestSeenEvaluation: Evaluation | undefined;

  const score = async (sharesOut: bigint): Promise<SizingDecision | null> => {
    let tokensIn: bigint;
    try {
      ({ tokensIn } = await quoteBuy({
        marketAddress: state.marketAddress,
        outcomeIdx,
        sharesOut,
      }));
    } catch {
      // The gateway rejects sizes outside its bounds (TokensInBelowMin and
      // friends). That makes this candidate infeasible, not the whole market
      // untradeable — keep walking the ladder.
      return null;
    }
    if (Number(tokensIn) / 1e6 > budget) return null;

    const evaluation = evaluate({
      state,
      outcomeIdx,
      sharesOut,
      tokensIn,
      probability: effectiveProbability,
      payoutModel: config.payoutModel,
      failureProbability: config.failureProbability,
    });
    if (!bestSeenEvaluation || evaluation.ev > bestSeenEvaluation.ev) {
      bestSeenEvaluation = evaluation;
    }

    const growth = expectedLogGrowth(
      evaluation,
      config.bankrollUsdc,
      effectiveProbability,
      config.failureProbability ?? 0,
    );
    if (growth === null) return null;
    if (evaluation.shareOfMarket > (config.maxShareOfMarket ?? 0.25)) return null;
    return {
      sharesOut,
      tokensIn,
      evaluation,
      effectiveProbability,
      kellyGrowth: growth,
    };
  };

  const better = (
    a: SizingDecision | null,
    b: SizingDecision | null,
  ): SizingDecision | null => {
    if (!b) return a;
    if (!a) return b;
    return b.kellyGrowth > a.kellyGrowth ? b : a;
  };

  // Coarse pass: expand geometrically until the budget bites. Anchoring the
  // ladder to a fixed rung count would cap the search at an arbitrary size
  // determined by `minShares`, which silently pins large-bankroll decisions to
  // the top rung and makes distinct edges look identical.
  const ladder: bigint[] = [];
  const maxSteps = config.candidateCount ?? 64;
  const floor = smallestViableSize(state, outcomeIdx, minShares, req.minTokens);
  let cursor = floor;
  for (let i = 0; i < maxSteps; i++) {
    ladder.push(cursor);
    const decision = await score(cursor);
    best = better(best, decision);
    if (decision === null && i > 0) break; // over budget: cost is monotonic
    cursor = (cursor * 3n) / 2n;
  }

  // Fine pass: the 1.5x ladder is too coarse to separate nearby optima, so
  // refine linearly between the rungs bracketing the best one.
  if (best) {
    const chosen = best.sharesOut;
    const idx = ladder.findIndex((s) => s === chosen);
    const lo = idx > 0 ? ladder[idx - 1]! : floor;
    const hi = idx >= 0 && idx + 1 < ladder.length ? ladder[idx + 1]! : chosen * 2n;
    const span = hi > lo ? hi - lo : 0n;
    if (span > 0n) {
      for (let step = 1; step < 12; step++) {
        const probe = lo + (span * BigInt(step)) / 12n;
        if (probe < floor) continue;
        best = better(best, await score(probe));
      }
    }
  }

  if (!best || best.kellyGrowth <= 0) {
    const cap = config.maxShareOfMarket ?? 0.25;
    const dominates =
      bestSeenEvaluation !== undefined && bestSeenEvaluation.shareOfMarket > cap;
    return {
      ok: false,
      reason: dominates
        ? `market too thin: any viable size would be ${(bestSeenEvaluation!.shareOfMarket * 100).toFixed(0)}% of redeemable supply (cap ${(cap * 100).toFixed(0)}%)`
        : "no size produced positive expected log growth",
      best: bestSeenEvaluation,
    };
  }

  // Fractional Kelly: re-quote at the scaled-down size so cost stays truthful.
  // Clamped to the viable floor, or the gateway rejects it as below MIN_TOKENS.
  const scaled = scaleShares(best.sharesOut, config.kellyFraction, floor);
  let tokensIn: bigint;
  try {
    ({ tokensIn } = await quoteBuy({
      marketAddress: state.marketAddress,
      outcomeIdx,
      sharesOut: scaled,
    }));
  } catch (err) {
    return {
      ok: false,
      reason: `gateway rejected the sized trade: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      best: bestSeenEvaluation,
    };
  }
  const evaluation = evaluate({
    state,
    outcomeIdx,
    sharesOut: scaled,
    tokensIn,
    probability: effectiveProbability,
    payoutModel: config.payoutModel,
    failureProbability: config.failureProbability,
  });

  if (evaluation.shareOfMarket > (config.maxShareOfMarket ?? 0.25)) {
    return {
      ok: false,
      reason: `would be ${(evaluation.shareOfMarket * 100).toFixed(0)}% of redeemable supply`,
      best: evaluation,
    };
  }
  if (evaluation.realEdge < config.minimumEdge) {
    return {
      ok: false,
      reason: `realEdge ${fmt(evaluation.realEdge)} < minimum ${fmt(config.minimumEdge)}`,
      best: evaluation,
    };
  }
  if (evaluation.evPerToken < config.minimumEvPerToken) {
    return {
      ok: false,
      reason: `EV/token ${fmt(evaluation.evPerToken)} < minimum ${fmt(config.minimumEvPerToken)}`,
      best: evaluation,
    };
  }
  if (evaluation.cost > budget) {
    return { ok: false, reason: "scaled size still exceeds budget", best: evaluation };
  }

  return {
    ok: true,
    decision: {
      sharesOut: scaled,
      tokensIn,
      evaluation,
      effectiveProbability,
      kellyGrowth: best.kellyGrowth,
    },
  };
}

/**
 * Expected log-wealth growth from staking this trade.
 * Returns null when the stake would wipe out the bankroll in any branch.
 */
export function expectedLogGrowth(
  evaluation: Evaluation,
  bankrollUsdc: number,
  probability: number,
  failureProbability = 0,
): number | null {
  const w = bankrollUsdc;
  if (w <= 0) return null;
  const lose = w - evaluation.cost;
  if (lose <= 0) return null;

  const win = w - evaluation.cost + evaluation.grossIfWin;
  const failed = w - evaluation.cost + evaluation.grossIfFailed;
  if (win <= 0 || failed <= 0) return null;

  const pf = Math.min(1, Math.max(0, failureProbability));
  const p = Math.min(1, Math.max(0, probability));

  const expected =
    (1 - pf) * p * Math.log(win) +
    (1 - pf) * (1 - p) * Math.log(lose) +
    pf * Math.log(failed);

  return expected - Math.log(w);
}

/**
 * Smallest size the gateway will actually quote.
 *
 * Two minimums bind, and only one of them is expressed in shares:
 * `MIN_SHARES_DELTA` and `MIN_TOKENS_DELTA`. On real markets the token minimum
 * is by far the tighter — `MIN_SHARES_DELTA` is 1e-12 shares, which costs
 * fractions of a cent and reverts with `TokensInBelowMin`. Starting the ladder
 * at the share minimum therefore made the first quote revert on every market.
 */
export function smallestViableSize(
  state: DpmState,
  outcomeIdx: number,
  minShares: bigint,
  minTokens?: bigint,
): bigint {
  const floor = minShares > 0n ? minShares : 1n;
  if (!minTokens || minTokens <= 0n) return floor;

  const price = spotPrice(state, outcomeIdx); // 6-dec USDC per share
  if (price <= 0n) return floor;

  // shares = tokens / price, in 18 decimals, with headroom for the fee and
  // for the curve being convex above spot.
  const needed = (minTokens * SHARE_SCALE * 3n) / (price * 2n);
  return needed > floor ? needed : floor;
}

function scaleShares(
  sharesOut: bigint,
  fraction: number,
  minShares: bigint,
): bigint {
  const scaled =
    (sharesOut * BigInt(Math.round(Math.min(1, Math.max(0, fraction)) * 1e6))) /
    1_000_000n;
  return scaled < minShares ? minShares : scaled;
}

const fmt = (n: number): string => (n * 100).toFixed(2) + "%";
