/**
 * The live Delphi adapter.
 *
 * Reads come from two places and are deliberately split:
 *   - REST (`DelphiClient`)  — market catalogue, metadata, positions
 *   - Gateway (`GatewayReader`) — pool, supplies, quotes, statuses
 *
 * The gateway half exists because the REST API exposes neither `pool` nor the
 * per-outcome supplies, and correct payout maths is impossible without them. It
 * also means analysis works with no wallet at all: the SDK's price helper calls
 * `getSigner()` and demands a private key just to run a read-only multicall.
 *
 * Writes require a signer and say so plainly rather than failing deep inside a
 * transaction builder.
 */

import { DelphiClient, ERC20_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { GatewayReader, NETWORKS } from "./gateway.js";
import type {
  Address,
  DelphiPort,
  DpmState,
  ListMarketsParams,
  Market,
  MarketStatus,
  Position,
  QuoteBuyResult,
  QuoteLiquidateResult,
  QuoteRedeemResult,
  QuoteSellResult,
  RedeemResult,
  TradeReceipt,
} from "./port.js";

export interface LiveDelphiOptions {
  network: "testnet" | "mainnet";
  apiKey: string;
  /** Required for any write, and for reading our own balances/positions. */
  privateKey?: Address;
  /** Watch-only address to value a portfolio without a private key. */
  watchWallet?: Address;
  /**
   * Bankroll to assume when there is no wallet at all. Lets a dry run produce
   * realistically-sized candidates instead of refusing to size anything.
   */
  paperBankrollUsdc?: number;
  rpcUrl?: string;
  apiBaseUrl?: string;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export class LiveDelphi implements DelphiPort {
  private readonly client: DelphiClient;
  private readonly gateway: GatewayReader;
  private readonly account?: ReturnType<typeof privateKeyToAccount>;
  private readonly options: LiveDelphiOptions;

  constructor(options: LiveDelphiOptions) {
    this.options = options;
    this.gateway = new GatewayReader(options.network, options.rpcUrl);
    this.client = new DelphiClient({
      network: options.network,
      apiKey: options.apiKey,
      signerType: "private_key",
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    });
    if (options.privateKey) {
      this.account = privateKeyToAccount(options.privateKey);
    }
  }

  /** True when this instance can actually send transactions. */
  get canTrade(): boolean {
    return this.account !== undefined;
  }

  private requireSigner(action: string): ReturnType<typeof privateKeyToAccount> {
    if (!this.account) {
      throw new Error(
        `${action} needs a wallet: set WALLET_PRIVATE_KEY in .env. ` +
          `Read-only analysis and --dry-run work without one.`,
      );
    }
    return this.account;
  }

  // ---------------------------------------------------------------- reads

  async getWalletAddress(): Promise<Address> {
    return this.account?.address ?? this.options.watchWallet ?? ZERO;
  }

  async getTokenBalance(): Promise<bigint> {
    const wallet = await this.getWalletAddress();
    if (wallet === ZERO) {
      // No wallet to read: fall back to the configured paper bankroll so a dry
      // run still sizes positions the way a funded run would.
      return BigInt(Math.round((this.options.paperBankrollUsdc ?? 0) * 1e6));
    }
    return this.gateway.publicClient.readContract({
      address: NETWORKS[this.options.network].tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    } as never) as Promise<bigint>;
  }

  async getEthBalance(): Promise<bigint> {
    const wallet = await this.getWalletAddress();
    if (wallet === ZERO) return 0n;
    return this.gateway.publicClient.getBalance({ address: wallet });
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    // Never pass `pricesAndImpliedProbabilities` — the SDK routes that through
    // getSigner(). Prices are enriched from the gateway below instead.
    const { markets } = await this.client.listMarkets({
      ...(params.status ? { status: params.status } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(params.verifiable !== undefined ? { verifiable: params.verifiable } : {}),
      ...(params.orderBy ? { orderBy: params.orderBy } : {}),
      skip: params.skip ?? 0,
      limit: params.limit ?? 50,
    });

    const list = (markets ?? []) as unknown as Market[];
    if (!params.pricesAndImpliedProbabilities) return list;

    return Promise.all(list.map((m) => this.withGatewayPrices(m)));
  }

  async getMarket(id: string, withPrices = false): Promise<Market> {
    const market = (await this.client.getMarket({ id })) as unknown as Market;
    return withPrices ? this.withGatewayPrices(market) : market;
  }

  async getMarketStatus(marketAddress: Address): Promise<MarketStatus> {
    return this.gateway.getMarketStatus(marketAddress);
  }

  async getDpmState(marketAddress: Address): Promise<DpmState> {
    return this.gateway.getDpmState(marketAddress);
  }

  async listPositions(wallet: string): Promise<Position[]> {
    if (!wallet || wallet === ZERO) return [];
    const { positions } = await this.client.listPositions({ wallet, limit: 200 });
    return (positions ?? []) as unknown as Position[];
  }

  async quoteBuy(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
  }): Promise<QuoteBuyResult> {
    return {
      tokensIn: await this.gateway.quoteBuy(
        p.marketAddress,
        p.outcomeIdx,
        p.sharesOut,
      ),
    };
  }

  async quoteSell(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
  }): Promise<QuoteSellResult> {
    return {
      tokensOut: await this.gateway.quoteSell(
        p.marketAddress,
        p.outcomeIdx,
        p.sharesIn,
      ),
    };
  }

  async quoteRedeem(p: { marketAddress: Address }): Promise<QuoteRedeemResult> {
    const account = await this.getWalletAddress();
    return this.client.quoteRedeem({
      marketAddress: p.marketAddress,
      account,
    });
  }

  async quoteLiquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<QuoteLiquidateResult> {
    const account = await this.getWalletAddress();
    return this.client.quoteLiquidate({
      marketAddress: p.marketAddress,
      outcomeIndices: p.outcomeIndices,
      account,
    });
  }

  async getTradeMinimums(): Promise<{ minShares: bigint; minTokens: bigint }> {
    return this.gateway.getTradeMinimums();
  }

  // -------------------------------------------------------------- writes

  async ensureTokenApproval(p: {
    marketAddress: Address;
    minimumAmount: bigint;
  }): Promise<void> {
    this.requireSigner("approving the collateral token");
    await this.client.ensureTokenApproval(p);
  }

  async buyShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesOut: bigint;
    maxTokensIn: bigint;
  }): Promise<TradeReceipt> {
    this.requireSigner("buying shares");
    return this.client.buyShares(p);
  }

  async sellShares(p: {
    marketAddress: Address;
    outcomeIdx: number;
    sharesIn: bigint;
    minTokensOut: bigint;
  }): Promise<TradeReceipt> {
    this.requireSigner("selling shares");
    return this.client.sellShares(p);
  }

  async redeemMarket(p: { marketAddress: Address }): Promise<RedeemResult> {
    this.requireSigner("redeeming");
    return this.client.redeemMarket(p);
  }

  async liquidate(p: {
    marketAddress: Address;
    outcomeIndices: number[];
  }): Promise<RedeemResult> {
    this.requireSigner("liquidating");
    const r = await this.client.liquidate(p);
    return {
      marketAddress: r.marketAddress,
      transactionHash: r.transactionHash,
      sharesIn: r.sharesIn.reduce((a, b) => a + b, 0n),
      tokensOut: r.totalTokensOut,
    };
  }

  // ------------------------------------------------------------- helpers

  /** Attach spot prices and implied probabilities read from the gateway. */
  private async withGatewayPrices(market: Market): Promise<Market> {
    const outcomeCount = market.metadata?.outcomes?.length ?? 0;
    if (outcomeCount === 0) return market;
    try {
      const spot = await this.gateway.getSpot(market.id as Address, outcomeCount);
      return {
        ...market,
        spotPrices: spot.prices.map((p) => Number(p) / 1e6),
        spotImpliedProbabilities: spot.impliedProbabilities.map(
          (p) => Number(p) / 1e18,
        ),
      };
    } catch {
      // Unreadable market (wrong deployment, not yet indexed) — the eligibility
      // filter will drop it for having no prices.
      return market;
    }
  }
}
