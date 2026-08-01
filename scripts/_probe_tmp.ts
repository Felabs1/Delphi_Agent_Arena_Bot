import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import "dotenv/config";

const client = new DelphiClient({ network: "testnet" });
console.log("health:", JSON.stringify(await client.health()));

const { markets } = await client.listMarkets({
  status: "open", limit: 5, orderBy: "liquidity"
});
console.log("open markets:", markets?.length ?? 0);
const m = markets?.[0];
if (m) {
  console.log("\n--- FIRST OPEN MARKET (raw keys) ---");
  console.log(Object.keys(m).join(", "));
  console.log("\nid:", m.id);
  console.log("question:", m.metadata?.question);
  console.log("outcomes:", JSON.stringify(m.metadata?.outcomes));
  console.log("category:", m.category, "| verifiable:", m.verifiable, "| tradingFee:", m.tradingFee);
  console.log("settlesAt:", m.settlesAt, "| resolvesAt:", m.resolvesAt);
    console.log("metadata.model:", JSON.stringify(m.metadata?.model));
  console.log("metadata keys:", Object.keys(m.metadata ?? {}).join(", "));
}
for (const s of ["settled","expired","failed","awaiting_settlement"] as const) {
  const r = await client.listMarkets({ status: s, limit: 3 });
  console.log(`${s}: ${r.markets?.length ?? 0}`);
}
