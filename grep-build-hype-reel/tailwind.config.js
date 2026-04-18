/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Hype reel palette
        bg: '#0a0a0a',
        surface: '#1a1a2e',
        primary: '#8B8DFF',
        secondary: '#A5A7FF',
        glow: '#8B8DFF',
        muted: '#94a3b8',
        // Claudette/Grep Build exact palette
        'claude-bg': '#1a1a1a',
        'claude-surface': '#242424',
        'claude-border': '#333333',
        'claude-text': '#e4e4e4',
        'claude-text-secondary': '#a0a0a0',
        'claude-accent': '#8B8DFF',
        'claude-accent-hover': '#A5A7FF',
        'claude-success': '#22c55e',
        'claude-error': '#ef4444',
        'claude-warning': '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'sound-bar': 'sound-bar 0.8s ease-in-out infinite',
        'wave': 'wave 1s ease-in-out infinite alternate',
        'pulse-slow': 'pulse-slow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
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
        'pulse-square': {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
