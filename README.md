# Arc Weather Market

A decentralized weather prediction market built on [Arc Network](https://arc.network) (Circle's EVM chain), settled entirely in USDC. Users bet on real-world temperature outcomes; an n8n-powered oracle fetches verified weather data and settles the contract on-chain — no custodian, no manual intervention.

## Overview

Each market defines a city, a target date, and a set of temperature buckets (e.g. ≤25 / 26–28 / 29–31 / 32–34 / >34°C). Users deposit USDC into a bucket before the lock time. After the oracle submits the final temperature, winners split the net pool proportionally to their stake.

The system consists of three contracts deployed on Arc Testnet (Chain ID: 5042002):
- **WeatherMarket** — holds bets, manages market lifecycle, distributes USDC payouts
- **AdminOracle** — the permissioned entry point for submitting on-chain results
- **MarketFactory** — deploys matched WeatherMarket + AdminOracle pairs in a single transaction

## Why Arc-Native

The contract stack is built around Arc's specific properties rather than being a generic EVM port.

| Design concern | Typical EVM approach | Arc-native approach |
|----------------|----------------------|---------------------|
| Settlement currency | Wrap or bridge an external stablecoin | Circle's USDC deployed natively on Arc — no bridge risk, no synthetic wrapper |
| Deploying new markets | Manually deploy contracts and wire them together | `MarketFactory.deployMarketWithOracle()` atomically deploys a WeatherMarket + AdminOracle pair and hands ownership to the caller in one tx |
| Off-chain data feed | Chainlink node subscription or centralized relayer | Self-hosted n8n workflow on VPS — pulls OpenWeather data, verifies, and calls `submitResult()` directly; no external oracle dependency |
| Agent composability | Custom integration per application | ERC-8004 AI Agent (`agentId: 6762`) registered on-chain — any agent runtime that speaks the standard can read market state and place bets programmatically |

## Core Features

### Multi-Bucket Temperature Prediction
Markets define temperature ranges as an ascending array of upper bounds. Given `buckets = [25, 28, 31, 34]`, five prediction ranges are created. This structure scales to any granularity without changing the contract interface.

### USDC-Native Settlement
All bets and payouts use Circle's USDC precompile on Arc (`0x360...`). No wrapping, no swaps — the asset users approve is the same asset they receive. The contract uses `IERC20.transferFrom` / `transfer` directly, so any standard USDC-compatible wallet works.

### MarketFactory
`deployMarketWithOracle()` deploys a WeatherMarket and AdminOracle atomically: the factory sets the oracle address on the market, then transfers ownership of both contracts to the caller. This makes spinning up isolated market instances safe and reproducible.

### n8n Oracle Integration
The oracle layer is a self-hosted n8n workflow rather than an on-chain subscription service. The workflow polls OpenWeather (and optionally ECMWF/GFS for verification), constructs the `submitResult` call, and fires it through the AdminOracle contract. Running on a VPS means the oracle has no dependency on a third-party node operator or subscription fee.

## Architecture

```
n8n (self-hosted VPS)
    │
    ├── HTTP Request → OpenWeather API    ← fetch daily high/low temp
    ├── (optional) ECMWF / GFS cross-check
    └── Write Contract → AdminOracle.submitResult(city, temp, marketId)
                              │
                              └── WeatherMarket.submitResult(marketId, finalTemp)
                                        │
                                        ├── determine winning bucket
                                        ├── record finalTemp on-chain
                                        └── unlock claimWinnings()

ERC-8004 AI Agent (agentId: 6762)
    └── reads market state, can call placeBet() programmatically
```

**Stack:**
- Smart contracts: Solidity `^0.8.28`, OpenZeppelin 5.x
- Development: Hardhat 3 + Viem
- Frontend: React + Vite + Tailwind CSS (deployed to Vercel)
- Oracle automation: n8n (self-hosted)
- Weather data: OpenWeather API, ECMWF, GFS
- Settlement token: Circle USDC on Arc Network

## Deployed Contracts

### Arc Testnet (Chain ID: 5042002)

| Contract | Address |
|----------|---------|
| WeatherMarket (v2) | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |
| AdminOracle | `0xbdc53e50b1167ce1199bfad54a034f7ab1741051` |
| MarketFactory | `0x914c40a644493b47336de847b0404e729e06c68d` |
| USDC (Arc native) | `0x3600000000000000000000000000000000000000` |

**ERC-8004 Agent:**

| Field | Value |
|-------|-------|
| Agent ID | `6762` |
| Name | `WeatherOracle` |
| Registration tx | `0x6ea8835782b5fc553e2b8834be7b711ebe1a05e61687f73e293dd6592aee8981` |

### First Market

| Field | Value |
|-------|-------|
| marketId | `0` |
| City | Taipei |
| Target date | 2026-05-14 |
| `createMarket` tx | `0x3a09da...6a295` |

### WeatherMarket v1 (deprecated)

| Field | Value |
|-------|-------|
| Address | `0x072a3a0c04cf8cdcaf5b4a73a4ea4ff5a841531f` |

### BuyMeACoffee (proof of deployment)

| Field | Value |
|-------|-------|
| Address | `0x9F57ec09303Fd94Fa1ea4AC07932abE844808617` |
| Tx | `0x659316db5a7e817f060db4c0e3f4d415c19aec180959f145504abd391c318cf2` |
| Verified | [Sourcify](https://repo.sourcify.dev/5042002/0x9F57ec09303Fd94Fa1ea4AC07932abE844808617/) |

## Live Demo

Frontend: https://arc-projects.vercel.app  
Network: Arc Testnet (Chain ID: 5042002)

## Quick Start

### Prerequisites

- Node.js 18+
- An Arc Testnet wallet with ETH (for gas) and USDC
- An OpenWeather API key (for the oracle)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer wallet private key (no `0x` prefix) |
| `USDC_ADDRESS` | USDC contract address on Arc — testnet: `0x3600000000000000000000000000000000000000` |

### 3. Compile contracts

```bash
npx hardhat compile
```

### 4. Run tests

```bash
npx hardhat test
```

### 5. Deploy

Deploys WeatherMarket, AdminOracle, MarketFactory, and wires them together:

```bash
npx hardhat run scripts/deploy.ts --network arc
```

Addresses are saved to `deployments/arc-testnet.json`.

### 6. Create a market

```bash
npx hardhat run scripts/createMarket.ts --network arc
```

Creates a Taipei high-temperature market locking 1 hour before the target date, with 5 buckets: ≤25 / 26–28 / 29–31 / 32–34 / >34°C.

### 7. Submit a result (oracle)

```bash
npx hardhat run scripts/submitResult.ts --network arc
```

### 8. Configure n8n oracle

In your self-hosted n8n instance, set up a workflow that:
1. Triggers after each market's `lockTime`
2. Calls the OpenWeather API for the target city and date
3. Executes a **Write Contract** node calling `AdminOracle.submitResult(city, temp, marketId)`

## Contract Interface

### WeatherMarket

```solidity
// Owner: create a new market with temperature buckets
createMarket(string city, uint256 targetDate, int256[] buckets, uint256 lockTime)
    returns (uint256 marketId)

// Anyone: deposit USDC into a bucket
placeBet(uint256 marketId, uint8 bucket, uint256 amount)

// Anyone: lock the market once lockTime has passed
lockMarket(uint256 marketId)

// Winner: withdraw USDC payout after settlement
claimWinnings(uint256 marketId)

// Owner: withdraw accumulated platform fees
withdrawFees()

// View: read full market state
getMarket(uint256 marketId)
```

### AdminOracle

```solidity
// Owner: submit real-world temperature and settle the market
submitResult(string city, int256 temp, uint256 marketId)
```

### MarketFactory

```solidity
// Owner: deploy a matched WeatherMarket + AdminOracle pair
deployMarketWithOracle() returns (address market, address oracle)

// View: list all deployed markets / oracles
getDeployedMarkets() returns (address[])
getDeployedOracles()  returns (address[])
```

## Temperature Encoding & Bucket System

Temperatures are passed as plain integers representing degrees Celsius (whole numbers only in this version):

```
31 = 31°C
-3 = -3°C
```

Given `buckets = [25, 28, 31, 34]`, the resulting ranges are:

| Bucket index | Range |
|:------------:|-------|
| 0 | ≤ 25°C |
| 1 | 26°C – 28°C |
| 2 | 29°C – 31°C |
| 3 | 32°C – 34°C |
| 4 | > 34°C |

Bucket boundaries are enforced to be strictly increasing at market creation. The overflow bucket (index = `buckets.length`) captures all values above the highest bound.

**No-winner case:** if no bets were placed in the winning bucket, the market enters a no-winner state and every bettor receives a full refund of their deposited USDC.

## Fees

- **Platform fee:** 2% of total pool (`FEE_BPS = 200`), deducted only when there is at least one winner
- **No-winner refund:** fee is waived; all USDC is returned to depositors at face value
- **Oracle cost:** zero on-chain fee — the n8n oracle wallet pays only the gas for the `submitResult` transaction

## Security

- `onlyOracle` modifier gates `submitResult` — only the configured AdminOracle address can settle a market
- `onlyOwner` gates `createMarket`, `setOracle`, `withdrawFees`, and all MarketFactory functions
- `ReentrancyGuard` on `claimWinnings` prevents re-entrancy during USDC transfers
- Market state machine enforces strict progression: `OPEN → LOCKED → SETTLED`; no function can skip or reverse a state
- API keys and private keys stored in `.env`; never committed (`.gitignore` enforced)

## Roadmap

- ✅ P1 — Arc Testnet setup, first contract deployed (BuyMeACoffee proof)
- ✅ P2 — Hardhat environment + USDC integration
- ✅ P3 — Weather Prediction Market core contracts + n8n Oracle + ERC-8004 agent registration
- ✅ P4 — Circle Developer Grant application submitted
- ⬜ P5 — Arc Mainnet (targeting Summer 2026)
  - M1: Deploy to Mainnet, first live USDC market, custom domain frontend
  - M2: Multi-city expansion (Taipei / Tokyo / Bangkok), 50+ unique wallets
  - M3: ERC-8004 Agent autonomously creates markets + submits oracle data on-chain; decentralized oracle integration (Chainlink / UMA)

## Developer

- GitHub: [pplmaverick](https://github.com/pplmaverick)
- Wallet: `0x529...d35b9` — 800+ mainnet transactions across multiple chains

## License

MIT
