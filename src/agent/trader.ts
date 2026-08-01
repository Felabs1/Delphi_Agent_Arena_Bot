/**
 * The trading loop: one full pass, then stop.
 *
 * Order matters. The sweep runs first because redeeming settled positions is
 * risk-free capital that then funds this pass. Candidates are ranked by EV per
 * USDC per day rather than raw EV, because DPM capital is locked until
 * settlement and a competition is a race over a fixed window. Exposure is
 * updated between executions so the caps apply to the trades we are making in
 * *this* pass, not just the ones we already had.
 */

import { evPerTokenPerDay, type Evaluation } from "./evaluator.js";
import { chooseSize, type SizingConfig } from "./strategy.js";
import {
  execute,
  sweepResolvedPositions,
  type ExecutionResult,
  type ExecutorConfig,
  type TradeJournal,
} from "./executor.js";
import {
  checkMarketEligible,
  checkPortfolio,
  checkTrade,
  correlationKey,
  type ExposureSnapshot,
  type RiskLimits,
} from "./risk.js";
import { buildPortfolio, type MarkedPosition } from "../portfolio/portfolio.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import type { Evidence, ProbabilityEstimator } from "../ai/estimator.js";
import type { Address, DelphiPort, Market } from "../sdk/port.js";

export interface EvidenceProvider {
  gather(market: Market): Promise<Evidence>;
}

export const NO_EVIDENCE: EvidenceProvider = {
  async gather() {
    return { summary: "", sources: [] };
  },
};

export interface TraderConfig {
  runId: string;
  sizing: Omit<SizingConfig, "bankrollUsdc" | "availableUsdc">;
  risk: RiskLimits;
  executor: ExecutorConfig;
  /** Markets to pull per pass. */
  marketLimit: number;
  /** Cap on trades executed in a single pass. */
  maxTradesPerRun: number;
  dryRun: boolean;
  /**
   * Highest bankroll ever recorded, from persisted state. Drawdown is
   * meaningless without it — defaults to the current bankroll, which makes the
   * breaker inert on a fresh database rather than falsely tripping it.
   */
  peakBankrollUsdc?: number;
  /** Trades already executed today (UTC), from persisted state. */
  tradesToday?: number;
  /**
   * How many markets to analyse at once. Bounded because free LLM tiers
   * rate-limit hard; unbounded fan-out gets everything 429'd.
   */
  evaluationConcurrency?: number;
}

export interface Candidate {
  market: Market;
  outcomeIdx: number;
  outcomeLabel: string;
  evaluation: Evaluation;
  sharesOut: bigint;
  tokensIn: bigint;
  score: number;
  correlationKey: string;
  confidence: number;
  reasoning: string;
  /** The full estimated distribution, kept for calibration scoring. */
  probabilities: number[];
}

export interface SkipRecord {
  marketId: string;
  question: string;
  outcomeIdx?: number;
  reason: string;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  walletAddress: string;
  bankrollUsdc: number;
  cashUsdc: number;
  marketsFetched: number;
  marketsEvaluated: number;
  candidates: Candidate[];
  executions: { candidate: Candidate; result: ExecutionResult }[];
  skips: SkipRecord[];
  sweep: Awaited<ReturnType<typeof sweepResolvedPositions>>;
  /** Positions still open after this pass, marked at what they'd fetch now. */
  positionsHeld: MarkedPosition[];
  halted?: string;
}

export async function runOnce(
  port: DelphiPort,
  estimator: ProbabilityEstimator,
  journal: TradeJournal,
  config: TraderConfig,
  evidenceProvider: EvidenceProvider = NO_EVIDENCE,
  now: Date = new Date(),
): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const skips: SkipRecord[] = [];

  // 1. Reclaim resolved capital before deciding what to do with it.
  const sweep = await sweepResolvedPositions(port, { dryRun: config.dryRun });

  // 2. Value the book.
  const portfolio = await buildPortfolio(port);
  const snapshot: ExposureSnapshot = {
    bankrollUsdc: portfolio.bankrollUsdc,
    peakBankrollUsdc: Math.max(
      config.peakBankrollUsdc ?? portfolio.bankrollUsdc,
      portfolio.bankrollUsdc,
    ),
    perMarket: new Map(portfolio.perMarket),
    perCorrelationKey: new Map(),
    tradesToday: config.tradesToday ?? 0,
  };

  const portfolioCheck = checkPortfolio(snapshot, config.risk);
  if (!portfolioCheck.allowed) {
    return {
      runId: config.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      walletAddress: portfolio.walletAddress,
      bankrollUsdc: portfolio.bankrollUsdc,
      cashUsdc: portfolio.cashUsdc,
      marketsFetched: 0,
      marketsEvaluated: 0,
      candidates: [],
      executions: [],
      skips,
      sweep,
      positionsHeld: portfolio.positions,
      halted: portfolioCheck.reason,
    };
  }

  // 3. Fetch markets, soonest-settling first — those free capital fastest.
  const markets = await port.listMarkets({
    status: "open",
    limit: config.marketLimit,
    orderBy: "settles_at",
    pricesAndImpliedProbabilities: true,
  });

  const minimums = await port.getTradeMinimums();
  let evaluated = 0;

  /**
   * Analysis is per-market independent, so it runs concurrently. Sequentially
   * this took over ten minutes for six markets on free models — useless for a
   * five-minute cron. Execution below stays strictly sequential, because it
   * mutates shared exposure and must respect caps in ranked order.
   */
  const perMarket = await mapWithConcurrency(
    markets,
    config.evaluationConcurrency ?? 4,
    async (market): Promise<{ candidates: Candidate[]; skips: SkipRecord[]; evaluated: boolean }> => {
      const localSkips: SkipRecord[] = [];
      const localCandidates: Candidate[] = [];
      const outcomes = market.metadata?.outcomes ?? [];

      const eligible = checkMarketEligible(
        {
          status: market.status,
          settlesAt: market.settlesAt,
          verifiable: market.verifiable,
          hasMetadata: Boolean(market.metadata?.question) && outcomes.length > 0,
          hasPrices: Boolean(market.spotImpliedProbabilities?.length),
        },
        config.risk,
        now,
      );
      if (!eligible.allowed) {
        localSkips.push({
          marketId: market.id,
          question: market.metadata?.question ?? "(no metadata)",
          reason: eligible.reason,
        });
        return { candidates: localCandidates, skips: localSkips, evaluated: false };
      }

      try {
        const evidence = await evidenceProvider.gather(market);
        const estimate = await estimator.estimate(market, evidence);
        const state = await port.getDpmState(market.id as Address);
        const key = correlationKey(
          market.metadata?.question ?? market.id,
          market.category,
        );

        for (let outcomeIdx = 0; outcomeIdx < outcomes.length; outcomeIdx++) {
          const probability = estimate.probabilities[outcomeIdx];
          if (probability === undefined) continue;

          const sized = await chooseSize(
            {
              state,
              outcomeIdx,
              probability,
              confidence: estimate.confidence,
              minShares: minimums.minShares,
              minTokens: minimums.minTokens,
              quoteBuy: (p) => port.quoteBuy(p),
            },
            {
              ...config.sizing,
              bankrollUsdc: portfolio.bankrollUsdc,
              availableUsdc: portfolio.cashUsdc,
            },
          );

          if (!sized.ok) {
            localSkips.push({
              marketId: market.id,
              question: market.metadata?.question ?? market.id,
              outcomeIdx,
              reason: sized.reason,
            });
            continue;
          }

          localCandidates.push({
            market,
            outcomeIdx,
            outcomeLabel: outcomes[outcomeIdx] ?? `#${outcomeIdx}`,
            evaluation: sized.decision.evaluation,
            sharesOut: sized.decision.sharesOut,
            tokensIn: sized.decision.tokensIn,
            score: evPerTokenPerDay(
              sized.decision.evaluation,
              market.settlesAt ? new Date(market.settlesAt) : null,
              now,
            ),
            correlationKey: key,
            confidence: estimate.confidence,
            reasoning: estimate.reasoning,
            probabilities: estimate.probabilities,
          });
        }
      } catch (err) {
        // One bad market must not abort the pass.
        localSkips.push({
          marketId: market.id,
          question: market.metadata?.question ?? market.id,
          reason: `analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return { candidates: localCandidates, skips: localSkips, evaluated: true };
    },
  );

  const candidates: Candidate[] = [];
  for (const result of perMarket) {
    if (result.evaluated) evaluated++;
    candidates.push(...result.candidates);
    skips.push(...result.skips);
  }

  // 4. Best risk-adjusted return on locked capital first.
  candidates.sort((a, b) => b.score - a.score);

  // At most one outcome per market. Holding two outcomes of the same market is
  // incoherent — they cannot both win — and when it happens it is a symptom of
  // a degenerate payout estimate rather than a real arbitrage. Keep the
  // best-scoring side and record the rest.
  const claimed = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.market.id.toLowerCase();
    if (claimed.has(key)) {
      skips.push({
        marketId: candidate.market.id,
        question: candidate.market.metadata?.question ?? candidate.market.id,
        outcomeIdx: candidate.outcomeIdx,
        reason: "another outcome of this market already scored higher",
      });
      continue;
    }
    claimed.add(key);
    deduped.push(candidate);
  }
  candidates.length = 0;
  candidates.push(...deduped);

  const executions: { candidate: Candidate; result: ExecutionResult }[] = [];
  for (const candidate of candidates) {
    if (executions.length >= config.maxTradesPerRun) {
      skips.push({
        marketId: candidate.market.id,
        question: candidate.market.metadata?.question ?? candidate.market.id,
        outcomeIdx: candidate.outcomeIdx,
        reason: `max trades per run (${config.maxTradesPerRun}) reached`,
      });
      continue;
    }

    const verdict = checkTrade(
      {
        marketAddress: candidate.market.id,
        correlationKey: candidate.correlationKey,
        costUsdc: candidate.evaluation.cost,
      },
      snapshot,
      config.risk,
    );
    if (!verdict.allowed) {
      skips.push({
        marketId: candidate.market.id,
        question: candidate.market.metadata?.question ?? candidate.market.id,
        outcomeIdx: candidate.outcomeIdx,
        reason: verdict.reason,
      });
      continue;
    }

    const result = await execute(
      {
        id: `${config.runId}:${candidate.market.id}:${candidate.outcomeIdx}`,
        marketAddress: candidate.market.id as Address,
        outcomeIdx: candidate.outcomeIdx,
        sharesOut: candidate.sharesOut,
        quotedTokensIn: candidate.tokensIn,
        probability: candidate.evaluation.probability,
      },
      port,
      journal,
      { ...config.executor, dryRun: config.dryRun },
    );
    executions.push({ candidate, result });

    if (result.status === "executed" || result.status === "dry-run") {
      const spent =
        result.status === "executed"
          ? Number(result.filledTokensIn) / 1e6
          : Number(result.wouldSpend) / 1e6;
      bump(snapshot.perMarket, candidate.market.id.toLowerCase(), spent);
      bump(snapshot.perCorrelationKey, candidate.correlationKey, spent);
      snapshot.tradesToday += 1;
    }
  }

  return {
    runId: config.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    walletAddress: portfolio.walletAddress,
    bankrollUsdc: portfolio.bankrollUsdc,
    cashUsdc: portfolio.cashUsdc,
    marketsFetched: markets.length,
    marketsEvaluated: evaluated,
    candidates,
    executions,
    skips,
    sweep,
    positionsHeld: portfolio.positions,
  };
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}
