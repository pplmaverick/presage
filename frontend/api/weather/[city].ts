import type { VercelRequest, VercelResponse } from '@vercel/node'

const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  taipei: { lat: 25.033, lon: 121.5654 },
  tokyo: { lat: 35.6762, lon: 139.6503 },
  bangkok: { lat: 13.7563, lon: 100.5018 },
  seoul: { lat: 37.5665, lon: 126.978 },
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const city = (req.query.city as string)?.toLowerCase()
  const coords = CITY_COORDS[city]
  if (!coords) return res.status(404).json({ error: 'Unknown city' })

  const apiKey = process.env.OPENWEATHER_API_KEY
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${coords.lat}&lon=${coords.lon}&appid=${apiKey}&units=metric`

  const upstream = await fetch(url)
  if (!upstream.ok) return res.status(502).json({ error: 'Upstream error' })

  const data = await upstream.json()
  res.status(200).json({
    temp: data.main.temp,
    humidity: data.main.humidity,
    windspeed: data.wind?.speed ?? null,
    description: data.weather?.[0]?.description ?? '',
    city,
  })
}
