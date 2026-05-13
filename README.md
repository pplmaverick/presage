# Arc Network Projects

Independent crypto trader building on Circle's Arc Network (Chain ID: 5042002).

## Deployed Contracts

### WeatherMarket v2 — arc-weather-market (Core Project)

The main contract system — a decentralized weather prediction market settled in USDC, built with Hardhat + OpenZeppelin.

| 合約 | 地址 |
|------|------|
| WeatherMarket | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |
| AdminOracle | `0xbdc53e50b1167ce1199bfad54a034f7ab1741051` |
| MarketFactory | `0x914c40a644493b47336de847b0404e729e06c68d` |
| USDC (testnet) | `0x3600000000000000000000000000000000000000` |

**Features:**
- Multi-bucket temperature prediction (e.g. ≤25 / 25~28 / 28~31 / 31~34 / >34°C)
- Users place USDC bets per bucket; winners share the pool proportionally
- AdminOracle (onlyOwner) submits final temperature on-chain
- ReentrancyGuard on claimWinnings; 2% platform fee
- MarketFactory deploys WeatherMarket + AdminOracle pairs

### First Market

| 項目 | 值 |
|------|-----|
| marketId | 0 |
| city | Taipei |
| targetDate | 2026-05-14 |
| createMarket tx | `0x3a09da1976fe5a1ce5fb73ae5e39056d77e04b43815ce998803834728bc6a295` |

### WeatherMarket v1 (deprecated)

| Field | Value |
|-------|-------|
| Contract Address | `0x072a3a0c04cf8cdcaf5b4a73a4ea4ff5a841531f` |
| Network | Arc Network Testnet (Chain ID: 5042002) |
| Explorer | [View on ArcScan](https://testnet.arcscan.app/tx/0xcbadd466e96480deed94505468bbbccd016c687b8cc164930ae121207a3583d7) |

### BuyMeACoffee

A tipping contract deployed to Arc Testnet as proof of deployment and first step toward a Weather Prediction Market.

| Field | Value |
|-------|-------|
| Contract Address | `0x9F57ec09303Fd94Fa1ea4AC07932abE844808617` |
| Transaction Hash | `0x659316db5a7e817f060db4c0e3f4d415c19aec180959f145504abd391c318cf2` |
| Network | Arc Network Testnet (Chain ID: 5042002) |
| Verified | [Sourcify](https://repo.sourcify.dev/5042002/0x9F57ec09303Fd94Fa1ea4AC07932abE844808617/) |
| Explorer | [View on ArcScan](https://testnet.arcscan.app/tx/0x659316db5a7e817f060db4c0e3f4d415c19aec180959f145504abd391c318cf2) |

## Roadmap

- [x] P1 — Arc Testnet setup, first contract deployed
- [x] P2 — Hardhat environment + USDC integration
- [x] P3 — Weather Prediction Market core contracts + n8n Oracle
- [ ] P4 — Circle Developer Grant application

## Project Vision

**Weather Prediction Market on Arc**
- Users bet on weather outcomes using USDC
- n8n-powered lightweight Oracle fetches OpenWeather data and pushes on-chain
- Smart contract auto-settles with USDC
- ERC-8004 AI Agent integration

## Stack
- Solidity / Hardhat / OpenZeppelin
- n8n (self-hosted Oracle on VPS)
- OpenWeather / ECMWF / GFS weather data
- Circle USDC / Arc Network

## Developer
- GitHub: [pplmaverick](https://github.com/pplmaverick)
- Wallet: 0x529...d35b9 (800+ mainnet transactions, multi-chain deployments)
