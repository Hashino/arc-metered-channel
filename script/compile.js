import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NAME = "MeteredChannel";
const source = readFileSync(`${root}/src/${NAME}.sol`, "utf8");

const input = {
  language: "Solidity",
  sources: { [`${NAME}.sol`]: { content: source } },
  settings: {
    // Arc tem base Osaka; paris e o alvo seguro e amplamente aceito para deploy.
    evmVersion: "paris",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.gasEstimates"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
const warnings = (out.errors ?? []).filter((e) => e.severity === "warning");
for (const w of warnings) console.warn("AVISO:", w.formattedMessage.trim());
if (errors.length) {
  for (const e of errors) console.error("ERRO:", e.formattedMessage.trim());
  process.exit(1);
}

const c = out.contracts[`${NAME}.sol`][NAME];
mkdirSync(`${root}/out`, { recursive: true });
writeFileSync(`${root}/out/${NAME}.json`,
  JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));

const bytes = c.evm.bytecode.object.length / 2;
console.log(`\nOK  ${NAME}`);
console.log(`    bytecode        ${bytes.toLocaleString()} bytes (limite EIP-170: 24.576)`);
console.log(`    funcoes no ABI  ${c.abi.filter((x) => x.type === "function").length}`);
console.log(`    deploy estimado ${c.evm.gasEstimates?.creation?.totalCost ?? "?"} gas`);
