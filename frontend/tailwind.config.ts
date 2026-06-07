import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#a8e8ff',
        'primary-container': '#00d4ff',
        'on-primary': '#003642',
        'on-primary-container': '#00586b',
        secondary: '#c9bfff',
        tertiary: '#00ff88',
        'tertiary-container': '#00df76',
        background: '#131318',
        surface: '#131318',
        'surface-dim': '#131318',
        'surface-container': '#1f1f25',
        'surface-container-low': '#1b1b20',
        'surface-container-high': '#2a292f',
        'surface-variant': '#35343a',
        'surface-tint': '#3cd7ff',
        'on-surface': '#e4e1e9',
        'on-surface-variant': '#bbc9cf',
        'outline-variant': '#3c494e',
        'warning-locked': '#FFB800',
        'danger-alert': '#FF4B4B',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['"Space Grotesk"', 'sans-serif'],
        mono: ['"Space Grotesk"', 'sans-serif'],
      },
      spacing: {
        'cmargin': '24px',
      },
    },
  },
  plugins: [],
} satisfies Config
