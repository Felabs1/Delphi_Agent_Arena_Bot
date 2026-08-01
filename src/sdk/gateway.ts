/**
 * Direct reads from the DynamicParimutuelGateway.
 *
 * The REST API exposes neither `pool` nor the per-outcome share supplies, and
 * without those the payout for a winning share — `pool / winning_supply` — is
 * unknowable. So the EV engine reads the gateway itself.
 *
 * This also sidesteps an SDK quirk: `listMarkets({ pricesAndImpliedProbabilities })`
 * calls `getSigner()`, so it demands a private key just to run a read-only price
 * multicall. Reading here needs no signer at all, which keeps analysis and
 * validation possible on a wallet-less setup.
 */

import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { DYNAMIC_PARIMUTUEL_GATEWAY_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import type { DpmState } from "./port.js";

export interface NetworkDefaults {
  rpcUrl: string;
  chainId: number;
  gatewayAddress: Address;
  factoryAddress: Address;
  legacyGatewayAddress: Address;
  legacyFactoryAddress: Address;
  tokenAddress: Address;
}

/** Mirrors the SDK's `NETWORK_DEFAULTS`. */
export const NETWORKS: Record<"testnet" | "mainnet", NetworkDefaults> = {
  testnet: {
    rpcUrl: "https://gensyn-testnet.g.alchemy.com/public",
    chainId: 685685,
    gatewayAddress: "0x22ea355D7218Dc86b4c83732cBbd01f7Ff2332b3",
    factoryAddress: "0x97d2b3F0614C8189343A38094629FCE2910b727A",
    legacyGatewayAddress: "0x7b8FDBD187B0Be5e30e48B1995df574A62667147",
    legacyFactoryAddress: "0xd03CEC55802f0D44D844384E1144B25717315E5A",
    tokenAddress: "0x0724D6079b986F8e44bDafB8a09B60C0bd6A45a1",
  },
  mainnet: {
    rpcUrl: "https://gensyn-mainnet.g.alchemy.com/public",
    chainId: 685689,
    gatewayAddress: "0x982a67aE92D8de361957249fB2BB4a62BCc6A8d5",
    factoryAddress: "0x9C73417f79a1361c6aF9Bd828343badEE1b84936",
    legacyGatewayAddress: "0x4e4e85c52E0F414cc67eE88d0C649Ec81698d700",
    legacyFactoryAddress: "0x4596d847eA56DCf9A37944c13793Af802Fc5D1eC",
    tokenAddress: "0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5",
  },
};

/** On-chain `marketStatus` enum → the string form used everywhere else. */
const STATUS_BY_INDEX = [
  "open",
  "awaiting_settlement",
  "settled",
  "expired",
  "failed",
] as const;

export class GatewayReader {
  private readonly client: PublicClient;
  private readonly defaults: NetworkDefaults;
  /** Which gateway owns each market — resolved once, then cached. */
  private readonly gatewayByMarket = new Map<string, Address>();

  constructor(
    network: "testnet" | "mainnet" = "testnet",
    rpcUrl?: string,
  ) {
    this.defaults = NETWORKS[network];
    const chain = defineChain({
      id: this.defaults.chainId,
      name: `gensyn-${network}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl ?? this.defaults.rpcUrl] } },
    });
    this.client = createPublicClient({
      chain,
      transport: http(rpcUrl ?? this.defaults.rpcUrl),
    });
  }

  get publicClient(): PublicClient {
    return this.client;
  }

  /**
   * Markets belong to either the automated or the legacy deployment, and each
   * gateway reverts on the other's markets. Probe the automated one first since
   * every new market lives there.
   */
  async resolveGateway(marketAddress: Address): Promise<Address> {
    const key = marketAddress.toLowerCase();
    const cached = this.gatewayByMarket.get(key);
    if (cached) return cached;

    for (const gateway of [
      this.defaults.gatewayAddress,
      this.defaults.legacyGatewayAddress,
    ]) {
      try {
        await this.client.readContract({
          address: gateway,
          abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
          functionName: "marketStatus",
          args: [marketAddress],
        });
        this.gatewayByMarket.set(key, gateway);
        return gateway;
      } catch {
        // Wrong deployment — try the next.
      }
    }
    throw new Error(`no gateway recognises market ${marketAddress}`);
  }

  async getMarketStatus(
    marketAddress: Address,
  ): Promise<(typeof STATUS_BY_INDEX)[number]> {
    const gateway = await this.resolveGateway(marketAddress);
    const raw = (await this.client.readContract({
      address: gateway,
      abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
      functionName: "marketStatus",
      args: [marketAddress],
    })) as number;
    const status = STATUS_BY_INDEX[Number(raw)];
    if (!status) throw new Error(`unknown market status enum ${raw}`);
    return status;
  }

  /**
   * Everything the EV engine needs, in one batch.
   *
   * `blockNumber` reads historical state. Settlement drains the pool, so what a
   * settled market actually paid is only reconstructable at the block it
   * settled — reading it now returns zero and tells you nothing.
   */
  async getDpmState(
    marketAddress: Address,
    blockNumber?: bigint,
  ): Promise<DpmState> {
    const gateway = await this.resolveGateway(marketAddress);
    const at = blockNumber === undefined ? {} : { blockNumber };
    // viem infers argument tuples from the const ABI; a dynamic function name
    // defeats that inference, so the call shape is asserted here instead.
    const read = <T>(functionName: string, args: unknown[]): Promise<T> =>
      this.client.readContract({
        address: gateway,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName,
        args,
        ...at,
      } as never) as Promise<T>;

    const market = await read<{
      config: {
        outcomeCount: bigint;
        k: bigint;
        tradingFee: bigint;
        tradingDeadline: bigint;
        settlementDeadline: bigint;
      };
      initialPool: bigint;
      pool: bigint;
      tradingFees: bigint;
      refund: bigint;
      sumTerm36: bigint;
      winningOutcomeIdx: bigint;
    }>("getMarket", [marketAddress]);

    const outcomeCount = Number(market.config.outcomeCount);
    const indices = Array.from({ length: outcomeCount }, (_, i) => BigInt(i));
    const [supplies, creatorSharesPerOutcome] = await Promise.all([
      read<readonly bigint[]>("totalSupplies", [marketAddress, indices]),
      read<bigint>("marketCreatorSharesPerOutcome", [marketAddress]),
    ]);

    return {
      marketAddress,
      outcomeCount,
      k: market.config.k,
      tradingFee: market.config.tradingFee,
      tradingDeadline: market.config.tradingDeadline,
      settlementDeadline: market.config.settlementDeadline,
      pool: market.pool,
      initialPool: market.initialPool,
      tradingFees: market.tradingFees,
      refund: market.refund,
      sumTerm36: market.sumTerm36,
      supplies: [...supplies],
      creatorSharesPerOutcome,
    };
  }

  /**
   * The market creator holds shares in *every* outcome, and settlement values
   * their winning shares separately from ordinary holders. Both numbers are
   * needed to predict what a trader's share actually pays.
   */
  async getCreatorPosition(
    marketAddress: Address,
    winningOutcomeIdx: number,
    blockNumber?: bigint,
  ): Promise<{ sharesPerOutcome: bigint; winningSettlementValue: bigint }> {
    const gw = await this.resolveGateway(marketAddress);
    const at = blockNumber === undefined ? {} : { blockNumber };
    const [sharesPerOutcome, winningSettlementValue] = await Promise.all([
      this.client.readContract({
        address: gw,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "marketCreatorSharesPerOutcome",
        args: [marketAddress],
        ...at,
      } as never) as Promise<bigint>,
      this.client.readContract({
        address: gw,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "marketCreatorWinningSharesSettlementValue",
        args: [marketAddress, BigInt(winningOutcomeIdx)],
        ...at,
      } as never) as Promise<bigint>,
    ]);
    return { sharesPerOutcome, winningSettlementValue };
  }

  /** Gateway's own view of prices/probabilities — used to cross-check our math. */
  async getSpot(
    marketAddress: Address,
    outcomeCount: number,
  ): Promise<{ prices: bigint[]; impliedProbabilities: bigint[] }> {
    const gateway = await this.resolveGateway(marketAddress);
    const indices = Array.from({ length: outcomeCount }, (_, i) => BigInt(i));
    const [prices, impliedProbabilities] = await Promise.all([
      this.client.readContract({
        address: gateway,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "spotPrices",
        args: [marketAddress, indices],
      }) as Promise<readonly bigint[]>,
      this.client.readContract({
        address: gateway,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "spotImpliedProbabilities",
        args: [marketAddress, indices],
      }) as Promise<readonly bigint[]>,
    ]);
    return {
      prices: [...prices],
      impliedProbabilities: [...impliedProbabilities],
    };
  }

  async quoteBuy(
    marketAddress: Address,
    outcomeIdx: number,
    sharesOut: bigint,
  ): Promise<bigint> {
    const gateway = await this.resolveGateway(marketAddress);
    return this.client.readContract({
      address: gateway,
      abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
      functionName: "quoteBuyExactOut",
      args: [marketAddress, BigInt(outcomeIdx), sharesOut],
    }) as Promise<bigint>;
  }

  async quoteSell(
    marketAddress: Address,
    outcomeIdx: number,
    sharesIn: bigint,
  ): Promise<bigint> {
    const gateway = await this.resolveGateway(marketAddress);
    return this.client.readContract({
      address: gateway,
      abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
      functionName: "quoteSellExactIn",
      args: [marketAddress, BigInt(outcomeIdx), sharesIn],
    }) as Promise<bigint>;
  }

  /** Smallest legal trade, straight from the gateway. */
  async getTradeMinimums(): Promise<{ minShares: bigint; minTokens: bigint }> {
    const [minShares, minTokens] = await Promise.all([
      this.client.readContract({
        address: this.defaults.gatewayAddress,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "MIN_SHARES_DELTA",
      }) as Promise<bigint>,
      this.client.readContract({
        address: this.defaults.gatewayAddress,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
        functionName: "MIN_TOKENS_DELTA",
      }) as Promise<bigint>,
    ]);
    return { minShares, minTokens };
  }

  /** Balance held by a wallet in a market's outcome, 18-decimal. */
  async balanceOf(
    marketAddress: Address,
    owner: Address,
    outcomeIdx: number,
  ): Promise<bigint> {
    const gateway = await this.resolveGateway(marketAddress);
    return this.client.readContract({
      address: gateway,
      abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI,
      functionName: "balanceOf",
      args: [marketAddress, owner, BigInt(outcomeIdx)],
    }) as Promise<bigint>;
  }
}
