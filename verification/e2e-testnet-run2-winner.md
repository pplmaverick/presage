# Arc Testnet E2E — 2026-09-16T11:14:15.501Z

| 項目 | 值 |
|---|---|
| 網路 | Arc Testnet (chainId 5042002) |
| WeatherMarket | `0x0bfb97a06521f4be7407891530ab22468d3e698c` |
| AdminOracle | `0xf7280ca7e04a8bbdc65edcac80ec49e98c305b2f` |
| 錢包 A (owner) | `0xed2B5717c9b936ecC76d75401026A99143e278F5` |
| 錢包 B (一般使用者) | `0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7` |
| Gas | feeHistory — baseFee(max of 11)=20.000 gwei, tip p90(max of 10)=60.000 gwei → priority=72.000 gwei (+20% buffer), maxFee=baseFee*2+priority=112.000 gwei |

## 0. 權限前提確認
- `WeatherMarket.owner()` = `0xed2B5717c9b936ecC76d75401026A99143e278F5`
- 錢包 A 是 owner：**true**
- 錢包 B 是 owner：**false**

## 1. 資助錢包 B
- B 原生餘額（= USDC，Arc 原生 gas 代幣）: 2.448273552
- 餘額足夠，跳過轉帳
- B 餘額（後）: 2.448273552

## 2. 非 owner 的權限邊界（鏈上實測）
- ✅ `createMarket (5 參數)` 由 B 呼叫被擋：`The contract function "createMarket" reverted.`
- ✅ `setDefaultLockedTimeout` 由 B 呼叫被擋：`The contract function "setDefaultLockedTimeout" reverted.`
- ✅ `withdrawFees` 由 B 呼叫被擋：`The contract function "withdrawFees" reverted.`

## 3. M1 結算路徑
- createMarket M1 (#2) → `0xdf231eb0e8dd392b598da19ef84bd95fef9fbf581d4604436a5bcaadeff1a3f2` (block 62393359, gasUsed 241186)
- getMarket(#2): city=`Taipei` lockTime=1789557405 targetDate=1789561005 status=OPEN buckets=[25,28,31,34]
- marketLockedTimeout=86400 settlementDeadline=1789643805 (= lockTime + 86400)
- B approve USDC → `0x81742fcac123937e020be6288398ded6246a47ba728c51ab5e055f6c8b14d13c` (block 62393369, gasUsed 38338)
- 下注前查真實氣溫：**25.85°C** → round 26 → 對應 bucket **1**；B 押 bucket **1**
- B placeBet(#2, bucket 1, 0.5 USDC) → `0x245cd453599e01d4fcabe2082673552b5b03718c5f33324846b3edc3471194e2` (block 62393378, gasUsed 162077)
- totalPool=0.5 USDC，bucketTotals[1]=0.5
- 等待 lockTime（140s）…
- B lockMarket(#2)（permissionless，非 owner 可呼叫） → `0x474980655989cfa013859c06ab9d768e6b8990a2fd52b75c7007e5537e4a7a5f` (block 62393666, gasUsed 49598)
- status → **LOCKED**
- OpenWeather Taipei 原始溫度 **25.85°C** → Math.round → 送上鏈 **26**
- A AdminOracle.submitResult("Taipei", 26, 2) → `0xd7d23f80ea87f59be3427015b88e3cd23aeabbbbd343d786322a1c16fe6bfb0d` (block 62393676, gasUsed 128482)
- getMarket(#2) 回讀：status=**SETTLED** finalTemp=**26** winningBucket=**1** noWinner=**false**
- 三者一致檢查：原始 25.85 → 四捨五入 26 → 鏈上 finalTemp 26 → **一致 ✅**
- B claimWinnings(#2) → `0x93e8356631e28064c036204dc3ea5bf63bcdf42d66cdc15f4d4369778680d68a` (block 62393685, gasUsed 91260)
- B USDC 前 1.925272 → 後 2.406876（扣掉 gas 0.008395）
- 扣除 gas 後的實得 ≈ 0.489999 USDC；池 0.5 - 2% 手續費 0.01 = 0.49
- collectedFees = **0.01 USDC**（= totalPool 0.5 × 2%）
- A withdrawFees() → `0xaab9c107720c86f600ba87f90e8e484fe28f6d1a080994784f65eb6c7193d7a1` (block 62393687, gasUsed 53445)
- A USDC 前 39.440803 → 後 39.445886
- collectedFees 歸零檢查：0

## 4. M2 退款路徑（等待 24h 後可 claimRefund）
- createMarket M2 (#3)，lockedTimeout=86400s (MIN) → `0x6b6499d45be2a7d498ec529401de391c148f34d31b328d42a772bee49439f4b5` (block 62393696, gasUsed 241174)
- B placeBet(#3, bucket 1, 0.5 USDC) → `0x376f0fad3014a93d6b3d219771710998467558a4a4d5af3b45bc21b5d8d14b86` (block 62393705, gasUsed 162077)
- 等待 lockTime（86s）…
- B lockMarket(#3) → `0x68506e4c1404cbb2381f0594d5dd765624ec9f095d2e726421c233b001910552` (block 62393884, gasUsed 49598)
- status=**LOCKED** settlementDeadline=**1789643915** (2026-09-17T11:18:35.000Z)
- 現在 claimRefund 應該要 revert（窗口未開）：
  - ✅ `The contract function "claimRefund" reverted with the following reason:`
- 現在 submitResult 應該要成功（窗口內），但刻意**不執行**，留給 24h 後測退款

> **待辦**：2026-09-17T11:18:35.000Z 之後，用錢包 B 對 #3 呼叫 `claimRefund`，
> 預期取回本金全額 0.5 USDC（不扣 2% 手續費）。
