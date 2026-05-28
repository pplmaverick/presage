import { useEffect, useState } from 'react'
import type { CityName } from '../config'

const CITY_QUERY: Record<CityName, string> = {
  Taipei:  'Taipei,TW',
  Tokyo:   'Tokyo,JP',
  Bangkok: 'Bangkok,TH',
  Seoul:   'Seoul,KR',
}

interface WeatherData {
  temp: number
  humidity: number
  pop: number
}

export default function WeatherBar({ city }: { city: CityName }) {
  const [data, setData] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY as string | undefined
    if (!apiKey) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function fetchWeather() {
      try {
        setError(false)
        const res = await fetch(
          `https://api.openweathermap.org/data/2.5/forecast?q=${CITY_QUERY[city]}&appid=${apiKey}&units=metric&cnt=1`
        )
        if (!res.ok) throw new Error('API error')
        const json = await res.json()
        const item = json.list[0]
        if (!cancelled) {
          setData({
            temp: Math.round(item.main.temp),
            humidity: item.main.humidity,
            pop: item.pop ?? 0,
          })
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    }

    setLoading(true)
    setData(null)
    fetchWeather()
    const id = setInterval(fetchWeather, 10 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [city])

  const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY as string | undefined
  if (!apiKey) return null

  return (
    <div className="flex items-center gap-3 bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-2.5 mb-5 text-sm flex-wrap">
      {loading && (
        <span className="text-slate-500 text-xs">Loading weather data...</span>
      )}
      {error && (
        <span className="text-slate-500 text-xs">Weather data unavailable</span>
      )}
      {!loading && !error && data && (
        <>
          <span className="text-slate-500 text-xs">Live Weather</span>
          <div className="w-px h-3 bg-slate-700" />
          <span className="text-white">🌡 <span className="font-semibold">{data.temp}°C</span></span>
          <div className="w-px h-3 bg-slate-700" />
          <span className="text-white">💧 <span className="font-semibold">{data.humidity}%</span></span>
          <div className="w-px h-3 bg-slate-700" />
          <span className="text-white">🌧 <span className="font-semibold">{Math.round(data.pop * 100)}%</span></span>
          <div className="w-px h-3 bg-slate-700" />
          <span className="text-emerald-400 text-xs font-medium">⬤ Oracle Active</span>
        </>
      )}
    </div>
  )
}
