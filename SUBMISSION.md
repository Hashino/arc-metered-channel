# Arc Microgrants — submission draft

Paste-ready. Fields follow the DoraHacks BUIDL form.

---

## Name

MeteredChannel

## One-liner

Metered payment channels for agent-to-service payments on Arc — one settlement transaction for a
thousand API calls, no custody.

## Live deployment (Arc mainnet, chain 5042)

`0x0aec193d8Ec9a7c1170cfB7fd97609E50c16CE73`

https://explorer.arc.io/address/0x0aec193d8Ec9a7c1170cfB7fd97609E50c16CE73

## Public repo

https://github.com/Hashino/arc-metered-channel

## Builder profile

https://github.com/Hashino

---

## Description

Arc's own agent demo prices API calls at $0.012 for a Polymarket feed, $0.004 for X social signals,
$0.0612 for Tavily search. Paying those on-chain, per call, is economically absurd — gas becomes a
large fraction of the payment itself, and an agent makes hundreds of calls. The missing piece is
micropayment for agent services **without custody**: meter off-chain, settle on-chain, amortized.

MeteredChannel does that. A payer deposits once into a channel with a provider. As each call is
served, the payer signs an EIP-712 voucher off-chain carrying the **running total** owed. The
provider keeps only the highest-value voucher it has seen and settles whenever it wants — one
transaction for a thousand calls, not a thousand transactions. One signature per call, zero gas.

Cumulative totals instead of per-call amounts make vouchers replay-proof by construction. The
contract pays only `cumulative − already_claimed`, so re-presenting an old voucher pays zero and
reverts `CumulativeNotIncreasing`. There is no per-call nonce, no spent-voucher list, and no state
that grows with usage.

The payer can open, top up, sign vouchers, and close after expiry — and cannot un-sign anything or
block a claim before expiry. The provider can claim partially or fully at any frequency — and
cannot claim more than was signed, or claim after expiry.

### Why this belongs on Arc specifically

On any other chain, a provider paid in USDC cannot withdraw without holding that chain's native
token: the asset earned and the asset needed to retrieve it are different. On Arc, USDC **is** the
gas token, so the cost of liquidating is quoted in the same asset being settled. That turns *"is it
worth claiming yet?"* into a single-quantity comparison, and `breakevenClaim(gasPrice)` answers it
on-chain with no price oracle at all. On another chain that function could not exist without an
ETH/USD feed.

### Evidence it works

`test/exercise.js` runs the full behaviour suite against the **live mainnet deployment** — no mocks,
no local chain, no testnet fallback. **15/15 pass on Arc mainnet (chain 5042).** The same script
runs either network (`node --env-file=.env test/exercise.js <address> mainnet`); only the network,
the key and the amounts differ, never the assertions.

Seven state-changing transactions, 542,226 gas total, channel
`0xf3ce11efd747fe3d96c10321de4e2ee0c086ca17f5cad5009c84b427fd49f818`:

| Step | Transaction |
|---|---|
| Fund provider account | [`0xe8400cd2…`](https://explorer.arc.io/tx/0xe8400cd2dbdf1d517d7ba40afb38a7e68c5f3651341aa327f14c8b05d611a46f) |
| `approve` deposit | [`0xd6193453…`](https://explorer.arc.io/tx/0xd6193453932ffafb4b9dd595e6b2eeaffdafd14e439477f41ed7b403f6f01bca) |
| `open` channel | [`0xd29048e7…`](https://explorer.arc.io/tx/0xd29048e7a2a19ac1ceb4f34fb1ea22c1b5990bc548dc1f44f6d27240c5b6f43b) |
| `claim` #1 — 0.006 USDC | [`0xabb57ad9…`](https://explorer.arc.io/tx/0xabb57ad9efffdf8ed3812500dc2be34c2eaacd9df04b001bc6d95be91984deaa) |
| `claim` #2 — incremental, pays only 0.007 | [`0x38765eae…`](https://explorer.arc.io/tx/0x38765eae4581b1618d59b75891c43248ed2348dd3e86c1e6a29fa7be99ac6efe) |
| `approve` top-up | [`0xf0325628…`](https://explorer.arc.io/tx/0xf0325628626e3d3af92371621cd6dde57481bc43bac633dd7d5ba7679ba58a62) |
| `topUp` | [`0x0891d226…`](https://explorer.arc.io/tx/0x0891d2260e40b9c756f40550e771e8b6755f0b6529c2fe67604e0c59ab9df0c8) |

The eight negative assertions were enforced by the live contract in the same run: `SelfChannel`,
`BadDuration`, `CumulativeNotIncreasing` for a replayed voucher, `CumulativeNotIncreasing` for an
*older* voucher, `ExceedsDeposit`, `BadSignature` for a voucher signed by anyone but the payer,
`NotProvider` for a third-party claim, and `NotYetExpired` for a premature close.

The incremental claim is the load-bearing one: after settling a 0.006 cumulative voucher, a 0.013
voucher moved exactly 0.007 — the difference, not the total. That is the whole economic claim of
the design, executed on mainnet rather than asserted in prose.

Deploy cost on mainnet was 927,050 gas at 20 Gwei — **0.0185 USDC**. 4,034 bytes deployed, no
constructor arguments. The entire exercise run above cost under 0.011 USDC in gas.

### Arc-specific findings, documented for other builders

1. **The decimals trap.** The native gas balance uses 18 decimals; the ERC-20 interface over the
   *same* balance uses 6. Mixing them silently corrupts value arithmetic. This contract uses the
   ERC-20 interface exclusively and never touches the native balance.
2. **Blocked addresses revert without a receipt.** Transfers from a blocklisted address are rejected
   at the RPC (`"Blocked address"` on `eth_estimateGas`), and the well-known Hardhat/Anvil test keys
   are on that list. Test keys must be freshly generated.
3. **`eth_getLogs` is range-limited** to 10,000 blocks and refuses larger ranges outright.
4. **ERC-20 transfers to a contract succeed with no `receive()`/`fallback()`** — the ERC-20 path
   moves the native balance without invoking the recipient.

The `llms.txt` in the Arc docs still says "Testnet only", which contradicts the banner and the live
RPC. Worth fixing — it is the first thing an agent reads.

---

## Pre-submission checklist

- [x] Live deployment on Arc mainnet, with a link that opens
- [x] Public repo
- [x] Short description of what it does and what it uses Arc for
- [x] Public builder profile (GitHub)
- [x] **Mainnet exercise run** — 15/15 pass, 7 transactions on chain 5042, hashes cited above.
      The contract is deployed *and working*, not merely deployed.
- [x] Submitted at https://dorahacks.io/hackathon/arc-microgrants/detail — pending review.

## Wallet for payout

Microgrants are paid in USDC on Arc. Receiving address must be one the user controls on chain 5042.
