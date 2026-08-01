/**
 * Stage 2 verification. Read-only against live Gensyn testnet — no signer, no
 * transactions, no spend.
 *
 *   npx tsx scripts/probe.ts
 *
 * Its real job is to falsify the DPM model derived in `src/agent/dpm.ts`
 * against actual on-chain state. Every identity below is checked against the
 * gateway's own view. If any of them fails, the EV engine is computing against
 * a market that does not exist and nothing downstream can be trusted.
 */

import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { loadConfig } from "../src/config.js";
import { GatewayReader } from "../src/sdk/gateway.js";
import {
  deriveK,
  impliedProbabilities,
  isqrt,
  payoutPerShare,
  spotPrice,
  toUsdc,
  SHARE_SCALE,
} from "../src/agent/dpm.js";
import type { Address } from "../src/sdk/port.js";

const config = loadConfig();
const client = new DelphiClient({ network: config.DELPHI_NETWORK });
const gateway = new GatewayReader(config.DELPHI_NETWORK);

console.log(`network: ${config.DELPHI_NETWORK}`);
console.log("api health:", JSON.stringify(await client.health()));

const mins = await gateway.getTradeMinimums();
console.log(
  `trade minimums: MIN_SHARES_DELTA=${Number(mins.minShares) / 1e18} shares, ` +
    `MIN_TOKENS_DELTA=${toUsdc(mins.minTokens)} USDC`,
);

const { markets } = await client.listMarkets({
  status: "open",
  limit: 8,
  orderBy: "liquidity",
});

console.log(`\nopen markets: ${markets?.length ?? 0}\n`);

let checked = 0;
const failures: string[] = [];

for (const market of markets ?? []) {
  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length === 0) continue;

  let state;
  try {
    state = await gateway.getDpmState(market.id as Address);
  } catch (err) {
    console.log(`SKIP ${market.id}: ${(err as Error).message}`);
    continue;
  }

  const spot = await gateway.getSpot(market.id as Address, state.outcomeCount);
  const ourProbs = impliedProbabilities(state.supplies);
  const chainProbs = spot.impliedProbabilities.map((p) => Number(p) / 1e18);

  console.log("─".repeat(78));
  console.log(market.metadata?.question ?? market.id);
  console.log(
    `  ${market.id}  status=${market.status}  fee=${Number(state.tradingFee) / 1e16}%  ` +
      `settles=${market.settlesAt ?? "?"}`,
  );
  console.log(
    `  pool=${toUsdc(state.pool).toFixed(4)} USDC  initialPool=${toUsdc(state.initialPool).toFixed(4)}  ` +
      `fees=${toUsdc(state.tradingFees).toFixed(4)}  refund=${toUsdc(state.refund).toFixed(4)}`,
  );
  console.log(`  judge: ${market.metadata?.model?.model_identifier ?? "—"}`);

  for (let i = 0; i < outcomes.length; i++) {
    const q = state.supplies[i] ?? 0n;
    const chainPrice = Number(spot.prices[i] ?? 0n) / 1e6;
    const ourPrice = toUsdc(spotPrice(state, i));
    const payout = toUsdc(payoutPerShare(state.pool, q));
    console.log(
      `   [${i}] ${(outcomes[i] ?? "").slice(0, 22).padEnd(22)} ` +
        `supply=${(Number(q) / 1e18).toFixed(2).padStart(10)}  ` +
        `price=${chainPrice.toFixed(4)}  prob=${(chainProbs[i]! * 100).toFixed(2).padStart(6)}%  ` +
        `payout/share=${payout.toFixed(4)}`,
    );

    // --- identity 1: prob_i = q_i^2 / sumTerm36 --------------------------
    const probErr = Math.abs(ourProbs[i]! - chainProbs[i]!);
    if (probErr > 1e-6) {
      failures.push(
        `${market.id}[${i}] implied probability: ours ${ourProbs[i]} vs chain ${chainProbs[i]}`,
      );
    }

    // --- identity 2: price_i = k * q_i / sqrt(sumTerm36) -----------------
    const priceErr = Math.abs(ourPrice - chainPrice);
    if (priceErr > 2e-6) {
      failures.push(
        `${market.id}[${i}] spot price: ours ${ourPrice} vs chain ${chainPrice}`,
      );
    }

    // --- identity 3: price_i * payout_i = k^2 ----------------------------
    const kFloat = Number(state.k) / 1e18;
    if (q > 0n && chainPrice > 0) {
      const product = chainPrice * payout;
      if (Math.abs(product - kFloat * kFloat) / (kFloat * kFloat) > 0.01) {
        failures.push(
          `${market.id}[${i}] price*payout=${product} but k^2=${kFloat * kFloat}`,
        );
      }
    }

    // --- identity 4: prob_i = (price_i / k)^2 ----------------------------
    if (kFloat > 0) {
      const fromPrice = (chainPrice / kFloat) ** 2;
      if (Math.abs(fromPrice - chainProbs[i]!) > 1e-4) {
        failures.push(
          `${market.id}[${i}] (price/k)^2=${fromPrice} but chain prob=${chainProbs[i]}`,
        );
      }
    }
  }

  // --- identity 5: probabilities sum to 1 -------------------------------
  const total = chainProbs.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    failures.push(`${market.id} probabilities sum to ${total}, not 1`);
  }

  // --- identity 6: pool = k * sqrt(sumTerm36) ---------------------------
  const modelledPool = (state.k * isqrt(state.sumTerm36)) / 10n ** 30n;
  const poolErr =
    state.pool > 0n
      ? Math.abs(Number(modelledPool - state.pool)) / Number(state.pool)
      : 0;
  console.log(
    `  pool identity: k*sqrt(sumTerm36)=${toUsdc(modelledPool).toFixed(6)} vs ` +
      `chain pool=${toUsdc(state.pool).toFixed(6)}  (rel err ${(poolErr * 100).toFixed(4)}%)`,
  );
  if (poolErr > 0.01) {
    failures.push(
      `${market.id} pool: modelled ${toUsdc(modelledPool)} vs chain ${toUsdc(state.pool)}`,
    );
  }

  // --- identity 7: derived k matches config k ---------------------------
  const kDerived = deriveK(state.pool, state.sumTerm36);
  const kErr =
    state.k > 0n ? Math.abs(Number(kDerived - state.k)) / Number(state.k) : 0;
  console.log(
    `  k: config=${Number(state.k) / 1e18} derived=${Number(kDerived) / 1e18}  ` +
      `(rel err ${(kErr * 100).toFixed(4)}%)`,
  );
  if (kErr > 0.01) failures.push(`${market.id} k mismatch`);

  // --- cost model vs the gateway's own quote ----------------------------
  if (market.status === "open") {
    // Size the probe in TOKENS, not shares: a fixed share count can fall under
    // MIN_TOKENS_DELTA on a cheap outcome and revert with TokensInBelowMin.
    const price0 = Number(spot.prices[0] ?? 0n) / 1e6;
    const targetUsdc = Math.max(1, (Number(mins.minTokens) / 1e6) * 10);
    const probeShares = price0 > 0 ? targetUsdc / price0 : 1;
    const probe = BigInt(Math.round(probeShares * 1e18));
    try {
      const chainCost = await gateway.quoteBuy(market.id as Address, 0, probe);
      const { costToBuy } = await import("../src/agent/dpm.js");
      const ourCost = costToBuy(state, 0, probe);
      const costErr =
        chainCost > 0n
          ? Math.abs(Number(ourCost - chainCost)) / Number(chainCost)
          : 0;
      console.log(
        `  quoteBuy(${(Number(probe) / 1e18).toFixed(3)} sh of [0]): chain=${toUsdc(chainCost).toFixed(6)} ` +
          `ours=${toUsdc(ourCost).toFixed(6)}  (rel err ${(costErr * 100).toFixed(4)}%)`,
      );
      if (costErr > 0.02) {
        failures.push(
          `${market.id} cost model: ours ${toUsdc(ourCost)} vs chain ${toUsdc(chainCost)}`,
        );
      }
    } catch (err) {
      console.log(`  quoteBuy failed: ${(err as Error).message.slice(0, 90)}`);
    }
  }

  checked++;
}

console.log("\n" + "═".repeat(78));
console.log(`markets checked: ${checked}`);
if (failures.length === 0) {
  console.log("ALL DPM IDENTITIES HOLD AGAINST LIVE CHAIN STATE ✓");
} else {
  console.log(`FAILURES (${failures.length}):`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exitCode = 1;
}
