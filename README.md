# Pharos Weather Market

![Network](https://img.shields.io/badge/Pharos_Atlantic-688689-blue)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple)
![License](https://img.shields.io/badge/license-MIT-green)

A decentralized temperature prediction market built natively on Pharos, settled entirely in Circle-native USDC. Users onboard from Arc via Arc Bridge Kit + CCTP and bet on real-world temperature outcomes — no wrapped assets, no bridging risk.

**Deployed on Pharos (Pacific Ocean)**

| Network | Contract | Address |
|---|---|---|
| Pharos Mainnet (1672) | WeatherMarket | TBD |
| Pharos Mainnet (1672) | AdminOracle | TBD |
| Pharos Atlantic Testnet (688689) | WeatherMarket | `0x072a3a0c04cf8cdcaf5b4a73a4ed4ff5a841531f` |
| Pharos Atlantic Testnet (688689) | AdminOracle | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |

---

## Why Pharos-Native

This project is not ported from another chain. Every design decision maps to a Pharos-specific capability.

| Problem | Generic EVM approach | Pharos-native approach |
|---|---|---|
| Cross-chain USDC onboarding | Wrapped tokens / third-party bridges | Arc Bridge Kit + CCTP: native burn-and-mint, no wrapped assets |
| Oracle dependency | External oracle required | Owner-submitted results; Phase 2 upgrades to Chainlink CCIP |
| Settlement finality | 10–60s confirmation | Sub-second finality, 30,000 TPS parallel execution |
| RWA-grade stablecoin | Any ERC-20 | Circle-native USDC, part of Pharos RealFi ecosystem |

---

## Architecture

```
Arc Testnet (USDC)
      │
      │  Arc Bridge Kit + CCTP
      │  burn → attest → mint
      ▼
Pharos Mainnet (USDC)
      │
      ├── WeatherMarket.sol
      │     ├── createMarket(city, buckets, lockTime)
      │     ├── placeBet(marketId, bucket, amount)
      │     ├── lockMarket(marketId)
      │     ├── submitResult(marketId, temp)  ← AdminOracle
      │     └── claimWinnings(marketId)
      │
      └── AdminOracle.sol
            └── onlyOwner submitResult → WeatherMarket
```

---

## Core Features

### Arc Bridge Kit + CCTP Cross-chain Onboarding

Users hold USDC on Arc and onboard to Pharos via Arc Bridge Kit, which uses Circle's Cross-Chain Transfer Protocol (CCTP) for native burn-and-mint. The asset that arrives in the user's Pharos wallet is Circle-native USDC — not a synthetic wrapper — which is the same asset accepted by WeatherMarket.

### Multi-Bucket Temperature Prediction

Markets define temperature ranges as an ascending array of upper bounds. Given `buckets = [20, 25, 30, 35]`, five prediction ranges are created:

| Bucket | Range |
|---|---|
| 0 | ≤ 20°C |
| 1 | > 20°C and ≤ 25°C |
| 2 | > 25°C and ≤ 30°C |
| 3 | > 30°C and ≤ 35°C |
| 4 | > 35°C |

Up to 253 buckets per market. The bucket structure scales to any granularity without changing the contract interface.

### No-Winner Full Refund

When no bets land on the winning bucket, the 2% protocol fee is waived and all USDC is refunded at face value. The market's `noWinner` flag triggers this path on-chain automatically.

### 2% Protocol Fee

The fee (`FEE_BPS = 200`) is collected only when at least one winning bet exists. It is deducted from the total pool before proportional payout calculation. Fee accumulates in `collectedFees` and is withdrawable by the owner via `withdrawFees()`.

---

## Deployed Contracts

**Pharos Atlantic Testnet (Chain ID: 688689)**

| Contract | Address |
|---|---|
| WeatherMarket | `0x072a3a0c04cf8cdcaf5b4a73a4ed4ff5a841531f` |
| AdminOracle | `0xcac5b9d2817325e78090e3ce4b9c299c819cf953` |
| USDC (testnet) | `0xcfc8330f4bcab529c625d12781b1c19466a9fc8b` |

**Pharos Pacific Ocean Mainnet (Chain ID: 1672)**

| Contract | Address |
|---|---|
| WeatherMarket | TBD |
| AdminOracle | TBD |
| USDC | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |

---

## Quick Start

**Prerequisites**
- Node.js 18+
- A funded Pharos wallet (PROS for gas, USDC for betting)
- Arc Bridge Kit or direct USDC on Pharos Atlantic for testnet

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Deployer wallet private key (no `0x` prefix) |
| `PHAROS_USDC_ADDRESS` | USDC contract address on Pharos |

```bash
# 3. Compile contracts
npx hardhat compile

# 4. Run tests
npx hardhat test

# 5. Deploy to Pharos Atlantic Testnet
npx hardhat run scripts/deploy-pharos.ts --network pharos

# 6. End-to-end test (creates market → bets → settles → claims)
npx hardhat run scripts/e2e-pharos.ts --network pharos

# 7. Deploy to Pharos Mainnet
npx hardhat run scripts/deploy-pharos.ts --network pharosMainnet
```

---

## Contract Interface

```solidity
// WeatherMarket
createMarket(string city, uint256 targetDate, int256[] buckets, uint256 lockTime) returns (uint256 marketId)
placeBet(uint256 marketId, uint8 bucket, uint256 amount)
lockMarket(uint256 marketId)          // callable by anyone after lockTime
claimWinnings(uint256 marketId)
withdrawFees()                        // onlyOwner
getMarket(uint256 marketId) returns (city, targetDate, lockTime, status, totalPool, finalTemp, winningBucket, buckets, noWinner)

// AdminOracle
submitResult(string city, int256 temp, uint256 marketId)   // onlyOwner
setWeatherMarket(address _weatherMarket)                   // onlyOwner
```

---

## Temperature Encoding & Bucket System

Temperatures are passed as plain `int256` whole-degree Celsius values. No decimal encoding required.

```
submitResult("Taipei", 28, 0)
// 28°C → evaluated against buckets [20, 25, 30, 35]
// 28 ≤ 30 → winning bucket = 2
```

Oracle rounding: raw float values from weather APIs should be floored before submission (e.g. 28.9°C → 28).

---

## Fees & Security

**Fees**
- Protocol fee: 2% of total pool (`FEE_BPS = 200`), deducted only when there is at least one winner
- No-winner case: fee waived, all USDC refunded at face value
- Oracle cost: oracle wallet pays only PROS gas for `submitResult`; no on-chain oracle subscription fee

**Security**
- `onlyOracle` modifier gates `WeatherMarket.submitResult`
- `onlyOwner` modifier gates `createMarket`, `setOracle`, `withdrawFees`, and all `AdminOracle` functions
- `ReentrancyGuard` on `claimWinnings`
- Market state machine enforces strict progression: `OPEN → LOCKED → SETTLED`

---

## Implementation Notes

**Gas limit must be set explicitly**

Pharos testnet does not auto-estimate gas correctly for all transaction types. The stable combination is `gas: 1_000_000n` with `gasPrice: parseGwei("10")`. This ensures a reservation of 0.01 PROS per transaction, well within a typical funded testnet wallet.

**Silent revert on insufficient balance**

When an account's PROS balance is below the gas reservation (`gasLimit × gasPrice`), Pharos does not throw a mempool error. The transaction is submitted, gets a receipt, and returns `status: "reverted"` — with no error message or revert reason. Always check `receipt.status === "reverted"` explicitly. The original gas configuration (`gas: 5_000_000n × maxFeePerGas: 50 gwei = 0.25 PROS reservation`) triggered this silently on a wallet holding only 0.042 PROS.

**USDC uses 6 decimals**

All USDC amounts must be expressed in 6-decimal units. 100 USDC = `100_000_000n`. A common mistake when adapting code from ETH-native chains is passing 18-decimal values.

---

## Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.28, OpenZeppelin 5.x |
| Development | Hardhat 3 + Viem |
| Oracle | AdminOracle (owner-submitted); Phase 2: Chainlink CCIP |
| Cross-chain | Arc Bridge Kit + Circle CCTP |
| Testnet token | USDC `0xcfc8330f4bcab529c625d12781b1c19466a9fc8b` |
| Mainnet token | USDC `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |

---

## Roadmap

**✅ M1 — Testnet Deployment (completed)**
- WeatherMarket + AdminOracle deployed on Pharos Atlantic (Chain ID 688689)
- Full e2e flow tested: `createMarket → placeBet → lockMarket → submitResult → claimWinnings`
- 2% fee logic and no-winner refund path verified on-chain
- Silent revert behavior diagnosed and gas configuration stabilized

**⬜ M2 — Mainnet + CCTP Bridge**
- Deploy to Pharos Pacific Ocean Mainnet (Chain ID 1672)
- Arc Bridge Kit frontend integration for USDC onboarding from Arc
- Multi-city market support: Taipei, Tokyo, Bangkok, Seoul

**⬜ M3 — Decentralized Oracle**
- Chainlink CCIP integration for trustless, permissionless settlement
- Remove `onlyOwner` requirement from oracle submission

---

## Developer

GitHub: [pplmaverick](https://github.com/pplmaverick)
Wallet: `0xed2B5717c9b936ecC76d75401026A99143e278F5`

## License

MIT
