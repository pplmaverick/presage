import { defineChain } from 'viem'

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
})

export const WEATHER_MARKET_ADDRESS = '0xcac5b9d2817325e78090e3ce4b9c299c819cf953' as const
export const ADMIN_ORACLE_ADDRESS = '0xbdc53e50b1167ce1199bfad54a034f7ab1741051' as const
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const
export const MARKET_ID = 0n
export const BUCKET_COUNT = 5

export const STATUS_LABEL = ['OPEN', 'LOCKED', 'SETTLED'] as const
export const STATUS_COLOR = [
  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  'bg-purple-500/20 text-purple-400 border border-purple-500/30',
] as const

export function getBucketLabel(thresholds: bigint[], index: number): string {
  if (thresholds.length === 0) return `Bucket ${index}`
  if (index === 0) return `≤ ${thresholds[0]}°C`
  if (index >= thresholds.length) return `> ${thresholds[thresholds.length - 1]}°C`
  return `${thresholds[index - 1]}-${thresholds[index]}°C`
}

export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2)
}

export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export const WEATHER_MARKET_ABI = [
  {
    inputs: [{ name: 'marketId', type: 'uint256' }],
    name: 'getMarket',
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
    type: 'function',
  },
  {
    inputs: [{ type: 'uint256' }, { type: 'uint8' }],
    name: 'bucketTotals',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ type: 'uint256' }, { type: 'uint8' }, { type: 'address' }],
    name: 'bets',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ type: 'uint256' }, { type: 'address' }],
    name: 'userTotalBets',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ type: 'uint256' }, { type: 'address' }],
    name: 'claimed',
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'bucket', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'placeBet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'marketId', type: 'uint256' }],
    name: 'claimWinnings',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

export const ERC20_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
