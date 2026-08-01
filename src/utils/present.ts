/**
 * Human-readable run output.
 *
 * The structured logger is for machines (`LOG_FORMAT=json`) and for grepping a
 * cron's history. It is a poor way to answer the question a person actually
 * has, which is "what is it about to do to my money, and why". This module
 * answers that: market questions instead of addresses, an explicit BUY line
 * with the stake, and a link to each market so any claim can be checked.
 */

import type { RunReport, Candidate } from "../agent/trader.js";

const RESET = "[0m";
const BOLD = "[1m";
const DIM = "[2m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const CYAN = "[36m";

const useColour =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const c = (code: string, s: string): string =>
  useColour ? `${code}${s}${RESET}` : s;

const usd = (n: number): string => `${n.toFixed(2)} USDC`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const rule = (): string => "─".repeat(72);

function untilSettlement(settlesAt: string | null, now: Date): string {
  if (!settlesAt) return "settlement date unknown";
  const ms = new Date(settlesAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "settlement date unreadable";
  if (ms <= 0) return "settling now";
  const days = ms / 86_400_000;
  if (days >= 1) return `settles in ${days.toFixed(1)} days`;
  return `settles in ${(days * 24).toFixed(1)} hours`;
}

function describeCandidate(
  candidate: Candidate,
  rank: number,
  now: Date,
): string[] {
  const e = candidate.evaluation;
  const question = candidate.market.metadata?.question ?? candidate.market.id;
  const shares = Number(candidate.sharesOut) / 1e18;
  const returnIfRight = shares * e.payoutPerShare;

  const lines = [
    `${c(BOLD, `#${rank}`)} ${c(BOLD, question)}`,
    `    ${c(GREEN, `BUY "${candidate.outcomeLabel}"`)}  ` +
      `stake ${c(BOLD, usd(e.cost))}  →  ${shares.toFixed(4)} shares`,
    `    our estimate ${c(CYAN, pct(e.probability))} vs market ${pct(e.marketProbability)}` +
      `  ${DIM ? c(DIM, `(breakeven ${pct(e.breakevenProbability)})`) : ""}`,
    `    if right: ${usd(e.payoutPerShare)}/share  →  ${c(BOLD, usd(returnIfRight))} back` +
      `   ${c(DIM, `(risking ${usd(e.cost)})`)}`,
    `    edge ${pct(e.realEdge)}   expected value ${usd(e.ev)}   ` +
      `confidence ${pct(candidate.confidence)}   ${untilSettlement(candidate.market.settlesAt, now)}`,
  ];

  // Flag the regime where the payout model is least trustworthy.
  if (e.payoutPerShare > 20 || e.shareOfMarket > 0.15) {
    lines.push(
      `    ${c(YELLOW, "! thin market")} — we would be ${pct(e.shareOfMarket)} of tradeable supply; ` +
        `treat the payout as optimistic`,
    );
  }
  if (candidate.market.marketUrl) {
    lines.push(`    ${c(DIM, candidate.market.marketUrl)}`);
  }
  return lines;
}

export interface PresentOptions {
  dryRun: boolean;
  /** Question text per market address, for positions held. */
  questions?: Map<string, string>;
  now?: Date;
}

export function present(r: RunReport, options: PresentOptions): string {
  const now = options.now ?? new Date();
  const out: string[] = [];
  const questions = options.questions ?? new Map<string, string>();

  out.push("");
  out.push(c(BOLD, "PORTFOLIO"));
  out.push(`  wallet    ${r.walletAddress}`);
  out.push(`  cash      ${usd(r.cashUsdc)}`);
  out.push(`  bankroll  ${usd(r.bankrollUsdc)}  ${c(DIM, "(cash + open positions)")}`);

  if (r.sweep.redeemed.length || r.sweep.liquidated.length) {
    const total =
      [...r.sweep.redeemed, ...r.sweep.liquidated].reduce(
        (a, x) => a + Number(x.tokensOut) / 1e6,
        0,
      );
    out.push(
      `  ${c(GREEN, "reclaimed")} ${usd(total)} from ` +
        `${r.sweep.redeemed.length} settled / ${r.sweep.liquidated.length} expired markets`,
    );
  }

  if (r.halted) {
    out.push("");
    out.push(c(RED, `HALTED: ${r.halted}`));
    return out.join("\n");
  }

  out.push("");
  out.push(
    c(BOLD, "SCAN") +
      `  ${r.marketsFetched} markets fetched · ${r.marketsEvaluated} analysed · ` +
      `${r.candidates.length} worth trading`,
  );

  if (r.candidates.length === 0) {
    out.push("");
    out.push("  Nothing met the bar this run. Most common reasons:");
    const counts = new Map<string, number>();
    for (const s of r.skips) {
      const key = s.reason.replace(/[\d.]+/g, "N").slice(0, 60);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [reason, n] of [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      out.push(`    ${String(n).padStart(3)}x  ${reason}`);
    }
  } else {
    out.push("");
    out.push(c(BOLD, "CANDIDATES") + c(DIM, "  (best return per USDC per day first)"));
    out.push(rule());
    r.candidates.forEach((candidate, i) => {
      out.push(...describeCandidate(candidate, i + 1, now));
      out.push("");
    });
  }

  out.push(rule());
  const executed = r.executions.filter((e) => e.result.status === "executed");
  const dryRun = r.executions.filter((e) => e.result.status === "dry-run");

  if (options.dryRun) {
    out.push(
      c(BOLD, "DRY RUN") +
        ` — nothing was signed. Would have traded ${dryRun.length} of ` +
        `${r.candidates.length} candidates.`,
    );
    for (const { candidate, result } of r.executions) {
      if (result.status !== "dry-run") continue;
      out.push(
        `  would spend ${usd(Number(result.wouldSpend) / 1e6)} on ` +
          `"${candidate.outcomeLabel}" in ${candidate.market.metadata?.question ?? candidate.market.id}`,
      );
    }
    out.push("");
    out.push(c(DIM, "  To trade for real:  npm run live:one   (sends ONE trade)"));
  } else if (executed.length === 0) {
    out.push(c(BOLD, "NO TRADES SENT"));
    for (const { candidate, result } of r.executions) {
      if (result.status === "skipped" || result.status === "failed") {
        out.push(
          `  ${result.status}: ${candidate.market.metadata?.question ?? candidate.market.id}`,
        );
        out.push(`    ${result.reason}`);
      }
    }
  } else {
    out.push(c(GREEN, c(BOLD, `TRADED (${executed.length})`)));
    for (const { candidate, result } of executed) {
      if (result.status !== "executed") continue;
      const spent = Number(result.filledTokensIn) / 1e6;
      const quoted = Number(result.quotedTokensIn) / 1e6;
      const shares = Number(candidate.sharesOut) / 1e18;
      out.push("");
      out.push(`  ${c(BOLD, candidate.market.metadata?.question ?? candidate.market.id)}`);
      out.push(
        `    bought ${c(BOLD, `"${candidate.outcomeLabel}"`)} · ` +
          `${shares.toFixed(4)} shares for ${c(BOLD, usd(spent))}`,
      );
      out.push(
        `    quoted ${usd(quoted)} → filled ${usd(spent)}` +
          (quoted > 0
            ? `  ${c(DIM, `(slippage ${pct(spent / quoted - 1)})`)}`
            : ""),
      );
      out.push(`    ${untilSettlement(candidate.market.settlesAt, now)}`);
      out.push(`    tx ${result.transactionHash}`);
      if (candidate.market.marketUrl) out.push(`    ${candidate.market.marketUrl}`);
    }
  }

  if (r.positionsHeld && r.positionsHeld.length > 0) {
    out.push("");
    out.push(c(BOLD, "OPEN POSITIONS"));
    for (const p of r.positionsHeld) {
      const label = questions.get(p.marketAddress.toLowerCase()) ?? p.marketAddress;
      const shares = Number(p.shares) / 1e18;
      out.push(
        `  ${shares.toFixed(4)} shares of outcome ${p.outcomeIdx} · ${p.marketStatus}` +
          (p.markUsdc !== null ? ` · worth ~${usd(p.markUsdc)}` : " · value unknown"),
      );
      out.push(`    ${label}`);
    }
  }

  out.push("");
  return out.join("\n");
}
