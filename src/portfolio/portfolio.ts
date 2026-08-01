/**
 * Portfolio valuation.
 *
 * Positions are marked at what we could actually get for them right now — the
 * on-chain `quoteSell` — not at spot price × shares. On a DPM those differ
 * materially: selling walks the curve back down, so spot-marking systematically
 * overstates the book. Overstated bankroll means oversized bets, so this is a
 * risk control as much as an accounting choice.
 *
 * The chain is authoritative. Local state is a cache and is reconciled against
 * `listPositions()` on every run.
 */

import { toUsdc } from "../agent/dpm.js";
import type { Address, DelphiPort, Position } from "../sdk/port.js";

export interface MarkedPosition {
  marketAddress: string;
  outcomeIdx: number;
  shares: bigint;
  /** Liquidation value right now, USDC. `null` if the market can't be quoted. */
  markUsdc: number | null;
  marketStatus: string;
}

export interface PortfolioSnapshot {
  walletAddress: string;
  cashUsdc: number;
  positions: MarkedPosition[];
  /** Cash plus the marked value of open positions. */
  bankrollUsdc: number;
  /** USDC locked per market address (lowercased). */
  perMarket: Map<string, number>;
}

export async function buildPortfolio(
  port: DelphiPort,
): Promise<PortfolioSnapshot> {
  const walletAddress = await port.getWalletAddress();
  const cashUsdc = toUsdc(await port.getTokenBalance());
  const raw = await port.listPositions(walletAddress);

  const positions: MarkedPosition[] = [];
  const perMarket = new Map<string, number>();
  let positionValue = 0;

  for (const p of open(raw)) {
    const shares = BigInt(p.shares);
    const outcomeIdx = Number(p.outcomeIdx);
    const mark = await markPosition(port, p, shares, outcomeIdx);

    positions.push({
      marketAddress: p.marketProxy,
      outcomeIdx,
      shares,
      markUsdc: mark,
      marketStatus: p.marketStatus,
    });

    if (mark !== null) {
      positionValue += mark;
      const key = p.marketProxy.toLowerCase();
      perMarket.set(key, (perMarket.get(key) ?? 0) + mark);
    }
  }

  return {
    walletAddress,
    cashUsdc,
    positions,
    bankrollUsdc: cashUsdc + positionValue,
    perMarket,
  };
}

/** Positions with a live stake. Zero-share rows revert on redeem/liquidate. */
export function open(positions: Position[]): Position[] {
  return positions.filter((p) => !p.redeemedOrLiquidated && BigInt(p.shares) > 0n);
}

async function markPosition(
  port: DelphiPort,
  p: Position,
  shares: bigint,
  outcomeIdx: number,
): Promise<number | null> {
  const address = p.marketProxy as Address;
  try {
    if (p.marketStatus === "settled") {
      const q = await port.quoteRedeem({ marketAddress: address });
      return toUsdc(q.tokensOut);
    }
    if (p.marketStatus === "expired" || p.marketStatus === "failed") {
      const q = await port.quoteLiquidate({
        marketAddress: address,
        outcomeIndices: [outcomeIdx],
      });
      return toUsdc(q.totalTokensOut);
    }
    if (p.marketStatus === "open") {
      const q = await port.quoteSell({
        marketAddress: address,
        outcomeIdx,
        sharesIn: shares,
      });
      return toUsdc(q.tokensOut);
    }
    // awaiting_settlement: trading is closed, so there is no sell quote. Value
    // is unknown until the oracle rules; carrying it at 0 would understate the
    // book and carrying it at cost would overstate it, so report it as unknown.
    return null;
  } catch {
    return null;
  }
}
