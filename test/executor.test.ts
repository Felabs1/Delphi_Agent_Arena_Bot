/**
 * Execution safety: the gap between deciding and sending.
 */

import { describe, expect, it } from "vitest";
import {
  MemoryJournal,
  execute,
  sweepResolvedPositions,
  type ExecutorConfig,
  type TradeIntent,
} from "../src/agent/executor.js";
import { FakeDelphi } from "../src/sdk/fake.js";
import { shares, toUsdc } from "../src/agent/dpm.js";
import type { Address } from "../src/sdk/port.js";

const MARKET = "0x00000000000000000000000000000000000000a1";

const config = (over: Partial<ExecutorConfig> = {}): ExecutorConfig => ({
  slippageTolerance: 0.02,
  maxRequoteDrift: 0.03,
  minimumEvPerToken: 0.01,
  payoutModel: { creatorHaircut: 0, feeToPoolFraction: 1 },
  ...over,
});

function setup() {
  const port = new FakeDelphi(
    [
      {
        id: MARKET,
        question: "Will it rain?",
        outcomes: ["Yes", "No"],
        supplies: [200, 800],
      },
    ],
    1000,
  );
  return { port, journal: new MemoryJournal() };
}

async function intent(
  port: FakeDelphi,
  sharesOut = shares(20),
  probability = 0.6,
): Promise<TradeIntent> {
  const { tokensIn } = await port.quoteBuy({
    marketAddress: MARKET as Address,
    outcomeIdx: 0,
    sharesOut,
  });
  return {
    id: "run-1:market-a:0",
    marketAddress: MARKET as Address,
    outcomeIdx: 0,
    sharesOut,
    quotedTokensIn: tokensIn,
    probability,
  };
}

describe("execute", () => {
  it("buys when the edge survives the re-quote", async () => {
    const { port, journal } = setup();
    const result = await execute(await intent(port), port, journal, config());

    expect(result.status).toBe("executed");
    expect(port.trades).toHaveLength(1);
    expect(port.trades[0]!.side).toBe("buy");
  });

  it("approves the token before buying", async () => {
    const { port, journal } = setup();
    await execute(await intent(port), port, journal, config());
    // The fake reverts on insufficient allowance, so a successful buy proves it.
    expect(port.trades).toHaveLength(1);
  });

  it("caps spend with a slippage-adjusted maxTokensIn", async () => {
    const { port, journal } = setup();
    const i = await intent(port);
    const result = await execute(i, port, journal, config());
    expect(result.status).toBe("executed");
    if (result.status === "executed") {
      expect(result.filledTokensIn).toBeLessThanOrEqual(
        (i.quotedTokensIn * 102n) / 100n,
      );
    }
  });

  it("skips when the market moved against us since evaluation", async () => {
    const { port, journal } = setup();
    const i = await intent(port);

    // Someone else buys the same side, pushing our cost up.
    await port.ensureTokenApproval({
      marketAddress: MARKET as Address,
      minimumAmount: 10n ** 12n,
    });
    await port.buyShares({
      marketAddress: MARKET as Address,
      outcomeIdx: 0,
      sharesOut: shares(300),
      maxTokensIn: 10n ** 12n,
    });

    const result = await execute(i, port, journal, config());
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toMatch(/price moved/);
  });

  it("skips a fairly-priced trade that clears the drift cap but not the EV bar", async () => {
    const { port, journal } = setup();
    // Market implies 200^2/(200^2+800^2) = 5.88% for outcome 0. Believing
    // exactly that leaves no edge, so nothing moved but there is nothing to win.
    const i = await intent(port, shares(20), 0.0588);
    const result = await execute(
      i,
      port,
      journal,
      config({ minimumEvPerToken: 0.01 }),
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toMatch(/EV\/token/);
    expect(port.trades).toHaveLength(0);
  });

  it("skips when the market is no longer open", async () => {
    const { port, journal } = setup();
    const i = await intent(port);
    port.settle(MARKET, 0);
    const result = await execute(i, port, journal, config());
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toMatch(/not open/);
  });

  it("skips when the balance cannot cover the trade", async () => {
    const { port, journal } = setup();
    const i = await intent(port);
    port.setTokenBalance(0.01);
    const result = await execute(i, port, journal, config());
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toMatch(/insufficient balance/);
    }
  });

  it("reports failure without throwing when the send reverts", async () => {
    const { port, journal } = setup();
    const i = await intent(port);
    port.failNextBuy = "execution reverted: MinSharesDelta";
    const result = await execute(i, port, journal, config());
    expect(result.status).toBe("failed");
    expect(port.trades).toHaveLength(0);
  });

  it("does nothing in dry-run mode", async () => {
    const { port, journal } = setup();
    const result = await execute(
      await intent(port),
      port,
      journal,
      config({ dryRun: true }),
    );
    expect(result.status).toBe("dry-run");
    expect(port.trades).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("does not re-send an intent that was already attempted", async () => {
    const { port, journal } = setup();
    const i = await intent(port);

    await execute(i, port, journal, config());
    expect(port.trades).toHaveLength(1);

    const replay = await execute(i, port, journal, config());
    expect(replay.status).toBe("skipped");
    expect(port.trades).toHaveLength(1);
  });

  it("does not re-send after a crash between journal and confirmation", async () => {
    const { port, journal } = setup();
    const i = await intent(port);
    port.failNextBuy = "network timeout";

    // The attempt is journalled before sending, so a timeout leaves it recorded.
    await execute(i, port, journal, config());
    const replay = await execute(i, port, journal, config());

    expect(replay.status).toBe("skipped");
    if (replay.status === "skipped") {
      expect(replay.reason).toMatch(/already attempted/);
    }
    expect(port.trades).toHaveLength(0);
  });
});

describe("sweeping resolved positions", () => {
  it("redeems settled winners", async () => {
    const port = new FakeDelphi(
      [
        {
          id: MARKET,
          question: "Settled?",
          outcomes: ["Yes", "No"],
          supplies: [200, 800],
        },
      ],
      1000,
    );
    port.seedPosition(MARKET, 0, 50);
    port.settle(MARKET, 0);

    const before = await port.getTokenBalance();
    const sweep = await sweepResolvedPositions(port);

    expect(sweep.redeemed).toHaveLength(1);
    expect(sweep.errors).toHaveLength(0);
    expect(await port.getTokenBalance()).toBeGreaterThan(before);
    // Payout is pool-derived, so it is emphatically not 1 USDC per share.
    expect(toUsdc(sweep.redeemed[0]!.tokensOut)).toBeGreaterThan(50);
  });

  it("liquidates markets that failed to resolve", async () => {
    const port = new FakeDelphi(
      [
        {
          id: MARKET,
          question: "Unresolvable?",
          outcomes: ["Yes", "No"],
          supplies: [200, 800],
        },
      ],
      1000,
    );
    port.seedPosition(MARKET, 0, 50);
    port.expire(MARKET, "failed");

    const sweep = await sweepResolvedPositions(port);
    expect(sweep.liquidated).toHaveLength(1);
    expect(sweep.liquidated[0]!.tokensOut).toBeGreaterThan(0n);
  });

  it("leaves open positions alone", async () => {
    const port = new FakeDelphi(
      [
        {
          id: MARKET,
          question: "Open?",
          outcomes: ["Yes", "No"],
          supplies: [200, 800],
        },
      ],
      1000,
    );
    port.seedPosition(MARKET, 0, 50);

    const sweep = await sweepResolvedPositions(port);
    expect(sweep.redeemed).toHaveLength(0);
    expect(sweep.liquidated).toHaveLength(0);
  });

  it("skips zero-share rows that would revert on-chain", async () => {
    const port = new FakeDelphi(
      [
        {
          id: MARKET,
          question: "Settled?",
          outcomes: ["Yes", "No"],
          supplies: [200, 800],
        },
      ],
      1000,
    );
    port.seedPosition(MARKET, 0, 0);
    port.settle(MARKET, 0);

    const sweep = await sweepResolvedPositions(port);
    expect(sweep.redeemed).toHaveLength(0);
    expect(sweep.errors).toHaveLength(0);
  });
});
