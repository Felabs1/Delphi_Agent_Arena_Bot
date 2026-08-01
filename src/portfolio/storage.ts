/**
 * SQLite persistence.
 *
 * Without this the agent is amnesiac between cron ticks, and three things
 * silently stop working:
 *
 *   - the drawdown breaker, because peak bankroll resets to current every run
 *     and a decline can never be observed;
 *   - the daily trade cap, because the count starts at zero each tick;
 *   - trade idempotency, because a crash mid-send leaves no record and the next
 *     tick happily buys again.
 *
 * It also stores every AI estimate so Stage 8 can score them against what
 * actually settled — calibration is impossible without a history of what we
 * believed and when.
 *
 * Written synchronously with better-sqlite3: a cron process doing a handful of
 * writes has no use for an async driver, and synchronous code cannot interleave
 * a half-written trade with a crash.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { TradeIntent, TradeJournal } from "../agent/executor.js";
import type { CachedEstimate, EstimateCache } from "../ai/cache.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  bankroll     REAL,
  cash         REAL,
  markets      INTEGER,
  candidates   INTEGER,
  executed     INTEGER,
  halted       TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  intent_id     TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  market        TEXT NOT NULL,
  outcome_idx   INTEGER NOT NULL,
  shares_out    TEXT NOT NULL,
  quoted_in     TEXT NOT NULL,
  filled_in     TEXT,
  probability   REAL,
  tx_hash       TEXT,
  status        TEXT NOT NULL,        -- attempted | filled | failed
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_market ON trades(market);
CREATE INDEX IF NOT EXISTS trades_created ON trades(created_at);

CREATE TABLE IF NOT EXISTS predictions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  market        TEXT NOT NULL,
  question      TEXT,
  outcome_count INTEGER NOT NULL,
  probabilities TEXT NOT NULL,        -- JSON array
  confidence    REAL NOT NULL,
  market_probs  TEXT,                 -- JSON array, implied at estimation time
  settles_at    TEXT,
  created_at    TEXT NOT NULL,
  -- filled in later, once the market resolves
  winning_idx   INTEGER,
  scored_at     TEXT
);
CREATE INDEX IF NOT EXISTS predictions_market ON predictions(market);
CREATE INDEX IF NOT EXISTS predictions_unscored ON predictions(scored_at);

CREATE TABLE IF NOT EXISTS estimates (
  market        TEXT PRIMARY KEY,
  payload       TEXT NOT NULL,        -- JSON CachedEstimate
  cached_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  bankrollUsdc: number;
  cashUsdc: number;
  markets: number;
  candidates: number;
  executed: number;
  halted?: string | undefined;
}

export interface PredictionRecord {
  runId: string;
  market: string;
  question: string | null;
  probabilities: number[];
  confidence: number;
  marketProbabilities: number[];
  settlesAt: string | null;
}

/** A stored prediction awaiting (or carrying) its resolved outcome. */
export interface ScoredPrediction {
  id: number;
  market: string;
  question: string | null;
  probabilities: number[];
  confidence: number;
  marketProbabilities: number[];
  winningIdx: number;
}

export class Store implements TradeJournal, EstimateCache {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL keeps a crashed run from leaving the database locked for the next one.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------- trade journal

  async wasAttempted(id: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM trades WHERE intent_id = ?")
      .get(id);
    return row !== undefined;
  }

  async recordAttempt(intent: TradeIntent): Promise<void> {
    // Written BEFORE the transaction is sent, so a crash in flight still leaves
    // a record and the next run refuses to re-send.
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trades
         (intent_id, run_id, market, outcome_idx, shares_out, quoted_in,
          probability, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'attempted', ?)`,
      )
      .run(
        intent.id,
        intent.id.split(":")[0] ?? "",
        intent.marketAddress.toLowerCase(),
        intent.outcomeIdx,
        intent.sharesOut.toString(),
        intent.quotedTokensIn.toString(),
        intent.probability,
        new Date().toISOString(),
      );
  }

  async recordResult(
    id: string,
    result: { transactionHash: string; filledTokensIn: bigint },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE trades SET status='filled', tx_hash=?, filled_in=? WHERE intent_id=?`,
      )
      .run(result.transactionHash, result.filledTokensIn.toString(), id);
  }

  async recordFailure(id: string, error: string): Promise<void> {
    this.db
      .prepare(`UPDATE trades SET status='failed', error=? WHERE intent_id=?`)
      .run(error.slice(0, 500), id);
  }

  /** Trades filled since UTC midnight — the daily cap needs this to mean anything. */
  tradesToday(now: Date = new Date()): number {
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM trades WHERE status='filled' AND created_at >= ?",
      )
      .get(midnight) as { n: number };
    return row.n;
  }

  // ------------------------------------------------------- estimate cache

  get(marketId: string): CachedEstimate | undefined {
    const row = this.db
      .prepare("SELECT payload FROM estimates WHERE market = ?")
      .get(marketId.toLowerCase()) as { payload: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.payload) as CachedEstimate;
    } catch {
      return undefined;
    }
  }

  set(marketId: string, entry: CachedEstimate): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO estimates (market, payload, cached_at) VALUES (?, ?, ?)",
      )
      .run(marketId.toLowerCase(), JSON.stringify(entry), entry.cachedAt);
  }

  delete(marketId: string): void {
    this.db
      .prepare("DELETE FROM estimates WHERE market = ?")
      .run(marketId.toLowerCase());
  }

  get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM estimates").get() as {
      n: number;
    };
    return row.n;
  }

  /** Drop cached estimates older than `maxAgeMinutes`, so the file stays small. */
  pruneEstimates(maxAgeMinutes: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - maxAgeMinutes * 60_000;
    return this.db
      .prepare("DELETE FROM estimates WHERE cached_at < ?")
      .run(cutoff).changes;
  }

  // ------------------------------------------------------------ bankroll

  /**
   * Highest bankroll ever recorded. The drawdown breaker is meaningless without
   * a peak that outlives the process.
   */
  peakBankroll(): number | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='peak_bankroll'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : undefined;
  }

  recordBankroll(bankrollUsdc: number): void {
    const peak = this.peakBankroll() ?? 0;
    if (bankrollUsdc > peak) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('peak_bankroll', ?)",
        )
        .run(String(bankrollUsdc));
    }
  }

  // ------------------------------------------------------------- history

  recordRun(summary: RunSummary): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
         (run_id, started_at, finished_at, bankroll, cash, markets,
          candidates, executed, halted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.runId,
        summary.startedAt,
        summary.finishedAt,
        summary.bankrollUsdc,
        summary.cashUsdc,
        summary.markets,
        summary.candidates,
        summary.executed,
        summary.halted ?? null,
      );
  }

  recordPrediction(p: PredictionRecord): void {
    this.db
      .prepare(
        `INSERT INTO predictions
         (run_id, market, question, outcome_count, probabilities, confidence,
          market_probs, settles_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.runId,
        p.market.toLowerCase(),
        p.question,
        p.probabilities.length,
        JSON.stringify(p.probabilities),
        p.confidence,
        JSON.stringify(p.marketProbabilities),
        p.settlesAt,
        new Date().toISOString(),
      );
  }

  /** Predictions on markets that have since resolved but are not yet scored. */
  unscoredPredictions(): { id: number; market: string }[] {
    return this.db
      .prepare(
        "SELECT id, market FROM predictions WHERE scored_at IS NULL ORDER BY id",
      )
      .all() as { id: number; market: string }[];
  }

  markScored(id: number, winningIdx: number): void {
    this.db
      .prepare("UPDATE predictions SET winning_idx=?, scored_at=? WHERE id=?")
      .run(winningIdx, new Date().toISOString(), id);
  }

  /** Everything with a known outcome, for Brier scoring. */
  scoredPredictions(): ScoredPrediction[] {
    const rows = this.db
      .prepare(
        `SELECT id, market, question, probabilities, confidence, market_probs, winning_idx
         FROM predictions WHERE winning_idx IS NOT NULL ORDER BY id`,
      )
      .all() as {
      id: number;
      market: string;
      question: string | null;
      probabilities: string;
      confidence: number;
      market_probs: string | null;
      winning_idx: number;
    }[];

    return rows.map((r) => ({
      id: r.id,
      market: r.market,
      question: r.question,
      probabilities: JSON.parse(r.probabilities) as number[],
      confidence: r.confidence,
      marketProbabilities: r.market_probs
        ? (JSON.parse(r.market_probs) as number[])
        : [],
      winningIdx: r.winning_idx,
    }));
  }

  /** Markets we hold or have traded, for resolution follow-up. */
  tradedMarkets(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT market FROM trades WHERE status='filled'")
      .all() as { market: string }[];
    return rows.map((r) => r.market);
  }
}
