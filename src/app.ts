/**
 * Entrypoint. Runs exactly one pass and exits — safe for Render Cron.
 *
 *   npx tsx src/app.ts --fake --dry-run     # offline simulator, no network
 *   npx tsx src/app.ts --dry-run            # live reads, real EV, no writes
 *   npx tsx src/app.ts --max-trades 1       # live, one trade
 *
 * Stage 1 ships `--fake` only; the live adapter arrives in Stage 2 and this
 * file will fail loudly rather than pretend to trade until it does.
 */

import { randomUUID } from "node:crypto";
import { assertLiveReady, loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./utils/logger.js";
import { present } from "./utils/present.js";
import { runOnce, type RunReport, type TraderConfig } from "./agent/trader.js";
import { MemoryJournal } from "./agent/executor.js";
import { StaticEstimator, type MarketEstimate } from "./ai/estimator.js";
import { OpenRouterClient } from "./ai/llm.js";
import { EnsembleEstimator } from "./ai/ensemble.js";
import { MemoryEstimateCache } from "./ai/cache.js";
import { FakeDelphi } from "./sdk/fake.js";
import { LiveDelphi } from "./sdk/delphi.js";
import type { DelphiPort } from "./sdk/port.js";
import type { ProbabilityEstimator } from "./ai/estimator.js";

interface Flags {
  fake: boolean;
  dryRun: boolean;
  liveAi: boolean;
  maxTrades?: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    fake: argv.includes("--fake"),
    dryRun: argv.includes("--dry-run"),
    liveAi: argv.includes("--live-ai"),
  };
  const i = argv.indexOf("--max-trades");
  if (i !== -1 && argv[i + 1]) flags.maxTrades = Number(argv[i + 1]);
  return flags;
}

function toTraderConfig(
  config: Config,
  flags: Flags,
  runId: string,
): TraderConfig {
  const payoutModel = {
    creatorHaircut: config.PAYOUT_CREATOR_HAIRCUT,
    feeToPoolFraction: 1,
  };
  return {
    runId,
    marketLimit: config.MARKET_LIMIT,
    maxTradesPerRun: flags.maxTrades ?? config.MAX_TRADES_PER_RUN,
    evaluationConcurrency: config.EVALUATION_CONCURRENCY,
    dryRun: flags.dryRun,
    sizing: {
      maxPositionFraction: config.MAX_POSITION_SIZE,
      kellyFraction: config.KELLY_FRACTION,
      maxShareOfMarket: config.MAX_SHARE_OF_MARKET,
      minimumEdge: config.MINIMUM_EDGE,
      minimumEvPerToken: config.MINIMUM_EV_PER_TOKEN,
      confidenceThreshold: config.CONFIDENCE_THRESHOLD,
      payoutModel,
      failureProbability: config.ASSUMED_FAILURE_PROBABILITY,
    },
    risk: {
      maxExposurePerMarket: config.MAX_EXPOSURE_PER_MARKET,
      maxExposurePerCorrelatedGroup: config.MAX_EXPOSURE_PER_CORRELATED_GROUP,
      maxTotalExposure: config.MAX_TOTAL_EXPOSURE,
      maxDailyTrades: config.MAX_DAILY_TRADES,
      maxDrawdown: config.MAX_DRAWDOWN,
      requireVerifiable: config.REQUIRE_VERIFIABLE,
      minHoursToSettlement: config.MIN_HOURS_TO_SETTLEMENT,
      ...(config.tradingWindowEnd
        ? { tradingWindowEnd: config.tradingWindowEnd }
        : {}),
    },
    executor: {
      slippageTolerance: config.SLIPPAGE_TOLERANCE,
      maxRequoteDrift: config.MAX_REQUOTE_DRIFT,
      minimumEvPerToken: config.MINIMUM_EV_PER_TOKEN,
      payoutModel,
      failureProbability: config.ASSUMED_FAILURE_PROBABILITY,
    },
  };
}

/**
 * A small offline market set that exercises the decision path: one badly
 * mispriced market, one fair market, and one that settles too late.
 */
function demoPort(): { port: DelphiPort; estimator: ProbabilityEstimator } {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const late = new Date(Date.now() + 200 * 86_400_000).toISOString();
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const C = "0x00000000000000000000000000000000000000c3";

  const port = new FakeDelphi(
    [
      {
        id: A,
        question: "Will BTC close above $150,000 before September?",
        outcomes: ["Yes", "No"],
        supplies: [200, 800],
        settlesAt: soon,
        category: "crypto",
        tradingFee: 0.02,
        judgeModel: "anthropic/claude-opus-4.1",
      },
      {
        id: B,
        question: "Will the ECB cut rates at the next meeting?",
        outcomes: ["Yes", "No"],
        supplies: [500, 500],
        settlesAt: soon,
        category: "economics",
        tradingFee: 0.02,
      },
      {
        id: C,
        question: "Will a human land on Mars this decade?",
        outcomes: ["Yes", "No"],
        supplies: [100, 900],
        settlesAt: late,
        category: "miscellaneous",
      },
    ],
    1_000,
  );

  const fair: MarketEstimate = {
    probabilities: [0.5, 0.5],
    confidence: 0.9,
    reasoning: "no disagreement with the market",
  };
  const mispriced: MarketEstimate = {
    probabilities: [0.42, 0.58],
    confidence: 0.9,
    reasoning: "demo: market underprices Yes",
  };

  return {
    port,
    estimator: new StaticEstimator(
      new Map([
        [A, mispriced],
        [B, fair],
      ]),
    ),
  };
}

/**
 * Human-readable summary. The structured logger still carries the machine view
 * (`LOG_FORMAT=json`); this is the bit a person reads to decide whether the
 * agent is about to do something sensible.
 */
async function report(
  log: Logger,
  r: RunReport,
  flags: Flags,
  port: DelphiPort,
): Promise<void> {
  // Positions carry only an address, so look up the questions they refer to.
  const questions = new Map<string, string>();
  for (const p of r.positionsHeld) {
    const key = p.marketAddress.toLowerCase();
    if (questions.has(key)) continue;
    try {
      const market = await port.getMarket(p.marketAddress);
      questions.set(key, market.metadata?.question ?? p.marketAddress);
    } catch {
      questions.set(key, p.marketAddress);
    }
  }

  if (process.env.LOG_FORMAT === "json") {
    log.info("run summary", {
      markets: r.marketsFetched,
      evaluated: r.marketsEvaluated,
      candidates: r.candidates.length,
      executed: r.executions.filter((e) => e.result.status === "executed").length,
      skips: r.skips.length,
      bankroll: r.bankrollUsdc,
      halted: r.halted ?? null,
    });
    return;
  }

  console.log(present(r, { dryRun: flags.dryRun, questions }));

  // Skip reasons stay behind --verbose / debug: useful, but noisy by default.
  for (const skip of r.skips) {
    log.debug(`skip: ${skip.question}`, {
      outcome: skip.outcomeIdx ?? "-",
      reason: skip.reason,
    });
  }
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig();
  const runId = randomUUID();
  const log = createLogger(config.LOG_LEVEL, { runId });

  if (config.KILL_SWITCH) {
    log.warn("KILL_SWITCH is set — doing nothing");
    return 0;
  }

  let port: DelphiPort;
  let estimator: ProbabilityEstimator;

  if (flags.fake) {
    const demo = demoPort();
    port = demo.port;
    estimator = demo.estimator;
  } else {
    if (!config.DELPHI_API_ACCESS_KEY) {
      log.error(
        "live mode needs DELPHI_API_ACCESS_KEY (https://delphi-api-access.gensyn.ai/). " +
          "Use --fake for the offline simulator.",
      );
      return 2;
    }
    // A wallet is only required to actually send a transaction.
    if (!flags.dryRun) assertLiveReady(config);

    const live = new LiveDelphi({
      network: config.DELPHI_NETWORK,
      apiKey: config.DELPHI_API_ACCESS_KEY,
      ...(config.WALLET_PRIVATE_KEY
        ? { privateKey: config.WALLET_PRIVATE_KEY as `0x${string}` }
        : {}),
      ...(config.WATCH_WALLET
        ? { watchWallet: config.WATCH_WALLET as `0x${string}` }
        : {}),
      paperBankrollUsdc: config.PAPER_BANKROLL_USDC,
      ...(config.GENSYN_RPC_URL ? { rpcUrl: config.GENSYN_RPC_URL } : {}),
      ...(config.DELPHI_API_BASE_URL ? { apiBaseUrl: config.DELPHI_API_BASE_URL } : {}),
    });
    port = live;
    estimator = new StaticEstimator(new Map());

    if (!live.canTrade) {
      log.warn(
        "no WALLET_PRIVATE_KEY — running read-only against a paper bankroll",
        { paperBankrollUsdc: config.PAPER_BANKROLL_USDC },
      );
    }
  }

  log.info(
    `${flags.fake ? "SIMULATED" : config.DELPHI_NETWORK} · ` +
      `${flags.dryRun ? "dry run (nothing will be signed)" : "LIVE — trades will be sent"} · ` +
      `analysing up to ${config.MARKET_LIMIT} markets`,
  );
  log.debug("thresholds", {
    minimumEdge: config.MINIMUM_EDGE,
    confidenceThreshold: config.CONFIDENCE_THRESHOLD,
    minimumEvPerToken: config.MINIMUM_EV_PER_TOKEN,
    maxShareOfMarket: config.MAX_SHARE_OF_MARKET,
  });

  let client: OpenRouterClient | undefined;

  if (flags.liveAi) {
    if (!config.OPENROUTER_API_KEY) {
      log.error("--live-ai needs OPENROUTER_API_KEY in .env");
      return 2;
    }
    client = new OpenRouterClient({
      apiKey: config.OPENROUTER_API_KEY,
      timeoutMs: config.LLM_TIMEOUT_MS,
      maxRetries: config.LLM_MAX_RETRIES,
      maxCostUsd: config.LLM_MAX_COST_PER_RUN_USD,
      title: "delphi-agent-arena-bot",
    });
    estimator = new EnsembleEstimator({
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
    log.info(
      `AI: ${config.ensembleModels.length} models + judge replica` +
        `${config.ALLOW_PAID_FALLBACK ? "" : " (free tier)"}`,
    );
    log.debug("ensemble configuration", {
      triage: config.TRIAGE_MODEL,
      models: config.ensembleModels.join(","),
      paidAllowed: config.ALLOW_PAID_FALLBACK,
      budget: config.LLM_MAX_COST_PER_RUN_USD,
    });
  }

  const result = await runOnce(
    port,
    estimator,
    new MemoryJournal(),
    toTraderConfig(config, flags, runId),
  );

  await report(log, result, flags, port);
  if (client) {
    log.info(
      `AI cost: $${client.spent.toFixed(4)} across ${client.calls} model calls`,
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    createLogger("error").error("fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
