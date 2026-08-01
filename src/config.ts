/**
 * Configuration: parsed once, validated, then immutable.
 *
 * Fails fast and loudly. A cron job that starts with a malformed threshold and
 * trades anyway is worse than one that refuses to start.
 *
 * The README's defaults (MINIMUM_EDGE=0.12, CONFIDENCE_THRESHOLD=0.75) are
 * carried over as starting points, but note they are *placeholders*: MINIMUM_EDGE
 * here gates `realEdge` (probability minus breakeven), which is a stricter and
 * differently-scaled quantity than the naive edge those numbers were guessed
 * against. Stage 8 re-tunes both from measured calibration.
 */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const fraction = (name: string) =>
  z.coerce
    .number()
    .min(0, `${name} must be >= 0`)
    .max(1, `${name} must be <= 1`);

/**
 * Environment booleans.
 *
 * NOT `z.coerce.boolean()` — that is `Boolean(value)`, so the string "false"
 * coerces to `true`. With that, `KILL_SWITCH=false` would silently disable the
 * agent and `REQUIRE_VERIFIABLE=false` would quietly filter out most markets.
 */
const envBool = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no", "on", "off", ""])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v === "yes" || v === "on");

/**
 * Optional string that treats blank as absent.
 *
 * `.env.example` ships every optional key with an empty value, so a plain
 * `.optional()` would reject a freshly-copied `.env` — "" is present, just
 * empty. Blank must mean unset, or you cannot run offline without deleting
 * lines from your config.
 */
const optionalString = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    inner.optional(),
  );

const schema = z.object({
  // --- Delphi / chain -------------------------------------------------
  DELPHI_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  DELPHI_API_ACCESS_KEY: optionalString(z.string().min(1)),
  DELPHI_SIGNER_TYPE: z.enum(["private_key", "cdp_server_wallet"]).default("private_key"),
  WALLET_PRIVATE_KEY: optionalString(
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "WALLET_PRIVATE_KEY must be 0x + 64 hex chars"),
  ),
  GENSYN_RPC_URL: optionalString(z.string().url()),
  DELPHI_API_BASE_URL: optionalString(z.string().url()),

  // --- AI --------------------------------------------------------------
  //
  // Cost is a first-class constraint. A 3-model ensemble over 50 markets costs
  // ~$2/run; on a 5-minute cron that is ~$600/day, which would dwarf anything
  // the agent can win. So: a cheap model triages every market, and only the
  // finalists reach the expensive ensemble. Estimates are then cached, because
  // a market's fundamentals do not change every five minutes.
  // Defaults are OpenRouter's zero-cost `:free` tier, verified to return valid
  // JSON for this task. Free tiers rate-limit, so each slot is a `|`-separated
  // fallback chain tried in order.
  OPENROUTER_API_KEY: optionalString(z.string().min(1)),
  /** Cheap model that screens every market. Supports `a|b` fallback chains. */
  TRIAGE_MODEL: z
    .string()
    .default("poolside/laguna-s-2.1:free|openai/gpt-oss-20b:free|openrouter/free"),
  /** Comma-separated ensemble slots; each may be a `|` fallback chain. */
  ENSEMBLE_MODELS: z
    .string()
    .default(
      "nvidia/nemotron-3-ultra-550b-a55b:free|openrouter/free," +
        "openai/gpt-oss-20b:free|google/gemma-4-26b-a4b-it:free," +
        "poolside/laguna-s-2.1:free|openrouter/free",
    ),
  /**
   * Permit models that cost money. Off by default — inference on a cron can
   * outspend the winnings. Turn on for maximum accuracy when it matters.
   */
  ALLOW_PAID_FALLBACK: envBool(false),
  /** Force the judge-replication model, overriding the market's metadata. */
  JUDGE_MODEL: optionalString(z.string().min(1)),
  /** Also query the market's own settlement judge, from its metadata. */
  REPLICATE_JUDGE: envBool(true),
  /** Triage must disagree with the market by at least this to escalate. */
  TRIAGE_GAP_THRESHOLD: fraction("TRIAGE_GAP_THRESHOLD").default(0.1),
  /** Reuse a cached estimate for this long. */
  ESTIMATE_TTL_MINUTES: z.coerce.number().min(0).default(60),
  /** Re-estimate early if implied probability moved more than this since caching. */
  ESTIMATE_INVALIDATE_ON_MOVE: fraction("ESTIMATE_INVALIDATE_ON_MOVE").default(0.05),
  /** Hard ceiling on LLM spend per run, USD. Calls stop once exceeded. */
  LLM_MAX_COST_PER_RUN_USD: z.coerce.number().min(0).default(0.5),
  /**
   * Free-tier models are markedly slower than paid ones (a 550B free model
   * measured at ~72s). Ensemble calls run in parallel, so this bounds the
   * slowest model, not their sum.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),

  // --- Data collection --------------------------------------------------
  /** Optional. Without it the news source is skipped, not fatal. */
  NEWS_API_KEY: optionalString(z.string().min(1)),
  /** Turn evidence gathering off entirely (LLM answers from training data). */
  ENABLE_EVIDENCE: envBool(true),
  EVIDENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  EVIDENCE_CACHE_MINUTES: z.coerce.number().min(0).default(10),

  // --- Decision thresholds ---------------------------------------------
  CONFIDENCE_THRESHOLD: fraction("CONFIDENCE_THRESHOLD").default(0.75),
  /**
   * Multiplier applied to reported confidence before sizing. Set below 1 to
   * correct measured overconfidence — `npm run calibrate` recommends a value.
   */
  CONFIDENCE_SCALE: fraction("CONFIDENCE_SCALE").default(1),
  /** Minimum `realEdge` — probability minus breakeven probability. */
  MINIMUM_EDGE: fraction("MINIMUM_EDGE").default(0.08),
  /** Minimum expected profit per USDC staked. */
  MINIMUM_EV_PER_TOKEN: fraction("MINIMUM_EV_PER_TOKEN").default(0.05),

  // --- Sizing -----------------------------------------------------------
  MAX_POSITION_SIZE: fraction("MAX_POSITION_SIZE").default(0.05),
  KELLY_FRACTION: fraction("KELLY_FRACTION").default(0.35),
  /** Refuse to become more than this fraction of a market's redeemable supply. */
  MAX_SHARE_OF_MARKET: fraction("MAX_SHARE_OF_MARKET").default(0.25),

  // --- Risk -------------------------------------------------------------
  MAX_EXPOSURE_PER_MARKET: fraction("MAX_EXPOSURE_PER_MARKET").default(0.1),
  MAX_EXPOSURE_PER_CORRELATED_GROUP: fraction(
    "MAX_EXPOSURE_PER_CORRELATED_GROUP",
  ).default(0.2),
  MAX_TOTAL_EXPOSURE: fraction("MAX_TOTAL_EXPOSURE").default(0.7),
  MAX_DAILY_TRADES: z.coerce.number().int().positive().default(30),
  MAX_TRADES_PER_RUN: z.coerce.number().int().positive().default(5),
  MAX_DRAWDOWN: fraction("MAX_DRAWDOWN").default(0.25),
  REQUIRE_VERIFIABLE: envBool(false),
  MIN_HOURS_TO_SETTLEMENT: z.coerce.number().min(0).default(2),
  /** ISO timestamp when the competition stops counting. Markets settling later are skipped. */
  TRADING_WINDOW_END: optionalString(z.string().datetime()),

  // --- Execution --------------------------------------------------------
  SLIPPAGE_TOLERANCE: fraction("SLIPPAGE_TOLERANCE").default(0.02),
  MAX_REQUOTE_DRIFT: fraction("MAX_REQUOTE_DRIFT").default(0.03),

  // --- Payout model (calibrated in Stage 3) ------------------------------
  PAYOUT_CREATOR_HAIRCUT: fraction("PAYOUT_CREATOR_HAIRCUT").default(0),
  ASSUMED_FAILURE_PROBABILITY: fraction("ASSUMED_FAILURE_PROBABILITY").default(0.02),

  /** Watch-only wallet: value a real portfolio without holding its key. */
  WATCH_WALLET: optionalString(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  /** Bankroll assumed in a dry run with no wallet, so sizing stays realistic. */
  PAPER_BANKROLL_USDC: z.coerce.number().min(0).default(1000),

  // --- Operations -------------------------------------------------------
  MARKET_LIMIT: z.coerce.number().int().positive().default(50),
  /** Markets analysed concurrently. Higher is faster but risks rate limits. */
  EVALUATION_CONCURRENCY: z.coerce.number().int().positive().max(32).default(5),
  DATABASE_PATH: z.string().default("database/state.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Hard stop: set to true to make the agent do nothing. */
  KILL_SWITCH: envBool(false),
});

export type Config = z.infer<typeof schema> & {
  tradingWindowEnd?: Date;
  ensembleModels: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const value = parsed.data;
  return {
    ...value,
    ensembleModels: value.ENSEMBLE_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    ...(value.TRADING_WINDOW_END
      ? { tradingWindowEnd: new Date(value.TRADING_WINDOW_END) }
      : {}),
  };
}

/** Config required to actually trade, as opposed to running offline. */
export function assertLiveReady(config: Config): void {
  const missing: string[] = [];
  if (!config.DELPHI_API_ACCESS_KEY) missing.push("DELPHI_API_ACCESS_KEY");
  if (config.DELPHI_SIGNER_TYPE === "private_key" && !config.WALLET_PRIVATE_KEY) {
    missing.push("WALLET_PRIVATE_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot run against a live network without: ${missing.join(", ")}.\n` +
        `Get a testnet API key at https://delphi-api-access.gensyn.ai/ ` +
        `or run with --fake to use the offline simulator.`,
    );
  }
}
