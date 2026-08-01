/**
 * Claim testnet USDC from the Gensyn faucet. Mints 1,000 mock USDC.
 *
 *   npx tsx scripts/faucet.ts
 *
 * Sends a transaction, so it needs gas. Testnet only — the faucet contract
 * does not exist on mainnet.
 */

import { createWalletClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import { loadConfig } from "../src/config.js";
import { GatewayReader, NETWORKS } from "../src/sdk/gateway.js";

const FAUCET = "0xB5876320DdA1AEE3eFC03aD02dC2e2CB4b61B7D9" as const;
const FAUCET_ABI = [
  {
    name: "requestToken",
    type: "function",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const config = loadConfig();
if (config.DELPHI_NETWORK !== "testnet") {
  console.error("the faucet only exists on testnet");
  process.exit(1);
}
if (!config.WALLET_PRIVATE_KEY) {
  console.error("WALLET_PRIVATE_KEY is not set — run: npx tsx scripts/wallet.ts");
  process.exit(1);
}

const net = NETWORKS.testnet;
const reader = new GatewayReader("testnet", config.GENSYN_RPC_URL);
const account = privateKeyToAccount(config.WALLET_PRIVATE_KEY as `0x${string}`);

const balanceOf = () =>
  reader.publicClient.readContract({
    address: net.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  } as never) as Promise<bigint>;

console.log(`wallet: ${account.address}`);

const gas = await reader.publicClient.getBalance({ address: account.address });
if (gas === 0n) {
  console.error(
    "\nNo ETH for gas on Gensyn testnet. Bridge some first:\n" +
      "  npx tsx scripts/wallet.ts   (shows the exact steps)",
  );
  process.exit(1);
}

const before = await balanceOf();
console.log(`before: ${formatUnits(before, 6)} USDC`);

const wallet = createWalletClient({
  account,
  chain: reader.publicClient.chain,
  transport: http(config.GENSYN_RPC_URL ?? net.rpcUrl),
});

console.log("claiming...");
const hash = await wallet.writeContract({
  address: FAUCET,
  abi: FAUCET_ABI,
  functionName: "requestToken",
  chain: reader.publicClient.chain,
  account,
});
console.log(`tx: ${hash}`);

const receipt = await reader.publicClient.waitForTransactionReceipt({ hash });
if (receipt.status === "reverted") {
  console.error(
    "faucet reverted — it rate-limits per wallet, so you may have claimed recently",
  );
  process.exit(1);
}

const after = await balanceOf();
console.log(`after:  ${formatUnits(after, 6)} USDC`);
console.log(`received: ${formatUnits(after - before, 6)} USDC`);
