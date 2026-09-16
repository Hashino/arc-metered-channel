import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, parseUnits } from "ethers";

const id = readFileSync("/tmp/lastid.txt", "utf8").trim();
const abi = JSON.parse(readFileSync("out/MeteredChannel.json", "utf8")).abi;
const p = new JsonRpcProvider("https://rpc.testnet.arc.io", 5042002);
const payer = new Wallet(process.env.PRIVATE_KEY_TESTNET, p);
const provider_acct = new Wallet(process.env.PROVIDER_KEY_TESTNET, p);
const ch = new Contract("0x9756E03c81c2a422AA13307203Ae5952dE44F7c6", abi, p);
const chAsProvider = ch.connect(provider_acct);

const c = await ch.channels(id);
console.log("canal:", id.slice(0, 14), "… dep =", Number(c.deposited) / 1e6, "claimado =", Number(c.claimed) / 1e6);

// assinatura correta do pagador para 0.15, mas apresentada por forjador com OUTRA assinatura
const hexToBytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));
const d = await ch.digest(id, parseUnits("0.15", 6));
const forged = provider_acct.signingKey.sign(hexToBytes(d)).serialized;  // assinado pela chave ERRADA
try {
  await chAsProvider.claim.staticCall(id, parseUnits("0.15", 6), forged);
  console.log("FALHA: aceitou assinatura de quem nao e o pagador");
  process.exit(1);
} catch (e) {
  const n = e.revert?.name ?? "?";
  console.log(n === "BadSignature"
    ? "OK    assinatura de quem nao e o pagador -> BadSignature"
    : `FALHA esperava BadSignature, veio ${n}`);
  process.exit(n === "BadSignature" ? 0 : 1);
}
