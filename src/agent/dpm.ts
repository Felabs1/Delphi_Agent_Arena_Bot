/**
 * Dynamic Parimutuel market mathematics.
 *
 * Delphi is a DPM, not an LMSR. The distinction is the whole game: a winning
 * share does NOT pay 1 USDC, it pays a share of the pool. Derived from the
 * gateway's own state layout (`k`, `sumTerm36`, `pool`, per-outcome supplies):
 *
 *   sumTerm36 = Σ qⱼ²                       (36-dec: squares of 18-dec supplies)
 *   price_i   = k · q_i / √sumTerm36        (marginal USDC per share, 6-dec)
 *   pool      = k · √sumTerm36              (6-dec)
 *   prob_i    = q_i² / sumTerm36            (implied probability, 0–1)
 *   payout_i  = pool / q_i                  (USDC per winning share)
 *
 * Two identities fall out, and both are asserted in the test suite:
 *   1. Σ prob_i = 1                         — probabilities are well-formed
 *   2. price_i · payout_i = k²              — price and payout are reciprocal
 *
 * Together they explain why `spotPrice ≠ spotImpliedProbability` on Delphi:
 *   prob_i = (price_i / k)²
 * The probability is the *square* of the normalised price. Reading spot price
 * as a probability — or assuming a 1 USDC payout — misprices every trade.
 *
 * Marginal sanity check: at infinitesimal size, EV = prob·payout − price
 *   = (q²/Σq²)·(k√Σq²/q) − k·q/√Σq² = 0.
 * A fair market has zero edge at the margin, exactly as it should.
 */

import type { DpmState } from "../sdk/port.js";

export const SHARE_SCALE = 10n ** 18n;
export const TOKEN_SCALE = 10n ** 6n;
export const WAD = 10n ** 18n;

/**
 * `k` is stored WAD-scaled (18 decimals), NOT at the token's 6 decimals.
 * Verified against live testnet: every open market reports k = 1e18, and
 * `spotPrice × payoutPerShare` lands on 1.0 exactly under that reading.
 *
 * Both derived quantities are `k × (an 18-decimal root)` and must land on the
 * token's 6 decimals:
 *   pool / cost : k(18) × root(18) = 36 dec  →  ÷ 1e30
 *   price       : k(18) × q(18) / root(18) = 18 dec  →  ÷ 1e12
 */
export const K_SCALE = 10n ** 18n;
const K_ROOT_TO_TOKEN = 10n ** 30n;
const K_PRICE_TO_TOKEN = 10n ** 12n;

/** Floor integer square root (Newton's method with a bit-length seed). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative input");
  if (n < 2n) return n;
  // Seed at 2^ceil(bits/2) so Newton converges in ~log log n steps.
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n);
  let y = (x + n / x) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** `Σ qⱼ²` over 18-decimal supplies, in 36 decimals. */
export function sumTerm36(supplies: readonly bigint[]): bigint {
  let acc = 0n;
  for (const q of supplies) acc += q * q;
  return acc;
}

/**
 * Implied probability of each outcome: `q_i² / Σ qⱼ²`.
 * Returns plain floats in 0–1 that sum to 1.
 */
export function impliedProbabilities(supplies: readonly bigint[]): number[] {
  const st = sumTerm36(supplies);
  if (st === 0n) return supplies.map(() => 0);
  // Scale to WAD before converting to float so precision survives the divide.
  return supplies.map((q) => Number(((q * q * WAD) / st)) / Number(WAD));
}

/**
 * Liquidity parameter `k` implied by the observed pool and supplies.
 *
 * The contract also reports `config.k` directly; the two must agree. Stage 2
 * asserts that against live markets — a mismatch means our model of the pool
 * is wrong and no trade should fire.
 */
export function deriveK(pool: bigint, st36: bigint): bigint {
  const root = isqrt(st36); // 18-dec
  if (root === 0n) return 0n;
  return (pool * K_ROOT_TO_TOKEN) / root;
}

/** Marginal spot price of an outcome, 6-decimal USDC per share. */
export function spotPrice(state: DpmState, outcomeIdx: number): bigint {
  const q = requireSupply(state, outcomeIdx);
  const root = isqrt(state.sumTerm36); // 18-dec
  if (root === 0n) return 0n;
  return (state.k * q) / (root * K_PRICE_TO_TOKEN);
}

/**
 * Cost to buy `sharesOut` of an outcome, gross of the trading fee.
 *
 * `C = k · (√(sumTerm' ) − √(sumTerm))` where the new sum-of-squares term is
 * `sumTerm + 2·q_i·N + N²`. Used by the simulator; live trading always prefers
 * the on-chain `quoteBuy`, which is ground truth.
 */
export function costToBuy(
  state: DpmState,
  outcomeIdx: number,
  sharesOut: bigint,
): bigint {
  if (sharesOut <= 0n) return 0n;
  const q = requireSupply(state, outcomeIdx);
  const before = state.sumTerm36;
  const after = before + 2n * q * sharesOut + sharesOut * sharesOut;
  const base = (state.k * (isqrt(after) - isqrt(before))) / K_ROOT_TO_TOKEN;
  // The fee is charged INTO the price, not added on top: the gateway grosses up
  // so that `base` lands in the pool and the fee is the remainder. Measured
  // against live quotes, `base*(1+fee)` is short by exactly fee/(1-fee) — 0.04%
  // at the 2% fee every testnet market uses.
  return (base * WAD) / (WAD - state.tradingFee);
}

/** Proceeds from selling `sharesIn`, net of the trading fee. */
export function proceedsFromSell(
  state: DpmState,
  outcomeIdx: number,
  sharesIn: bigint,
): bigint {
  if (sharesIn <= 0n) return 0n;
  const q = requireSupply(state, outcomeIdx);
  if (sharesIn > q) throw new RangeError("proceedsFromSell: supply underflow");
  const before = state.sumTerm36;
  const after = before - 2n * q * sharesIn + sharesIn * sharesIn;
  const base = (state.k * (isqrt(before) - isqrt(after))) / K_ROOT_TO_TOKEN;
  const fee = (base * state.tradingFee) / WAD;
  return base - fee;
}

/**
 * How much of the pool actually reaches winning shareholders.
 *
 * At settlement `submitWinner` pays out `marketCreatorReward`, `refund` and
 * `marketCreatorTradingFeesCut` before holders redeem, so the distributable
 * pool is strictly smaller than `pool`. `refund` is readable on-chain; the
 * creator reward is not known until settlement, so it is carried as a
 * calibrated haircut.
 *
 * Stage 3 replaces `creatorHaircut` with a value measured against realised
 * redemptions. Until then it is deliberately pessimistic: under-estimating
 * payout costs us marginal trades, over-estimating loses money.
 */
export interface PayoutModel {
  /** Fraction of the pool assumed lost to creator rewards/fees at settlement. */
  creatorHaircut: number;
  /** Fraction of a buy's gross cost that lands in the pool (rest is fee). */
  feeToPoolFraction: number;
}

export const DEFAULT_PAYOUT_MODEL: PayoutModel = {
  // Measured, not guessed. Stage 3 (`npm run validate:payout`) showed the
  // creator deduction is structural — it is the creator's shares leaving the
  // denominator, not a fraction leaving the pool — and once modelled explicitly
  // the fit is exact. So there is no residual haircut to apply.
  creatorHaircut: 0,
  feeToPoolFraction: 1,
};

/** Pool available to winning holders, 6-decimal. */
export function distributablePool(
  state: DpmState,
  model: PayoutModel = DEFAULT_PAYOUT_MODEL,
): bigint {
  const afterRefund = state.pool > state.refund ? state.pool - state.refund : 0n;
  const keep = BigInt(Math.round((1 - model.creatorHaircut) * 1e6));
  return (afterRefund * keep) / 1_000_000n;
}

/**
 * USDC received per winning share, 6-decimal.
 * This is the number the README assumed was always 1.0.
 *
 * WHICH POOL YOU PASS MATTERS, and getting it wrong is not a rounding issue:
 *
 *   OPEN market (pre-settlement) — `pool` still contains the creator's cut:
 *       payout = pool / totalSupply(winner)
 *
 *   SETTLED market (post-settlement) — `submitWinner` has already paid the
 *   creator out, and their shares no longer share in the remainder:
 *       payout = pool / (totalSupply(winner) - creatorSharesPerOutcome)
 *
 * Both were measured against every settled testnet market at 0.0000% error,
 * median and worst case. They are the same law seen before and after the
 * creator is settled — the creator's take is exactly
 * `creatorShares x payout`, which is what makes the open-market form collapse
 * to the simple ratio.
 *
 * Trading decisions are always about OPEN markets, so `creatorShares` defaults
 * to 0. Passing it while also passing a pre-settlement pool double-counts the
 * creator and inflates payout enormously — on a market where the creator holds
 * most of the supply it overstated by 37x.
 */
export function payoutPerShare(
  pool: bigint,
  winningSupply: bigint,
  creatorShares = 0n,
): bigint {
  const redeemable = winningSupply - creatorShares;
  if (redeemable <= 0n) return 0n;
  return (pool * SHARE_SCALE) / redeemable;
}

/**
 * State after buying `sharesOut` of `outcomeIdx`, given the actual cost paid.
 *
 * Passing `tokensIn` explicitly (rather than recomputing it) lets the evaluator
 * feed in a real on-chain quote and keep the simulation anchored to reality.
 */
export function applyBuy(
  state: DpmState,
  outcomeIdx: number,
  sharesOut: bigint,
  tokensIn: bigint,
  model: PayoutModel = DEFAULT_PAYOUT_MODEL,
): DpmState {
  const q = requireSupply(state, outcomeIdx);
  const supplies = state.supplies.slice();
  supplies[outcomeIdx] = q + sharesOut;
  const poolDelta = BigInt(
    Math.round(Number(tokensIn) * model.feeToPoolFraction),
  );
  const feeDelta = tokensIn - poolDelta;
  return {
    ...state,
    supplies,
    sumTerm36: sumTerm36(supplies),
    pool: state.pool + poolDelta,
    tradingFees: state.tradingFees + feeDelta,
  };
}

function requireSupply(state: DpmState, outcomeIdx: number): bigint {
  const q = state.supplies[outcomeIdx];
  if (q === undefined) {
    throw new RangeError(
      `outcomeIdx ${outcomeIdx} out of range (${state.supplies.length} outcomes)`,
    );
  }
  return q;
}

/** 6-decimal bigint → float USDC. */
export const toUsdc = (v: bigint): number => Number(v) / 1e6;
/** 18-decimal bigint → float shares. */
export const toShares = (v: bigint): number => Number(v) / 1e18;
/** float USDC → 6-decimal bigint. */
export const usdc = (v: number): bigint => BigInt(Math.round(v * 1e6));
/** float shares → 18-decimal bigint. */
export const shares = (v: number): bigint => BigInt(Math.round(v * 1e18));
