/**
 * Expected-value engine for Dynamic Parimutuel markets.
 *
 * The README (and Gensyn's own `compute-edge.ts`) treats
 *   edge = your_probability − market_implied_probability
 * as the trade signal. On a DPM that is a *direction* indicator only. It ignores
 * three things that decide whether the trade actually makes money:
 *
 *   1. Payout is `pool / winning_supply`, not 1 USDC per share.
 *   2. Your own buy dilutes that payout — EV is concave in size.
 *   3. Slippage and the trading fee push your average price above spot.
 *
 * So we compute a breakeven probability `p*` from the real quoted cost and the
 * post-trade payout, and define the edge that matters as `p_true − p*`.
 * At infinitesimal size `p*` converges to the market's implied probability,
 * which is exactly the sanity check the naive formula gets right and nothing
 * else. Every other size, it is wrong.
 */

import {
  DEFAULT_PAYOUT_MODEL,
  SHARE_SCALE,
  impliedProbabilities,
  payoutPerShare,
  spotPrice,
  toUsdc,
  type PayoutModel,
} from "./dpm.js";
import type { DpmState } from "../sdk/port.js";

export interface EvaluationInput {
  state: DpmState;
  outcomeIdx: number;
  /** Candidate trade size, 18-decimal shares. */
  sharesOut: bigint;
  /** Real quoted cost for that size, 6-decimal USDC. Ground truth. */
  tokensIn: bigint;
  /** Our estimated probability the outcome wins, 0–1. */
  probability: number;
  payoutModel?: PayoutModel;
  /**
   * Probability the market never resolves to a winner (`expired` / `failed`),
   * in which case capital comes back pro-rata via `liquidate()` instead.
   */
  failureProbability?: number;
}

export interface Evaluation {
  outcomeIdx: number;
  probability: number;
  /** What the market thinks, `q_i² / Σqⱼ²`. */
  marketProbability: number;
  /** `probability − marketProbability` — the naive signal. Reported, not traded on. */
  naiveEdge: number;
  sharesOut: bigint;
  tokensIn: bigint;
  /** USDC per share actually paid, including fee and slippage. */
  averagePrice: number;
  /** Marginal price before the trade. */
  spotPrice: number;
  /** `averagePrice / spotPrice − 1`. */
  slippage: number;
  /** USDC per winning share *after* our buy dilutes the pool. */
  payoutPerShare: number;
  /** Total USDC returned if the outcome wins. */
  grossIfWin: number;
  /** Pro-rata USDC returned if the market fails to resolve. */
  grossIfFailed: number;
  /** Probability at which this trade breaks even. */
  breakevenProbability: number;
  /** `probability − breakevenProbability`. The edge that actually pays. */
  realEdge: number;
  /** Expected profit in USDC. */
  ev: number;
  /** Expected profit per USDC staked. */
  evPerToken: number;
  cost: number;
  /**
   * Our share of the redeemable supply after the trade, 0–1.
   *
   * In a near-empty market `supply ≈ creatorShares`, so the redeemable
   * denominator collapses to our own purchase and the model says we capture the
   * whole pool. That is only true if nobody ever trades again. High values mean
   * the estimate is a fantasy, not an edge.
   */
  shareOfMarket: number;
  /** Redeemable supply after the trade (excludes creator shares), in shares. */
  redeemableSupply: number;
}

export function evaluate(input: EvaluationInput): Evaluation {
  const {
    state,
    outcomeIdx,
    sharesOut,
    tokensIn,
    probability,
    payoutModel = DEFAULT_PAYOUT_MODEL,
    failureProbability = 0,
  } = input;

  const supply = state.supplies[outcomeIdx];
  if (supply === undefined) {
    throw new RangeError(`evaluate: outcomeIdx ${outcomeIdx} out of range`);
  }

  const marketProbability = impliedProbabilities(state.supplies)[outcomeIdx] ?? 0;

  // Post-trade pool and supply — our own buy is part of the state we redeem against.
  const poolDelta = BigInt(
    Math.round(Number(tokensIn) * payoutModel.feeToPoolFraction),
  );
  const poolAfter = state.pool + poolDelta;
  const supplyAfter = supply + sharesOut;

  const afterRefund = poolAfter > state.refund ? poolAfter - state.refund : 0n;
  const keep = BigInt(Math.round((1 - payoutModel.creatorHaircut) * 1e6));
  const distributable = (afterRefund * keep) / 1_000_000n;

  // `state.pool` is a live, pre-settlement pool, so the simple ratio is the
  // exact law here. Subtracting creator shares as well would double-count them.
  const perShare = payoutPerShare(distributable, supplyAfter);
  const grossIfWinRaw = (perShare * sharesOut) / SHARE_SCALE;

  // If the market never resolves, holders recover pro-rata across all outcomes.
  const totalSupplyAfter =
    state.supplies.reduce((a, b) => a + b, 0n) + sharesOut;
  const grossIfFailedRaw =
    totalSupplyAfter > 0n ? (poolAfter * sharesOut) / totalSupplyAfter : 0n;

  const cost = toUsdc(tokensIn);
  const grossIfWin = toUsdc(grossIfWinRaw);
  const grossIfFailed = toUsdc(grossIfFailedRaw);

  const pf = clamp01(failureProbability);
  const expectedReturn =
    (1 - pf) * probability * grossIfWin + pf * grossIfFailed;
  const ev = expectedReturn - cost;

  // p* solves: (1-pf)·p·grossIfWin + pf·grossIfFailed = cost
  const winTerm = (1 - pf) * grossIfWin;
  const breakevenProbability =
    winTerm > 0 ? (cost - pf * grossIfFailed) / winTerm : 1;

  const spot = toUsdc(spotPrice(state, outcomeIdx));
  const shareCount = Number(sharesOut) / 1e18;
  const averagePrice = shareCount > 0 ? cost / shareCount : 0;

  return {
    outcomeIdx,
    probability,
    marketProbability,
    naiveEdge: probability - marketProbability,
    sharesOut,
    tokensIn,
    averagePrice,
    spotPrice: spot,
    slippage: spot > 0 ? averagePrice / spot - 1 : 0,
    payoutPerShare: toUsdc(perShare),
    grossIfWin,
    grossIfFailed,
    breakevenProbability,
    realEdge: probability - breakevenProbability,
    ev,
    evPerToken: cost > 0 ? ev / cost : 0,
    cost,
    shareOfMarket:
      supplyAfter > 0n ? Number(sharesOut) / Number(supplyAfter) : 1,
    redeemableSupply: Number(supplyAfter) / 1e18,
  };
}

/**
 * EV per USDC per day of capital lock-up.
 *
 * DPM capital is locked until settlement, so over a fixed competition window a
 * 4% edge settling tomorrow beats a 9% edge settling in three weeks. Ranking on
 * raw EV silently parks the bankroll in slow markets.
 */
export function evPerTokenPerDay(
  evaluation: Evaluation,
  settlesAt: Date | null,
  now: Date = new Date(),
): number {
  if (!settlesAt) return evaluation.evPerToken;
  const days = Math.max(
    0.25,
    (settlesAt.getTime() - now.getTime()) / 86_400_000,
  );
  return evaluation.evPerToken / days;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
