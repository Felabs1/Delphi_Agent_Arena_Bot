/**
 * The probability-estimation seam.
 *
 * The LLM's job is to estimate probabilities, never to say "buy" or "sell" —
 * sizing and execution are the agent's, and mixing the two lets a confident
 * sentence override the EV math.
 *
 * The real implementation (Stage 4) is an OpenRouter ensemble that also
 * impersonates the market's own settlement judge, read from
 * `metadata.model.model_identifier` / `prompt_context`. Stage 1 runs against
 * `StaticEstimator` so the pipeline is testable with zero network.
 */

import type { Market } from "../sdk/port.js";

export interface Evidence {
  /** Normalised context assembled by the data layer. */
  summary: string;
  sources: string[];
}

export interface MarketEstimate {
  /** One probability per outcome, in outcome order. Should sum to ~1. */
  probabilities: number[];
  /** 0–1. Drives shrinkage toward the market, so it must mean something. */
  confidence: number;
  reasoning: string;
  contradictions?: string;
  uncertainty?: string;
  /** Per-model outputs, kept for calibration scoring. */
  raw?: unknown;
}

export interface ProbabilityEstimator {
  estimate(market: Market, evidence: Evidence): Promise<MarketEstimate>;
}

/** Normalise to a proper distribution; reject anything unusable. */
export function normalizeProbabilities(values: number[]): number[] {
  const clean = values.map((v) =>
    Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0,
  );
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // No signal — fall back to uniform rather than pretending to know something.
    return clean.map(() => 1 / Math.max(1, clean.length));
  }
  return clean.map((v) => v / total);
}

/** Fixed answers, keyed by market address. For tests and dry runs. */
export class StaticEstimator implements ProbabilityEstimator {
  constructor(
    private readonly answers: Map<string, MarketEstimate>,
    private readonly fallback?: MarketEstimate,
  ) {}

  async estimate(market: Market, _evidence: Evidence): Promise<MarketEstimate> {
    const hit =
      this.answers.get(market.id) ?? this.answers.get(market.id.toLowerCase());
    const estimate =
      hit ??
      this.fallback ??
      uniformEstimate(market.metadata?.outcomes.length ?? 2);
    return {
      ...estimate,
      probabilities: normalizeProbabilities(estimate.probabilities),
    };
  }
}

export function uniformEstimate(outcomeCount: number): MarketEstimate {
  const n = Math.max(1, outcomeCount);
  return {
    probabilities: Array.from({ length: n }, () => 1 / n),
    confidence: 0,
    reasoning: "no estimate available",
  };
}
