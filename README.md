# Arc Weather Market

![Arc Testnet](https://img.shields.io/badge/Arc_Testnet-5042002-blue)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/grant-under_review-orange)

**Live Demo → [arc-projects.vercel.app](https://arc-projects.vercel.app)** · Network: Arc Testnet (Chain ID 5042002)

---

A USDC-native prediction market infrastructure built on Arc Network (Circle's EVM chain). Weather is the first use case — MarketFactory supports any quantifiable real-world event. An n8n-powered oracle fetches verified data and settles on-chain automatically via ERC-8004 AI Agent — no custodian, no manual intervention.

## Overview

Each market defines a city, a target date, and a set of temperature buckets (e.g. ≤25 / 26–28 / 29–31 / 32–34 / >34°C). Users deposit USDC into a bucket before the lock time. After the oracle submits the final temperature, winners split the net pool proportionally to their stake.

The system consists of three contracts deployed on Arc Testnet (Chain ID: 5042002):

- **WeatherMarket** — holds bets, manages market lifecycle, distributes USDC payouts
- **AdminOracle** — the permissioned entry point for submitting on-chain results
- **MarketFactory** — deploys matched WeatherMarket + AdminOracle pairs in a single transaction

## Why Arc-Native

The contract stack is built around Arc's specific properties rather than being a generic EVM port.

| Design concern | Typical EVM approach | Arc-native approach |
|---|---|---|
| Settlement currency | Wrap or bridge an external stablecoin | Circle's USDC deployed natively on Arc — no bridge risk, no synthetic wrapper |
| Deploying new markets | Manually deploy contracts and wire them together | `MarketFactory.deployMarketWithOracle()` atomically deploys a WeatherMarket + AdminOracle pair and hands ownership to the caller in one tx |
| Off-chain data feed | Chainlink node subscription or centralized relayer | Self-hosted n8n workflow on VPS — pulls OpenWeather data, verifies, and calls `submitResult()` directly; no external oracle dependency |
| Agent composability | Custom integration per application | ERC-8004 AI Agent (agentId: 6762) registered on-chain — any agent runtime that speaks the standard can read market state and place bets programmatically |

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

## Deployed Contracts

**Arc Testnet (Chain ID: 5042002)**

| Contract | Address |
|---|---|
| WeatherMarket (v2) | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |
| AdminOracle | `0xbdc53e50b1167ce1199bfad54a034f7ab1741051` |
| MarketFactory | `0x914c40a644493b47336de847b0404e729e06c68d` |
| USDC (Arc native) | `0x3600000000000000000000000000000000000000` |

**ERC-8004 AI Agent**

| Field | Value |
|---|---|
| Agent ID | 6762 |
| Name | WeatherOracle |
| Registration tx | `0x6ea8835782b5fc553e2b8834be7b711ebe1a05e61687f73e293dd6592aee8981` |

**First Market**

| Field | Value |
|---|---|
| marketId | 0 |
| City | Taipei |
| Target date | 2026-05-14 |
| createMarket tx | `0x3a09da1976fe5a1ce5fb73ae5e39056d77e04b43815ce998803834728bc6a295` |

## Core Features

### Multi-Bucket Temperature Prediction

Markets define temperature ranges as an ascending array of upper bounds. Given `buckets = [25, 28, 31, 34]`, five prediction ranges are created. This structure scales to any granularity without changing the contract interface.

### USDC-Native Settlement

All bets and payouts use Circle's USDC precompile on Arc (`0x360...`). No wrapping, no swaps — the asset users approve is the same asset they receive.

### MarketFactory

`deployMarketWithOracle()` deploys a WeatherMarket and AdminOracle atomically: the factory sets the oracle address on the market, then transfers ownership of both contracts to the caller. This makes spinning up isolated market instances safe and reproducible.

### n8n Oracle Integration

The oracle layer is a self-hosted n8n workflow rather than an on-chain subscription service. The workflow polls OpenWeather (and optionally ECMWF/GFS for verification), constructs the `submitResult` call, and fires it through the AdminOracle contract. Running on a VPS means the oracle has no dependency on a third-party node operator or subscription fee.

### ERC-8004 AI Agent

Agent ID 6762 (`WeatherOracle`) is registered on-chain. Any agent runtime that implements the ERC-8004 standard can read market state and place bets programmatically — no custom integration required.

## Quick Start

**Prerequisites**
- Node.js 18+
- An Arc Testnet wallet with ETH (for gas) and USDC
- An OpenWeather API key (for the oracle)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Deployer wallet private key (no 0x prefix) |
| `USDC_ADDRESS` | USDC contract address — testnet: `0x3600000000000000000000000000000000000000` |

```bash
# 3. Compile contracts
npx hardhat compile

# 4. Run tests
npx hardhat test

# 5. Deploy (saves addresses to deployments/arc-testnet.json)
npx hardhat run scripts/deploy.ts --network arc

# 6. Create a market (Taipei, 5 buckets: ≤25 / 26–28 / 29–31 / 32–34 / >34°C)
npx hardhat run scripts/createMarket.ts --network arc

# 7. Submit oracle result
npx hardhat run scripts/submitResult.ts --network arc
```

**n8n Oracle Setup**

The oracle follows a strict two-phase settlement sequence:

1. **lockMarket(marketId)** — closes the betting window; no new bets accepted after this point
2. **submitResult(city, temp, marketId)** — submits the final temperature and triggers payout calculation

> ⚠️ submitResult will revert if called before lockMarket. Always execute in order.

In your self-hosted n8n instance, configure the workflow as follows:

- **Trigger**: Schedule node fires after each market's `lockTime`
- **Phase 1**: Write Contract node → `WeatherMarket.lockMarket(marketId)`
- **Wait**: 30-second delay node to ensure lockMarket is confirmed on-chain
- **Phase 2**: HTTP Request node → OpenWeather API for target city and date
- **Phase 3**: Write Contract node → `AdminOracle.submitResult(city, temp, marketId)`
- **Error handling**: Enable n8n built-in retry (3 attempts, 10s interval) on both Write Contract nodes
- **Notifications**: Connect an error branch to a Telegram or email node for settlement failure alerts

## Contract Interface

```solidity
// WeatherMarket
createMarket(string city, uint256 targetDate, int256[] buckets, uint256 lockTime) returns (uint256 marketId)
placeBet(uint256 marketId, uint8 bucket, uint256 amount)
lockMarket(uint256 marketId)
claimWinnings(uint256 marketId)
withdrawFees()
getMarket(uint256 marketId)

// AdminOracle
submitResult(string city, int256 temp, uint256 marketId)

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
| 1 | > 25°C 且 ≤ 28°C |
| 2 | > 28°C 且 ≤ 31°C |
| 3 | > 31°C 且 ≤ 34°C |
| 4 | > 34°C |

Oracle rounding: raw float values are floored before submission (e.g. 24.76°C → 24°C).

## Fees & Security

**Fees**
- Platform fee: 2% of total pool (`FEE_BPS = 200`), deducted only when there is at least one winner
- No-winner case: fee waived, all USDC refunded at face value
- Oracle cost: zero on-chain fee — oracle wallet pays only gas for `submitResult`

**Security**
- `onlyOracle` modifier gates `submitResult`
- `onlyOwner` gates `createMarket`, `setOracle`, `withdrawFees`, and all MarketFactory functions
- `ReentrancyGuard` on `claimWinnings`
- Market state machine enforces strict progression: `OPEN → LOCKED → SETTLED`

## Roadmap

**✅ M1 — Testnet MVP (completed)**
- 4 smart contracts deployed on Arc Testnet
- n8n Oracle automation live on VPS
- ERC-8004 Agent registered (agentId: 6762)
- React frontend deployed to Vercel
- Multi-city support: Taipei, Tokyo, Bangkok, Seoul
- ArcScan explorer links integrated (tx hashes clickable)
- First market fully settled (Taipei, 54 USDC)
- Circle Developer Grant application submitted (under review)

**⬜ M2 — Mainnet Launch (targeting Summer 2026)**
- Deploy to Arc Mainnet
- Multi-city support: Tokyo, Bangkok, Seoul
- Custom domain frontend
- Multi-source weather oracle (OpenWeather + WeatherAPI median)
- TypeScript SDK (`createMarket`, `placeBet` wrappers)
- 50+ unique wallets

**⬜ M3 — Autonomous Agent (post-mainnet)**
- ERC-8004 Agent autonomously creates markets (no manual `createMarket`)
- ERC-8004 Agent autonomously submits oracle results
- Chainlink Oracle integration (pending Arc mainnet availability)

## Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.28, OpenZeppelin 5.x |
| Development | Hardhat 3 + Viem |
| Frontend | React + Vite + Tailwind CSS (Vercel) |
| Oracle automation | n8n (self-hosted VPS) |
| Weather data | OpenWeather API, ECMWF, GFS |
| Settlement token | Circle USDC on Arc Network |

## Developer

GitHub: [pplmaverick](https://github.com/pplmaverick)
Wallet: `0x529...d35b9` — 800+ mainnet transactions across multiple chains

## License

MIT

