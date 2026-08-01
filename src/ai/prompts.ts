/**
 * Prompts.
 *
 * Two distinct jobs, and conflating them is a mistake:
 *
 *   1. ANALYST — "what is the probability this outcome occurs?"
 *   2. JUDGE REPLICA — "what will the model that settles this market rule?"
 *
 * On Delphi the second is the one that pays. Every market names its settlement
 * model in `metadata.model.model_identifier` and its instructions in
 * `prompt_context`. Payout follows that model's ruling, not the truth. When the
 * two diverge — an ambiguous question, a strict resolution criterion, a judge
 * that will answer "No" for lack of evidence — the judge wins, every time.
 *
 * Deliberately absent: any request for a trade recommendation. The model
 * estimates; the EV engine decides. Letting a confident paragraph reach the
 * sizing logic is how an agent talks itself into a bad position.
 */

import type { Market } from "../sdk/port.js";
import type { Evidence } from "./estimator.js";

export const ANALYST_SYSTEM = `You are a superforecaster estimating probabilities for prediction markets.

Rules:
- Output ONLY a JSON object. No prose, no code fences.
- Probabilities are your genuine credences and MUST sum to 1.0 across outcomes.
- Base rates first, then update on specific evidence. Do not anchor on the market price.
- If the evidence is thin, say so and stay near the base rate. A wide, honest
  estimate is worth more than a confident wrong one.
- "confidence" measures how much better than the base rate your information is:
  0.0 = no information beyond the base rate, 1.0 = near-certain from hard evidence.
  Do not inflate it. It is used to shrink your estimate toward the market.`;

export const JUDGE_SYSTEM = `You are predicting how an automated AI settlement judge will resolve a prediction market.

You are NOT being asked what is true. You are being asked what the judge will rule.
These differ more often than people expect:
- Judges follow the resolution criteria literally, not charitably.
- A judge with insufficient evidence usually resolves to the negative or default outcome.
- Ambiguous wording resolves on the wording, not on intent.
- The judge sees only its prompt context and the sources available to it.

Output ONLY a JSON object. No prose, no code fences.`;

const OUTPUT_CONTRACT = `Respond with exactly this JSON shape:
{
  "probabilities": [<one number per outcome, in the SAME order as listed, summing to 1.0>],
  "confidence": <0..1>,
  "reasoning": "<2-4 sentences on the decisive considerations>",
  "contradictions": "<the strongest evidence against your view>",
  "uncertainty": "<what evidence would most change your estimate>"
}`;

function marketBlock(market: Market): string {
  const meta = market.metadata;
  const outcomes = (meta?.outcomes ?? [])
    .map((o, i) => `  [${i}] ${o}`)
    .join("\n");

  const lines = [
    `QUESTION: ${meta?.question ?? "(unknown)"}`,
    `CATEGORY: ${market.category ?? "unknown"}`,
    `OUTCOMES:\n${outcomes}`,
  ];

  if (market.settlesAt) lines.push(`SETTLES AT: ${market.settlesAt}`);
  if (market.resolvesAt) lines.push(`RESOLVES AT: ${market.resolvesAt}`);
  const criteria = meta?.["resolutionCriteria"] ?? meta?.["resolution_criteria"];
  if (typeof criteria === "string" && criteria.trim()) {
    lines.push(`RESOLUTION CRITERIA: ${criteria}`);
  }
  const description = meta?.["description"];
  if (typeof description === "string" && description.trim()) {
    lines.push(`DESCRIPTION: ${description}`);
  }
  return lines.join("\n");
}

function evidenceBlock(evidence: Evidence, now: Date): string {
  if (!evidence.summary.trim()) {
    return `EVIDENCE: none gathered. Rely on base rates and your own knowledge, and lower your confidence accordingly.`;
  }
  return [
    `CURRENT DATE: ${now.toISOString()}`,
    `EVIDENCE:`,
    evidence.summary,
    evidence.sources.length ? `SOURCES: ${evidence.sources.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cheap first-pass screen. Terse on purpose — it runs over every market. */
export function triagePrompt(market: Market, now: Date): string {
  const outcomes = (market.metadata?.outcomes ?? [])
    .map((o, i) => `[${i}] ${o}`)
    .join(", ");
  return `Estimate outcome probabilities for this prediction market using base rates and your own knowledge.

QUESTION: ${market.metadata?.question ?? "(unknown)"}
OUTCOMES: ${outcomes}
SETTLES: ${market.settlesAt ?? "unknown"}
TODAY: ${now.toISOString().slice(0, 10)}

${OUTPUT_CONTRACT}

Keep "reasoning" to one sentence.`;
}

/** Full analyst pass, with gathered evidence. */
export function analystPrompt(
  market: Market,
  evidence: Evidence,
  now: Date,
): string {
  return `${marketBlock(market)}

${evidenceBlock(evidence, now)}

${OUTPUT_CONTRACT}`;
}

/**
 * Judge-replication pass.
 *
 * Feeds the market's own `prompt_context` back to the model that will settle it
 * (or the closest available), and asks it to predict its own ruling.
 */
export function judgePrompt(
  market: Market,
  evidence: Evidence,
  now: Date,
): string {
  const model = market.metadata?.model;
  const judgeLines = [
    model?.model_identifier
      ? `The settlement judge for this market is: ${model.model_identifier}`
      : `The settlement judge for this market is an automated AI model.`,
  ];
  if (model?.prompt_context?.trim()) {
    judgeLines.push(
      `The judge will be given exactly this context when it settles:\n---\n${model.prompt_context}\n---`,
    );
  }

  return `${judgeLines.join("\n")}

${marketBlock(market)}

${evidenceBlock(evidence, now)}

Predict the probability the judge assigns to each outcome when it settles this market.
Weigh how a literal-minded automated judge reads the resolution criteria, and what
it will do if the evidence available to it is incomplete.

${OUTPUT_CONTRACT}`;
}
