/**
 * STAGE 3 GATE — validate the payout model against realised redemptions.
 *
 *   npm run validate:payout
 *
 * Read-only. No signer, no spend.
 *
 * Everything upstream rests on one number: how much USDC a winning share
 * actually pays. This is a genuine out-of-sample test — it reads each settled
 * market's state at the block BEFORE it settled, predicts the payout from that
 * alone, and compares against what real redeemers actually received
 * (`GatewayRedemption` events).
 *
 * Reading state at the wrong moment is the trap. Settlement moves money:
 * `submitWinner` pays the creator out, so a post-settlement `pool` means
 * something different from a live one. An earlier version of this script read
 * current state and got 100% error; a later one read post-settlement state and
 * fitted a creator-share correction that is simply wrong to apply to a live
 * market. Predicting from pre-settlement state is the only thing that tests
 * what the agent actually does.
 */

import { loadConfig } from "../src/config.js";
import { GatewayReader } from "../src/sdk/gateway.js";
import { payoutPerShare, toUsdc } from "../src/agent/dpm.js";
import type { Address } from "../src/sdk/port.js";

const SUBGRAPH: Record<string, string> = {
  testnet:
    "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-testnet-autoset/1.0.0/gn",
};

const config = loadConfig();
const subgraphUrl = SUBGRAPH[config.DELPHI_NETWORK];
if (!subgraphUrl) {
  console.error(`no subgraph configured for ${config.DELPHI_NETWORK}`);
  process.exit(1);
}
const gateway = new GatewayReader(config.DELPHI_NETWORK, config.GENSYN_RPC_URL);

async function query<T>(gql: string): Promise<T> {
  const res = await fetch(subgraphUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) throw new Error(`subgraph error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

interface Redemption {
  marketProxy: string;
  sharesIn: string;
  tokensOut: string;
}
interface Settlement {
  marketProxy: string;
  winningOutcomeIdx: string;
  block_number: string;
}

const { gatewayRedemptions, gatewayMarketSettleds } = await query<{
  gatewayRedemptions: Redemption[];
  gatewayMarketSettleds: Settlement[];
}>(`{
  gatewayRedemptions(first: 500, orderBy: timestamp_, orderDirection: desc) {
    marketProxy sharesIn tokensOut
  }
  gatewayMarketSettleds(first: 500, orderBy: timestamp_, orderDirection: desc) {
    marketProxy winningOutcomeIdx block_number
  }
}`);

const settlementByMarket = new Map(
  gatewayMarketSettleds.map((s) => [s.marketProxy.toLowerCase(), s]),
);

/** Realised payout per share, aggregated across every redeemer of a market. */
const realised = new Map<string, { shares: bigint; tokens: bigint; n: number }>();
for (const r of gatewayRedemptions) {
  const sharesIn = BigInt(r.sharesIn);
  if (sharesIn <= 0n) continue;
  const key = r.marketProxy.toLowerCase();
  const e = realised.get(key) ?? { shares: 0n, tokens: 0n, n: 0 };
  e.shares += sharesIn;
  e.tokens += BigInt(r.tokensOut);
  e.n += 1;
  realised.set(key, e);
}

console.log(
  `redemptions: ${gatewayRedemptions.length} · settlements: ${gatewayMarketSettleds.length}\n`,
);
console.log("Predicting from PRE-settlement state: payout = pool / totalSupply(winner)\n");
console.log(
  "market                                            pool  supply(win)  predicted     actual      err",
);

const errors: number[] = [];
let nonUnit = 0;

for (const [market, obs] of realised) {
  const settlement = settlementByMarket.get(market);
  if (!settlement) continue;

  const winningIdx = Number(settlement.winningOutcomeIdx);
  const beforeBlock = BigInt(settlement.block_number) - 1n;

  let state;
  try {
    state = await gateway.getDpmState(market as Address, beforeBlock);
  } catch (err) {
    console.log(`${market}  skip: ${(err as Error).message.slice(0, 50)}`);
    continue;
  }

  const supply = state.supplies[winningIdx] ?? 0n;
  if (supply <= 0n) continue;

  const predicted = toUsdc(payoutPerShare(state.pool, supply));
  const actual = Number(obs.tokens) / 1e6 / (Number(obs.shares) / 1e18);
  const err = Math.abs(predicted - actual) / actual;
  errors.push(err);
  if (Math.abs(actual - 1) > 0.01) nonUnit++;

  console.log(
    `${market}  ${toUsdc(state.pool).toFixed(2).padStart(12)}  ` +
      `${(Number(supply) / 1e18).toFixed(2).padStart(11)}  ` +
      `${predicted.toFixed(5).padStart(9)}  ${actual.toFixed(5).padStart(9)}  ` +
      `${(err * 100).toFixed(4)}%`,
  );
}

console.log("\n" + "=".repeat(78));
if (errors.length === 0) {
  console.log("No settled markets with redemptions yet — cannot validate.");
  process.exitCode = 1;
} else {
  const sorted = [...errors].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 1;
  const worst = sorted.at(-1) ?? 1;

  console.log(`markets validated: ${errors.length}`);
  console.log(
    `markets whose payout was NOT ~1.0 USDC/share: ${nonUnit}/${errors.length}`,
  );
  console.log(`median error: ${(median * 100).toFixed(4)}%`);
  console.log(`worst error:  ${(worst * 100).toFixed(4)}%`);

  if (worst < 0.005) {
    console.log("\nGATE PASSED — the payout model predicts realised redemptions exactly.");
  } else {
    console.log(
      `\nGATE FAILED — worst-case error ${(worst * 100).toFixed(2)}% is too high to trade on.`,
    );
    process.exitCode = 1;
  }
}
