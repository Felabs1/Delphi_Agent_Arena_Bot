/**
 * Multi-model probability estimation.
 *
 * Two tiers, for cost reasons that are load-bearing rather than incidental:
 *
 *   TRIAGE   one cheap model screens every market. If its view is close to the
 *            market's, we stop. Most markets are roughly correctly priced, so
 *            most markets end here for a fraction of a cent.
 *   ENSEMBLE only markets where triage sees a real gap reach the frontier
 *            models, plus a replica of the market's own settlement judge.
 *
 * Confidence comes from *disagreement between models*, not from what any model
 * says about itself. Self-reported confidence is not calibrated and correlates
 * with fluency rather than accuracy. Disagreement is a measurement, and it feeds
 * straight into the shrinkage in `strategy.ts`, so an ensemble that splits
 * produces a small position rather than a confident wrong one.
 */

import { z } from "zod";
import {
  BudgetExceededError,
  type CompletionResult,
  type OpenRouterClient,
} from "./llm.js";
import { analystPrompt, judgePrompt, triagePrompt, ANALYST_SYSTEM, JUDGE_SYSTEM } from "./prompts.js";
import {
  fingerprintMetadata,
  stalenessReason,
  type EstimateCache,
  type FreshnessPolicy,
} from "./cache.js";
import {
  normalizeProbabilities,
  uniformEstimate,
  type Evidence,
  type MarketEstimate,
  type ProbabilityEstimator,
} from "./estimator.js";
import type { Market } from "../sdk/port.js";
import type { Logger } from "../utils/logger.js";

const responseSchema = z.object({
  probabilities: z.array(z.number()).min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(""),
  contradictions: z.string().optional(),
  uncertainty: z.string().optional(),
});

export type ModelResponse = z.infer<typeof responseSchema>;

export interface ModelOpinion {
  model: string;
  role: "triage" | "analyst" | "judge";
  probabilities: number[];
  selfConfidence: number;
  reasoning: string;
  contradictions?: string;
  uncertainty?: string;
  costUsd: number;
  latencyMs: number;
}

/**
 * OpenRouter marks zero-cost models with a `:free` suffix (plus the
 * `openrouter/free` auto-router). Free tiers are rate-limited, which is why
 * every slot supports a fallback chain rather than a single id.
 */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

/** `"a|b|c"` means: try a, then b, then c. */
export function parseModelChain(spec: string): string[] {
  return spec
    .split("|")
    .map((m) => m.trim())
    .filter(Boolean);
}

export interface EnsembleOptions {
  client: OpenRouterClient;
  /**
   * One entry per ensemble slot. Each entry may be a `|`-separated fallback
   * chain, tried in order until one answers.
   */
  models: string[];
  /** Cheap model that screens every market. May be a fallback chain. */
  triageModel: string;
  /**
   * Allow calling models that cost money. Default false: free models are
   * adequate for probability estimation and an agent on a cron can otherwise
   * spend more on inference than it wins.
   */
  allowPaidFallback?: boolean;
  /** Force a specific model for judge replication, overriding market metadata. */
  judgeModelOverride?: string;
  /** Query the market's own settlement judge as an extra opinion. */
  replicateJudge?: boolean;
  /**
   * Weight of the judge replica relative to an analyst (1.0). Above 1 because
   * the judge decides payout, but not dominant — it is still a prediction.
   */
  judgeWeight?: number;
  /** Triage must differ from the market by this much to escalate. */
  triageGapThreshold: number;
  cache?: EstimateCache;
  freshness?: FreshnessPolicy;
  logger?: Logger;
  now?: () => Date;
}

export class EnsembleEstimator implements ProbabilityEstimator {
  constructor(private readonly options: EnsembleOptions) {}

  async estimate(market: Market, evidence: Evidence): Promise<MarketEstimate> {
    const now = this.options.now?.() ?? new Date();
    const log = this.options.logger;
    const outcomes = market.metadata?.outcomes ?? [];
    const marketProbabilities = market.spotImpliedProbabilities ?? [];

    if (outcomes.length === 0) return uniformEstimate(0);

    const fingerprint = fingerprintMetadata(
      market.metadata?.question,
      outcomes,
    );

    // --- cache ---------------------------------------------------------
    const cache = this.options.cache;
    const freshness = this.options.freshness;
    if (cache && freshness) {
      const hit = cache.get(market.id);
      if (hit) {
        const reason = stalenessReason(
          hit,
          marketProbabilities,
          fingerprint,
          freshness,
          now,
        );
        if (reason === null) {
          log?.debug("estimate cache hit", { market: market.id });
          return hit.estimate;
        }
        log?.debug("estimate cache miss", { market: market.id, reason });
      }
    }

    const remember = (estimate: MarketEstimate): MarketEstimate => {
      cache?.set(market.id, {
        estimate,
        cachedAt: now.getTime(),
        marketProbabilities,
        metadataFingerprint: fingerprint,
      });
      return estimate;
    };

    // --- tier 1: triage -------------------------------------------------
    if (this.options.client.exhausted) {
      log?.warn("LLM budget exhausted before triage", { market: market.id });
      return uniformEstimate(outcomes.length);
    }

    const triage = await this.ask(
      this.options.triageModel,
      "triage",
      ANALYST_SYSTEM,
      triagePrompt(market, now),
      outcomes.length,
      600,
    );

    if (!triage) {
      log?.warn("triage failed; not trading this market", { market: market.id });
      return uniformEstimate(outcomes.length);
    }

    const gap = maxGap(triage.probabilities, marketProbabilities);
    if (gap < this.options.triageGapThreshold) {
      log?.debug("triage: priced about right, skipping ensemble", {
        market: market.id,
        gap,
      });
      // Confidence 0 keeps this out of the trade path without special-casing.
      return remember({
        probabilities: triage.probabilities,
        confidence: 0,
        reasoning: `Triage saw no material gap (max ${(gap * 100).toFixed(1)}%). ${triage.reasoning}`,
        raw: { triage },
      });
    }

    log?.debug("triage: escalating to ensemble", { market: market.id, gap });

    // --- tier 2: ensemble + judge replica --------------------------------
    const tasks: Promise<ModelOpinion | null>[] = this.options.models.map((model) =>
      this.ask(
        model,
        "analyst",
        ANALYST_SYSTEM,
        analystPrompt(market, evidence, now),
        outcomes.length,
      ),
    );

    if (this.options.replicateJudge !== false) {
      const judgeModel = this.resolveJudgeModel(market);
      if (judgeModel) {
        tasks.push(
          this.ask(
            judgeModel,
            "judge",
            JUDGE_SYSTEM,
            judgePrompt(market, evidence, now),
            outcomes.length,
          ),
        );
      }
    }

    const opinions = (await Promise.all(tasks)).filter(
      (o): o is ModelOpinion => o !== null,
    );

    if (opinions.length === 0) {
      log?.warn("every ensemble model failed", { market: market.id });
      return uniformEstimate(outcomes.length);
    }

    const aggregated = aggregate(opinions, this.options.judgeWeight ?? 2);
    log?.debug("ensemble estimate", {
      market: market.id,
      models: opinions.length,
      confidence: aggregated.confidence,
      cost: opinions.reduce((a, o) => a + o.costUsd, 0),
    });

    return remember(aggregated);
  }

  /**
   * Which model plays the judge.
   *
   * Ideally the market's actual settlement model — it is the one whose ruling
   * decides payout. But that model is usually paid, so unless paid calls are
   * enabled we substitute a free model and keep the judge *prompt*, including
   * the market's own `prompt_context`. Most of the edge here comes from asking
   * the literal-minded "what will the judge rule?" question rather than from
   * the specific weights answering it.
   */
  private resolveJudgeModel(market: Market): string | undefined {
    const override = this.options.judgeModelOverride?.trim();
    if (override) return override;

    const actual = market.metadata?.model?.model_identifier?.trim();
    const fallback = this.options.models[0];

    if (!actual) return fallback;
    if (this.options.allowPaidFallback || isFreeModel(actual)) return actual;

    this.options.logger?.debug("substituting a free model for the paid judge", {
      judge: actual,
      using: fallback,
    });
    return fallback;
  }

  /**
   * Try each model in the chain until one answers.
   * Free tiers rate-limit aggressively, so a single id is a single point of
   * failure; paid entries are skipped entirely unless explicitly allowed.
   */
  private async ask(
    modelSpec: string,
    role: ModelOpinion["role"],
    system: string,
    user: string,
    outcomeCount: number,
    maxTokens?: number,
  ): Promise<ModelOpinion | null> {
    const chain = parseModelChain(modelSpec).filter(
      (m) => this.options.allowPaidFallback || isFreeModel(m) || chainIsAllPaid(modelSpec),
    );
    for (const model of chain) {
      const opinion = await this.askOne(
        model,
        role,
        system,
        user,
        outcomeCount,
        maxTokens,
      );
      if (opinion) return opinion;
      this.options.logger?.debug("falling back to next model in chain", {
        failed: model,
        role,
      });
    }
    return null;
  }

  private async askOne(
    model: string,
    role: ModelOpinion["role"],
    system: string,
    user: string,
    outcomeCount: number,
    maxTokens?: number,
  ): Promise<ModelOpinion | null> {
    try {
      const { value, result } = await this.options.client.completeJson(
        {
          model,
          system,
          user,
          ...(maxTokens ? { maxTokens } : {}),
          // We want a calibrated number and a short justification, not a
          // treatise. On reasoning models the hidden tokens dominate both
          // latency and cost, and more of them does not make the probability
          // better calibrated.
          reasoningEffort: "low",
        },
        (raw) => responseSchema.parse(raw),
      );

      // A model that returns the wrong number of outcomes has misunderstood the
      // question; using it would silently misalign every index downstream.
      if (value.probabilities.length !== outcomeCount) {
        this.options.logger?.warn("model returned wrong outcome count", {
          model,
          expected: outcomeCount,
          got: value.probabilities.length,
        });
        return null;
      }

      return {
        model,
        role,
        probabilities: normalizeProbabilities(value.probabilities),
        selfConfidence: value.confidence,
        reasoning: value.reasoning,
        ...(value.contradictions ? { contradictions: value.contradictions } : {}),
        ...(value.uncertainty ? { uncertainty: value.uncertainty } : {}),
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      this.options.logger?.warn("model call failed", {
        model,
        role,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/**
 * Combine opinions into one distribution plus a confidence.
 *
 * Confidence = agreement x dampened self-report.
 * Agreement is 1 minus the mean pairwise total-variation distance, so models
 * that genuinely disagree drive it toward 0 and the position toward nothing.
 */
export function aggregate(
  opinions: ModelOpinion[],
  judgeWeight = 2,
): MarketEstimate {
  const outcomeCount = opinions[0]!.probabilities.length;

  let totalWeight = 0;
  const summed = new Array<number>(outcomeCount).fill(0);
  for (const o of opinions) {
    const weight = o.role === "judge" ? judgeWeight : 1;
    totalWeight += weight;
    o.probabilities.forEach((p, i) => {
      summed[i] = (summed[i] ?? 0) + p * weight;
    });
  }
  const probabilities = normalizeProbabilities(
    summed.map((s) => s / (totalWeight || 1)),
  );

  const agreement = agreementScore(opinions.map((o) => o.probabilities));
  const meanSelf =
    opinions.reduce((a, o) => a + o.selfConfidence, 0) / opinions.length;
  // Self-report is dampened into [0.5, 1]: it can modulate confidence but not
  // manufacture it, because it is the least trustworthy number we receive.
  const confidence = clamp01(agreement * (0.5 + 0.5 * meanSelf));

  const judge = opinions.find((o) => o.role === "judge");
  const reasoning = [
    judge ? `[judge ${judge.model}] ${judge.reasoning}` : null,
    ...opinions
      .filter((o) => o.role === "analyst")
      .map((o) => `[${o.model}] ${o.reasoning}`),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    probabilities,
    confidence,
    reasoning,
    contradictions: opinions
      .map((o) => o.contradictions)
      .filter(Boolean)
      .join(" | "),
    uncertainty: opinions
      .map((o) => o.uncertainty)
      .filter(Boolean)
      .join(" | "),
    raw: { opinions, agreement, meanSelfConfidence: meanSelf },
  };
}

/**
 * 1 - mean pairwise total-variation distance.
 * A single opinion has nothing to cross-check, so it is capped well below 1.
 */
export function agreementScore(distributions: number[][]): number {
  if (distributions.length <= 1) return 0.6;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < distributions.length; i++) {
    for (let j = i + 1; j < distributions.length; j++) {
      total += totalVariation(distributions[i]!, distributions[j]!);
      pairs++;
    }
  }
  return clamp01(1 - total / Math.max(1, pairs));
}

function totalVariation(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / 2;
}

/** Largest per-outcome disagreement with the market. */
export function maxGap(ours: number[], market: number[]): number {
  if (market.length === 0) return 1; // no market view: always worth a look
  let max = 0;
  for (let i = 0; i < ours.length; i++) {
    const m = market[i];
    if (m === undefined) continue;
    max = Math.max(max, Math.abs((ours[i] ?? 0) - m));
  }
  return max;
}

/** Sum of per-model cost, for run reporting. */
export function totalCost(results: CompletionResult[]): number {
  return results.reduce((a, r) => a + r.costUsd, 0);
}

/**
 * A chain with no free option at all is used as configured. Someone who lists
 * only paid models means it; silently refusing would look like a broken agent
 * rather than a cost control.
 */
function chainIsAllPaid(spec: string): boolean {
  const chain = parseModelChain(spec);
  return chain.length > 0 && chain.every((m) => !isFreeModel(m));
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
