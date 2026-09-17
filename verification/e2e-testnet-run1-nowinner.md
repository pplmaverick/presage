> 產生新的測試錢包 B，私鑰已寫入 .env.e2e（已被 .gitignore 的 .env* 規則涵蓋）
# Arc Testnet E2E — 2026-09-16T11:08:51.040Z

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
- B 原生餘額（= USDC，Arc 原生 gas 代幣）: 0
- A → B 轉帳 3 USDC → `0x32fef2398afc7133568a61979827e001b94e1d552e696e4c35e0e49af159770a` (block 62392716, gasUsed 21000)
- B 餘額（後）: 3

## 2. 非 owner 的權限邊界（鏈上實測）
- ✅ `createMarket (5 參數)` 由 B 呼叫被擋：`The contract function "createMarket" reverted.`
- ✅ `setDefaultLockedTimeout` 由 B 呼叫被擋：`The contract function "setDefaultLockedTimeout" reverted.`
- ✅ `withdrawFees` 由 B 呼叫被擋：`The contract function "withdrawFees" reverted.`

## 3. M1 結算路徑
- createMarket M1 (#0) → `0x8f5ddf02eb2be7f64706c6e8b2d4c8bd90600f207d63fbe41f4705ca4c704d30` (block 62392726, gasUsed 258286)
- getMarket(#0): city=`Taipei` lockTime=1789557085 targetDate=1789560685 status=OPEN buckets=[25,28,31,34]
- marketLockedTimeout=86400 settlementDeadline=1789643485 (= lockTime + 86400)
- B approve USDC → `0xd31a9d5d4a9072518789cb20a30f9d9ec8cecc79b299d3f7431588c0f79d3397` (block 62392736, gasUsed 55438)
- B placeBet(#0, bucket 2, 0.5 USDC) → `0x5b01aef90c41d7d4a97c55ffa3747689b24c2cc53c255e3cffd99b28878eb8a5` (block 62392744, gasUsed 162065)
- totalPool=0.5 USDC，bucketTotals[2]=0.5
- 等待 lockTime（140s）…
- B lockMarket(#0)（permissionless，非 owner 可呼叫） → `0x91c5789c0f3d564a23e3aafc27c9fb16d3afbff529cd9237c3c3f358b29e8c94` (block 62393031, gasUsed 49586)
- status → **LOCKED**
- OpenWeather Taipei 原始溫度 **25.85°C** → Math.round → 送上鏈 **26**
- A AdminOracle.submitResult("Taipei", 26, 0) → `0x9e255ae128c4dcc4999cf0388d81e88894fa704333bfeecbc769f729850125cc` (block 62393041, gasUsed 123527)
- getMarket(#0) 回讀：status=**SETTLED** finalTemp=**26** winningBucket=**1** noWinner=**true**
- 三者一致檢查：原始 25.85 → 四捨五入 26 → 鏈上 finalTemp 26 → **一致 ✅**
- ⚠ 實際氣溫 26°C 落在 bucket 1（B 押的是 bucket 2），noWinner=true
- B claimWinnings(#0)（noWinner → 全額退款） → `0xfe88e8f7bc7240b19b2e87eb4d6c5c01ab2d7c4a0b2c7aaff600ee3e7dfb9bcb` (block 62393050, gasUsed 83480)
- B USDC 前 2.475427 → 後 2.967747
- collectedFees = 0 USDC

## 4. M2 退款路徑（等待 24h 後可 claimRefund）
- createMarket M2 (#1)，lockedTimeout=86400s (MIN) → `0x58682fb88ba6a9a5b4d8a832ca53203bfd28fc3b7eb41e98e9651dcbbec5c334` (block 62393059, gasUsed 241174)
- B placeBet(#1, bucket 1, 0.5 USDC) → `0x1917ab97e5b81ecf4a7adcc0041e0b06cce18835ed3dd94d938a8e360d18d61f` (block 62393068, gasUsed 162077)
- 等待 lockTime（86s）…
- B lockMarket(#1) → `0x017ece8f0e95b1d6507020efcafbd8e5d65e13d16641c6ffff01d7b6de8d090d` (block 62393247, gasUsed 49598)
- status=**LOCKED** settlementDeadline=**1789643594** (2026-09-17T11:13:14.000Z)
- 現在 claimRefund 應該要 revert（窗口未開）：
  - ✅ `The contract function "claimRefund" reverted with the following reason:`
- 現在 submitResult 應該要成功（窗口內），但刻意**不執行**，留給 24h 後測退款

> **待辦**：2026-09-17T11:13:14.000Z 之後，用錢包 B 對 #1 呼叫 `claimRefund`，
> 預期取回本金全額 0.5 USDC（不扣 2% 手續費）。
