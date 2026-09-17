import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits, parseUnits } from "ethers";

const ADDR = process.argv[2];
const net = process.argv[3] ?? "testnet";

// Mesma tabela de redes do script/deploy.js. O exercise roda igual nas duas:
// o que muda e a rede, a chave e a escala dos valores — nao a bateria de testes.
const NETS = {
  testnet: {
    rpc: "https://rpc.testnet.arc.io", chainId: 5042002,
    explorer: "https://explorer.testnet.arc.io",
    payerKey: "PRIVATE_KEY_TESTNET", providerKey: "PROVIDER_KEY_TESTNET",
    // USDC de faucet: valores folgados.
    amt: { gas: "0.1", gasMin: "0.05", deposit: "0.2", cum1: "0.06", cum2: "0.13", forged: "0.15", topUp: "0.1" },
  },
  mainnet: {
    rpc: "https://rpc.mainnet.arc.io", chainId: 5042,
    explorer: "https://explorer.arc.io",
    payerKey: "PRIVATE_KEY_MAINNET", providerKey: "PROVIDER_KEY_MAINNET",
    // USDC de verdade: um decimo da escala de testnet. O que se prova aqui e
    // que o contrato vive na mainnet, nao o tamanho do canal.
    amt: { gas: "0.02", gasMin: "0.005", deposit: "0.02", cum1: "0.006", cum2: "0.013", forged: "0.015", topUp: "0.01" },
  },
};

const cfg = NETS[net];
if (!cfg) { console.error(`rede invalida: ${net}. use "testnet" ou "mainnet".`); process.exit(1); }
if (!ADDR) { console.error("uso: node --env-file=.env test/exercise.js <contrato> [testnet|mainnet]"); process.exit(1); }

const pk = process.env[cfg.payerKey];
if (!pk || pk === "0x") { console.error(`faltou ${cfg.payerKey} no .env (copie de .env.example).`); process.exit(1); }

const { abi } = JSON.parse(readFileSync("out/MeteredChannel.json", "utf8"));
const p = new JsonRpcProvider(cfg.rpc, cfg.chainId);

const netInfo = await p.getNetwork();
if (Number(netInfo.chainId) !== cfg.chainId) {
  console.error(`chain id divergente: RPC respondeu ${netInfo.chainId}, esperado ${cfg.chainId}`);
  process.exit(1);
}

const payer = new Wallet(pk, p);
// Conta do provedor: fixa entre rodadas se houver chave no .env (o saldo de gas
// persiste), efemera caso contrario — o passo 0 a financia.
const provider_acct = process.env[cfg.providerKey] && process.env[cfg.providerKey] !== "0x"
  ? new Wallet(process.env[cfg.providerKey], p)
  : new Wallet(Wallet.createRandom().privateKey, p);

const ch = new Contract(ADDR, abi, payer);
const chAsProvider = ch.connect(provider_acct);
const usdc = new Contract("0x3600000000000000000000000000000000000000",
  ["function transfer(address,uint256) returns (bool)","function approve(address,uint256) returns (bool)",
   "function balanceOf(address) view returns (uint256)"], payer);
const A = cfg.amt;
const u = (n) => parseUnits(n, 6), f = (n) => formatUnits(n, 6);
const hexToBytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((b) => parseInt(b, 16)));

let pass = 0, fail = 0;
const txs = [];
const ok = (m) => { console.log(`  OK    ${m}`); pass++; };
const bad = (m) => { console.log(`  FALHA ${m}`); fail++; };

// Envia, espera e registra o hash — a prova de que a rodada foi on-chain.
async function send(label, txPromise) {
  const rc = await (await txPromise).wait();
  txs.push({ label, hash: rc.hash, gas: rc.gasUsed });
  console.log(`  tx    ${label}: ${rc.hash}  (gas ${rc.gasUsed})`);
  return rc;
}
async function expectRev(label, fn, wanted) {
  try { await fn(); bad(`${label} — deveria reverter`); }
  catch (e) {
    const n = e.revert?.name ?? (e.shortMessage ?? String(e)).slice(0, 70);
    n === wanted ? ok(`${label} -> ${n}`) : bad(`${label} -> ${n}, esperado ${wanted}`);
  }
}
const sign = async (id, cum) => payer.signingKey.sign(hexToBytes(await ch.digest(id, cum))).serialized;

console.log(`rede      ${net} (chain ${cfg.chainId})`);
console.log(`contrato  ${ADDR}`);
console.log(`pagador   ${payer.address}`);
console.log(`provedor  ${provider_acct.address}`);
console.log(`saldo do pagador: ${f(await usdc.balanceOf(payer.address))} USDC`);

console.log("\n0. gas para o provedor");
if (await usdc.balanceOf(provider_acct.address) < u(A.gasMin)) {
  await send("transfer(gas ao provedor)", usdc.transfer(provider_acct.address, u(A.gas)));
}
ok(`provedor ${provider_acct.address.slice(0,10)}… com ${f(await usdc.balanceOf(provider_acct.address))} USDC de gas`);

console.log("\n1. abertura de canal");
await send("approve(deposito)", usdc.approve(ADDR, u(A.deposit)));
let id;
try {
  const rc = await send("open", ch.open(provider_acct.address, u(A.deposit), 7200));
  const ev = rc.logs.find((l) => l.eventName === "ChannelOpened");
  id = ev.args[0];
  const c = await ch.channels(id);
  ok(`canal aberto: pagador=${c.payer.slice(0, 8)}… deposito=${f(c.deposited)} vence=${Number(c.expiry)}`);
} catch (e) { bad(`open: ${e.shortMessage ?? e.message}`.slice(0, 160)); }

console.log("\n2. validacoes de abertura");
await expectRev("self-canal", () => ch.open.staticCall(payer.address, u(A.deposit), 7200), "SelfChannel");
await expectRev("duracao < 1h", () => ch.open.staticCall(provider_acct.address, u(A.deposit), 60), "BadDuration");

console.log("\n3. comprovante e resgate");
const CUM1 = u(A.cum1);
const sig1 = await sign(id, CUM1);
try {
  const rc = await send("claim #1", chAsProvider.claim(id, CUM1, sig1));
  const ev = rc.logs.find((l) => l.eventName === "Claimed");
  ok(`provedor resgatou ${f(ev.args.paid)} (acumulado ${f(ev.args.cumulative)})`);
  ok(`saldo do provedor: ${f(await usdc.balanceOf(provider_acct.address))}`);
} catch (e) { bad(`claim: ${e.shortMessage ?? e.message}`.slice(0, 200)); }

console.log("\n4. ataque de repeticao");
await expectRev("mesmo comprovante de novo", () => chAsProvider.claim.staticCall(id, CUM1, sig1), "CumulativeNotIncreasing");
const CUM0 = u(A.gasMin);
const sig0 = await sign(id, CUM0);
await expectRev("comprovante MAIS ANTIGO (acumulado menor)", () => chAsProvider.claim.staticCall(id, CUM0, sig0), "CumulativeNotIncreasing");
ok("sem nonce por chamada, sem lista de gastos: imunidade vem do acumulado monotonicamente crescente");

console.log("\n5. comprovante incremental paga so a diferenca");
const CUM2 = u(A.cum2);
const sig2 = await sign(id, CUM2);
{
  const rc = await send("claim #2 (incremental)", chAsProvider.claim(id, CUM2, sig2));
  const ev = rc.logs.find((l) => l.eventName === "Claimed");
  const c = await ch.channels(id);
  ok(`resgatou ${f(ev.args.paid)} (${A.cum2}-${A.cum1}); total claimado ${f(c.claimed)}`);
}

console.log("\n6. limites e permissao");
{
  const sig99 = await sign(id, u("50"));
  await expectRev("acumulado acima do deposito", () => chAsProvider.claim.staticCall(id, u("50"), sig99), "ExceedsDeposit");
  const forged = provider_acct.signingKey.sign(hexToBytes(await ch.digest(id, u(A.forged)))).serialized;
  await expectRev("assinatura de quem nao e o pagador", () => chAsProvider.claim.staticCall(id, u(A.forged), forged), "BadSignature");
  const stranger = new Contract(ADDR, abi, new Wallet(Wallet.createRandom().privateKey, p));
  await expectRev("claim por terceiro", () => stranger.claim.staticCall(id, CUM2, sig2), "NotProvider");
}

console.log("\n7. fechar antes do prazo");
await expectRev("fechar antes do prazo", () => ch.close.staticCall(id), "NotYetExpired");

console.log("\n8. recarga");
await send("approve(recarga)", usdc.approve(ADDR, u(A.topUp)));
await send("topUp", ch.topUp(id, u(A.topUp)));
ok(`deposito agora ${f((await ch.channels(id)).deposited)}`);

console.log(`\n${pass} passaram, ${fail} falharam`);
if (txs.length) {
  const total = txs.reduce((s, t) => s + t.gas, 0n);
  console.log(`\n--- ${txs.length} transacoes on-chain em ${net} (gas total ${total}) ---`);
  console.log(`canal ${id}`);
  for (const t of txs) console.log(`${t.label.padEnd(26)} ${cfg.explorer}/tx/${t.hash}`);
}
process.exit(fail ? 1 : 0);
