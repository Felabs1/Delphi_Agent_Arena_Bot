/**
 * Bridge ETH from Ethereum Sepolia to Gensyn testnet (OP Stack canonical bridge).
 *
 *   npx tsx scripts/bridge-eth.ts 0.02
 *
 * Spends real Sepolia ETH. Funds appear on Gensyn testnet a few minutes after
 * the Sepolia transaction confirms, and show under "Internal txns" on the
 * explorer rather than normal transactions — OP Stack deposits are a special
 * transaction type triggered by the L1 bridge, not a user-signed L2 tx.
 */

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";

const L1_STANDARD_BRIDGE = "0xaf99ffa3281548a1c30fcb443f066eaff2d297d4" as const;
const BRIDGE_ABI = [
  {
    name: "depositETH",
    type: "function",
    inputs: [
      { name: "_minGasLimit", type: "uint32" },
      { name: "_extraData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

const amount = process.argv[2];
if (!amount || Number.isNaN(Number(amount))) {
  console.error("usage: npx tsx scripts/bridge-eth.ts <amount-eth>");
  console.error("example: npx tsx scripts/bridge-eth.ts 0.02");
  process.exit(1);
}

const config = loadConfig();
if (!config.WALLET_PRIVATE_KEY) {
  console.error("WALLET_PRIVATE_KEY is not set — run: npx tsx scripts/wallet.ts");
  process.exit(1);
}

const account = privateKeyToAccount(config.WALLET_PRIVATE_KEY as `0x${string}`);
const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: http(rpc),
});

const value = parseEther(amount);
const balance = await publicClient.getBalance({ address: account.address });

console.log(`wallet:  ${account.address}`);
console.log(`sepolia: ${formatEther(balance)} ETH`);
console.log(`bridging: ${amount} ETH -> Gensyn testnet`);

if (balance <= value) {
  console.error(
    `\nNot enough Sepolia ETH (need more than ${amount} to cover gas too).\n` +
      `Get some first: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`,
  );
  process.exit(1);
}

const hash = await walletClient.writeContract({
  address: L1_STANDARD_BRIDGE,
  abi: BRIDGE_ABI,
  functionName: "depositETH",
  args: [200_000, "0x"],
  value,
});
console.log(`sepolia tx: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}`);
console.log("\nFunds arrive on Gensyn testnet in a few minutes. Check with:");
console.log("  npx tsx scripts/wallet.ts");
