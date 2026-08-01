/**
 * The seam between the agent's decision core and Delphi.
 *
 * Types mirror `@gensyn-ai/gensyn-delphi-sdk@2.0.0` field-for-field so the real
 * adapter (`delphi.ts`) is a drop-in and the fake (`fake.ts`) is honest.
 *
 * UNITS — the highest-risk detail in this codebase:
 *   shares  : 18 decimals (1e18 = 1 share)
 *   tokens  : 6 decimals  (1e6  = 1 USDC)
 *   sumTerm36: 36 decimals (sum of squared 18-dec supplies)
 *   tradingFee / implied probability on-chain: 18 decimals (1e18 = 100%)
 * `spotPrices` and `spotImpliedProbabilities` from the REST API are already
 * decimal-adjusted to plain floats by the SDK. On-chain reads are not.
 */

export type Address = `0x${string}`;

export type MarketStatus =
  | "open"
  | "awaiting_settlement"
  | "settled"
  | "expired"
  | "failed";

/** Statuses with no winning outcome — exit via `liquidate()`, not `redeem()`. */
export const LIQUIDATABLE_MARKET_STATUSES: readonly MarketStatus[] = [
  "expired",
  "failed",
];

export interface MarketMetadata {
  question: string;
  outcomes: string[];
  /**
   * The AI judge that settles this market. Our probability estimate should
   * predict *this model's ruling*, not abstract ground truth — it is what
   * actually determines payout.
   */
  model?: {
    model_identifier?: string;
    prompt_context?: string;
  };
  initial_liquidity?: string;
  initial_pool?: string;
  refund?: string;
  market_creation_fee?: string;
  version?: string;
  [key: string]: unknown;
}

export interface Market {
  /** On-chain market proxy address — the `marketAddress` for every SDK call. */
  id: string;
  appMarketId: string;
  marketUrl: string;
  status: MarketStatus;
  category: string | null;
  deployer: string;
  implementation: string;
  metadataUri: string;
  metadataUriContentHash: string;
  metadata: MarketMetadata | null;
  dataSources: unknown;
  createdAt: string;
  fetchedAt: string | null;
  fetchResponseStatus: string | null;
  resolvesAt: string | null;
  settledAt: string | null;
  settlesAt: string | null;
  winningOutcomeIdx: string | null;
  /** 18-decimal bigint string, e.g. "20000000000000000" = 2%. */
  tradingFee: string | null;
  proof: string | null;
  error: string | null;
  verifiable: boolean;
  /** Present only when `pricesAndImpliedProbabilities: true`. USDC per share. */
  spotPrices?: number[];
  /** Present only when `pricesAndImpliedProbabilities: true`. 0–1. */
  spotImpliedProbabilities?: number[];
}

export interface Position {
  id: string;
  marketProxy: string;
  wallet: string;
  /** Stringified integer. */
  outcomeIdx: string;
  /** 18-decimal bigint string. */
  shares: string;
  redeemedOrLiquidated: boolean;
  /** 6-decimal bigint string. */
  tokensRedeemed: string;
  marketStatus: MarketStatus;
}

export interface ListMarketsParams {
  skip?: number;
  limit?: number;
  orderBy?: "liquidity" | "created" | "settles_at";
  status?: MarketStatus;
  category?: string;
  verifiable?: boolean;
  pricesAndImpliedProbabilities?: boolean;
}

/**
 * Raw Dynamic Parimutuel state, read straight from the gateway contract.
 *
 * The REST API does not expose `pool` or the per-outcome supplies, but correct
 * expected-value math is impossible without them: under DPM the payout for a
 * winning share is `pool / supply[winner]`, not a fixed 1 USDC.
 */
export interface DpmState {
  marketAddress: Address;
  outcomeCount: number;
  /** Liquidity parameter `k`, 6-decimal (same scale as the token). */
  k: bigint;
  /** 18-decimal fraction, e.g. 2e16 = 2%. */
  tradingFee: bigint;
  /** Unix seconds. Trading is impossible after this. */
  tradingDeadline: bigint;
  /** Unix seconds. Past this with no winner, the market expires. */
  settlementDeadline: bigint;
  /** Collateral pool backing payouts, 6-decimal. */
  pool: bigint;
  initialPool: bigint;
  /** Accrued trading fees, 6-decimal. Not all of this reaches traders. */
  tradingFees: bigint;
  /** Creator refund reserved out of the pool, 6-decimal. */
  refund: bigint;
  /** `Σ qⱼ²` over outcome supplies, 36-decimal. */
  sumTerm36: bigint;
  /** Per-outcome share supply, 18-decimal. */
  supplies: bigint[];
  /**
   * Shares the market creator holds in EVERY outcome, 18-decimal.
   *
   * Settlement values these separately, so they are excluded from the
   * redemption denominator. Verified exactly (0.0000% error across every
   * settled testnet market): payoutPerShare = pool / (supply - creatorShares).
   */
  creatorSharesPerOutcome: bigint;
}

export interface QuoteBuyResult {
  tokensIn: bigint;
}
export interface QuoteSellResult {
  tokensOut: bigint;
}
export interface QuoteRedeemResult {
  sharesIn: bigint;
  tokensOut: bigint;
}
export interface QuoteLiquidateResult {
  sharesIn: bigint[];
  totalTokensOut: bigint;
}
export interface TradeReceipt {
  transactionHash: Address;
}
export interface RedeemResult {
  marketAddress: Address;
  transactionHash: Address;
  sharesIn: bigint;
  tokensOut: bigint;
}

/**
 * Everything the agent is allowed to do to the outside world.
 *
 * Keeping this narrow is what makes the decision core testable offline: the
 * Stage 1 suite runs entirely against `FakeDelphi`, which simulates real DPM
 * pool mechanics rather than returning canned numbers.
 */
export interface DelphiPort {
  /** Address the agent trades from. */
  getWalletAddress(): Promise<Address>;
  /** Collateral (USDC) balance, 6-decimal. */
  getTokenBalance(): Promise<bigint>;
  /** Native gas balance, 18-decimal. */
  getEthBalance(): Promise<bigint>;

  listMarkets(params?: ListMarketsParams): Promise<Market[]>;
  getMarket(id: string, withPrices?: boolean): Promise<Market>;
  getMarketStatus(marketAddress: Address): Promise<MarketStatus>;
  /** Raw DPM state — required for payout math. */
  getDpmState(marketAddress: Address): Promise<DpmState>;

  listPositions(wallet: string): Promise<Position[]>;

  quoteBuy(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
  }): Promise<QuoteBuyResult>;
  quoteSell(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
  }): Promise<QuoteSellResult>;
  quoteRedeem(p: { marketAddress: Address }): Promise<QuoteRedeemResult>;
  quoteLiquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<QuoteLiquidateResult>;

  ensureTokenApproval(p: {
    marketAddress: Address;
    minimumAmount: bigint;
  }): Promise<void>;
  buyShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
    maxTokensIn: bigint;
  }): Promise<TradeReceipt>;
  sellShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
    minTokensOut: bigint;
  }): Promise<TradeReceipt>;

  redeemMarket(p: { marketAddress: Address }): Promise<RedeemResult>;
  liquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<RedeemResult>;

  /** Gateway `MIN_SHARES_DELTA` / `MIN_TOKENS_DELTA` — smallest legal trade. */
  getTradeMinimums(): Promise<{ minShares: bigint; minTokens: bigint }>;
}
