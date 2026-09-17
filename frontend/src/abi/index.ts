export const WEATHER_MARKET_ABI = [
  // Events
  {
    type: 'event',
    name: 'BetPlaced',
    inputs: [
      { indexed: true, name: 'marketId', type: 'uint256' },
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'bucket', type: 'uint8' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'MarketCreated',
    inputs: [
      { indexed: true, name: 'marketId', type: 'uint256' },
      { indexed: false, name: 'city', type: 'string' },
      { indexed: false, name: 'targetDate', type: 'uint256' },
      { indexed: false, name: 'lockTime', type: 'uint256' },
      { indexed: false, name: 'bucketCount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'MarketLocked',
    inputs: [{ indexed: true, name: 'marketId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'ResultSubmitted',
    inputs: [
      { indexed: true, name: 'marketId', type: 'uint256' },
      { indexed: false, name: 'finalTemp', type: 'int256' },
      { indexed: false, name: 'winningBucket', type: 'uint8' },
      { indexed: false, name: 'noWinner', type: 'bool' },
    ],
  },
  {
    type: 'event',
    name: 'WinningsClaimed',
    inputs: [
      { indexed: true, name: 'marketId', type: 'uint256' },
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  // Read functions
  {
    type: 'function',
    name: 'bets',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint8' },
      { name: '', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'bucketTotals',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint8' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimed',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getMarket',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [
      { name: 'city', type: 'string' },
      { name: 'targetDate', type: 'uint256' },
      { name: 'lockTime', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'totalPool', type: 'uint256' },
      { name: 'finalTemp', type: 'int256' },
      { name: 'winningBucket', type: 'uint8' },
      { name: 'buckets', type: 'int256[]' },
      { name: 'noWinner', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nextMarketId',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'usdc',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'userTotalBets',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // Write functions
  {
    type: 'function',
    name: 'claimWinnings',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'placeBet',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'bucket', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'oracle',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'collectedFees',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'defaultLockedTimeout',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MIN_LOCKED_TIMEOUT',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_LOCKED_TIMEOUT',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'settlementDeadline',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'marketLockedTimeout',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // Write functions
  {
    type: 'function',
    name: 'claimRefund',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'lockMarket',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdrawFees',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setDefaultLockedTimeout',
    inputs: [{ name: 'newTimeout', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // 只收錄 5 參數版 overload：admin 面板一律顯式指定該市場的 lockedTimeout，
  // 不收 4 參數版可以完全避免 viem 的 overload 解析歧義。
  // CLI 腳本走的 4 參數版不受影響（那邊用 hardhat artifact 的完整 ABI）。
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      { name: 'city', type: 'string' },
      { name: 'targetDate', type: 'uint256' },
      { name: 'buckets', type: 'int256[]' },
      { name: 'lockTime', type: 'uint256' },
      { name: 'lockedTimeout', type: 'uint256' },
    ],
    outputs: [{ name: 'marketId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'RefundClaimed',
    inputs: [
      { indexed: true, name: 'marketId', type: 'uint256' },
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
] as const

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const ADMIN_ORACLE_ABI = [
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'weatherMarket',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  // 結果提交唯一入口。city 由呼叫端從 WeatherMarket.getMarket 讀回後原樣帶入，
  // 合約不會比對 city 是否與該市場相符，所以絕不能讓它變成可手動輸入的欄位。
  {
    type: 'function',
    name: 'submitResult',
    inputs: [
      { name: 'city', type: 'string' },
      { name: 'temp', type: 'int256' },
      { name: 'marketId', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const
