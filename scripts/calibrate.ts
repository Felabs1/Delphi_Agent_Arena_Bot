/**
 * Score past predictions against what actually settled, and report whether the
 * agent has any measurable skill.
 *
 *   npm run calibrate
 *
 * Read-only. Resolves any stored prediction whose market has since settled,
 * then reports Brier score, reliability, and threshold advice.
 *
 * The headline number is `skill vs market`. Beating your own past self is
 * meaningless; beating the price you have to pay is the only thing that makes
 * an edge real.
 */

import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/portfolio/storage.js";
import { advise, score } from "../src/calibration/scorer.js";

const config = loadConfig();
if (!config.DELPHI_API_ACCESS_KEY) {
  console.error("DELPHI_API_ACCESS_KEY is required to resolve market outcomes");
  process.exit(1);
}

const store = new Store(config.DATABASE_PATH);
const client = new DelphiClient({
  network: config.DELPHI_NETWORK,
  apiKey: config.DELPHI_API_ACCESS_KEY,
});

// --- resolve outcomes for anything that has settled since we predicted -----
const pending = store.unscoredPredictions();
console.log(`unscored predictions: ${pending.length}`);

let resolved = 0;
const statusCache = new Map<string, { settled: boolean; winningIdx: number }>();

for (const p of pending) {
  const key = p.market.toLowerCase();
  let info = statusCache.get(key);
  if (!info) {
    try {
      const market = await client.getMarket({ id: p.market });
      info = {
        settled: market.status === "settled" && market.winningOutcomeIdx !== null,
        winningIdx: Number(market.winningOutcomeIdx ?? -1),
      };
      statusCache.set(key, info);
    } catch {
      continue;
    }
  }
  if (info.settled && info.winningIdx >= 0) {
    store.markScored(p.id, info.winningIdx);
    resolved++;
  }
}
console.log(`newly resolved: ${resolved}\n`);

// --- score -----------------------------------------------------------------
const scored = store.scoredPredictions();
const report = score(scored);

console.log("=".repeat(70));
console.log("CALIBRATION");
console.log("=".repeat(70));
console.log(`  scored predictions   ${report.samples}`);

if (report.samples === 0) {
  console.log(
    "\n  Nothing has settled yet. Run the agent for a while, then come back —" +
      "\n  most Delphi markets take days to weeks to resolve.",
  );
  store.close();
  process.exit(0);
}

console.log(`  our Brier score      ${report.brier.toFixed(4)}  (lower is better)`);
console.log(
  `  market Brier score   ${Number.isNaN(report.marketBrier) ? "n/a" : report.marketBrier.toFixed(4)}`,
);
console.log(
  `  skill vs market      ${Number.isNaN(report.skillVsMarket) ? "n/a" : (report.skillVsMarket >= 0 ? "+" : "") + report.skillVsMarket.toFixed(4)}` +
    `   ${report.skillVsMarket > 0 ? "(beating the market)" : "(NOT beating the market)"}`,
);
console.log(
  `  overconfidence       ${(report.overconfidence * 100).toFixed(1)}%` +
    `   ${report.overconfidence > 0.05 ? "(sizing is too aggressive)" : ""}`,
);
console.log(`  mean confidence      ${(report.meanConfidence * 100).toFixed(1)}%`);

console.log("\nRELIABILITY  (of the times we said X%, how often were we right?)");
for (const bin of report.reliability) {
  if (bin.count === 0) continue;
  const bar = "█".repeat(Math.round(bin.observedFrequency * 20));
  console.log(
    `  ${(bin.lower * 100).toFixed(0).padStart(3)}-${(bin.upper * 100).toFixed(0)}%  ` +
      `n=${String(bin.count).padStart(3)}  said ${(bin.meanPredicted * 100).toFixed(0).padStart(3)}%  ` +
      `actual ${(bin.observedFrequency * 100).toFixed(0).padStart(3)}%  ${bar}`,
  );
}

const advice = advise(report);
console.log("\n" + "=".repeat(70));
console.log("ADVICE");
console.log("=".repeat(70));
console.log(`  ${advice.rationale}`);
if (advice.confidenceThreshold !== null) {
  console.log(`\n  CONFIDENCE_THRESHOLD=${advice.confidenceThreshold}`);
  if (advice.confidenceScale !== null && advice.confidenceScale < 1) {
    console.log(
      `  CONFIDENCE_SCALE=${advice.confidenceScale}   # shrink to correct measured overconfidence`,
    );
  }
  console.log("\n  Put these in .env, replacing the PROVISIONAL values.");
} else {
  console.log("\n  No threshold change recommended.");
}

store.close();
