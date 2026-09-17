# Legacy Arc Testnet deployment (retired)

> ⚠️ **This file is a historical record of a deployment that is no longer in use.**
>
> Nothing on this page describes Arc Mainnet or the current Arc Testnet deployment.
> The figures below were accurate for the retired testnet contracts at the time they
> were written and are **not** current usage statistics for the live product.
>
> For live addresses see the [README](../README.md) and, authoritatively,
> `deployments/arc-mainnet.json` and `deployments/arc-testnet.json`.

## ⚠️ Read this before comparing addresses

The retired testnet WeatherMarket and AdminOracle have addresses that are
**byte-identical to the current Arc Mainnet contracts**:

| Contract | Address | Retired testnet (5042002) | Current mainnet (5042) |
|---|---|---|---|
| WeatherMarket | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` | ⬅ this page | ⬅ live |
| AdminOracle | `0xbdc53e50b1167ce1199bfad54a034f7ab1741051` | ⬅ this page | ⬅ live |

This is not a mistake and not a proxy. A contract address created with `CREATE` is
`keccak(deployer, nonce)`, and the deployer wallet happened to reach the same nonce
on both chains — testnet nonce 1–2 in May 2026, mainnet nonce 1–2 in September 2026.

**Consequence:** the address alone cannot tell you which network you are looking at.
Always check the chain ID. Querying `0xcac5b9d2…` against a testnet RPC returns the
retired contract described here; querying the same address against a mainnet RPC
returns the live production contract.

The `MarketFactory` addresses do differ (`0x1321b178…` retired testnet vs
`0x914c40a6…` mainnet), because a `setOracle` transaction sat between the two
deployments on mainnet and shifted the nonce.

## Retired deployment record

Deployed **2026-05-13T04:45:22Z** on Arc Testnet (Chain ID 5042002).

| Contract | Address |
|---|---|
| WeatherMarket | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |
| AdminOracle | `0xbdc53e50b1167ce1199bfad54a034f7ab1741051` |
| MarketFactory | `0x1321b1782838b193df74118fc134eac278a33eef` |
| USDC (Arc) | `0x3600000000000000000000000000000000000000` |

Also preserved under `previousDeployment` in `deployments/arc-testnet.json`.

This deployment was superseded on **2026-09-16** by
`0x0bfb97a06521f4be7407891530ab22468d3e698c`, which added the per-market
settlement timeout and the `claimRefund` escape hatch. The retired contracts were
never upgraded — they are immutable and still sitting on testnet in their final state.

## ERC-8004 AI Agent

Registered against the retired deployment. The agent ID is still valid on testnet;
it does not participate in settlement.

| Field | Value |
|---|---|
| Agent ID | 6762 |
| Name | WeatherOracle |
| Owner | `0xed2B5717c9b936ecC76d75401026A99143e278F5` |
| Validator | `0xAcCC48919cA90Bd3643031517CD1eFDF9E2C9Dd0` |
| Registration tx | `0x6ea8835782b5fc553e2b8834be7b711ebe1a05e61687f73e293dd6592aee8981` |
| Registered at | 2026-05-13T06:21:04Z |

## First Market

Moved verbatim from the README as it stood before the mainnet launch:

| Field | Value |
|---|---|
| marketId | 0 |
| City | Taipei |
| Target date | 2026-05-14 |
| createMarket tx | `0x3a09da1976fe5a1ce5fb73ae5e39056d77e04b43815ce998803834728bc6a295` |

On-chain state of that market, read back from the retired testnet contract on
2026-09-17 (it has been settled and unchanged since May):

| Field | On-chain value |
|---|---|
| city | `Taipei` |
| lockTime | `1778731706` → 2026-05-14 04:08:26 UTC |
| targetDate | `1778735306` → 2026-05-14 05:08:26 UTC |
| status | `2` (SETTLED) |
| totalPool | `54000000` → 54.00 USDC |
| finalTemp | `25` |
| winningBucket | `0` (≤ 25°C) |
| buckets | `[25, 28, 31, 34]` |
| noWinner | `false` |

This is the market the pre-mainnet README referred to as
"First market fully settled (Taipei, 54 USDC)".

## Activity figures as published pre-mainnet

The following two lines appeared in the README before the mainnet launch and are
reproduced here **exactly as they were written**. They describe the retired testnet
deployment only.

> - 55+ successful on-chain transactions (WeatherMarket contract)

> Dev Wallet: `0xed2B5717c9b936ecC76d75401026A99143e278F5` — 55+ successful on-chain interactions on Arc Testnet

Neither line recorded the date it was measured, and there is no preserved breakdown
of how the count was composed. What can be verified today, read directly from the
retired contract on Arc Testnet on **2026-09-17**:

| Metric | Value |
|---|---|
| `nextMarketId` | `33` (markets #0–#32 were created over the deployment's lifetime) |
| `collectedFees` | `1360000` → 1.36 USDC of accrued platform fees, never withdrawn |
| USDC held by the contract | `72840000` → 72.84 USDC |
| Unclaimed user funds | ≈ 71.48 USDC (contract balance minus accrued fees) |
| `owner` | `0xed2B5717c9b936ecC76d75401026A99143e278F5` |
| `oracle` | `0xBdC53E50b1167cE1199bFaD54A034f7ab1741051` |

The deployer wallet's testnet nonce was `315` on the same date, covering all
activity across this and every other testnet project, not just this contract.

> The ~71.48 USDC of unclaimed funds is testnet USDC sitting in an immutable,
> superseded contract. It is not reachable by the owner — `withdrawFees` can only
> move `collectedFees` — and remains claimable by whoever placed those bets.

## Pre-mainnet M1 milestone, as published

Reproduced from the README as it stood before the mainnet launch:

> **✅ M1 — Testnet MVP (completed)**
> - 4 smart contracts deployed on Arc Testnet
> - n8n Oracle automation live on VPS
> - ERC-8004 Agent registered (agentId: 6762)
> - React frontend deployed to Vercel
> - Multi-city support: Taipei, Tokyo, Bangkok, Seoul
> - ArcScan explorer links integrated (tx hashes clickable)
> - First market fully settled (Taipei, 54 USDC)
> - Circle Developer Grant application submitted (under review)
> - 55+ successful on-chain transactions (WeatherMarket contract)

Two of these no longer hold:

- **"n8n Oracle automation live on VPS"** — the workflow was archived on
  2026-09-13. It had stopped running months earlier (its last recorded execution
  was 2026-05-26) and, while it was running, its HTTP node treated JSON-RPC errors
  from `eth_sendRawTransaction` as successful responses, so failed submissions were
  recorded as successes. Settlement is now performed by a human via the admin panel
  or the CLI scripts.
- **"ArcScan explorer links"** — `testnet.arcscan.app` now redirects to
  `explorer.testnet.arc.io`, which is what the README links to today.

## Why this deployment was retired

The contracts were rewritten after an internal security audit. The changes that made
a redeploy necessary (rather than a configuration change) were:

- Per-market `lockedTimeout` stored in the `Market` struct, replacing a fixed constant
- `claimRefund` — bettors can withdraw their principal if a market sits `LOCKED` past
  `lockTime + lockedTimeout`, with `submitResult` permanently closed after that point
- `placeBet` reordered to write all state before its external call, plus a balance-delta
  assertion and `nonReentrant`
- `SafeERC20` for all token transfers
- `lockMarket` rejecting market IDs that do not exist yet

None of these could be applied to the deployed contracts, which have no upgrade path
by design.
