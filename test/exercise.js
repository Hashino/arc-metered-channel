import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits, parseUnits } from "ethers";

const ADDR = process.argv[2];
const { abi } = JSON.parse(readFileSync("out/MeteredChannel.json", "utf8"));
const p = new JsonRpcProvider("https://rpc.testnet.arc.io", 5042002);
const payer = new Wallet(process.env.PRIVATE_KEY_TESTNET, p);
// chave de teste descartavel, so para este script. Nunca usar com valor real.
const provider_acct = new Wallet("0xREMOVIDA_DO_HISTORICO", p);

const ch = new Contract(ADDR, abi, payer);
const chAsProvider = ch.connect(provider_acct);   // claim parte do provedor
const usdc = new Contract("0x3600000000000000000000000000000000000000",
  ["function transfer(address,uint256) returns (bool)","function approve(address,uint256) returns (bool)",
   "function balanceOf(address) view returns (uint256)"], payer);
const u = (n) => parseUnits(n, 6), f = (n) => formatUnits(n, 6);
const hexToBytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((b) => parseInt(b, 16)));

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  OK    ${m}`); pass++; };
const bad = (m) => { console.log(`  FALHA ${m}`); fail++; };
async function expectRev(label, fn, wanted) {
  try { await fn(); bad(`${label} — deveria reverter`); }
  catch (e) {
    const n = e.revert?.name ?? (e.shortMessage ?? String(e)).slice(0, 70);
    n === wanted ? ok(`${label} -> ${n}`) : bad(`${label} -> ${n}, esperado ${wanted}`);
  }
}
// assina o digest EIP-712 CRU (sem o prefixo de mensagem pessoal do signMessage)
const sign = async (id, cum) => payer.signingKey.sign(hexToBytes(await ch.digest(id, cum))).serialized;

console.log("saldo do pagador:", f(await usdc.balanceOf(payer.address)), "USDC");
console.log("\n0. gas para o provedor (conta efemera local)");
if (await usdc.balanceOf(provider_acct.address) < u("0.05")) {
  await (await usdc.transfer(provider_acct.address, u("0.1"))).wait();
}
ok(`provedor ${provider_acct.address.slice(0,10)}… com ${f(await usdc.balanceOf(provider_acct.address))} USDC de gas`);

console.log("\n1. abertura de canal");
await (await usdc.approve(ADDR, u("0.2"))).wait();
let id;
try {
  const rc = await (await ch.open(provider_acct.address, u("0.2"), 7200)).wait();
  const ev = rc.logs.find((l) => l.eventName === "ChannelOpened");
  id = ev.args[0];
  const c = await ch.channels(id);
  ok(`canal aberto: pagador=${c.payer.slice(0, 8)}… deposito=${f(c.deposited)} vence=${Number(c.expiry)}`);
} catch (e) { bad(`open: ${e.shortMessage ?? e.message}`.slice(0, 160)); }

console.log("\n2. validacoes de abertura");
await expectRev("self-canal", () => ch.open.staticCall(payer.address, u("0.2"), 7200), "SelfChannel");
await expectRev("duracao < 1h", () => ch.open.staticCall(provider_acct.address, u("0.2"), 60), "BadDuration");

console.log("\n3. comprovante e resgate");
const CUM1 = u("0.06");
const sig1 = await sign(id, CUM1);
try {
  const rc = await (await chAsProvider.claim(id, CUM1, sig1)).wait();
  const ev = rc.logs.find((l) => l.eventName === "Claimed");
  ok(`provedor resgatou ${f(ev.args.paid)} (acumulado ${f(ev.args.cumulative)})`);
  ok(`saldo do provedor: ${f(await usdc.balanceOf(provider_acct.address))}`);
} catch (e) { bad(`claim: ${e.shortMessage ?? e.message}`.slice(0, 200)); }

console.log("\n4. ataque de repeticao");
await expectRev("mesmo comprovante de novo", () => chAsProvider.claim.staticCall(id, CUM1, sig1), "CumulativeNotIncreasing");
const CUM0 = u("0.02");
const sig0 = await sign(id, CUM0);
await expectRev("comprovante MAIS ANTIGO (acumulado menor)", () => chAsProvider.claim.staticCall(id, CUM0, sig0), "CumulativeNotIncreasing");
ok("sem nonce por chamada, sem lista de gastos: imunidade vem do acumulado monotonicamente crescente");

console.log("\n5. comprovante incremental paga so a diferenca");
const CUM2 = u("0.13");
const sig2 = await sign(id, CUM2);
{
  const rc = await (await chAsProvider.claim(id, CUM2, sig2)).wait();
  const ev = rc.logs.find((l) => l.eventName === "Claimed");
  const c = await ch.channels(id);
  ok(`resgatou ${f(ev.args.paid)} (0.13-0.06); total claimado ${f(c.claimed)}`);
}

console.log("\n6. limites e permissao");
{
  const sig99 = await sign(id, u("50"));
  await expectRev("acumulado acima do deposito", () => chAsProvider.claim.staticCall(id, u("50"), sig99), "ExceedsDeposit");
  const forged = provider_acct.signingKey.sign(hexToBytes(await ch.digest(id, u("0.15")))).serialized;
  await expectRev("assinatura de quem nao e o pagador", () => chAsProvider.claim.staticCall(id, u("0.15"), forged), "BadSignature");
  const stranger = new Contract(ADDR, abi, new Wallet(Wallet.createRandom().privateKey, p));
  await expectRev("claim por terceiro", () => stranger.claim.staticCall(id, CUM2, sig2), "NotProvider");
}

console.log("\n7. fechar antes do prazo");
await expectRev("fechar antes do prazo", () => ch.close.staticCall(id), "NotYetExpired");

console.log("\n8. recarga");
await (await usdc.approve(ADDR, u("0.1"))).wait();
await (await ch.topUp(id, u("0.1"))).wait();
ok(`deposito agora ${f((await ch.channels(id)).deposited)}`);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
