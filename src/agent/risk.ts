/**
 * Risk gates. Pure functions over a snapshot of current exposure.
 *
 * Every check returns a reason string on rejection rather than a bare boolean,
 * because "why didn't it trade?" is the question we will be asking constantly
 * during the competition, and the logs need to answer it.
 *
 * Note on a testnet competition: the faucet makes capital replenishable, so the
 * drawdown breaker is not protecting solvency — it is protecting *P&L ranking*.
 * A model that has started losing is a model that is mis-calibrated, and the
 * right response is to stop and re-calibrate, not to keep buying.
 */

export interface RiskLimits {
  /** Max fraction of bankroll in any single market. */
  maxExposurePerMarket: number;
  /** Max fraction of bankroll across markets sharing a correlation key. */
  maxExposurePerCorrelatedGroup: number;
  /** Max fraction of bankroll deployed at once. */
  maxTotalExposure: number;
  /** Max trades per UTC day. */
  maxDailyTrades: number;
  /** Halt trading once cumulative drawdown from peak exceeds this fraction. */
  maxDrawdown: number;
  /** Skip markets settling after this instant (competition close). */
  tradingWindowEnd?: Date;
  /** Skip markets settling sooner than this many hours from now. */
  minHoursToSettlement?: number;
  /** Require `verifiable: true` markets. */
  requireVerifiable?: boolean;
}

export interface ExposureSnapshot {
  bankrollUsdc: number;
  /** Peak bankroll ever observed, for drawdown. */
  peakBankrollUsdc: number;
  /** USDC currently locked per market address (lowercased). */
  perMarket: Map<string, number>;
  /** USDC currently locked per correlation key. */
  perCorrelationKey: Map<string, number>;
  /** Trades already executed today (UTC). */
  tradesToday: number;
}

export interface RiskCheckRequest {
  marketAddress: string;
  correlationKey: string;
  /** USDC this trade would deploy. */
  costUsdc: number;
}

export type RiskVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOWED: RiskVerdict = { allowed: true };
const deny = (reason: string): RiskVerdict => ({ allowed: false, reason });

/** Portfolio-level gates that do not depend on a specific candidate trade. */
export function checkPortfolio(
  snapshot: ExposureSnapshot,
  limits: RiskLimits,
): RiskVerdict {
  if (snapshot.peakBankrollUsdc > 0) {
    const drawdown =
      (snapshot.peakBankrollUsdc - snapshot.bankrollUsdc) /
      snapshot.peakBankrollUsdc;
    if (drawdown >= limits.maxDrawdown) {
      return deny(
        `drawdown circuit breaker: ${(drawdown * 100).toFixed(1)}% from peak >= ${(limits.maxDrawdown * 100).toFixed(1)}%`,
      );
    }
  }
  if (snapshot.tradesToday >= limits.maxDailyTrades) {
    return deny(
      `daily trade cap reached (${snapshot.tradesToday}/${limits.maxDailyTrades})`,
    );
  }
  return ALLOWED;
}

/** Per-trade exposure gates. */
export function checkTrade(
  req: RiskCheckRequest,
  snapshot: ExposureSnapshot,
  limits: RiskLimits,
): RiskVerdict {
  const portfolio = checkPortfolio(snapshot, limits);
  if (!portfolio.allowed) return portfolio;

  const bankroll = snapshot.bankrollUsdc;
  if (bankroll <= 0) return deny("bankroll is zero");

  const market = req.marketAddress.toLowerCase();
  const marketAfter = (snapshot.perMarket.get(market) ?? 0) + req.costUsdc;
  if (marketAfter / bankroll > limits.maxExposurePerMarket) {
    return deny(
      `market exposure ${pct(marketAfter / bankroll)} would exceed cap ${pct(limits.maxExposurePerMarket)}`,
    );
  }

  const groupAfter =
    (snapshot.perCorrelationKey.get(req.correlationKey) ?? 0) + req.costUsdc;
  if (groupAfter / bankroll > limits.maxExposurePerCorrelatedGroup) {
    return deny(
      `correlated exposure for "${req.correlationKey}" ${pct(groupAfter / bankroll)} would exceed cap ${pct(limits.maxExposurePerCorrelatedGroup)}`,
    );
  }

  let total = req.costUsdc;
  for (const v of snapshot.perMarket.values()) total += v;
  if (total / bankroll > limits.maxTotalExposure) {
    return deny(
      `total exposure ${pct(total / bankroll)} would exceed cap ${pct(limits.maxTotalExposure)}`,
    );
  }

  return ALLOWED;
}

export interface MarketEligibility {
  status: string;
  settlesAt: string | null;
  verifiable: boolean;
  hasMetadata: boolean;
  hasPrices: boolean;
}

/**
 * Should we even look at this market?
 *
 * Settlement timing is a hard filter, not a preference: DPM capital is locked
 * until the market resolves, so anything settling after the competition closes
 * is dead money regardless of how good the edge looks.
 */
export function checkMarketEligible(
  market: MarketEligibility,
  limits: RiskLimits,
  now: Date = new Date(),
): RiskVerdict {
  if (market.status !== "open") return deny(`status is ${market.status}`);
  if (!market.hasMetadata) return deny("no metadata (question/outcomes)");
  if (!market.hasPrices) return deny("no on-chain prices available");
  if (limits.requireVerifiable && !market.verifiable) {
    return deny("market is not verifiable");
  }
  if (!market.settlesAt) return deny("no settlement date");

  const settles = new Date(market.settlesAt);
  if (Number.isNaN(settles.getTime())) return deny("unparseable settlement date");
  if (settles <= now) return deny("settlement date has passed");

  if (limits.tradingWindowEnd && settles > limits.tradingWindowEnd) {
    return deny(
      `settles ${settles.toISOString()} after competition close ${limits.tradingWindowEnd.toISOString()}`,
    );
  }
  const minHours = limits.minHoursToSettlement ?? 0;
  if (minHours > 0) {
    const hours = (settles.getTime() - now.getTime()) / 3_600_000;
    if (hours < minHours) {
      return deny(
        `settles in ${hours.toFixed(1)}h, under the ${minHours}h minimum`,
      );
    }
  }
  return ALLOWED;
}

/**
 * Group markets that resolve on the same underlying event.
 *
 * Two markets asking "BTC above 100k on Jan 1?" and "Will BTC hit 100k by
 * Jan 1?" are one bet wearing two hats; capping them separately is how you end
 * up 3x concentrated without noticing.
 *
 * The key keeps entities, numbers and dates and discards the comparison
 * predicate, because the predicate is how the *same* event gets reworded. A
 * consequence is that opposite-direction markets on one event ("above 100k" /
 * "below 100k") collapse to the same key. That is intended: they carry the same
 * event risk, so they belong under one cap.
 *
 * Deliberately blunt — Stage 4 can upgrade this to an LLM-derived event id.
 */
export function correlationKey(question: string, category: string | null): string {
  const stop = new Set([
    // Grammar
    "will", "the", "be", "is", "are", "a", "an", "of", "on", "in", "at", "to",
    "by", "for", "and", "or", "than", "then", "this", "that", "have", "has",
    "had", "before", "after", "any", "does", "do", "did", "it", "its", "with",
    "as", "if", "there", "their", "from", "up", "down",
    // Comparison predicates — the part that gets reworded between markets
    "above", "below", "over", "under", "exceed", "exceeds", "exceeding",
    "hit", "hits", "reach", "reaches", "reached", "cross", "crosses",
    "close", "closes", "closing", "end", "ends", "ending", "trade", "trades",
    "more", "less", "least", "most", "higher", "lower", "greater",
    // Interrogatives
    "when", "what", "which", "who", "whom", "whose", "how",
  ]);
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t))
    .sort();
  const unique = [...new Set(tokens)].slice(0, 6);
  return `${category ?? "uncategorised"}:${unique.join("-")}`;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
