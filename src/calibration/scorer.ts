/**
 * Calibration scoring.
 *
 * The thresholds this agent trades on — `CONFIDENCE_THRESHOLD`, `MINIMUM_EDGE`
 * — started as guesses copied from a README. This module replaces them with
 * measurements, by scoring what the agent believed against what actually
 * settled.
 *
 * Two things get measured:
 *
 *   BRIER SCORE — mean squared error of the probability vector against the
 *   one-hot outcome. Lower is better. It is a *proper* scoring rule: it is
 *   minimised only by reporting your true credence, so it cannot be gamed by
 *   hedging toward 0.5.
 *
 *   RELIABILITY — of the times we said 70%, how often were we right? A model
 *   can have a decent Brier score and still be systematically overconfident;
 *   the reliability curve is what exposes that, and overconfidence is precisely
 *   what destroys a Kelly-sized bankroll.
 *
 * The comparison that matters is against the market, not against zero. Beating
 * the market's implied probability is the only thing that makes an edge real.
 */

import type { ScoredPrediction } from "../portfolio/storage.js";

export interface ReliabilityBin {
  /** Lower edge of the predicted-probability bucket, e.g. 0.7 for 70–80%. */
  lower: number;
  upper: number;
  count: number;
  /** Mean probability we assigned inside this bucket. */
  meanPredicted: number;
  /** Fraction that actually happened. */
  observedFrequency: number;
}

export interface CalibrationReport {
  samples: number;
  /** Our Brier score. Lower is better; 0 is perfect. */
  brier: number;
  /** The market's Brier score over the same events. */
  marketBrier: number;
  /**
   * `marketBrier - brier`. Positive means we beat the market — the only
   * evidence that the agent has any edge at all.
   */
  skillVsMarket: number;
  /**
   * Mean(predicted) - mean(observed) over the outcomes we called most likely.
   * Positive means overconfident, which is the dangerous direction.
   */
  overconfidence: number;
  reliability: ReliabilityBin[];
  /** Mean confidence the ensemble reported on scored markets. */
  meanConfidence: number;
}

/** Multi-class Brier: mean over outcomes of (p - actual)^2, averaged over events. */
export function brierScore(
  predictions: { probabilities: number[]; winningIdx: number }[],
): number {
  if (predictions.length === 0) return NaN;
  let total = 0;
  for (const p of predictions) {
    let sum = 0;
    for (let i = 0; i < p.probabilities.length; i++) {
      const actual = i === p.winningIdx ? 1 : 0;
      sum += ((p.probabilities[i] ?? 0) - actual) ** 2;
    }
    total += sum;
  }
  return total / predictions.length;
}

/**
 * Bucket predictions by the probability assigned to the outcome we thought
 * most likely, and compare with how often it actually happened.
 */
export function reliability(
  predictions: ScoredPrediction[],
  bins = 5,
): ReliabilityBin[] {
  const buckets: { predicted: number[]; hits: number[] }[] = Array.from(
    { length: bins },
    () => ({ predicted: [], hits: [] }),
  );

  for (const p of predictions) {
    let bestIdx = 0;
    let best = -1;
    p.probabilities.forEach((v, i) => {
      if (v > best) {
        best = v;
        bestIdx = i;
      }
    });
    if (best < 0) continue;
    const idx = Math.min(bins - 1, Math.floor(best * bins));
    buckets[idx]!.predicted.push(best);
    buckets[idx]!.hits.push(bestIdx === p.winningIdx ? 1 : 0);
  }

  return buckets.map((b, i) => ({
    lower: i / bins,
    upper: (i + 1) / bins,
    count: b.predicted.length,
    meanPredicted:
      b.predicted.length > 0
        ? b.predicted.reduce((a, x) => a + x, 0) / b.predicted.length
        : 0,
    observedFrequency:
      b.hits.length > 0 ? b.hits.reduce((a, x) => a + x, 0) / b.hits.length : 0,
  }));
}

export function score(predictions: ScoredPrediction[]): CalibrationReport {
  const usable = predictions.filter((p) => p.probabilities.length > 0);
  const withMarket = usable.filter(
    (p) => p.marketProbabilities.length === p.probabilities.length,
  );

  const bins = reliability(usable);
  const populated = bins.filter((b) => b.count > 0);
  const overconfidence =
    populated.length > 0
      ? populated.reduce(
          (a, b) => a + (b.meanPredicted - b.observedFrequency) * b.count,
          0,
        ) / populated.reduce((a, b) => a + b.count, 0)
      : 0;

  const ourBrier = brierScore(usable);
  const marketBrier = brierScore(
    withMarket.map((p) => ({
      probabilities: p.marketProbabilities,
      winningIdx: p.winningIdx,
    })),
  );

  return {
    samples: usable.length,
    brier: ourBrier,
    marketBrier,
    skillVsMarket: Number.isNaN(marketBrier) ? NaN : marketBrier - ourBrier,
    overconfidence,
    reliability: bins,
    meanConfidence:
      usable.length > 0
        ? usable.reduce((a, p) => a + p.confidence, 0) / usable.length
        : 0,
  };
}

export interface ThresholdAdvice {
  /** Suggested CONFIDENCE_THRESHOLD, or null if there is not enough data. */
  confidenceThreshold: number | null;
  /** Suggested shrinkage multiplier to correct measured overconfidence. */
  confidenceScale: number | null;
  rationale: string;
}

/**
 * Turn a calibration report into threshold advice.
 *
 * Deliberately conservative and explicitly refuses to advise on thin data:
 * re-tuning a live trading agent from a handful of samples is how you chase
 * noise into a drawdown.
 */
export function advise(
  report: CalibrationReport,
  minimumSamples = 20,
): ThresholdAdvice {
  if (report.samples < minimumSamples) {
    return {
      confidenceThreshold: null,
      confidenceScale: null,
      rationale:
        `only ${report.samples} scored predictions — need ${minimumSamples} ` +
        `before tuning on them. Anything sooner is fitting noise.`,
    };
  }

  if (!Number.isNaN(report.skillVsMarket) && report.skillVsMarket <= 0) {
    return {
      confidenceThreshold: null,
      confidenceScale: null,
      rationale:
        `no measurable skill: our Brier ${report.brier.toFixed(4)} vs market ` +
        `${report.marketBrier.toFixed(4)}. The agent is not beating the price it ` +
        `pays to trade against — raise thresholds or stop trading, do not tune.`,
    };
  }

  // Overconfidence directly inflates Kelly sizing, so correct it at the source
  // by scaling reported confidence rather than by nudging the threshold.
  const scale =
    report.overconfidence > 0.02
      ? Math.max(0.3, 1 - report.overconfidence * 2)
      : 1;

  // Aim the threshold just under the mean confidence actually observed, so the
  // gate admits the better half of estimates rather than everything or nothing.
  const suggested = Math.max(0.2, Math.min(0.9, report.meanConfidence * 0.9));

  return {
    confidenceThreshold: Number(suggested.toFixed(2)),
    confidenceScale: Number(scale.toFixed(2)),
    rationale:
      `${report.samples} samples · Brier ${report.brier.toFixed(4)} vs market ` +
      `${report.marketBrier.toFixed(4)} (skill ${report.skillVsMarket >= 0 ? "+" : ""}` +
      `${report.skillVsMarket.toFixed(4)}) · overconfidence ` +
      `${(report.overconfidence * 100).toFixed(1)}%`,
  };
}
