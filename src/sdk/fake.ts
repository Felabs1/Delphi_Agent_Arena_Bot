/**
 * In-memory Delphi with a real Dynamic Parimutuel engine behind it.
 *
 * This is not a stub that returns canned numbers: buys move the pool and the
 * outcome supplies through the same cost function the chain uses, so quotes
 * stay self-consistent, slippage is real, and self-dilution actually happens.
 * That is what makes the Stage 1 suite a specification rather than a mirror of
 * the implementation.
 */

import {
  costToBuy,
  proceedsFromSell,
  sumTerm36,
  isqrt,
  payoutPerShare,
  SHARE_SCALE,
  shares as toShareUnits,
} from "../agent/dpm.js";
import type {
  Address,
  DelphiPort,
  DpmState,
  ListMarketsParams,
  Market,
  MarketMetadata,
  MarketStatus,
  Position,
  QuoteBuyResult,
  QuoteLiquidateResult,
  QuoteRedeemResult,
  QuoteSellResult,
  RedeemResult,
  TradeReceipt,
} from "./port.js";

export interface FakeMarketSpec {
  id: string;
  question: string;
  outcomes: string[];
  /** Initial share supply per outcome, as plain share counts. */
  supplies: number[];
  /** Liquidity parameter, plain USDC scale. Default 1.0. */
  k?: number;
  /** Trading fee as a fraction, e.g. 0.02 for 2%. Default 0. */
  tradingFee?: number;
  status?: MarketStatus;
  category?: string;
  verifiable?: boolean;
  /** ISO timestamp the market settles at. */
  settlesAt?: string;
  winningOutcomeIdx?: number;
  /** Judge model that will settle this market. */
  judgeModel?: string;
  promptContext?: string;
  /** Creator refund reserved out of the pool, plain USDC. */
  refund?: number;
  /** Shares the creator holds in every outcome (excluded from redemption). */
  creatorSharesPerOutcome?: number;
}

export interface RecordedTrade {
  marketAddress: Address;
  outcomeIdx: number;
  sharesOut: bigint;
  tokensIn: bigint;
  side: "buy" | "sell";
}

const ADDR = (s: string): Address =>
  (s.startsWith("0x") ? s : `0x${s}`) as Address;

export class FakeDelphi implements DelphiPort {
  readonly trades: RecordedTrade[] = [];
  readonly approvals = new Map<string, bigint>();
  /** Set by tests to make a specific call fail. */
  failNextBuy: string | null = null;

  private wallet: Address = ADDR("0x00000000000000000000000000000000000a9e17");
  private tokenBalance: bigint;
  private ethBalance = 10n ** 18n;
  private readonly states = new Map<string, DpmState>();
  private readonly markets = new Map<string, Market>();
  private readonly holdings = new Map<string, bigint>(); // `${market}:${idx}`
  private readonly redeemed = new Set<string>();
  private minShares = toShareUnits(0.01);
  private minTokens = 1_000n; // 0.001 USDC

  constructor(specs: FakeMarketSpec[] = [], startingBalanceUsdc = 1_000) {
    this.tokenBalance = BigInt(Math.round(startingBalanceUsdc * 1e6));
    for (const spec of specs) this.addMarket(spec);
  }

  addMarket(spec: FakeMarketSpec): void {
    const supplies = spec.supplies.map((n) => toShareUnits(n));
    const st = sumTerm36(supplies);
    const k = BigInt(Math.round((spec.k ?? 1) * 1e18)); // WAD-scaled, as on-chain
    const pool = (k * isqrt(st)) / 10n ** 30n;
    const address = ADDR(spec.id);

    this.states.set(address.toLowerCase(), {
      marketAddress: address,
      outcomeCount: supplies.length,
      k,
      tradingFee: BigInt(Math.round((spec.tradingFee ?? 0) * 1e18)),
      tradingDeadline: BigInt(
        Math.floor(new Date(spec.settlesAt ?? nextWeek()).getTime() / 1000),
      ),
      settlementDeadline: BigInt(
        Math.floor(new Date(spec.settlesAt ?? nextWeek()).getTime() / 1000) +
          86_400,
      ),
      pool,
      initialPool: pool,
      tradingFees: 0n,
      refund: BigInt(Math.round((spec.refund ?? 0) * 1e6)),
      sumTerm36: st,
      supplies,
      creatorSharesPerOutcome: toShareUnits(spec.creatorSharesPerOutcome ?? 0),
    });

    const metadata: MarketMetadata = {
      question: spec.question,
      outcomes: spec.outcomes,
      ...(spec.judgeModel || spec.promptContext
        ? {
            model: {
              model_identifier: spec.judgeModel,
              prompt_context: spec.promptContext,
            },
          }
        : {}),
    };

    this.markets.set(address.toLowerCase(), {
      id: address,
      appMarketId: `app-${spec.id}`,
      marketUrl: `https://app.delphi.fyi/market/${spec.id}`,
      status: spec.status ?? "open",
      category: spec.category ?? "miscellaneous",
      deployer: ADDR("0x00000000000000000000000000000000dead0001"),
      implementation: ADDR("0x00000000000000000000000000000000imp00001"),
      metadataUri: `ipfs://${spec.id}`,
      metadataUriContentHash: "0x00",
      metadata,
      dataSources: null,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      fetchedAt: new Date().toISOString(),
      fetchResponseStatus: "200",
      resolvesAt: spec.settlesAt ?? nextWeek(),
      settledAt: spec.status === "settled" ? new Date().toISOString() : null,
      settlesAt: spec.settlesAt ?? nextWeek(),
      winningOutcomeIdx:
        spec.winningOutcomeIdx === undefined
          ? null
          : String(spec.winningOutcomeIdx),
      tradingFee: String(BigInt(Math.round((spec.tradingFee ?? 0) * 1e18))),
      proof: null,
      error: null,
      verifiable: spec.verifiable ?? true,
    });
  }

  /** Give a wallet a position without going through the market. */
  seedPosition(marketId: string, outcomeIdx: number, shareCount: number): void {
    const key = `${ADDR(marketId).toLowerCase()}:${outcomeIdx}`;
    this.holdings.set(
      key,
      (this.holdings.get(key) ?? 0n) + toShareUnits(shareCount),
    );
  }

  /** Force a market into a terminal state, as the oracle would. */
  settle(marketId: string, winningOutcomeIdx: number): void {
    const m = this.mustMarket(marketId);
    m.status = "settled";
    m.winningOutcomeIdx = String(winningOutcomeIdx);
    m.settledAt = new Date().toISOString();
    this.mustState(marketId).supplies; // touch for symmetry
  }

  expire(marketId: string, status: "expired" | "failed" = "expired"): void {
    this.mustMarket(marketId).status = status;
  }

  setTokenBalance(usdc: number): void {
    this.tokenBalance = BigInt(Math.round(usdc * 1e6));
  }

  // ---------------------------------------------------------------- reads

  async getWalletAddress(): Promise<Address> {
    return this.wallet;
  }
  async getTokenBalance(): Promise<bigint> {
    return this.tokenBalance;
  }
  async getEthBalance(): Promise<bigint> {
    return this.ethBalance;
  }
  async getTradeMinimums(): Promise<{ minShares: bigint; minTokens: bigint }> {
    return { minShares: this.minShares, minTokens: this.minTokens };
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    let out = [...this.markets.values()];
    if (params.status) out = out.filter((m) => m.status === params.status);
    if (params.category) out = out.filter((m) => m.category === params.category);
    if (params.verifiable !== undefined) {
      out = out.filter((m) => m.verifiable === params.verifiable);
    }
    if (params.orderBy === "settles_at") {
      out.sort((a, b) => (a.settlesAt ?? "").localeCompare(b.settlesAt ?? ""));
    }
    const skip = params.skip ?? 0;
    out = out.slice(skip, skip + (params.limit ?? 50));
    return out.map((m) =>
      params.pricesAndImpliedProbabilities ? this.withPrices(m) : { ...m },
    );
  }

  async getMarket(id: string, withPrices = false): Promise<Market> {
    const m = this.mustMarket(id);
    return withPrices ? this.withPrices(m) : { ...m };
  }

  async getMarketStatus(marketAddress: Address): Promise<MarketStatus> {
    return this.mustMarket(marketAddress).status;
  }

  async getDpmState(marketAddress: Address): Promise<DpmState> {
    const s = this.mustState(marketAddress);
    return { ...s, supplies: [...s.supplies] };
  }

  async listPositions(_wallet: string): Promise<Position[]> {
    const out: Position[] = [];
    for (const [key, shareAmount] of this.holdings) {
      const [market, idx] = key.split(":") as [string, string];
      const m = this.markets.get(market);
      if (!m) continue;
      out.push({
        id: key,
        marketProxy: m.id,
        wallet: this.wallet,
        outcomeIdx: idx,
        shares: shareAmount.toString(),
        redeemedOrLiquidated: this.redeemed.has(key),
        tokensRedeemed: "0",
        marketStatus: m.status,
      });
    }
    return out;
  }

  // --------------------------------------------------------------- quotes

  async quoteBuy(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
  }): Promise<QuoteBuyResult> {
    const state = this.mustState(p.marketAddress);
    return { tokensIn: costToBuy(state, p.outcomeIdx, p.sharesOut) };
  }

  async quoteSell(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
  }): Promise<QuoteSellResult> {
    const state = this.mustState(p.marketAddress);
    return { tokensOut: proceedsFromSell(state, p.outcomeIdx, p.sharesIn) };
  }

  async quoteRedeem(p: { marketAddress: Address }): Promise<QuoteRedeemResult> {
    const m = this.mustMarket(p.marketAddress);
    if (m.status !== "settled" || m.winningOutcomeIdx === null) {
      throw new Error("quoteRedeem: market is not settled");
    }
    const idx = Number(m.winningOutcomeIdx);
    const state = this.mustState(p.marketAddress);
    const held = this.holdings.get(`${m.id.toLowerCase()}:${idx}`) ?? 0n;
    const per = payoutPerShare(
      state.pool - state.refund,
      state.supplies[idx] ?? 0n,
      state.creatorSharesPerOutcome,
    );
    return { sharesIn: held, tokensOut: (held * per) / SHARE_SCALE };
  }

  async quoteLiquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<QuoteLiquidateResult> {
    const state = this.mustState(p.marketAddress);
    const m = this.mustMarket(p.marketAddress);
    const totalSupply = state.supplies.reduce((a, b) => a + b, 0n);
    const sharesIn: bigint[] = [];
    let total = 0n;
    for (const idx of p.outcomeIndices) {
      const held = this.holdings.get(`${m.id.toLowerCase()}:${idx}`) ?? 0n;
      sharesIn.push(held);
      if (totalSupply > 0n) total += (state.pool * held) / totalSupply;
    }
    return { sharesIn, totalTokensOut: total };
  }

  // -------------------------------------------------------------- writes

  async ensureTokenApproval(p: {
    marketAddress: Address;
    minimumAmount: bigint;
  }): Promise<void> {
    const key = p.marketAddress.toLowerCase();
    const current = this.approvals.get(key) ?? 0n;
    if (current < p.minimumAmount) this.approvals.set(key, p.minimumAmount);
  }

  async buyShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
    maxTokensIn: bigint;
  }): Promise<TradeReceipt> {
    if (this.failNextBuy) {
      const msg = this.failNextBuy;
      this.failNextBuy = null;
      throw new Error(msg);
    }
    const key = p.marketAddress.toLowerCase();
    const market = this.mustMarket(p.marketAddress);
    if (market.status !== "open") {
      throw new Error(`buyShares: market is ${market.status}, not open`);
    }
    const state = this.mustState(p.marketAddress);
    if (p.sharesOut < this.minShares) {
      throw new Error("buyShares: below MIN_SHARES_DELTA");
    }

    const tokensIn = costToBuy(state, p.outcomeIdx, p.sharesOut);
    // The contract reverts rather than filling above the caller's cap.
    if (tokensIn > p.maxTokensIn) {
      throw new Error(
        `buyShares: slippage — cost ${tokensIn} exceeds maxTokensIn ${p.maxTokensIn}`,
      );
    }
    if ((this.approvals.get(key) ?? 0n) < tokensIn) {
      throw new Error("buyShares: insufficient token allowance");
    }
    if (tokensIn > this.tokenBalance) {
      throw new Error("buyShares: insufficient balance");
    }

    const supplies = state.supplies.slice();
    const prev = supplies[p.outcomeIdx];
    if (prev === undefined) throw new RangeError("buyShares: bad outcomeIdx");
    supplies[p.outcomeIdx] = prev + p.sharesOut;

    const fee = (tokensIn * state.tradingFee) / 10n ** 18n; // grossed-up: fee = tokensIn * f
    this.states.set(key, {
      ...state,
      supplies,
      sumTerm36: sumTerm36(supplies),
      pool: state.pool + (tokensIn - fee),
      tradingFees: state.tradingFees + fee,
    });

    this.tokenBalance -= tokensIn;
    this.approvals.set(key, (this.approvals.get(key) ?? 0n) - tokensIn);
    const hkey = `${key}:${p.outcomeIdx}`;
    this.holdings.set(hkey, (this.holdings.get(hkey) ?? 0n) + p.sharesOut);
    this.trades.push({
      marketAddress: p.marketAddress,
      outcomeIdx: p.outcomeIdx,
      sharesOut: p.sharesOut,
      tokensIn,
      side: "buy",
    });

    return { transactionHash: ADDR(`0xbuy${this.trades.length}`) };
  }

  async sellShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
    minTokensOut: bigint;
  }): Promise<TradeReceipt> {
    const key = p.marketAddress.toLowerCase();
    const state = this.mustState(p.marketAddress);
    const tokensOut = proceedsFromSell(state, p.outcomeIdx, p.sharesIn);
    if (tokensOut < p.minTokensOut) {
      throw new Error("sellShares: slippage — proceeds below minTokensOut");
    }
    const hkey = `${key}:${p.outcomeIdx}`;
    const held = this.holdings.get(hkey) ?? 0n;
    if (held < p.sharesIn) throw new Error("sellShares: insufficient shares");

    const supplies = state.supplies.slice();
    const prev = supplies[p.outcomeIdx];
    if (prev === undefined) throw new RangeError("sellShares: bad outcomeIdx");
    supplies[p.outcomeIdx] = prev - p.sharesIn;

    this.states.set(key, {
      ...state,
      supplies,
      sumTerm36: sumTerm36(supplies),
      pool: state.pool - tokensOut,
    });
    this.holdings.set(hkey, held - p.sharesIn);
    this.tokenBalance += tokensOut;
    this.trades.push({
      marketAddress: p.marketAddress,
      outcomeIdx: p.outcomeIdx,
      sharesOut: p.sharesIn,
      tokensIn: -tokensOut,
      side: "sell",
    });
    return { transactionHash: ADDR(`0xsell${this.trades.length}`) };
  }

  async redeemMarket(p: { marketAddress: Address }): Promise<RedeemResult> {
    const m = this.mustMarket(p.marketAddress);
    if (m.status !== "settled") {
      throw new Error(`redeemMarket: market is ${m.status}, not settled`);
    }
    const { sharesIn, tokensOut } = await this.quoteRedeem(p);
    const idx = Number(m.winningOutcomeIdx);
    const hkey = `${m.id.toLowerCase()}:${idx}`;
    this.holdings.set(hkey, 0n);
    this.redeemed.add(hkey);
    this.tokenBalance += tokensOut;
    return {
      marketAddress: p.marketAddress,
      transactionHash: ADDR("0xredeem"),
      sharesIn,
      tokensOut,
    };
  }

  async liquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<RedeemResult> {
    const m = this.mustMarket(p.marketAddress);
    if (m.status !== "expired" && m.status !== "failed") {
      throw new Error(`liquidate: market is ${m.status}`);
    }
    const { sharesIn, totalTokensOut } = await this.quoteLiquidate(p);
    for (const idx of p.outcomeIndices) {
      const hkey = `${m.id.toLowerCase()}:${idx}`;
      this.holdings.set(hkey, 0n);
      this.redeemed.add(hkey);
    }
    this.tokenBalance += totalTokensOut;
    return {
      marketAddress: p.marketAddress,
      transactionHash: ADDR("0xliquidate"),
      sharesIn: sharesIn.reduce((a, b) => a + b, 0n),
      tokensOut: totalTokensOut,
    };
  }

  // ------------------------------------------------------------- helpers

  private withPrices(m: Market): Market {
    const state = this.mustState(m.id);
    const root = isqrt(state.sumTerm36);
    const st = state.sumTerm36;
    return {
      ...m,
      spotPrices: state.supplies.map((q) =>
        root === 0n ? 0 : Number((state.k * q) / (root * 10n ** 12n)) / 1e6,
      ),
      spotImpliedProbabilities: state.supplies.map((q) =>
        st === 0n ? 0 : Number((q * q * 10n ** 18n) / st) / 1e18,
      ),
    };
  }

  private mustMarket(id: string): Market {
    const m = this.markets.get(ADDR(id).toLowerCase());
    if (!m) throw new Error(`unknown market ${id}`);
    return m;
  }

  private mustState(id: string): DpmState {
    const s = this.states.get(ADDR(id).toLowerCase());
    if (!s) throw new Error(`unknown market state ${id}`);
    return s;
  }
}

const nextWeek = (): string =>
  new Date(Date.now() + 7 * 86_400_000).toISOString();
