/**
 * Wallet status and the exact next step to get trading.
 *
 *   npx tsx scripts/wallet.ts          # status
 *   npx tsx scripts/wallet.ts --new    # generate a fresh testnet keypair
 *
 * Read-only apart from `--new`, which only prints a key — it never writes to
 * .env for you, so nothing lands in a file you did not choose to edit.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther, formatUnits } from "viem";
import { ERC20_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import { loadConfig } from "../src/config.js";
import { GatewayReader, NETWORKS } from "../src/sdk/gateway.js";

if (process.argv.includes("--new")) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  console.log("\nGenerated a fresh keypair. TESTNET USE ONLY.\n");
  console.log(`  address: ${account.address}`);
  console.log(`  private key: ${key}\n`);
  console.log("Add this line to .env (NOT .env.example — that file is committed):\n");
  console.log(`WALLET_PRIVATE_KEY=${key}\n`);
  process.exit(0);
}

const config = loadConfig();
const net = NETWORKS[config.DELPHI_NETWORK];
const reader = new GatewayReader(config.DELPHI_NETWORK, config.GENSYN_RPC_URL);

console.log(`network: ${config.DELPHI_NETWORK} (chain ${net.chainId})`);

if (!config.WALLET_PRIVATE_KEY) {
  console.log("\nNo WALLET_PRIVATE_KEY set — the agent can analyse but not trade.\n");
  console.log("  1. npx tsx scripts/wallet.ts --new      # generate a keypair");
  console.log("  2. add WALLET_PRIVATE_KEY=0x... to .env");
  console.log("  3. npx tsx scripts/wallet.ts            # re-check funding");
  process.exit(0);
}

const account = privateKeyToAccount(config.WALLET_PRIVATE_KEY as `0x${string}`);
console.log(`address: ${account.address}\n`);

const [eth, usdc] = await Promise.all([
  reader.publicClient.getBalance({ address: account.address }),
  reader.publicClient.readContract({
    address: net.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  } as never) as Promise<bigint>,
]);

console.log(`  ETH  (gas):        ${formatEther(eth)}`);
console.log(`  USDC (collateral): ${formatUnits(usdc, 6)}`);

const needsGas = eth === 0n;
const needsUsdc = usdc === 0n;

console.log("");
if (!needsGas && !needsUsdc) {
  console.log("Funded and ready. Next:");
  console.log("  npx tsx src/app.ts --dry-run --live-ai      # confirm the plan");
  console.log("  npx tsx src/app.ts --live-ai --max-trades 1 # send ONE real trade");
  process.exit(0);
}

console.log("Not ready yet.\n");

if (needsGas) {
  console.log("GAS — you need ETH on Gensyn testnet. This is the manual bit:");
  console.log("  1. Get Sepolia ETH (captcha, so it cannot be scripted):");
  console.log("     https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
  console.log(`     send it to ${account.address}`);
  console.log("  2. Bridge Sepolia -> Gensyn testnet:");
  console.log("     npx tsx scripts/bridge-eth.ts 0.02");
  console.log("     (arrives in a few minutes, under 'Internal txns' on the explorer)");
  console.log("");
}

if (needsUsdc) {
  console.log("COLLATERAL — testnet USDC is minted directly, no bridge needed:");
  console.log("  npx tsx scripts/faucet.ts     # mints 1,000 mock USDC");
  if (needsGas) console.log("  (needs gas first — do the ETH step above)");
  console.log("");
}
