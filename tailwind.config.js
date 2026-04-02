/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}',
    './src/renderer/index.html',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'claude-bg': '#1a1a1a',
        'claude-surface': '#242424',
        'claude-border': '#333333',
        'claude-text': '#f0f0f0',
        'claude-text-secondary': '#d0d0d0',
        'claude-accent': '#8B8DFF',
        'claude-accent-hover': '#A5A7FF',
        'claude-success': '#22c55e',
        'claude-error': '#ef4444',
        'claude-warning': '#f59e0b',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'sound-bar': {
          '0%, 100%': { transform: 'scaleY(0.3)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'wave': {
          '0%': { transform: 'translateX(-10px)' },
          '100%': { transform: 'translateX(10px)' },
        },
        'pulse-slow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
      animation: {
        'sound-bar': 'sound-bar 0.8s ease-in-out infinite',
        'wave': 'wave 1s ease-in-out infinite alternate',
        'pulse-slow': 'pulse-slow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}

