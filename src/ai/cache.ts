/**
 * Estimate caching.
 *
 * A cron tick every five minutes does not mean the world changed every five
 * minutes. Re-running a frontier ensemble on an unchanged market is pure cost,
 * so estimates are reused until either they age out or the market itself moves
 * enough that our view is worth re-examining.
 *
 * The price-move trigger matters as much as the TTL: if other agents have
 * repriced an outcome by 5 points, either they know something we don't or an
 * edge just appeared. Both are reasons to look again.
 */

import type { MarketEstimate } from "./estimator.js";

export interface CachedEstimate {
  estimate: MarketEstimate;
  /** Epoch millis. */
  cachedAt: number;
  /** Market implied probabilities at the time of caching. */
  marketProbabilities: number[];
  /** Hash of the market metadata, so a re-worded question invalidates. */
  metadataFingerprint: string;
}

export interface EstimateCache {
  get(marketId: string): CachedEstimate | undefined;
  set(marketId: string, entry: CachedEstimate): void;
  delete(marketId: string): void;
  readonly size: number;
}

export class MemoryEstimateCache implements EstimateCache {
  private readonly entries = new Map<string, CachedEstimate>();

  get(marketId: string): CachedEstimate | undefined {
    return this.entries.get(marketId.toLowerCase());
  }
  set(marketId: string, entry: CachedEstimate): void {
    this.entries.set(marketId.toLowerCase(), entry);
  }
  delete(marketId: string): void {
    this.entries.delete(marketId.toLowerCase());
  }
  get size(): number {
    return this.entries.size;
  }
}

export interface FreshnessPolicy {
  ttlMinutes: number;
  /** Largest per-outcome probability move tolerated before re-estimating. */
  invalidateOnMove: number;
}

export type StaleReason = "expired" | "market-moved" | "metadata-changed";

/**
 * Why this entry can't be reused — or `null` if it can.
 * Returning the reason keeps cache behaviour visible in the logs.
 */
export function stalenessReason(
  entry: CachedEstimate,
  currentMarketProbabilities: number[],
  currentFingerprint: string,
  policy: FreshnessPolicy,
  now: Date = new Date(),
): StaleReason | null {
  if (entry.metadataFingerprint !== currentFingerprint) return "metadata-changed";

  const ageMinutes = (now.getTime() - entry.cachedAt) / 60_000;
  if (ageMinutes >= policy.ttlMinutes) return "expired";

  const moved = currentMarketProbabilities.some((p, i) => {
    const before = entry.marketProbabilities[i];
    return before !== undefined && Math.abs(p - before) > policy.invalidateOnMove;
  });
  if (moved) return "market-moved";

  return null;
}

/** Cheap, stable fingerprint of the question and outcomes. */
export function fingerprintMetadata(
  question: string | undefined,
  outcomes: string[] | undefined,
): string {
  const source = `${question ?? ""}|${(outcomes ?? []).join("|")}`;
  // FNV-1a: not cryptographic, just needs to change when the text changes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
