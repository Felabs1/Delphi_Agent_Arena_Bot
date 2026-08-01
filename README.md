# Delphi Agent Arena Bot

A modular AI-powered prediction market trading agent built for the **Gensyn Delphi Agent Arena Competition**.

The agent continuously evaluates Delphi prediction markets, estimates the probability of each outcome using AI and external information, compares those estimates against what the market actually charges, and executes trades whenever it detects a real, quantifiable edge.

**Goal:** finish the competition with the highest Profit & Loss (P&L).

---

## Philosophy

The agent should never gamble. Every trade must be backed by data and a measurable edge.

Instead of asking:

> "Who will win?"

it asks:

> "Does the market price accurately represent reality?"

A trade only fires when the estimated probability differs meaningfully from the market's **breakeven** probability **and** that difference survives slippage, fees, sizing, and risk checks.

**Guiding principle:** Don't predict the future. Predict when the market is wrong.

---

## Market mechanism: Dynamic Parimutuel

> Earlier drafts of this README hedged between LMSR and dynamic parimutuel. **It is DPM.** This is settled, not assumed: the SDK exports `DYNAMIC_PARIMUTUEL_GATEWAY_ABI`, the gateway's market struct carries `k` / `pool` / `sumTerm36`, and Gensyn's trading reference states that spot price *"is **not** equal to the implied probability. These two values diverge in DPMs."*

This is the single most important fact in the codebase. Reconstructed from the gateway's on-chain state layout, with `qᵢ` the share supply of outcome `i`:

```
sumTerm36 = Σ qⱼ²                    (36-dec: squares of 18-dec supplies)
price_i   = k · q_i / √sumTerm36     (marginal USDC per share)
pool      = k · √sumTerm36
prob_i    = q_i² / sumTerm36         (implied probability)
payout_i  = pool / q_i               (USDC per WINNING share)
```

Two identities follow, and both are asserted in the test suite:

| Identity | Meaning |
|---|---|
| `Σ prob_i = 1` | probabilities are well-formed |
| `price_i · payout_i = k²` | price and payout are reciprocal |

Together they give `prob_i = (price_i / k)²` — **the implied probability is the *square* of the normalised price.** That is exactly why spot price and implied probability diverge.

### Why this matters more than anything else

**A winning share does not pay 1 USDC.** It pays `pool / winning_supply`, which can be far more or far less.

For a market with supplies `[1200, 800, 400]` and `k = 1`:

| Outcome | Implied prob | Spot price | Payout/share | EV if you assume payout = 1 | True EV |
|---|---|---|---|---|---|
| 0 | 64.3% | 0.802 | 1.247 | −0.159 ❌ | 0.000 ✓ |
| 1 | 28.6% | 0.535 | 1.871 | −0.249 ❌ | 0.000 ✓ |
| 2 | 7.1% | 0.267 | 3.742 | −0.196 ❌ | 0.000 ✓ |

Assuming a fixed 1 USDC payout makes **every outcome in a perfectly fair market look negative-EV**. An agent built that way never trades, or trades on noise once thresholds are loosened to compensate.

### The edge that actually pays

Gensyn's reference `compute-edge.ts` computes `edge = your_prob − market_prob`. That is a *direction* indicator. It ignores the payout ratio, slippage, and fees. This agent computes:

```
payoutPerShare = (pool + tokensIn) / (supply_i + N)   ← your own buy dilutes you
grossIfWin     = N × payoutPerShare
breakeven  p*  = tokensIn / grossIfWin
realEdge       = p_true − p*
EV             = p_true × grossIfWin − tokensIn
```

At infinitesimal size `p*` converges to the market's implied probability — the one case where the naive formula is right. At every real size it is wrong, and always in the optimistic direction.

Three consequences the naive model misses:

- **Self-dilution.** Buying raises the pool but also your outcome's supply, lowering payout. EV is *concave* in size, so there is an interior optimum a multiplicative sizing rule cannot find.
- **Creator shares.** The creator holds shares in *every* outcome and is settled separately, so those shares leave the redemption denominator:
  `payoutPerShare = pool / (winningSupply − creatorSharesPerOutcome)`.
  Measured against every settled testnet market, this fits with **0.0000% error — median and worst case**. Dropping the term understates payout by up to **31%** on thin markets, always in the direction that makes a good trade look bad.
- **Locked capital.** DPM stakes are locked until settlement, so candidates are ranked by **EV per USDC per day**, not raw EV.

---

## Architecture

```
                   ┌──────────────────────┐
                   │  Delphi Competition  │
                   │       Markets        │
                   └──────────┬───────────┘
                    Fetch Available Markets
                              ▼
                  ┌────────────────────────┐
                  │    Market Fetcher      │
                  └──────────┬─────────────┘
                Filter: settles within trading window?
                              ▼
                  ┌────────────────────────┐
                  │  Data Collection Layer │
                  └──────────┬─────────────┘
         ┌───────────────────┼────────────────────┐
         ▼                   ▼                    ▼
      News APIs         Crypto APIs        Other APIs
         └───────────────────┼────────────────────┘
                             ▼
                  ┌────────────────────────┐
                  │  AI Decision Engine    │  ← also replicates the market's
                  └──────────┬─────────────┘    own AI settlement judge
             Estimate Probability + Confidence
                             ▼
                  ┌────────────────────────┐
                  │  DPM Expected Value    │  ← pool/supply payout, not 1 USDC
                  └──────────┬─────────────┘
                 realEdge ≥ min? Confidence ≥ threshold?
                ┌────────────┴────────────┐
                ▼                         ▼
             Ignore                  Risk Assessment
                                           ▼
                                  Fractional-Kelly Sizing
                                  (search real quotes)
                                           ▼
                                  Re-quote + slippage check
                                           ▼
                                 EV still positive?
                                ┌──────────┴──────────┐
                                ▼                     ▼
                             Ignore            Execute Trade
                                                      ▼
                                            Portfolio Update
                                                      ▼
                                                 Save State
```

---

## Folder Structure

TypeScript, because **the Delphi SDK is TypeScript-only** — there is no Python SDK. The README's original Python layout is preserved as module structure.

```
delphi-agent-arena-bot/
├── src/
│   ├── app.ts                # cron entrypoint: one pass, then exit
│   ├── config.ts             # env parsing + validation (zod), fails fast
│   ├── sdk/
│   │     ├── port.ts         # DelphiPort — the seam
│   │     ├── delphi.ts       # real adapter over DelphiClient      (Stage 2)
│   │     ├── gateway.ts      # raw DPM reads: pool, supplies, k    (Stage 2)
│   │     └── fake.ts         # in-memory DPM simulator for tests
│   ├── agent/
│   │     ├── dpm.ts          # DPM mathematics
│   │     ├── evaluator.ts    # expected-value engine
│   │     ├── strategy.ts     # shrinkage + fractional-Kelly sizing
│   │     ├── risk.ts         # exposure caps, correlation, drawdown
│   │     ├── executor.ts     # re-quote, slippage guard, idempotency
│   │     └── trader.ts       # pipeline orchestration
│   ├── ai/
│   │     ├── estimator.ts    # the probability-estimation seam
│   │     ├── llm.ts          # OpenRouter client: retries, timeout, budget
│   │     ├── prompts.ts      # analyst + judge-replication prompts
│   │     ├── cache.ts        # TTL + price-move invalidation
│   │     └── ensemble.ts     # triage -> ensemble, judge replication
│   ├── data/                 # news, crypto, sports, politics       (Stage 5)
│   ├── portfolio/
│   │     ├── portfolio.ts    # marks positions at real sell quotes
│   │     └── storage.ts      # SQLite persistence                  (Stage 6)
│   ├── calibration/          # Brier score, backtest, tuner         (Stage 8)
│   └── utils/logger.ts
├── test/                     # the executable specification
├── database/state.db
└── logs/
```

---

## Trading Pipeline

1. **Sweep resolved positions first** — redeem settled winners, liquidate `expired`/`failed`. Risk-free capital that funds this pass.
2. Value the book (positions marked at real sell quotes, not spot × shares)
3. Fetch markets, soonest-settling first
4. Filter: open, has metadata and prices, settles inside the competition window
5. Collect context (news, data feeds)
6. Estimate probabilities + confidence (LLM ensemble + settlement-judge replication)
7. Shrink estimate toward the market in proportion to confidence
8. Search real `quoteBuy` sizes for maximum expected log-wealth growth
9. Scale by fractional Kelly; clamp to caps and gateway minimums
10. Risk assessment (per-market, correlated-group, total exposure, drawdown)
11. Rank by EV per USDC per day
12. Re-quote immediately before sending; abort if the edge evaporated
13. Execute, journal, persist. Exit.

---

## AI Decision Engine

The LLM estimates probabilities — it does not make buy/sell recommendations. Sizing and execution belong to the agent, so a confident sentence can never override the EV math.

**The key insight:** every Delphi market names the AI judge that settles it, in `metadata.model.model_identifier`, along with its `prompt_context`. The prediction target is therefore **what that judge will rule**, not abstract ground truth. A separate judge-replication pass asks exactly that question, feeding the market's own context back in.

```json
{
  "probabilities": [0.71, 0.29],
  "confidence": 0.84,
  "reasoning": "...",
  "contradictions": "...",
  "uncertainty": "..."
}
```

Confidence is derived from **inter-model disagreement**, not from the model's self-reported number — self-reported confidence is not calibrated and tracks fluency rather than accuracy. Disagreement is a measurement, and it feeds the shrinkage in `strategy.ts`, so a split ensemble produces a small position instead of a confident wrong one.

### Cost control (free models by default)

Inference on a cron can easily outspend the winnings. A 3-model frontier ensemble over 50 markets costs ~$2/run — about **$600/day** at a 5-minute cadence. So:

| Tier | What runs | Cost |
|---|---|---|
| **Triage** | one cheap model screens every market | ~$0.0003/market |
| **Ensemble** | frontier models + judge replica, only where triage sees a gap ≥ `TRIAGE_GAP_THRESHOLD` | only for finalists |
| **Cache** | reused until TTL expires or the market repriced by `ESTIMATE_INVALIDATE_ON_MOVE` | free |

Defaults use OpenRouter's zero-cost `:free` tier. Measured on the same market, free matched paid closely:

| | Paid ensemble | Free ensemble |
|---|---|---|
| P(Yes) | 6.6% | 8.4% |
| Confidence | 77.5% | 74.4% |
| Model agreement | 94% | 92.3% |
| **Cost** | $0.0223 | **$0.00** |
| Wall clock | 19.2s | 81.5s |

Free tiers rate-limit, so every model slot accepts a `|`-separated fallback chain (`primary|backup|last-resort`). Paid models are skipped unless `ALLOW_PAID_FALLBACK=true`; when a market's actual judge is paid, a free model runs the judge *prompt* instead — most of the edge is in asking the literal-minded "what will the judge rule?" question, not in the specific weights answering it.

Verified working free models: `nvidia/nemotron-3-ultra-550b-a55b:free`, `openai/gpt-oss-20b:free`, `poolside/laguna-s-2.1:free`, `google/gemma-4-26b-a4b-it:free`, `openrouter/free`. Avoid `nvidia/nemotron-3-super-120b-a12b:free` (truncates into garbage).

### Calibration

LLM probabilities are not automatically well-calibrated:

- Backtest the prompt against already-resolved markets before trading
- Track a running Brier score and reliability curve as markets settle
- Re-tune `MINIMUM_EDGE` and `CONFIDENCE_THRESHOLD` from observed calibration, not intuition

---

## Risk Management

- Maximum position size (fraction of bankroll)
- Maximum exposure per market
- Maximum exposure across correlated markets (same underlying event, matched on entities/numbers/dates so rewordings collapse together)
- Maximum total exposure
- Daily and per-run trade caps
- Confidence threshold
- Minimum real edge and minimum EV per USDC
- Drawdown circuit breaker
- Skip markets with insufficient data
- Skip markets that won't settle before trading closes

On a testnet competition the faucet makes capital replenishable, so the drawdown breaker protects **P&L ranking**, not solvency: a model that has started losing is mis-calibrated, and the right response is to stop and re-calibrate.

---

## Position Sizing

Default: **confidence shrinkage + fractional Kelly over real quotes.**

```
p_effective = market_prob + confidence × (p_estimate − market_prob)
size        = argmax_N  E[log(wealth)]   subject to quoted cost
size       ×= KELLY_FRACTION
size        = clamp(size, gateway minimum, MAX_POSITION_SIZE × bankroll, available cash)
```

The README's original `Base × Confidence × Edge` is not used: it cannot find the interior EV optimum created by self-dilution, and it has no notion of bankroll, so a large edge sizes into ruin.

---

## Configuration

See [.env.example](.env.example) for the full annotated list.

```env
DELPHI_NETWORK=testnet
DELPHI_API_ACCESS_KEY=
WALLET_PRIVATE_KEY=
OPENROUTER_API_KEY=

CONFIDENCE_THRESHOLD=0.75
MINIMUM_EDGE=0.08          # gates realEdge, not naive edge
MAX_POSITION_SIZE=0.05
KELLY_FRACTION=0.35
MAX_DAILY_TRADES=30
```

Treat every threshold as a starting point — tune against calibration results.

---

## Development

```bash
npm install
npm test                              # 144 specs, fully offline
npm run typecheck
npm run dev                           # full pipeline on the DPM simulator
npx tsx src/app.ts --fake --dry-run
npm run smoke:ai                      # live OpenRouter check (free models, $0)
npm run dev:ai                        # full pipeline, simulated markets + live AI

npm run probe                         # live testnet: verify DPM identities on-chain
npm run validate:payout               # Stage 3 gate: model vs realised redemptions
```

Both live scripts are read-only — no signer, no transactions, no spend.

The test suite is the specification. It runs against `FakeDelphi`, an in-memory market with a **real DPM engine** — buys move the pool and supplies through the same cost curve as the chain, so quotes stay self-consistent, slippage is real, and self-dilution actually happens.

---

## Build Stages

| Stage | Scope | Status |
|---|---|---|
| 1 | Skeleton + executable spec, fully offline | ✅ done |
| 2 | Raw gateway reads + live probe: every DPM identity verified on-chain | ✅ done |
| 3 | **⚠️ Gate:** payout model validated against realised redemptions | ✅ **PASSED (0.0000% error)** |
| 4 | OpenRouter ensemble + settlement-judge replication | ✅ done |
| 5 | Data collection layer | pending |
| 6 | SQLite persistence, reconciliation, portfolio | pending |
| 7 | Live execution loop | pending |
| 8 | Calibration (Brier) + adaptive threshold tuning | pending |
| 9 | Deployment (Render Cron / Docker) | pending |

**Stage 3 is a hard gate.** The payout model is a hypothesis until measured against settled markets; trading on an unvalidated one is the most likely way to lose the competition while appearing to work.

---

## Tech Stack

**Core:** TypeScript, Node 20+, `@gensyn-ai/gensyn-delphi-sdk` v2, viem, SQLite, Zod, Vitest

**AI:** OpenRouter (multi-model ensemble, free tier by default)

**Network:** Gensyn Testnet (chain 685685) — faucet mints 1,000 mock USDC per call; gas is ETH bridged from Sepolia

**Deployment:** Render Cron Jobs, Docker (optional), GitHub Actions (optional)

---

## Future Improvements

- Bayesian updating across sequential signals
- Social media sentiment analysis
- Detect and fade other agents' flow via the Goldsky subgraph
- Real-time websocket support (if the SDK adds it)
- Adaptive risk management driven by live calibration
- Market-specific strategies (sports, crypto, politics modelled separately)
- Self-evaluation and prompt refinement
