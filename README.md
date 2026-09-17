# Presage

**On-chain prediction markets, built on Arc. Weather is just the beginning.**

[![CI](https://github.com/pplmaverick/presage/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/pplmaverick/presage/actions/workflows/test.yml)
![Arc Mainnet](https://img.shields.io/badge/Arc_Mainnet-5042-brightgreen)
![Arc Testnet](https://img.shields.io/badge/Arc_Testnet-5042002-blue)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple)
![License](https://img.shields.io/badge/license-MIT-green)

**Live → [presage-arc.vercel.app](https://presage-arc.vercel.app)** · Arc Mainnet (Chain ID 5042)

---

A USDC-native prediction market on Arc Network (Circle's EVM chain). Weather is the first use case — `MarketFactory` supports any quantifiable real-world event.

Markets are **operated manually by the contract owner**: a human creates each market, locks it after the betting window, fetches the temperature, and submits the result — every step signed from a connected wallet. There is no automated settlement bot running today. If the owner fails to settle in time, bettors can withdraw their own principal without needing anyone's permission (see [Settlement & the refund escape hatch](#settlement--the-refund-escape-hatch)).

## Deployed Contracts

**Arc Mainnet** — Chain ID `5042` · gas token: USDC · explorer: [explorer.arc.io](https://explorer.arc.io)

| Contract | Address |
|---|---|
| WeatherMarket | [`0xcac5b9d2…cf953`](https://explorer.arc.io/address/0xcac5b9d2817325e78090e3ce4b9c299c819cf953) |
| AdminOracle | [`0xbdc53e50…41051`](https://explorer.arc.io/address/0xbdc53e50b1167ce1199bfad54a034f7ab1741051) |
| MarketFactory | [`0x914c40a6…6c68d`](https://explorer.arc.io/address/0x914c40a644493b47336de847b0404e729e06c68d) |
| USDC | [`0x3600…0000`](https://explorer.arc.io/address/0x3600000000000000000000000000000000000000) |

**Arc Testnet** — Chain ID `5042002` · explorer: [explorer.testnet.arc.io](https://explorer.testnet.arc.io)

| Contract | Address |
|---|---|
| WeatherMarket | [`0x0bfb97a0…3e698c`](https://explorer.testnet.arc.io/address/0x0bfb97a06521f4be7407891530ab22468d3e698c) |
| AdminOracle | [`0xf7280ca7…05b2f`](https://explorer.testnet.arc.io/address/0xf7280ca7e04a8bbdc65edcac80ec49e98c305b2f) |
| MarketFactory | [`0xe8fc501b…b2920`](https://explorer.testnet.arc.io/address/0xe8fc501b1d7f79b3f4dc11178cda779a09db2920) |
| USDC | [`0x3600…0000`](https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000) |

Both networks run the same contract version and are maintained in parallel — testnet is where changes are exercised before mainnet. Canonical addresses live in `deployments/arc-mainnet.json` and `deployments/arc-testnet.json`; treat those files as the source of truth, not this table.

> ⚠️ **The mainnet WeatherMarket and AdminOracle addresses are byte-identical to the *retired* testnet deployment.** Contract addresses are `keccak(deployer, nonce)`, and the deployer's nonce on each chain happened to line up. Always check the chain ID — the address alone will not tell you which network you are looking at. The retired testnet addresses are recorded under `previousDeployment` in `deployments/arc-testnet.json`.

## Overview

Each market defines a city, a target date, and a set of temperature buckets (e.g. ≤25 / 26–28 / 29–31 / 32–34 / >34°C). Users deposit USDC into a bucket before the lock time. Once the result is submitted, winners split the net pool proportionally to their stake.

Three contracts:

- **WeatherMarket** — holds bets, manages the market lifecycle, distributes USDC payouts
- **AdminOracle** — the permissioned entry point for submitting results
- **MarketFactory** — deploys matched WeatherMarket + AdminOracle pairs in a single transaction

## Architecture

```
  Bettor (any wallet)                    Owner (single EOA)
        │                                       │
        │ 1. approve + placeBet                 │ a. createMarket        ┐
        ▼                                       │ b. lockMarket          │ signed in the
  ┌──────────────────┐                          │ c. submitResult ──┐    │ browser from
  │  WeatherMarket   │◄─────────────────────────┘                   │    │ /admin, or via
  │  OPEN → LOCKED   │                                              │    │ the CLI scripts
  │      → SETTLED   │◄──── AdminOracle.submitResult(city,temp,id) ─┘    ┘
  └────────┬─────────┘        (onlyOwner → onlyOracle)
           │
           │ 2a. claimWinnings   (SETTLED)
           │ 2b. claimRefund     (still LOCKED past settlementDeadline)
           ▼
       Bettor gets USDC
```

Temperature data comes from the OpenWeather API, fetched at settlement time through a server-side route (`/api/weather/[city]`) so the API key never reaches the browser. A human reads the value, confirms it on screen, and signs the transaction.

`docs/arc_presage_architecture.svg` shows the **original** design, in which an n8n workflow triggered settlement. That workflow has been archived and is no longer part of the system; the diagram is kept for historical reference only.

## Settlement & the refund escape hatch

Settlement is a two-step sequence, and `submitResult` reverts if called before `lockMarket`:

1. **`lockMarket(marketId)`** — closes the betting window. Permissionless: anyone can call it once `lockTime` has passed, so a negligent owner cannot keep a market open forever.
2. **`AdminOracle.submitResult(city, temp, marketId)`** — `onlyOwner`. Writes the final temperature and computes the winning bucket.

Every market stores its own `lockedTimeout` at creation time, which defines a hard deadline:

```
settlementDeadline = lockTime + lockedTimeout
```

- **Before the deadline** — the owner can settle; nobody can refund.
- **On or after the deadline** — `submitResult` is permanently closed for that market, and every bettor can call **`claimRefund(marketId)`** to withdraw their full principal, with **no 2% fee deducted**.

The two windows are mutually exclusive by construction, so the same principal can never be both refunded and settled. The trade-off is deliberate: an owner who is more than `lockedTimeout` late loses the ability to settle that market at all, and the money goes back to the people who staked it.

`lockedTimeout` is chosen per market from `MIN_LOCKED_TIMEOUT = 1 day` to `MAX_LOCKED_TIMEOUT = 30 days`; `defaultLockedTimeout` is 3 days. Changing the default only affects markets created afterwards — markets that already hold deposits keep the deadline they were created with.

## Admin panel

`/admin` on the frontend. The route reads `WeatherMarket.owner()` and compares it to the connected wallet:

- Non-owner, or no wallet connected → the **ADMIN** nav entry is not rendered, and navigating to `/admin` directly redirects to the home page without rendering any panel content.
- While the check is still resolving (wallet reconnecting, or the `owner()` call in flight) → nothing is rendered and no redirect fires, so the page does not flash.

What the owner can do there, all signed from the connected wallet — **the frontend holds no private key and performs no signing of its own**:

| Action | Notes |
|---|---|
| Create market | City from the supported list, buckets validated as strictly increasing, fixed dropdowns for betting window (24h / 2d / 3d / 7d / 14d) and settlement window (3d / 7d / 14d / 30d). A `simulateContract` dry run must pass before the submit button unlocks; editing any field invalidates it. |
| Market list | Status, lock time, settlement deadline, pool size. Amber when less than 24h remains to settle, red once the window has closed. |
| Lock market | Shown only when a market is `OPEN` and `lockTime` has passed. |
| Submit result | Fetches the temperature, shows the raw value and the rounded integer for confirmation, then submits. The `city` argument is read from `getMarket` and has no input field — the contract does not verify that `city` matches the market, so it must not be hand-typed. |
| Withdraw fees | Transfers `collectedFees` only; user principal is untouchable through this path. |
| Set default settlement window | Applies to future markets only. |

`scripts/lock-markets.ts` and `scripts/submit-results.ts` remain a fully supported CLI fallback if the frontend is unavailable.

## Why Arc-Native

| Design concern | Typical EVM approach | This project on Arc |
|---|---|---|
| Settlement currency | Wrap or bridge an external stablecoin | Circle's USDC, native on Arc — no bridge, no synthetic wrapper. It is also the gas token. |
| Gas budgeting | Denominated in a volatile native coin | Fees are paid in USDC, so operating cost is dollar-denominated and predictable |
| Deploying new markets | Manually deploy and wire contracts | `MarketFactory.deployMarketWithOracle()` deploys a WeatherMarket + AdminOracle pair and hands ownership to the caller in one tx |
| Agent composability | Custom integration per application | ERC-8004 agent (`agentId: 6762`) registered on Arc Testnet — any runtime speaking the standard can read market state and place bets. It does **not** participate in settlement today. |

**A note on USDC.** Arc's USDC at `0x3600…0000` is *not* a precompile, despite the address shape. Per Arc's documentation it is a native token exposed through an optional ERC-20 interface, and the contract at that address is an upgradeable proxy. Native balances are accounted in 18 decimals while the ERC-20 view uses 6 — the same balance, two representations.

## Core Features

### Multi-bucket temperature prediction

Markets define ranges as an ascending array of upper bounds. Given `buckets = [25, 28, 31, 34]`, five prediction ranges are created. The structure scales to any granularity without changing the contract interface.

### USDC-native settlement

All bets and payouts use Arc's USDC. No wrapping, no swaps — the asset users approve is the asset they receive.

### MarketFactory

`deployMarketWithOracle()` deploys a WeatherMarket and AdminOracle atomically: the factory sets the oracle address on the market, then transfers ownership of both to the caller.

## Quick Start

**Prerequisites**
- Node.js 18+
- An Arc wallet funded with USDC — on Arc, USDC *is* the gas token; you do not need ETH
- An OpenWeather API key (only needed if you want live temperature lookups)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Deployer / operator wallet key (no `0x` prefix) |
| `ARC_RPC_URL` | Arc Testnet RPC (defaults to the public node) |
| `ARC_MAINNET_RPC_URL` | Arc Mainnet RPC (defaults to the public node) |
| `NETWORK` | `arc-testnet` (default) or `arc-mainnet` — scripts refuse to run until the RPC's chain ID matches |

```bash
# 3. Compile and test
npx hardhat compile
npx hardhat test nodejs

# 4. Deploy (writes deployments/arc-<network>.json)
NETWORK=arc-testnet npx hardhat run scripts/deploy.ts --network arc

# 5. Create a market
CITY=Taipei LOCK_DELAY=86400 LOCKED_TIMEOUT=259200 \
  NETWORK=arc-testnet npx hardhat run scripts/create-market.ts --network arc

# 6. Lock every market whose lockTime has passed
NETWORK=arc-testnet npx hardhat run scripts/lock-markets.ts --network arc

# 7. Submit results (temperatures supplied explicitly; city is read from chain)
RESULTS="0:26,1:31" NETWORK=arc-testnet \
  npx hardhat run scripts/submit-results.ts --network arc

# 8. Refund from any market that blew past its settlement deadline
NETWORK=arc-testnet npx hardhat run scripts/claim-refund.ts --network arc
```

Steps 5–8 scan `0..nextMarketId-1` and act on whatever is in the right state, rather than relying on hard-coded market IDs.

`scripts/createMarket.ts` and `scripts/submitResult.ts` are earlier single-market scripts kept for reference; they are testnet-only. Use the hyphenated ones above.

**Gas.** No script hard-codes a gas price. `scripts/lib/ops.ts` queries `eth_feeHistory` before each transaction and uses the **median** of per-block p90 tips (+20% headroom, capped at 200 gwei), with `maxFeePerGas = baseFee × 2 + priority`. The median matters: Arc produces occasional outlier blocks — one mainnet sample had a block with a 268 gwei p90 tip while the base fee sat flat at 20 gwei and blocks were 8–25% full — and taking the maximum lets a single outlier inflate every subsequent transaction. Deployment gas limits come from `estimateGas` plus a 30% buffer, never a fixed number.

## Contract Interface

```solidity
// WeatherMarket — owner
createMarket(string city, uint256 targetDate, int256[] buckets, uint256 lockTime)
  returns (uint256 marketId)                       // uses defaultLockedTimeout
createMarket(string city, uint256 targetDate, int256[] buckets, uint256 lockTime,
             uint256 lockedTimeout) returns (uint256 marketId)
setOracle(address oracle)
setDefaultLockedTimeout(uint256 newTimeout)        // affects future markets only
withdrawFees()

// WeatherMarket — oracle
submitResult(uint256 marketId, int256 finalTemp)   // reverts past settlementDeadline

// WeatherMarket — anyone
placeBet(uint256 marketId, uint8 bucket, uint256 amount)
lockMarket(uint256 marketId)                       // permissionless once lockTime passes
claimWinnings(uint256 marketId)                    // SETTLED markets
claimRefund(uint256 marketId)                      // LOCKED markets past the deadline

// WeatherMarket — views
getMarket(uint256 marketId)
settlementDeadline(uint256 marketId)               // lockTime + lockedTimeout
marketLockedTimeout(uint256 marketId)
defaultLockedTimeout() / MIN_LOCKED_TIMEOUT() / MAX_LOCKED_TIMEOUT()
bets() / bucketTotals() / userTotalBets() / claimed() / collectedFees() / nextMarketId()

// AdminOracle
submitResult(string city, int256 temp, uint256 marketId)   // onlyOwner
setWeatherMarket(address weatherMarket)

// MarketFactory
deployMarketWithOracle() returns (address market, address oracle)
getDeployedMarkets() returns (address[])
getDeployedOracles() returns (address[])
```

## Temperature Encoding & Bucket System

Temperatures are passed as plain integers (whole degrees Celsius). Given `buckets = [25, 28, 31, 34]`:

| Bucket | Range |
|---|---|
| 0 | ≤ 25°C |
| 1 | > 25°C and ≤ 28°C |
| 2 | > 28°C and ≤ 31°C |
| 3 | > 31°C and ≤ 34°C |
| 4 | > 34°C |

The winning bucket is the first `i` where `temp <= buckets[i]`, otherwise `buckets.length`.

**Rounding:** the raw API value is rounded to the nearest integer with `Math.round` before submission (e.g. `25.85°C → 26`, `24.4°C → 24`). The admin panel displays both the raw value and the rounded integer for confirmation before the transaction is signed.

## Fees & Security

**Fees**
- Platform fee: 2% of the total pool (`FEE_BPS = 200`), charged only when there is at least one winner
- No-winner case: fee waived, every bettor refunded at face value
- Timed-out case: fee waived, every bettor refunds their own principal via `claimRefund`
- Integer division floors payouts, so a few units of rounding dust can remain in the contract; `withdrawFees` cannot reach it

**Access control**
- `onlyOracle` gates `submitResult` on WeatherMarket; the oracle is the AdminOracle contract, whose own `submitResult` is `onlyOwner`
- `onlyOwner` gates `createMarket`, `setOracle`, `setDefaultLockedTimeout`, `withdrawFees`, and all MarketFactory functions
- `lockMarket`, `claimWinnings` and `claimRefund` are open to anyone; each user can only claim their own position, once

**Contract hardening**
- `ReentrancyGuard` on `placeBet`, `claimWinnings` and `claimRefund`
- `placeBet` writes all state before its single external call, then asserts the received balance delta equals the requested amount — a fee-on-transfer token would revert the whole transaction rather than leave the books overstated
- `SafeERC20` for every token transfer
- `lockMarket` rejects market IDs that do not exist yet
- `createMarket` bounds `lockTime` and `targetDate` to 90 days out
- State machine: `OPEN → LOCKED → SETTLED`, with `LOCKED → (refund-only)` after the deadline

**Owner trust model.** A single EOA owns all three contracts and is also the owner of the AdminOracle. That key can create markets, repoint the oracle, submit results, and withdraw fees. It cannot withdraw user principal, and it cannot settle a market after its deadline. There is no multisig or timelock today.

**Verification.** The contracts went through an internal security audit followed by Independent Reference Model testing: a Python model written from the specification alone produces the expected outcome for 32 scenarios and commits each trace to a SHA-256 digest, which a Hardhat test replays against the real contracts and compares byte-for-byte. Those artifacts live in `verification/`. The full suite is 59 tests, and the refund path was additionally exercised end-to-end on Arc Testnet with real transactions.

## Roadmap

**✅ M1 — Testnet MVP**
- Contracts deployed on Arc Testnet
- ERC-8004 agent registered (`agentId: 6762`)
- React frontend on Vercel, multi-city: Taipei, Tokyo, Bangkok, Seoul
- Explorer links integrated
- Circle Developer Grant application submitted

**✅ M2 — Audit & mainnet deployment**
- Internal security audit + Independent Reference Model testing
- Per-market settlement deadline and `claimRefund` escape hatch
- Owner-gated admin panel replacing private-key CLI operation as the primary path
- End-to-end verification on Arc Testnet, including the refund path
- Contracts deployed to Arc Mainnet (Chain ID 5042)

**⬜ M3 — Hardening & automation**
- Move ownership to a multisig
- Multi-source temperature data (currently a single OpenWeather feed with no cross-check)
- Verify `city` on-chain at settlement instead of trusting the caller
- Rebuild automated settlement — the previous n8n workflow was archived after it was found to be reporting JSON-RPC errors as successes
- Custom domain, TypeScript SDK

## Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.28, OpenZeppelin 5.x |
| Development | Hardhat 3 + Viem |
| Frontend | React + Vite + Tailwind CSS (Vercel) |
| Wallet / chain access | wagmi + viem, reads proxied server-side |
| Verification | Hardhat tests, Python reference model, Playwright browser E2E |
| Weather data | OpenWeather API (single source) |
| Settlement token | Circle USDC on Arc Network |

## Developer

GitHub: [pplmaverick](https://github.com/pplmaverick)
Owner wallet: `0xed2B5717c9b936ecC76d75401026A99143e278F5`

## License

MIT
