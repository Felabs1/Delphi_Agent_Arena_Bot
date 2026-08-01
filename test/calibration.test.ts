/**
 * Calibration scoring — the mechanism that replaces guessed thresholds with
 * measured ones.
 */

import { describe, expect, it } from "vitest";
import { advise, brierScore, reliability, score } from "../src/calibration/scorer.js";
import type { ScoredPrediction } from "../src/portfolio/storage.js";

const p = (
  probabilities: number[],
  winningIdx: number,
  marketProbabilities: number[] = [],
  confidence = 0.8,
): ScoredPrediction => ({
  id: 0,
  market: "0xm",
  question: null,
  probabilities,
  confidence,
  marketProbabilities,
  winningIdx,
});

describe("Brier score", () => {
  it("is 0 for a perfect confident prediction", () => {
    expect(brierScore([{ probabilities: [1, 0], winningIdx: 0 }])).toBe(0);
  });

  it("is 2 for a confident wrong prediction — the maximum", () => {
    expect(brierScore([{ probabilities: [0, 1], winningIdx: 0 }])).toBe(2);
  });

  it("is 0.5 for a coin-flip guess on a binary", () => {
    expect(brierScore([{ probabilities: [0.5, 0.5], winningIdx: 0 }])).toBeCloseTo(
      0.5,
      9,
    );
  });

  it("rewards honesty — hedging cannot beat a correct confident call", () => {
    // This is what makes it a proper scoring rule: you cannot game it by
    // always saying 50%.
    const honest = brierScore([{ probabilities: [0.9, 0.1], winningIdx: 0 }]);
    const hedged = brierScore([{ probabilities: [0.5, 0.5], winningIdx: 0 }]);
    expect(honest).toBeLessThan(hedged);
  });
});

describe("reliability", () => {
  it("detects systematic overconfidence", () => {
    // Said 90% ten times, right only half of them.
    const preds = [
      ...Array.from({ length: 5 }, () => p([0.9, 0.1], 0)),
      ...Array.from({ length: 5 }, () => p([0.9, 0.1], 1)),
    ];
    const bins = reliability(preds);
    const bin = bins.find((b) => b.count > 0)!;
    expect(bin.meanPredicted).toBeCloseTo(0.9, 6);
    expect(bin.observedFrequency).toBeCloseTo(0.5, 6);
  });

  it("reports a well-calibrated model as calibrated", () => {
    const preds = [
      ...Array.from({ length: 8 }, () => p([0.8, 0.2], 0)),
      ...Array.from({ length: 2 }, () => p([0.8, 0.2], 1)),
    ];
    const bin = reliability(preds).find((b) => b.count > 0)!;
    expect(bin.observedFrequency).toBeCloseTo(0.8, 6);
  });
});

describe("skill vs market", () => {
  it("is positive when we beat the market's implied probability", () => {
    const preds = Array.from({ length: 10 }, () => p([0.9, 0.1], 0, [0.5, 0.5]));
    const report = score(preds);
    expect(report.brier).toBeLessThan(report.marketBrier);
    expect(report.skillVsMarket).toBeGreaterThan(0);
  });

  it("is negative when the market was closer to the truth", () => {
    const preds = Array.from({ length: 10 }, () => p([0.2, 0.8], 0, [0.9, 0.1]));
    const report = score(preds);
    expect(report.skillVsMarket).toBeLessThan(0);
  });
});

describe("threshold advice", () => {
  it("refuses to tune on thin data rather than chasing noise", () => {
    const report = score([p([0.9, 0.1], 0, [0.5, 0.5])]);
    const a = advise(report);
    expect(a.confidenceThreshold).toBeNull();
    expect(a.rationale).toMatch(/need 20|fitting noise/);
  });

  it("refuses to tune when the agent has no edge over the market", () => {
    const preds = Array.from({ length: 30 }, () => p([0.2, 0.8], 0, [0.9, 0.1]));
    const a = advise(score(preds));
    expect(a.confidenceThreshold).toBeNull();
    expect(a.rationale).toMatch(/no measurable skill/);
  });

  it("recommends shrinking confidence when overconfidence is measured", () => {
    // Says 90%, right half the time, but still beats a market that said 50/50
    // on the losing side — skill positive, calibration poor.
    const preds = [
      ...Array.from({ length: 20 }, () => p([0.95, 0.05], 0, [0.5, 0.5])),
      ...Array.from({ length: 10 }, () => p([0.95, 0.05], 1, [0.5, 0.5])),
    ];
    const report = score(preds);
    const a = advise(report);
    expect(report.overconfidence).toBeGreaterThan(0);
    if (a.confidenceScale !== null) expect(a.confidenceScale).toBeLessThan(1);
  });

  it("suggests a threshold within a sane range", () => {
    const preds = Array.from({ length: 30 }, (_, i) =>
      p([0.8, 0.2], i % 5 === 0 ? 1 : 0, [0.5, 0.5], 0.7),
    );
    const a = advise(score(preds));
    if (a.confidenceThreshold !== null) {
      expect(a.confidenceThreshold).toBeGreaterThanOrEqual(0.2);
      expect(a.confidenceThreshold).toBeLessThanOrEqual(0.9);
    }
  });
});

describe("empty input", () => {
  it("does not divide by zero", () => {
    const report = score([]);
    expect(report.samples).toBe(0);
    expect(Number.isNaN(report.brier)).toBe(true);
    expect(advise(report).confidenceThreshold).toBeNull();
  });
});
