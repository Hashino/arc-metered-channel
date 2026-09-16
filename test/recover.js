import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits } from "ethers";

const abi = JSON.parse(readFileSync("out/MeteredChannel.json", "utf8")).abi;
const p = new JsonRpcProvider("https://rpc.testnet.arc.io", 5042002);
const payer = new Wallet(process.env.PRIVATE_KEY_TESTNET, p);
const ch = new Contract("0x9756E03c81c2a422AA13307203Ae5952dE44F7c6", abi, payer);
const usdc = new Contract("0x3600000000000000000000000000000000000000",
  ["function balanceOf(address) view returns (uint256)"], p);

const antes = formatUnits(await usdc.balanceOf(payer.address), 6);
for (const id of [
  "0x81a99143be4a6ac590cd488a3ef05b06da5d85c245834e7fc483da1134a7493c",
  "0x3fd3033f5f4cb2313e6dc840312d80dc1e356df2329440de8d4cc056f1c2c794",
]) {
  const rc = await (await ch.close(id)).wait();
  const ev = rc.logs.find((l) => l.eventName === "ChannelClosed");
  console.log(`fechado ${id.slice(0, 12)}…  reembolsado ${formatUnits(ev.args[1], 6)} USDC`);
}
const depois = formatUnits(await usdc.balanceOf(payer.address), 6);
console.log(`\nsaldo: ${antes} -> ${depois} USDC`);
