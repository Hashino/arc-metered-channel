import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, ContractFactory, formatUnits } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "MeteredChannel";

const NETS = {
  testnet: { rpc: "https://rpc.testnet.arc.io", chainId: 5042002, explorer: "https://explorer.testnet.arc.io" },
  mainnet: { rpc: "https://rpc.mainnet.arc.io", chainId: 5042,    explorer: "https://explorer.arc.io" },
};

const net = process.argv[2] ?? "testnet";
const cfg = NETS[net];
if (!cfg) { console.error(`rede invalida: ${net}. use "testnet" ou "mainnet".`); process.exit(1); }

// Chave por rede: a de testnet nao serve para mainnet e vice-versa. Sem
// fallback de propósito — um erro de variavel deve travar, nao trocar de conta.
const varName = net === "mainnet" ? "PRIVATE_KEY_MAINNET" : "PRIVATE_KEY_TESTNET";
const pk = process.env[varName];
if (!pk || pk === "0x") {
  console.error(`faltou ${varName} no .env (copie de .env.example).`);
  process.exit(1);
}

// Limites iniciais, na unidade da interface ERC-20 do USDC na Arc (6 decimais).


const { abi, bytecode } = JSON.parse(readFileSync(`${root}/out/${NAME}.json`, "utf8"));

const provider = new JsonRpcProvider(cfg.rpc, cfg.chainId);
const wallet = new Wallet(pk, provider);

const netInfo = await provider.getNetwork();
if (Number(netInfo.chainId) !== cfg.chainId) {
  console.error(`chain id divergente: RPC respondeu ${netInfo.chainId}, esperado ${cfg.chainId}`);
  process.exit(1);
}

// Na Arc o saldo nativo e o proprio USDC, com 18 decimais.
const bal = await provider.getBalance(wallet.address);
console.log(`rede      ${net} (chain ${cfg.chainId})`);
console.log(`conta     ${wallet.address}`);
console.log(`saldo     ${formatUnits(bal, 18)} USDC`);
if (bal === 0n) { console.error("\nsaldo zero: sem gas nao da para fazer deploy."); process.exit(1); }

const factory = new ContractFactory(abi, bytecode, wallet);

const deployTx = await factory.getDeployTransaction();
const gas = await provider.estimateGas({ ...deployTx, from: wallet.address });
const fee = await provider.getFeeData();
const price = fee.gasPrice ?? 20_000_000_000n;
console.log(`gas       ${gas.toLocaleString()} x ${Number(price) / 1e9} Gwei = ${formatUnits(gas * price, 18)} USDC`);

const contract = await factory.deploy();
console.log(`\nenviado   ${contract.deploymentTransaction().hash}`);
await contract.waitForDeployment();

const address = await contract.getAddress();
console.log(`\nDEPLOY OK`);
console.log(`  contrato  ${address}`);
console.log(`  explorer  ${cfg.explorer}/address/${address}`);
console.log(`  canal     sem argumentos — dominio EIP-712 fixado no construtor`);
