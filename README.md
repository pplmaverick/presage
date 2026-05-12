# Arc Network Projects

Independent crypto trader building on Circle's Arc Network (Chain ID: 5042002).

## Deployed Contracts

### WeatherMarket (Core Project)
The main contract — a decentralized weather prediction market settled in USDC.

| Field | Value |
|-------|-------|
| Contract Address | `0x072a3a0c04cf8cdcaf5b4a73a4ea4ff5a841531f` |
| Transaction Hash | `0xcbadd466e96480deed94505468bbbccd016c687b8cc164930ae121207a3583d7` |
| Network | Arc Network Testnet (Chain ID: 5042002) |
| Explorer | [View on ArcScan](https://testnet.arcscan.app/tx/0xcbadd466e96480deed94505468bbbccd016c687b8cc164930ae121207a3583d7) |

**Features:**
- Create weather prediction markets (temperature, rainfall, etc.)
- Users place USDC bets on outcomes (Above / Below threshold)
- Owner settles market based on real weather data from n8n Oracle
- Winners claim proportional rewards automatically

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
- [ ] P3 — Weather Prediction Market core contracts + n8n Oracle
- [ ] P4 — Circle Developer Grant application

## Project Vision

**Weather Prediction Market on Arc**
- Users bet on weather outcomes using USDC
- n8n-powered lightweight Oracle fetches OpenWeather data and pushes on-chain
- Smart contract auto-settles with USDC
- ERC-8004 AI Agent integration

## Stack
- Solidity / Remix / Hardhat
- n8n (self-hosted Oracle on VPS)
- OpenWeather / ECMWF / GFS weather data
- Circle USDC / Arc Network

## Developer
- GitHub: [pplmaverick](https://github.com/pplmaverick)
- Wallet: 0x529...d35b9 (800+ mainnet transactions, multi-chain deployments)
