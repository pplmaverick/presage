import { useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { formatUnits } from 'viem'
import {
  ADMIN_ORACLE_ADDRESS,
  CITIES,
  CITY_NAMES,
  CONTRACT_ADDRESS,
  ENV_VAR_NAMES,
  activeChain,
  getBucketLabel,
  type CityName,
} from '../lib/wagmi'
import { ADMIN_ORACLE_ABI, WEATHER_MARKET_ABI } from '../abi'
import { useAdminMarkets, STATUS_LABEL, type AdminMarket } from '../hooks/useAdminMarkets'
import AdvancedGas, { useGasOverride, type GasOverride } from '../components/AdvancedGas'

const HOUR = 3600
const DAY = 24 * HOUR

// 下注期長度 —— 固定選項，不開放自訂輸入
const LOCK_OPTIONS = [
  { label: '24 小時', seconds: 24 * HOUR },
  { label: '2 天', seconds: 2 * DAY },
  { label: '3 天', seconds: 3 * DAY },
  { label: '7 天', seconds: 7 * DAY },
  { label: '14 天', seconds: 14 * DAY },
] as const

// 結算期長度（該市場的 lockedTimeout）—— 固定選項
const TIMEOUT_OPTIONS = [
  { label: '3 天', seconds: 3 * DAY },
  { label: '7 天', seconds: 7 * DAY },
  { label: '14 天', seconds: 14 * DAY },
  { label: '30 天', seconds: 30 * DAY },
] as const

// 建立市場時 targetDate 固定設為 lockTime + 1 小時，與既有市場的慣例一致
// （例：市場 #29 lockTime 07:00 / targetDate 08:00）。合約只要求
// targetDate > lockTime 且 <= lockTime + 90 天，本身不參與任何結算邏輯。
const TARGET_DATE_OFFSET = HOUR

function fmtTime(ts: bigint | number): string {
  const n = Number(ts)
  if (!n) return '—'
  return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z'
}

function fmtDuration(seconds: bigint | number): string {
  const n = Number(seconds)
  if (n % DAY === 0) return `${n / DAY} 天`
  if (n % HOUR === 0) return `${n / HOUR} 小時`
  return `${n} 秒`
}

function errText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string }
  return e?.shortMessage ?? e?.message ?? String(err)
}

// ── 共用交易 hook ────────────────────────────────────────────────────────────

function useAdminTx() {
  const { writeContractAsync } = useWriteContract()
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const { isLoading: confirming, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash })

  async function send(args: Parameters<typeof writeContractAsync>[0]) {
    setError(null)
    setHash(undefined)
    setSending(true)
    try {
      const h = await writeContractAsync(args)
      setHash(h)
      return h
    } catch (err) {
      setError(errText(err))
      return undefined
    } finally {
      setSending(false)
    }
  }

  function reset() {
    setHash(undefined)
    setError(null)
  }

  return { send, reset, hash, error, sending, confirming, confirmed, busy: sending || confirming }
}

function TxStatus({ tx }: { tx: ReturnType<typeof useAdminTx> }) {
  if (tx.error) {
    return (
      <p className="mt-2 text-xs font-mono text-red-400 break-words">✗ {tx.error}</p>
    )
  }
  if (tx.confirmed && tx.hash) {
    return (
      <p className="mt-2 text-xs font-mono text-tertiary break-all">
        ✓ 已確認 {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
      </p>
    )
  }
  if (tx.hash) {
    return (
      <p className="mt-2 text-xs font-mono text-[rgba(255,255,255,0.4)] break-all">
        等待確認 {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
      </p>
    )
  }
  return null
}

function Card({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <section className="glass-card rounded-2xl p-5">
      <h2 className="flex items-center gap-2 font-display text-base text-white mb-4">
        <span className="material-symbols-outlined text-[20px] text-primary">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

// ── 建立市場 ────────────────────────────────────────────────────────────────

function CreateMarketPanel({ onDone }: { onDone: () => void }) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const tx = useAdminTx()
  const gas = useGasOverride()

  const { data: defaultTimeout } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'defaultLockedTimeout',
  })

  const [city, setCity] = useState<CityName>(CITY_NAMES[0])
  const [bucketsText, setBucketsText] = useState('25, 28, 31, 34')
  const [lockSeconds, setLockSeconds] = useState<number>(LOCK_OPTIONS[0].seconds)
  const [timeoutSeconds, setTimeoutSeconds] = useState<number | null>(null)
  const [preflight, setPreflight] = useState<'idle' | 'running' | 'ok'>('idle')
  const [preflightError, setPreflightError] = useState<string | null>(null)

  // 預設值取合約 defaultLockedTimeout 對應到最接近的固定選項
  useEffect(() => {
    if (defaultTimeout === undefined || timeoutSeconds !== null) return
    const target = Number(defaultTimeout)
    const closest = TIMEOUT_OPTIONS.reduce((best, opt) =>
      Math.abs(opt.seconds - target) < Math.abs(best.seconds - target) ? opt : best,
    )
    setTimeoutSeconds(closest.seconds)
  }, [defaultTimeout, timeoutSeconds])

  // 任何欄位變動都讓預飛結果失效
  useEffect(() => {
    setPreflight('idle')
    setPreflightError(null)
  }, [city, bucketsText, lockSeconds, timeoutSeconds])

  const parsed = useMemo(() => {
    const raw = bucketsText.split(',').map((s) => s.trim()).filter(Boolean)
    if (raw.length === 0) return { error: 'buckets 不可為空', values: [] as bigint[] }
    const values: bigint[] = []
    for (const r of raw) {
      if (!/^-?\d+$/.test(r)) return { error: `"${r}" 不是整數`, values: [] as bigint[] }
      values.push(BigInt(r))
    }
    if (values.length > 253) return { error: 'buckets 最多 253 個', values: [] as bigint[] }
    for (let i = 1; i < values.length; i++) {
      if (values[i] <= values[i - 1]) {
        return { error: `必須嚴格遞增：${values[i - 1]} → ${values[i]}`, values: [] as bigint[] }
      }
    }
    return { error: null as string | null, values }
  }, [bucketsText])

  const buildArgs = () => {
    const now = Math.floor(Date.now() / 1000)
    const lockTime = BigInt(now + lockSeconds)
    const targetDate = lockTime + BigInt(TARGET_DATE_OFFSET)
    return [city, targetDate, parsed.values, lockTime, BigInt(timeoutSeconds ?? 0)] as const
  }

  async function runPreflight() {
    if (!publicClient || !address) return
    setPreflight('running')
    setPreflightError(null)
    try {
      await publicClient.simulateContract({
        account: address,
        address: CONTRACT_ADDRESS,
        abi: WEATHER_MARKET_ABI,
        functionName: 'createMarket',
        args: buildArgs(),
      })
      setPreflight('ok')
    } catch (err) {
      setPreflight('idle')
      setPreflightError(errText(err))
    }
  }

  async function submit() {
    const overrides: GasOverride = gas.build()
    const h = await tx.send({
      address: CONTRACT_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'createMarket',
      args: buildArgs(),
      ...overrides,
    } as Parameters<typeof tx.send>[0])
    if (h) setPreflight('idle')
  }

  useEffect(() => {
    if (tx.confirmed) onDone()
  }, [tx.confirmed, onDone])

  const nowPreview = Math.floor(Date.now() / 1000)
  const canPreflight = !parsed.error && timeoutSeconds !== null && !!address

  return (
    <Card title="建立市場" icon="add_circle">
      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
            City
          </span>
          <select
            value={city}
            onChange={(e) => setCity(e.target.value as CityName)}
            className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
          >
            {CITY_NAMES.map((c) => (
              <option key={c} value={c} className="bg-[#1a1a20]">
                {c}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-[rgba(255,255,255,0.35)]">
            限既有支援城市（{CITY_NAMES.map((c) => CITIES[c].slug).join(' / ')}）——
            結算時要靠 /api/weather/&lt;slug&gt; 取溫度，清單外的城市取不到資料。
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
            Buckets（溫度區間上界，逗號分隔，必須嚴格遞增）
          </span>
          <input
            value={bucketsText}
            onChange={(e) => setBucketsText(e.target.value)}
            className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 font-mono text-sm text-white focus:outline-none focus:border-primary"
          />
          {parsed.error ? (
            <span className="text-[11px] font-mono text-red-400">✗ {parsed.error}</span>
          ) : (
            <span className="text-[10px] text-[rgba(255,255,255,0.35)]">
              {parsed.values.length + 1} 個區間：
              {Array.from({ length: parsed.values.length + 1 }, (_, i) =>
                getBucketLabel(parsed.values, i),
              ).join(' · ')}
            </span>
          )}
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
              下注期長度
            </span>
            <select
              value={lockSeconds}
              onChange={(e) => setLockSeconds(Number(e.target.value))}
              className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
            >
              {LOCK_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds} className="bg-[#1a1a20]">
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] font-mono text-[rgba(255,255,255,0.35)]">
              lockTime ≈ {fmtTime(nowPreview + lockSeconds)}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
              結算期長度（該市場 lockedTimeout）
            </span>
            <select
              value={timeoutSeconds ?? ''}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
            >
              {TIMEOUT_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds} className="bg-[#1a1a20]">
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] font-mono text-[rgba(255,255,255,0.35)]">
              settlementDeadline ≈ {fmtTime(nowPreview + lockSeconds + (timeoutSeconds ?? 0))}
              {defaultTimeout !== undefined && (
                <> · 合約預設 {fmtDuration(defaultTimeout as bigint)}</>
              )}
            </span>
          </label>
        </div>

        <p className="text-[10px] text-[rgba(255,255,255,0.3)]">
          targetDate 自動設為 lockTime + 1 小時（合約僅要求 targetDate &gt; lockTime，
          不參與結算判定）。
        </p>

        <AdvancedGas state={gas} />

        {preflightError && (
          <p className="text-xs font-mono text-red-400 break-words">
            預飛失敗：{preflightError}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={runPreflight}
            disabled={!canPreflight || preflight === 'running'}
            className="btn-outline text-xs px-4 py-2 disabled:opacity-40"
          >
            {preflight === 'running' ? '預飛中…' : '① 預飛 (simulateContract)'}
          </button>
          <button
            onClick={submit}
            disabled={preflight !== 'ok' || tx.busy}
            className="btn-primary text-xs px-4 py-2 disabled:opacity-40"
          >
            {tx.busy ? '送出中…' : '② 送出交易'}
          </button>
          {preflight === 'ok' && (
            <span className="self-center text-[11px] font-mono text-tertiary">
              ✓ 預飛通過
            </span>
          )}
        </div>
        <TxStatus tx={tx} />
      </div>
    </Card>
  )
}

// ── 手續費 + defaultLockedTimeout ───────────────────────────────────────────

function SettingsPanel() {
  const tx = useAdminTx()
  const timeoutTx = useAdminTx()
  const gas = useGasOverride()

  const { data: fees, refetch: refetchFees } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'collectedFees',
  })
  const { data: defaultTimeout, refetch: refetchTimeout } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'defaultLockedTimeout',
  })
  const { data: minTimeout } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'MIN_LOCKED_TIMEOUT',
  })
  const { data: maxTimeout } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'MAX_LOCKED_TIMEOUT',
  })

  const [newTimeout, setNewTimeout] = useState<number>(TIMEOUT_OPTIONS[0].seconds)

  useEffect(() => {
    if (tx.confirmed) void refetchFees()
  }, [tx.confirmed, refetchFees])
  useEffect(() => {
    if (timeoutTx.confirmed) void refetchTimeout()
  }, [timeoutTx.confirmed, refetchTimeout])

  const feeAmount = fees !== undefined ? Number(formatUnits(fees as bigint, 6)).toFixed(6) : '—'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Card title="手續費" icon="savings">
        <p className="font-mono text-3xl text-primary mb-1">{feeAmount}</p>
        <p className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.35)] mb-4">
          USDC collectedFees
        </p>
        <button
          onClick={() =>
            void tx.send({
              address: CONTRACT_ADDRESS,
              abi: WEATHER_MARKET_ABI,
              functionName: 'withdrawFees',
              args: [],
              ...gas.build(),
            } as Parameters<typeof tx.send>[0])
          }
          disabled={tx.busy || !fees || (fees as bigint) === 0n}
          className="btn-primary text-xs px-4 py-2 disabled:opacity-40"
        >
          {tx.busy ? '提領中…' : '提領手續費'}
        </button>
        <p className="mt-2 text-[10px] text-[rgba(255,255,255,0.3)]">
          只會轉出 collectedFees，動不到使用者本金。
        </p>
        <AdvancedGas state={gas} />
        <TxStatus tx={tx} />
      </Card>

      <Card title="預設結算期" icon="timer">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-mono text-3xl text-primary">
            {defaultTimeout !== undefined ? fmtDuration(defaultTimeout as bigint) : '—'}
          </span>
        </div>
        <p className="text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.35)] mb-1">
          defaultLockedTimeout
        </p>
        <p className="text-[10px] font-mono text-[rgba(255,255,255,0.3)] mb-4">
          允許範圍 {minTimeout !== undefined ? fmtDuration(minTimeout as bigint) : '?'} ～{' '}
          {maxTimeout !== undefined ? fmtDuration(maxTimeout as bigint) : '?'}
        </p>

        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={newTimeout}
            onChange={(e) => setNewTimeout(Number(e.target.value))}
            className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
          >
            {TIMEOUT_OPTIONS.map((o) => (
              <option key={o.seconds} value={o.seconds} className="bg-[#1a1a20]">
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void timeoutTx.send({
                address: CONTRACT_ADDRESS,
                abi: WEATHER_MARKET_ABI,
                functionName: 'setDefaultLockedTimeout',
                args: [BigInt(newTimeout)],
              } as Parameters<typeof timeoutTx.send>[0])
            }
            disabled={timeoutTx.busy}
            className="btn-outline text-xs px-4 py-2 disabled:opacity-40"
          >
            {timeoutTx.busy ? '送出中…' : '更新'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-amber-400/80">
          ⚠ 僅影響之後新建立的市場。已建立的市場沿用當時寫入的值，結算截止時間不會改變。
        </p>
        <TxStatus tx={timeoutTx} />
      </Card>
    </div>
  )
}

// ── 提交結果流程 ────────────────────────────────────────────────────────────

function SubmitResultRow({ market, onDone }: { market: AdminMarket; onDone: () => void }) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const tx = useAdminTx()
  const [temp, setTemp] = useState<{ raw: number; rounded: number } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)

  const slug = (CITIES as Record<string, { slug: string } | undefined>)[market.city]?.slug
    ?? market.city.toLowerCase()

  useEffect(() => {
    if (tx.confirmed) onDone()
  }, [tx.confirmed, onDone])

  async function fetchTemp() {
    setFetching(true)
    setFetchError(null)
    setTemp(null)
    try {
      const res = await fetch(`/api/weather/${slug}`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`/api/weather/${slug} 回傳 ${res.status}`)
      const json = (await res.json()) as { temp?: number }
      if (typeof json.temp !== 'number') throw new Error('回應缺少 temp 欄位')
      setTemp({ raw: json.temp, rounded: Math.round(json.temp) })
    } catch (err) {
      setFetchError(errText(err))
    } finally {
      setFetching(false)
    }
  }

  async function confirmSubmit() {
    if (!temp || !ADMIN_ORACLE_ADDRESS || !publicClient || !address) return
    setPreflightError(null)
    // city 一律用鏈上讀回的 market.city，不經任何輸入欄位
    const args = [market.city, BigInt(temp.rounded), market.id] as const
    try {
      await publicClient.simulateContract({
        account: address,
        address: ADMIN_ORACLE_ADDRESS,
        abi: ADMIN_ORACLE_ABI,
        functionName: 'submitResult',
        args,
      })
    } catch (err) {
      setPreflightError(errText(err))
      return
    }
    await tx.send({
      address: ADMIN_ORACLE_ADDRESS,
      abi: ADMIN_ORACLE_ABI,
      functionName: 'submitResult',
      args,
    } as Parameters<typeof tx.send>[0])
  }

  if (!ADMIN_ORACLE_ADDRESS) {
    return (
      <span className="text-[10px] font-mono text-amber-400">
        未設定 {ENV_VAR_NAMES.adminOracle}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!temp ? (
        <>
          <button
            onClick={() => void fetchTemp()}
            disabled={fetching}
            className="btn-outline text-[11px] px-3 py-1.5 disabled:opacity-40"
          >
            {fetching ? '查詢中…' : '取得溫度'}
          </button>
          {fetchError && (
            <span className="text-[10px] font-mono text-red-400 max-w-[220px] text-right break-words">
              {fetchError}
            </span>
          )}
        </>
      ) : (
        <>
          <div className="text-right">
            <p className="font-mono text-sm text-white">
              {temp.raw.toFixed(2)}°C → 送出 <span className="text-primary">{temp.rounded}</span>
            </p>
            <p className="text-[10px] font-mono text-[rgba(255,255,255,0.35)]">
              city="{market.city}"（鏈上讀回）
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setTemp(null)}
              className="text-[11px] font-mono text-[rgba(255,255,255,0.4)] hover:text-white px-2 py-1.5"
            >
              取消
            </button>
            <button
              onClick={() => void confirmSubmit()}
              disabled={tx.busy}
              className="btn-primary text-[11px] px-3 py-1.5 disabled:opacity-40"
            >
              {tx.busy ? '送出中…' : '確認提交'}
            </button>
          </div>
          {preflightError && (
            <span className="text-[10px] font-mono text-red-400 max-w-[240px] text-right break-words">
              預飛失敗：{preflightError}
            </span>
          )}
        </>
      )}
      <TxStatus tx={tx} />
    </div>
  )
}

// ── 市場列表 ────────────────────────────────────────────────────────────────

function MarketRow({ market, now, onDone }: { market: AdminMarket; now: number; onDone: () => void }) {
  const tx = useAdminTx()

  useEffect(() => {
    if (tx.confirmed) onDone()
  }, [tx.confirmed, onDone])

  const status = market.status
  const canLock = status === 0 && now >= Number(market.lockTime)
  const deadline = Number(market.settlementDeadline)
  const secondsLeft = deadline - now
  const urgent = status !== 2 && secondsLeft > 0 && secondsLeft < DAY
  const expired = status !== 2 && secondsLeft <= 0

  const statusClass =
    status === 0 ? 'status-open' : status === 1 ? 'status-locked' : 'status-settled'

  return (
    <tr
      className={`border-b border-[rgba(255,255,255,0.06)] ${
        expired ? 'bg-red-500/[0.07]' : urgent ? 'bg-amber-500/[0.07]' : ''
      }`}
    >
      <td className="px-4 py-3">
        <div className="flex flex-col">
          <span className="font-display text-sm text-white">{market.city}</span>
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">
            #{market.id.toString()}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className={statusClass}>{STATUS_LABEL[status] ?? status}</span>
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-[rgba(255,255,255,0.6)] whitespace-nowrap">
        {fmtTime(market.lockTime)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex flex-col">
          <span
            className={`font-mono text-[11px] ${
              expired ? 'text-red-400' : urgent ? 'text-amber-400' : 'text-[rgba(255,255,255,0.6)]'
            }`}
          >
            {fmtTime(market.settlementDeadline)}
          </span>
          {expired ? (
            <span className="text-[10px] font-mono text-red-400">結算窗口已關閉 · 退款模式</span>
          ) : urgent ? (
            <span className="text-[10px] font-mono text-amber-400">
              剩 {Math.floor(secondsLeft / HOUR)}h{Math.floor((secondsLeft % HOUR) / 60)}m
            </span>
          ) : (
            <span className="text-[10px] font-mono text-[rgba(255,255,255,0.25)]">
              {fmtDuration(market.lockedTimeout)}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-sm text-white whitespace-nowrap">
        {Number(formatUnits(market.totalPool, 6)).toFixed(2)}
      </td>
      <td className="px-4 py-3 text-right">
        {canLock ? (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={() =>
                void tx.send({
                  address: CONTRACT_ADDRESS,
                  abi: WEATHER_MARKET_ABI,
                  functionName: 'lockMarket',
                  args: [market.id],
                } as Parameters<typeof tx.send>[0])
              }
              disabled={tx.busy}
              className="btn-primary text-[11px] px-3 py-1.5 disabled:opacity-40"
            >
              {tx.busy ? '鎖盤中…' : '鎖盤'}
            </button>
            <TxStatus tx={tx} />
          </div>
        ) : status === 1 && !expired ? (
          <SubmitResultRow market={market} onDone={onDone} />
        ) : status === 1 && expired ? (
          <span className="text-[10px] font-mono text-red-400">
            已逾時，使用者可自行 claimRefund
          </span>
        ) : status === 0 ? (
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">
            未到 lockTime
          </span>
        ) : (
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">
            finalTemp {market.finalTemp.toString()}°C
            {market.noWinner ? ' · noWinner' : ` · bucket ${market.winningBucket}`}
          </span>
        )}
      </td>
    </tr>
  )
}

// ── 主頁面 ──────────────────────────────────────────────────────────────────

export default function Admin() {
  const { address } = useAccount()
  const { markets, count, isLoading, refetch } = useAdminMarkets()
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])

  const { data: oracleOnMarket } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'oracle',
  })
  const { data: adminOracleOwner } = useReadContract({
    address: ADMIN_ORACLE_ADDRESS ?? undefined,
    abi: ADMIN_ORACLE_ABI,
    functionName: 'owner',
    query: { enabled: !!ADMIN_ORACLE_ADDRESS },
  })

  const oracleMismatch =
    !!ADMIN_ORACLE_ADDRESS &&
    !!oracleOnMarket &&
    (oracleOnMarket as string).toLowerCase() !== ADMIN_ORACLE_ADDRESS.toLowerCase()

  const oracleOwnerMismatch =
    !!adminOracleOwner &&
    !!address &&
    (adminOracleOwner as string).toLowerCase() !== address.toLowerCase()

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <span className="text-[#ff9f45]">ADMIN</span>
            <span className="text-[rgba(255,255,255,0.3)] text-base font-mono">
              {activeChain.name} · {CONTRACT_ADDRESS.slice(0, 8)}…{CONTRACT_ADDRESS.slice(-6)}
            </span>
          </h1>
          <p className="text-[11px] font-mono text-[rgba(255,255,255,0.35)] mt-1">
            交易一律由連接的錢包簽署，前端不持有任何私鑰。
            CLI 腳本（scripts/lock-markets.ts、submit-results.ts）維持可用，作為備援路徑。
          </p>
        </div>
        <button onClick={() => void refetch()} className="btn-outline text-xs px-4 py-2">
          重新整理
        </button>
      </header>

      {(oracleMismatch || oracleOwnerMismatch || !ADMIN_ORACLE_ADDRESS) && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-1">
          {!ADMIN_ORACLE_ADDRESS && (
            <p className="text-xs font-mono text-amber-300">
              ⚠ {ENV_VAR_NAMES.adminOracle} 未設定 —— 「提交結果」功能停用，其餘功能不受影響。
            </p>
          )}
          {oracleMismatch && (
            <p className="text-xs font-mono text-amber-300">
              ⚠ WeatherMarket.oracle = {String(oracleOnMarket)}，與 {ENV_VAR_NAMES.adminOracle}
              （{ADMIN_ORACLE_ADDRESS}）不符。submitResult 會被 onlyOracle 擋下。
            </p>
          )}
          {oracleOwnerMismatch && (
            <p className="text-xs font-mono text-amber-300">
              ⚠ AdminOracle.owner = {String(adminOracleOwner)}，不是目前連接的地址。
              提交結果會 revert（WeatherMarket 與 AdminOracle 的 owner 是分開的）。
            </p>
          )}
        </div>
      )}

      <CreateMarketPanel onDone={() => void refetch()} />

      <SettingsPanel />

      <Card title={`市場列表（${count}）`} icon="table_rows">
        {isLoading && markets.length === 0 ? (
          <p className="text-sm text-[rgba(255,255,255,0.4)] py-6 text-center">載入中…</p>
        ) : markets.length === 0 ? (
          <p className="text-sm text-[rgba(255,255,255,0.4)] py-6 text-center">尚無市場</p>
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-[rgba(255,255,255,0.1)]">
                  {['Market', 'Status', 'Lock Time', 'Settlement Deadline', 'Pool (USDC)', ''].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-2 text-left text-[10px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.35)]"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {[...markets].reverse().map((m) => (
                  <MarketRow
                    key={m.id.toString()}
                    market={m}
                    now={now}
                    onDone={() => void refetch()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
