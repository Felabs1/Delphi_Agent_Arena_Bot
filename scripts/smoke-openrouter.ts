/**
 * Live smoke test for the AI layer. Makes REAL OpenRouter calls and spends real
 * money — the budget ceiling is set low deliberately.
 *
 *   npx tsx scripts/smoke-openrouter.ts
 *
 * Verifies: credentials, model ids, JSON parsing across providers, triage
 * escalation, judge replication, disagreement-based confidence, and cost
 * accounting.
 */

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/utils/logger.js";
import { OpenRouterClient } from "../src/ai/llm.js";
import { EnsembleEstimator } from "../src/ai/ensemble.js";
import { MemoryEstimateCache } from "../src/ai/cache.js";
import { FakeDelphi } from "../src/sdk/fake.js";
import { impliedProbabilities } from "../src/agent/dpm.js";
import type { ModelOpinion } from "../src/ai/ensemble.js";

const config = loadConfig();
const log = createLogger("info");

if (!config.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set (put it in .env, not .env.example)");
  process.exit(1);
}

const MARKET_ID = "0x00000000000000000000000000000000000000a1";

// A market whose price is well away from any reasonable estimate, so triage
// escalates and we exercise the full path.
const port = new FakeDelphi([
  {
    id: MARKET_ID,
    question:
      "Will Bitcoin trade above $250,000 on any major exchange before 31 December 2026?",
    outcomes: ["Yes", "No"],
    supplies: [700, 300], // market implies ~84% Yes — aggressive
    settlesAt: "2026-12-31T23:59:59Z",
    category: "crypto",
    judgeModel: config.ensembleModels[0] ?? "anthropic/claude-opus-5",
    promptContext:
      "Resolve YES only if a spot price above 250000 USD is printed on Coinbase, " +
      "Binance or Kraken before 2026-12-31T23:59:59Z. Otherwise resolve NO.",
  },
]);

const market = await port.getMarket(MARKET_ID, true);
const state = await port.getDpmState(MARKET_ID as `0x${string}`);

console.log("\n=== MARKET ===");
console.log(market.metadata?.question);
console.log(
  "market implied:",
  impliedProbabilities(state.supplies)
    .map((p, i) => `${market.metadata?.outcomes[i]} ${(p * 100).toFixed(1)}%`)
    .join("  |  "),
);
console.log("settlement judge:", market.metadata?.model?.model_identifier);

const client = new OpenRouterClient({
  apiKey: config.OPENROUTER_API_KEY,
  timeoutMs: config.LLM_TIMEOUT_MS,
  maxRetries: config.LLM_MAX_RETRIES,
  maxCostUsd: 0.25, // hard cap for a smoke test
  title: "delphi-agent-arena-bot",
});

const estimator = new EnsembleEstimator({
  client,
  models: config.ensembleModels,
  triageModel: config.TRIAGE_MODEL,
  replicateJudge: config.REPLICATE_JUDGE,
  allowPaidFallback: config.ALLOW_PAID_FALLBACK,
  ...(config.JUDGE_MODEL ? { judgeModelOverride: config.JUDGE_MODEL } : {}),
  triageGapThreshold: config.TRIAGE_GAP_THRESHOLD,
  cache: new MemoryEstimateCache(),
  freshness: {
    ttlMinutes: config.ESTIMATE_TTL_MINUTES,
    invalidateOnMove: config.ESTIMATE_INVALIDATE_ON_MOVE,
  },
  logger: log,
});

console.log("\n=== MODELS ===");
console.log("triage  :", config.TRIAGE_MODEL);
console.log("ensemble:", config.ensembleModels.join(", "));
console.log("paid allowed:", config.ALLOW_PAID_FALLBACK);

const startedAt = Date.now();
const estimate = await estimator.estimate(market, {
  summary:
    "As of August 2026, Bitcoin has been trading in the 90,000-130,000 range for " +
    "several months. No sustained move above 200,000 has occurred.",
  sources: ["smoke-test-fixture"],
});
const elapsed = Date.now() - startedAt;

console.log("\n=== RESULT ===");
estimate.probabilities.forEach((p, i) => {
  const label = market.metadata?.outcomes[i] ?? `#${i}`;
  const mkt = market.spotImpliedProbabilities?.[i] ?? 0;
  const edge = p - mkt;
  console.log(
    `  ${label.padEnd(4)} ours ${(p * 100).toFixed(1).padStart(5)}%   ` +
      `market ${(mkt * 100).toFixed(1).padStart(5)}%   ` +
      `naive edge ${(edge >= 0 ? "+" : "") + (edge * 100).toFixed(1)}%`,
  );
});
console.log(`  confidence: ${(estimate.confidence * 100).toFixed(1)}%`);

const raw = estimate.raw as
  | { opinions?: ModelOpinion[]; agreement?: number; meanSelfConfidence?: number }
  | undefined;

if (raw?.opinions) {
  console.log("\n=== PER MODEL ===");
  for (const o of raw.opinions) {
    console.log(
      `  [${o.role.padEnd(7)}] ${o.model.padEnd(30)} ` +
        `${o.probabilities.map((p) => (p * 100).toFixed(1) + "%").join(" / ")}  ` +
        `self-conf ${(o.selfConfidence * 100).toFixed(0)}%  ` +
        `$${o.costUsd.toFixed(5)}  ${o.latencyMs}ms`,
    );
    console.log(`             ${o.reasoning.slice(0, 160)}`);
  }
  console.log(`\n  agreement: ${((raw.agreement ?? 0) * 100).toFixed(1)}%`);
  console.log(
    `  mean self-reported confidence: ${((raw.meanSelfConfidence ?? 0) * 100).toFixed(1)}%`,
  );
}

console.log("\n=== COST ===");
console.log(`  calls: ${client.calls}`);
console.log(`  spent: $${client.spent.toFixed(5)}`);
console.log(`  wall clock: ${(elapsed / 1000).toFixed(1)}s`);

// Cache behaviour: a repeat must not spend anything.
const before = client.calls;
await estimator.estimate(market, { summary: "", sources: [] });
console.log(
  `  cache re-run made ${client.calls - before} additional call(s) (expected 0)`,
);
