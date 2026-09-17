> Generated a fresh test wallet B; its key was written to .env.e2e (covered by the .env* rule in .gitignore)
# Arc Testnet E2E — 2026-09-16T11:08:51.040Z

| Field | Value |
|---|---|
| Network | Arc Testnet (chainId 5042002) |
| WeatherMarket | `0x0bfb97a06521f4be7407891530ab22468d3e698c` |
| AdminOracle | `0xf7280ca7e04a8bbdc65edcac80ec49e98c305b2f` |
| Wallet A (owner) | `0xed2B5717c9b936ecC76d75401026A99143e278F5` |
| Wallet B (ordinary user) | `0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7` |
| Gas | feeHistory — baseFee(max of 11)=20.000 gwei, tip p90(max of 10)=60.000 gwei → priority=72.000 gwei (+20% buffer), maxFee=baseFee*2+priority=112.000 gwei |

## 0. Permission preconditions
- `WeatherMarket.owner()` = `0xed2B5717c9b936ecC76d75401026A99143e278F5`
- Wallet A is the owner: **true**
- Wallet B is the owner: **false**

## 1. Funding wallet B
- B native balance (= USDC, Arc's native gas token): 0
- A -> B transfer of 3 USDC → `0x32fef2398afc7133568a61979827e001b94e1d552e696e4c35e0e49af159770a` (block 62392716, gasUsed 21000)
- B balance (after): 3

## 2. Non-owner permission boundary (measured on-chain)
- ✅ `createMarket (5-arg)` called by B is rejected: `The contract function "createMarket" reverted.`
- ✅ `setDefaultLockedTimeout` called by B is rejected: `The contract function "setDefaultLockedTimeout" reverted.`
- ✅ `withdrawFees` called by B is rejected: `The contract function "withdrawFees" reverted.`

## 3. M1 settlement path
- createMarket M1 (#0) → `0x8f5ddf02eb2be7f64706c6e8b2d4c8bd90600f207d63fbe41f4705ca4c704d30` (block 62392726, gasUsed 258286)
- getMarket(#0): city=`Taipei` lockTime=1789557085 targetDate=1789560685 status=OPEN buckets=[25,28,31,34]
- marketLockedTimeout=86400 settlementDeadline=1789643485 (= lockTime + 86400)
- B approve USDC → `0xd31a9d5d4a9072518789cb20a30f9d9ec8cecc79b299d3f7431588c0f79d3397` (block 62392736, gasUsed 55438)
- B placeBet(#0, bucket 2, 0.5 USDC) → `0x5b01aef90c41d7d4a97c55ffa3747689b24c2cc53c255e3cffd99b28878eb8a5` (block 62392744, gasUsed 162065)
- totalPool=0.5 USDC，bucketTotals[2]=0.5
- Waiting for lockTime (140s)…
- B lockMarket(#0) (permissionless — callable by a non-owner) → `0x91c5789c0f3d564a23e3aafc27c9fb16d3afbff529cd9237c3c3f358b29e8c94` (block 62393031, gasUsed 49586)
- status -> **LOCKED**
- OpenWeather Taipei raw temperature **25.85°C** -> Math.round -> submitted on-chain **26**
- A AdminOracle.submitResult("Taipei", 26, 0) → `0x9e255ae128c4dcc4999cf0388d81e88894fa704333bfeecbc769f729850125cc` (block 62393041, gasUsed 123527)
- getMarket(#0) read back: status=**SETTLED** finalTemp=**26** winningBucket=**1** noWinner=**true**
- Three-way consistency check: raw 25.85 -> rounded 26 -> on-chain finalTemp 26 -> **consistent ✅**
- ⚠ Actual temperature 26°C falls in bucket 1 (B bet bucket 2), noWinner=true
- B claimWinnings(#0) (noWinner -> full refund) → `0xfe88e8f7bc7240b19b2e87eb4d6c5c01ab2d7c4a0b2c7aaff600ee3e7dfb9bcb` (block 62393050, gasUsed 83480)
- B USDC before 2.475427 -> after 2.967747
- collectedFees = 0 USDC

## 4. M2 refund path (claimRefund becomes available after 24h)
- createMarket M2 (#1), lockedTimeout=86400s (MIN) → `0x58682fb88ba6a9a5b4d8a832ca53203bfd28fc3b7eb41e98e9651dcbbec5c334` (block 62393059, gasUsed 241174)
- B placeBet(#1, bucket 1, 0.5 USDC) → `0x1917ab97e5b81ecf4a7adcc0041e0b06cce18835ed3dd94d938a8e360d18d61f` (block 62393068, gasUsed 162077)
- Waiting for lockTime (86s)…
- B lockMarket(#1) → `0x017ece8f0e95b1d6507020efcafbd8e5d65e13d16641c6ffff01d7b6de8d090d` (block 62393247, gasUsed 49598)
- status=**LOCKED** settlementDeadline=**1789643594** (2026-09-17T11:13:14.000Z)
- claimRefund should revert right now (window not open):
  - ✅ `The contract function "claimRefund" reverted with the following reason:`
- submitResult would succeed right now (still inside the window) but is deliberately **not executed**, leaving the refund path to be tested after 24h

> **TODO**: 2026-09-17T11:13:14.000Z — from wallet B, call `claimRefund` on #1, 
> expecting the full principal of 0.5 USDC back (no 2% fee deducted).
