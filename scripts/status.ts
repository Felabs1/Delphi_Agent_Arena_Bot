/**
 * What the agent has actually done so far.
 *
 *   npm run status
 *
 * Read-only. Reads the local database plus live balances — the two together
 * are the honest answer to "is this thing making money".
 */

import { formatUnits } from "viem";
import { ERC20_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import { privateKeyToAccount } from "viem/accounts";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { GatewayReader, NETWORKS } from "../src/sdk/gateway.js";

const config = loadConfig();
const db = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: false });

const table = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }
};

console.log("=".repeat(70));
console.log("DELPHI AGENT — STATUS");
console.log("=".repeat(70));

// --- runs ------------------------------------------------------------------
const runs = table(
  "SELECT COUNT(*) n, MIN(started_at) first, MAX(finished_at) last FROM runs",
)[0];
const runCount = Number(runs?.["n"] ?? 0);
console.log(`\nRUNS  ${runCount}`);
if (runCount > 0) {
  console.log(`  first  ${runs?.["first"]}`);
  console.log(`  last   ${runs?.["last"]}`);
  const halted = table(
    "SELECT halted, COUNT(*) n FROM runs WHERE halted IS NOT NULL GROUP BY halted",
  );
  for (const h of halted) {
    console.log(`  halted ${h["n"]}x: ${h["halted"]}`);
  }
}

// --- trades ----------------------------------------------------------------
const trades = table("SELECT status, COUNT(*) n FROM trades GROUP BY status");
console.log("\nTRADES");
if (trades.length === 0) {
  console.log("  none yet");
} else {
  for (const t of trades) console.log(`  ${String(t["status"]).padEnd(10)} ${t["n"]}`);
  const spent = table(
    "SELECT SUM(CAST(filled_in AS REAL)) s FROM trades WHERE status='filled'",
  )[0];
  const total = Number(spent?.["s"] ?? 0) / 1e6;
  console.log(`  total staked  ${total.toFixed(4)} USDC`);

  const recent = table(
    `SELECT market, outcome_idx, filled_in, tx_hash, created_at
     FROM trades WHERE status='filled' ORDER BY created_at DESC LIMIT 5`,
  );
  if (recent.length > 0) {
    console.log("\n  most recent:");
    for (const r of recent) {
      console.log(
        `    ${String(r["created_at"]).slice(0, 19)}  ` +
          `${String(r["market"]).slice(0, 12)}…  outcome ${r["outcome_idx"]}  ` +
          `${(Number(r["filled_in"]) / 1e6).toFixed(4)} USDC`,
      );
    }
  }
}

// --- predictions -----------------------------------------------------------
const preds = table(
  "SELECT COUNT(*) total, SUM(CASE WHEN scored_at IS NOT NULL THEN 1 ELSE 0 END) scored FROM predictions",
)[0];
console.log("\nPREDICTIONS");
console.log(`  recorded  ${Number(preds?.["total"] ?? 0)}`);
console.log(
  `  scored    ${Number(preds?.["scored"] ?? 0)}   ` +
    `(run 'npm run calibrate' to resolve settled ones)`,
);

// --- bankroll --------------------------------------------------------------
const peak = table("SELECT value FROM meta WHERE key='peak_bankroll'")[0];
const cached = table("SELECT COUNT(*) n FROM estimates")[0];
console.log("\nSTATE");
console.log(
  `  peak bankroll   ${peak ? Number(peak["value"]).toFixed(2) + " USDC" : "not recorded yet"}`,
);
console.log(`  cached estimates ${Number(cached?.["n"] ?? 0)}`);
console.log(`  database        ${config.DATABASE_PATH}`);

// --- live wallet -----------------------------------------------------------
if (config.WALLET_PRIVATE_KEY) {
  const net = NETWORKS[config.DELPHI_NETWORK];
  const reader = new GatewayReader(config.DELPHI_NETWORK, config.GENSYN_RPC_URL);
  const account = privateKeyToAccount(config.WALLET_PRIVATE_KEY as `0x${string}`);
  try {
    const [eth, usdc] = await Promise.all([
      reader.publicClient.getBalance({ address: account.address }),
      reader.publicClient.readContract({
        address: net.tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      } as never) as Promise<bigint>,
    ]);
    console.log("\nWALLET (live)");
    console.log(`  ${account.address}`);
    console.log(`  ETH   ${formatUnits(eth, 18)}`);
    console.log(`  USDC  ${formatUnits(usdc, 6)}`);

    const peakValue = peak ? Number(peak["value"]) : null;
    if (peakValue !== null) {
      const drawdown = (peakValue - Number(formatUnits(usdc, 6))) / peakValue;
      if (drawdown > 0) {
        console.log(
          `  drawdown from peak  ${(drawdown * 100).toFixed(1)}%` +
            `   (breaker trips at ${(config.MAX_DRAWDOWN * 100).toFixed(0)}%)`,
        );
      }
    }
  } catch (err) {
    console.log(`\nWALLET  unreadable: ${(err as Error).message.slice(0, 60)}`);
  }
}

if (config.KILL_SWITCH) {
  console.log("\n  !! KILL_SWITCH is on — the agent will not trade.");
}
console.log("");
db.close();
