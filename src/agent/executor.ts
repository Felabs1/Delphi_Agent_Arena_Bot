/**
 * Trade execution: re-quote, re-check, approve, send.
 *
 * The gap between deciding and sending is where money leaks. Another agent can
 * move a thin DPM pool between our evaluation and our transaction, and on a DPM
 * that movement changes both our cost *and* our payout. So the executor never
 * trusts the decision's quote: it re-quotes immediately before sending and
 * re-runs the EV check against fresh state. If the edge evaporated in those few
 * seconds, we skip — that is the whole point of step 10 in the README pipeline.
 *
 * Every send is journalled before it goes out, so a crash mid-flight cannot
 * become a duplicate trade on the next cron tick.
 */

import { evaluate, type Evaluation } from "./evaluator.js";
import type { PayoutModel } from "./dpm.js";
import type { Address, DelphiPort } from "../sdk/port.js";

export interface TradeIntent {
  /** Stable id derived from run + market + outcome; the idempotency key. */
  id: string;
  marketAddress: Address;
  outcomeIdx: number;
  sharesOut: bigint;
  /** Cost quoted at decision time. */
  quotedTokensIn: bigint;
  probability: number;
}

export interface TradeJournal {
  /** True if this intent already resulted in a send (or is mid-flight). */
  wasAttempted(id: string): Promise<boolean>;
  recordAttempt(intent: TradeIntent): Promise<void>;
  recordResult(
    id: string,
    result: { transactionHash: string; filledTokensIn: bigint },
  ): Promise<void>;
  recordFailure(id: string, error: string): Promise<void>;
}

export interface ExecutorConfig {
  /** Slippage tolerance added to the fresh quote as `maxTokensIn`. */
  slippageTolerance: number;
  /** Abort if the re-quote exceeds the decision quote by more than this. */
  maxRequoteDrift: number;
  /** EV must still clear this after re-quoting. */
  minimumEvPerToken: number;
  payoutModel?: PayoutModel;
  failureProbability?: number;
  /** When true, do everything except send the transaction. */
  dryRun?: boolean;
}

export type ExecutionResult =
  | {
      status: "executed";
      transactionHash: string;
      quotedTokensIn: bigint;
      filledTokensIn: bigint;
      evaluation: Evaluation;
    }
  | { status: "skipped"; reason: string; evaluation?: Evaluation }
  | { status: "dry-run"; evaluation: Evaluation; wouldSpend: bigint }
  | { status: "failed"; reason: string };

export async function execute(
  intent: TradeIntent,
  port: DelphiPort,
  journal: TradeJournal,
  config: ExecutorConfig,
): Promise<ExecutionResult> {
  if (await journal.wasAttempted(intent.id)) {
    return { status: "skipped", reason: `already attempted (${intent.id})` };
  }

  // Fresh state and a fresh quote — the decision's numbers are already stale.
  const status = await port.getMarketStatus(intent.marketAddress);
  if (status !== "open") {
    return { status: "skipped", reason: `market is ${status}, not open` };
  }

  const state = await port.getDpmState(intent.marketAddress);
  const { tokensIn } = await port.quoteBuy({
    marketAddress: intent.marketAddress,
    outcomeIdx: intent.outcomeIdx,
    sharesOut: intent.sharesOut,
  });

  const drift =
    intent.quotedTokensIn > 0n
      ? Number(tokensIn - intent.quotedTokensIn) / Number(intent.quotedTokensIn)
      : 0;
  if (drift > config.maxRequoteDrift) {
    return {
      status: "skipped",
      reason: `price moved ${(drift * 100).toFixed(2)}% since evaluation (cap ${(config.maxRequoteDrift * 100).toFixed(2)}%)`,
    };
  }

  const evaluation = evaluate({
    state,
    outcomeIdx: intent.outcomeIdx,
    sharesOut: intent.sharesOut,
    tokensIn,
    probability: intent.probability,
    payoutModel: config.payoutModel,
    failureProbability: config.failureProbability,
  });

  if (evaluation.evPerToken < config.minimumEvPerToken) {
    return {
      status: "skipped",
      reason: `EV/token fell to ${(evaluation.evPerToken * 100).toFixed(2)}% after re-quote (minimum ${(config.minimumEvPerToken * 100).toFixed(2)}%)`,
      evaluation,
    };
  }

  const balance = await port.getTokenBalance();
  if (balance < tokensIn) {
    return {
      status: "skipped",
      reason: `insufficient balance: have ${balance}, need ${tokensIn}`,
      evaluation,
    };
  }

  const maxTokensIn = withTolerance(tokensIn, config.slippageTolerance);

  if (config.dryRun) {
    return { status: "dry-run", evaluation, wouldSpend: tokensIn };
  }

  await journal.recordAttempt({ ...intent, quotedTokensIn: tokensIn });

  try {
    await port.ensureTokenApproval({
      marketAddress: intent.marketAddress,
      minimumAmount: maxTokensIn,
    });
    const receipt = await port.buyShares({
      marketAddress: intent.marketAddress,
      outcomeIdx: intent.outcomeIdx,
      sharesOut: intent.sharesOut,
      maxTokensIn,
    });
    await journal.recordResult(intent.id, {
      transactionHash: receipt.transactionHash,
      filledTokensIn: tokensIn,
    });
    return {
      status: "executed",
      transactionHash: receipt.transactionHash,
      quotedTokensIn: intent.quotedTokensIn,
      filledTokensIn: tokensIn,
      evaluation,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await journal.recordFailure(intent.id, reason);
    return { status: "failed", reason };
  }
}

/**
 * Sweep settled and unresolvable positions back into cash.
 *
 * Run this before evaluating new trades: it is risk-free capital that compounds,
 * and on a long competition the difference between reclaiming it promptly and
 * letting it sit is real P&L.
 */
export async function sweepResolvedPositions(
  port: DelphiPort,
  opts: { dryRun?: boolean } = {},
): Promise<{
  redeemed: { marketAddress: string; tokensOut: bigint }[];
  liquidated: { marketAddress: string; tokensOut: bigint }[];
  errors: { marketAddress: string; error: string }[];
}> {
  const wallet = await port.getWalletAddress();
  const positions = await port.listPositions(wallet);

  const redeemed: { marketAddress: string; tokensOut: bigint }[] = [];
  const liquidated: { marketAddress: string; tokensOut: bigint }[] = [];
  const errors: { marketAddress: string; error: string }[] = [];

  // Group outcome indices per market so liquidation is one call per market.
  const byMarket = new Map<string, { status: string; indices: number[] }>();
  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    if (BigInt(p.shares) <= 0n) continue; // zero-share rows revert on redeem
    const entry = byMarket.get(p.marketProxy) ?? {
      status: p.marketStatus,
      indices: [],
    };
    entry.indices.push(Number(p.outcomeIdx));
    byMarket.set(p.marketProxy, entry);
  }

  for (const [marketAddress, { status, indices }] of byMarket) {
    try {
      if (status === "settled") {
        if (opts.dryRun) {
          const q = await port.quoteRedeem({
            marketAddress: marketAddress as Address,
          });
          redeemed.push({ marketAddress, tokensOut: q.tokensOut });
        } else {
          const r = await port.redeemMarket({
            marketAddress: marketAddress as Address,
          });
          redeemed.push({ marketAddress, tokensOut: r.tokensOut });
        }
      } else if (status === "expired" || status === "failed") {
        if (opts.dryRun) {
          const q = await port.quoteLiquidate({
            marketAddress: marketAddress as Address,
            outcomeIndices: indices,
          });
          liquidated.push({ marketAddress, tokensOut: q.totalTokensOut });
        } else {
          const r = await port.liquidate({
            marketAddress: marketAddress as Address,
            outcomeIndices: indices,
          });
          liquidated.push({ marketAddress, tokensOut: r.tokensOut });
        }
      }
    } catch (err) {
      errors.push({
        marketAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { redeemed, liquidated, errors };
}

function withTolerance(tokens: bigint, tolerance: number): bigint {
  const bps = BigInt(Math.round(Math.max(0, tolerance) * 10_000));
  return (tokens * (10_000n + bps)) / 10_000n;
}

/** In-memory journal — the SQLite-backed one arrives in Stage 6. */
export class MemoryJournal implements TradeJournal {
  private readonly attempted = new Set<string>();
  readonly results = new Map<
    string,
    { transactionHash: string; filledTokensIn: bigint }
  >();
  readonly failures = new Map<string, string>();

  async wasAttempted(id: string): Promise<boolean> {
    return this.attempted.has(id);
  }
  async recordAttempt(intent: TradeIntent): Promise<void> {
    this.attempted.add(intent.id);
  }
  async recordResult(
    id: string,
    result: { transactionHash: string; filledTokensIn: bigint },
  ): Promise<void> {
    this.results.set(id, result);
  }
  async recordFailure(id: string, error: string): Promise<void> {
    this.failures.set(id, error);
  }
}
