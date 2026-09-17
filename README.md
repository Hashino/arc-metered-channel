# MeteredChannel

Metered payment channel for services consumed by autonomous agents — the infrastructure Arc's own
agent demo shows it needs, but doesn't have.

Built for [Arc](https://docs.arc.io), Circle's Layer-1 where USDC is the native gas token.

---

## The problem, in Arc's own demo

The Arc Portal agent demo prices API calls like this: Polymarket feed **$0.012**, Tavily search
**$0.0612**, X social signals **$0.004**, Browserbase **$0.4012**, Perplexity **$0.015**.

An on-chain payment per call at those values is economically absurd — gas becomes a large fraction
of the payment itself, and an agent makes hundreds of calls. What's missing is the piece that makes
micropayment for agent services work **without custody**: metering off-chain, settlement on-chain,
amortized.

## What this contract does

A payer **deposits once** into a channel with a provider. As each call is served, the payer signs a
voucher off-chain containing the **running total** owed. The provider keeps only the
highest-value voucher it has seen and settles on-chain **whenever it wants** — one transaction for a
thousand calls, not a thousand transactions.

```
payer ──deposit──▶ channel ──claim(diff)──▶ provider
   │                                   ▲
   └── voucher(cumulative), off-chain ──┘   ← one signature per call, zero gas
```

**Why cumulative totals instead of per-call amounts:** vouchers are replay-proof by construction.
The contract pays only `cumulative − already_claimed`. Re-presenting an old voucher pays zero
(reverts `CumulativeNotIncreasing`) — there is no per-call nonce, no spent-voucher list, and no
state that grows with usage.

| Who | Can | Cannot |
|---|---|---|
| Payer | open, top up, close after expiry, sign vouchers | un-sign anything, block claims before expiry |
| Provider | claim partial or full, at any frequency | claim more than signed, claim after expiry |
| Anyone | read | touch funds |

## Why this belongs on Arc specifically

On any other chain, a provider paid in USDC cannot withdraw without holding the chain's native
token. The asset earned and the asset needed to retrieve it are different. On Arc, USDC **is** the
gas token: liquidation cost is quoted in the same asset being settled, so *"is it worth claiming
yet?"* is a single-quantity comparison — and `breakevenClaim(gasPrice)` answers it on-chain with no
price oracle. On another chain that function would need an ETH/USD feed to exist at all.

## Live deployments

| Network | Contract | Deploy cost |
|---|---|---|
| **Arc mainnet** (chain 5042) | [`0x0aec193d8Ec9a7c1170cfB7fd97609E50c16CE73`](https://explorer.arc.io/address/0x0aec193d8Ec9a7c1170cfB7fd97609E50c16CE73) | 927,050 gas @ 20 Gwei = **0.0185 USDC** |
| Arc testnet (chain 5042002) | [`0x9756E03c81c2a422AA13307203Ae5952dE44F7c6`](https://explorer.testnet.arc.io/address/0x9756E03c81c2a422AA13307203Ae5952dE44F7c6) | 935,575 gas @ 25 Gwei = 0.0234 USDC |

4,246 bytes of creation bytecode, 4,034 bytes deployed. No constructor arguments — the EIP-712
domain is fixed at construction, so the same input produced both deployments.

`test/exercise.js` runs the full behaviour suite against a live deployment — no mocks, no local
chain. It runs either network; only the network, the key and the amounts change, never the
assertions. **15/15 pass on testnet and on Arc mainnet.** The mainnet run is 7 transactions on
chain 5042, listed with hashes in `SUBMISSION.md`. **15/15 pass**:

```
1. channel opens           deposit received, expiry set (2h minimum enforced)
2. open validation         self-channel -> SelfChannel; < 1h duration -> BadDuration
3. voucher + claim         provider claimed 0.06; balance moved on-chain
4. replay attack           same voucher again      -> CumulativeNotIncreasing
                           OLDER voucher (lower)   -> CumulativeNotIncreasing
                           (no per-call nonce: immunity comes from monotonic totals)
5. incremental voucher     claim(0.13) paid 0.07 = 0.13 − 0.06, exactly the difference
6. bounds & permission     cumulative > deposit -> ExceedsDeposit
                           wrong signer         -> BadSignature
                           third party claiming -> NotProvider
7. premature close         before expiry -> NotYetExpired
8. top-up                  deposit 0.2 -> 0.3, expiry unchanged
```

## Arc-specific findings (verified, documented for other builders)

1. **The decimals trap.** The native gas balance uses **18 decimals**; the ERC-20 interface over the
   *same* balance uses **6**. This contract uses the ERC-20 interface exclusively and never touches
   the native balance — mixing them silently corrupts value arithmetic.
2. **Blocked addresses revert without a receipt.** A transfer *from* a blocklisted address is
   rejected at the RPC (`"Blocked address"` on `eth_estimateGas`) — well-known Hardhat/Anvil test
   keys are on the list. Test keys must be freshly generated, not the famous ones.
3. **`eth_getLogs` is range-limited** (10,000 blocks) and large ranges are refused outright — scan
   in ≤5,000-block windows.
4. **ERC-20 transfers to a contract succeed with no `receive()`/`fallback()`** — the ERC-20 path
   moves the native balance without invoking the recipient.

## Voucher format (EIP-712)

```
domain:  { name: "MeteredChannel", version: "1", chainId, verifyingContract }
message: Voucher { bytes32 channelId, uint256 cumulative }
```

The domain includes `chainId`, so a testnet voucher is dead on mainnet. Signatures reject the high
half of `s` (no signature malleability) and non-27/28 `v`.

Signing on the client: sign the **raw EIP-712 digest** with the key (`signingKey.sign(digest)`).
Prefixing with `signMessage()`'s personal-message prefix will produce a valid-looking signature
that reverts `BadSignature` — the contract recovers over the digest directly.

## Build, deploy, test

```bash
npm install
npm run build
cp .env.example .env               # PRIVATE_KEY_TESTNET / _MAINNET, per-network, no fallback
node --env-file=.env script/deploy.js testnet
node --env-file=.env test/exercise.js <contract address> testnet
node --env-file=.env test/exercise.js <contract address> mainnet   # USDC de verdade
```

Testnet USDC is free from the [Circle faucet](https://faucet.circle.com) — select **Arc Testnet**
(20 USDC, one request per 2 hours).

## Design decisions worth stating

**Fixed expiry, not a rolling challenge window.** Lightning-style watchtowers are overkill for a
channel whose worst case is bounded by the deposit. The provider's risk window is: services rendered
after the last claim, up to deposit — and the 1-hour minimum duration exists so a payer can't open
channels that expire before the provider's first claim.

**`claim` checks in cheapest-first order** (existence → permission → expiry → monotonicity →
deposit bound → signature), so an invalid attempt costs the least possible gas.

**Effects before interactions.** `claimed` is written before the USDC transfer in `claim`;
`deposited` before the `transferFrom` in `open`/`topUp`.

**No admin key.** No upgrade path, no pause, no owner. The contract is 4.2 KB and finished.

## License

MIT
