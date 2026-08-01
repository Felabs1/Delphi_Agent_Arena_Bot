/**
 * STAGE 3 GATE — validate the payout model against realised redemptions.
 *
 *   npx tsx scripts/validate-payout.ts
 *
 * Read-only. No signer, no spend.
 *
 * Everything upstream rests on one number: how much USDC a winning share
 * actually pays. The EV engine models it as
 *
 *     payoutPerShare = distributablePool / winningSupply
 *
 * where `distributablePool` is the pool net of whatever settlement pays out to
 * the market creator. That is a hypothesis. Settled markets are the answer key:
 * `GatewayRedemption` events record exactly what real redeemers received.
 *
 * This script fits several candidate models against those events and reports
 * the error of each. Trading on an unvalidated payout model is the most likely
 * way to lose the competition while appearing to work, so this must pass before
 * any live trade fires.
 */

import { loadConfig } from "../src/config.js";
import { GatewayReader } from "../src/sdk/gateway.js";
import { toUsdc } from "../src/agent/dpm.js";
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
const gateway = new GatewayReader(config.DELPHI_NETWORK);

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
  redeemer: string;
  sharesIn: string;
  tokensOut: string;
}
interface Settlement {
  marketProxy: string;
  winningOutcomeIdx: string;
  marketCreatorReward: string;
  refund: string;
  marketCreatorTradingFeesCut: string;
  block_number: string;
}

const { gatewayRedemptions, gatewayMarketSettleds } = await query<{
  gatewayRedemptions: Redemption[];
  gatewayMarketSettleds: Settlement[];
}>(`{
  gatewayRedemptions(first: 200, orderBy: timestamp_, orderDirection: desc) {
    marketProxy redeemer sharesIn tokensOut
  }
  gatewayMarketSettleds(first: 200, orderBy: timestamp_, orderDirection: desc) {
    marketProxy winningOutcomeIdx marketCreatorReward refund marketCreatorTradingFeesCut block_number
  }
}`);

console.log(
  `redemptions: ${gatewayRedemptions.length}  settlements: ${gatewayMarketSettleds.length}\n`,
);

const settlementByMarket = new Map(
  gatewayMarketSettleds.map((s) => [s.marketProxy.toLowerCase(), s]),
);

/** Realised payout per share, grouped by market. */
const realised = new Map<string, { ratios: number[]; shares: bigint; tokens: bigint }>();
for (const r of gatewayRedemptions) {
  const sharesIn = BigInt(r.sharesIn);
  const tokensOut = BigInt(r.tokensOut);
  if (sharesIn <= 0n) continue;
  const key = r.marketProxy.toLowerCase();
  const entry = realised.get(key) ?? { ratios: [], shares: 0n, tokens: 0n };
  entry.ratios.push(Number(tokensOut) / 1e6 / (Number(sharesIn) / 1e18));
  entry.shares += sharesIn;
  entry.tokens += tokensOut;
  realised.set(key, entry);
}

interface Candidate {
  name: string;
  predict: (ctx: Ctx) => number;
}
interface Ctx {
  pool: number;
  refund: number;
  tradingFees: number;
  winningSupply: number;
  creatorReward: number;
  settlementRefund: number;
  creatorFeeCut: number;
  /** Creator holds this many shares in EVERY outcome. */
  creatorShares: number;
  /** What settlement pays the creator for its winning shares. */
  creatorWinningValue: number;
}

const candidates: Candidate[] = [
  { name: "pool / supply", predict: (c) => c.pool / c.winningSupply },
  {
    name: "(pool - refund) / supply",
    predict: (c) => (c.pool - c.refund) / c.winningSupply,
  },
  {
    name: "(pool - refund - creatorReward) / supply",
    predict: (c) =>
      (c.pool - c.refund - c.creatorReward) / c.winningSupply,
  },
  {
    name: "(pool - settlementRefund - creatorReward) / supply",
    predict: (c) =>
      (c.pool - c.settlementRefund - c.creatorReward) / c.winningSupply,
  },
  {
    name: "(pool + tradingFees - refund) / supply",
    predict: (c) => (c.pool + c.tradingFees - c.refund) / c.winningSupply,
  },
  // The creator is settled separately, so ordinary holders divide the remaining
  // pool among the remaining shares.
  {
    name: "(pool - creatorWinningValue) / (supply - creatorShares)",
    predict: (c) =>
      (c.pool - c.creatorWinningValue) / (c.winningSupply - c.creatorShares),
  },
  {
    name: "pool / (supply - creatorShares)",
    predict: (c) => c.pool / (c.winningSupply - c.creatorShares),
  },
  {
    name: "(pool - creatorWinningValue) / supply",
    predict: (c) => (c.pool - c.creatorWinningValue) / c.winningSupply,
  },
];

const errors = new Map<string, number[]>(candidates.map((c) => [c.name, []]));
let evaluated = 0;
let nonUnitPayouts = 0;

for (const [market, obs] of realised) {
  const settlement = settlementByMarket.get(market);
  if (!settlement) continue;

  const winningIdx = Number(settlement.winningOutcomeIdx);
  // State AT the settlement block: after submitWinner took the creator's cut,
  // before any redemption drained the pool.
  const settlementBlock = BigInt(settlement.block_number);
  let state;
  try {
    state = await gateway.getDpmState(market as Address, settlementBlock);
  } catch (err) {
    console.log(`skip ${market}: ${(err as Error).message.slice(0, 70)}`);
    continue;
  }

  const winningSupply = Number(state.supplies[winningIdx] ?? 0n) / 1e18;
  if (winningSupply <= 0) {
    console.log(`skip ${market}: winning supply is 0 at settlement block`);
    continue;
  }

  // Aggregate ratio is the most reliable observation: it pools every redeemer.
  const actual = Number(obs.tokens) / 1e6 / (Number(obs.shares) / 1e18);
  const spread =
    Math.max(...obs.ratios) - Math.min(...obs.ratios);

  let creator = { sharesPerOutcome: 0n, winningSettlementValue: 0n };
  try {
    creator = await gateway.getCreatorPosition(
      market as Address,
      winningIdx,
      settlementBlock,
    );
  } catch {
    // Legacy markets may not expose these; the candidate simply won't fit.
  }

  const ctx: Ctx = {
    pool: toUsdc(state.pool),
    refund: toUsdc(state.refund),
    tradingFees: toUsdc(state.tradingFees),
    winningSupply,
    creatorReward: Number(settlement.marketCreatorReward) / 1e6,
    settlementRefund: Number(settlement.refund) / 1e6,
    creatorFeeCut: Number(settlement.marketCreatorTradingFeesCut) / 1e6,
    creatorShares: Number(creator.sharesPerOutcome) / 1e18,
    creatorWinningValue: Number(creator.winningSettlementValue) / 1e6,
  };

  evaluated++;
  if (Math.abs(actual - 1) > 0.01) nonUnitPayouts++;

  console.log("─".repeat(78));
  console.log(`${market}  winner=[${winningIdx}]  redeemers=${obs.ratios.length}  @block ${settlementBlock}`);
  console.log(
    `  pool=${ctx.pool.toFixed(4)}  refund=${ctx.refund.toFixed(4)}  ` +
      `fees=${ctx.tradingFees.toFixed(4)}  winningSupply=${winningSupply.toFixed(4)}`,
  );
  console.log(
    `  settlement: creatorReward=${ctx.creatorReward.toFixed(4)}  ` +
      `refund=${ctx.settlementRefund.toFixed(4)}  feeCut=${ctx.creatorFeeCut.toFixed(4)}`,
  );
  console.log(
    `  creator: sharesPerOutcome=${ctx.creatorShares.toFixed(4)}  ` +
      `winningSettlementValue=${ctx.creatorWinningValue.toFixed(4)}`,
  );
  console.log(
    `  REALISED payout/share = ${actual.toFixed(6)}` +
      (spread > 1e-6 ? `  (spread across redeemers ${spread.toExponential(2)})` : ""),
  );

  for (const c of candidates) {
    const predicted = c.predict(ctx);
    const relErr = Math.abs(predicted - actual) / actual;
    errors.get(c.name)!.push(relErr);
    console.log(
      `    ${c.name.padEnd(52)} ${predicted.toFixed(6)}  err ${(relErr * 100).toFixed(4)}%`,
    );
  }
}

console.log("\n" + "═".repeat(78));
console.log(`markets evaluated: ${evaluated}`);
console.log(
  `markets whose payout was NOT ~1.0 USDC/share: ${nonUnitPayouts}/${evaluated}`,
);

if (evaluated === 0) {
  console.log("\nNo settled markets with remaining supply — cannot validate yet.");
  process.exitCode = 1;
} else {
  console.log("\nmodel fit (median relative error):");
  const ranked = candidates
    .map((c) => {
      const list = [...errors.get(c.name)!].sort((a, b) => a - b);
      const median = list[Math.floor(list.length / 2)] ?? Infinity;
      const worst = Math.max(...list);
      return { name: c.name, median, worst };
    })
    .sort((a, b) => a.median - b.median);

  for (const r of ranked) {
    console.log(
      `  ${r.name.padEnd(52)} median ${(r.median * 100).toFixed(4)}%  worst ${(r.worst * 100).toFixed(4)}%`,
    );
  }

  const best = ranked[0]!;
  console.log(`\nBEST MODEL: ${best.name}`);
  if (best.median < 0.005) {
    console.log(
      `GATE PASSED — median error ${(best.median * 100).toFixed(4)}% is within tolerance.`,
    );
    console.log(
      "Set PAYOUT_CREATOR_HAIRCUT to 0 when using this model; the deduction is",
    );
    console.log("explicit in the formula rather than a fudge factor.");
  } else {
    console.log(
      `GATE FAILED — best median error ${(best.median * 100).toFixed(2)}% is too high to trade on.`,
    );
    process.exitCode = 1;
  }
}
