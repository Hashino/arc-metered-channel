import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits } from "ethers";

const ADDR = "0x9756E03c81c2a422AA13307203Ae5952dE44F7c6";
const abi = JSON.parse(readFileSync("out/MeteredChannel.json", "utf8")).abi;
const p = new JsonRpcProvider("https://rpc.testnet.arc.io", 5042002);
const payer = new Wallet(process.env.PRIVATE_KEY_TESTNET, p);
const usdc = new Contract("0x3600000000000000000000000000000000000000",
  ["function balanceOf(address) view returns (uint256)",
   "function allowance(address,address) view returns (uint256)"], p);
const ch = new Contract(ADDR, abi, p);

const bal = formatUnits(await usdc.balanceOf(payer.address), 6);
const nat = formatUnits(await p.getBalance(payer.address), 18);
console.log("pagador          :", payer.address);
console.log("saldo ERC-20 (6) :", bal, "USDC");
console.log("saldo nativo (18):", nat, "USDC");
console.log("nonce            :", await p.getTransactionCount(payer.address));

const evs = await ch.queryFilter("ChannelOpened", 0).catch((e) => { console.log("queryFilter erro:", e.shortMessage ?? e.message); return []; });
console.log("\ncanais abertos:", evs.length);
for (const e of evs) {
  const c = await ch.channels(e.args[0]);
  console.log(`  ${e.args[0].slice(0, 12)}… provedor=${c.provider.slice(0, 10)}… dep=${formatUnits(c.deposited, 6)} claimado=${formatUnits(c.claimed, 6)} vence=${new Date(Number(c.expiry) * 1000).toISOString()}`);
}
