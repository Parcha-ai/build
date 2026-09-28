/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}',
    './src/renderer/index.html',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Graphite design system (aj/design-refresh). Legacy claude-* names are
      // kept as aliases so every existing class picks up the new palette.
      colors: {
        'claude-bg': '#0F0F0F',
        'claude-surface': '#171717',
        'claude-surface-hover': '#1E1E1E',
        'claude-sidebar': '#141414',
        'claude-border': '#262626',
        'claude-text': '#EDEDED',
        'claude-text-secondary': '#A0A0A0',
        'claude-accent': '#4C9AFF',
        'claude-accent-hover': '#8DBBFF',
        'claude-success': '#3FB950',
        'claude-error': '#F85149',
        'claude-warning': '#F0B429',
        ink: {
          term: '#0A0A0A',
          0: '#0F0F0F',
          1: '#141414',
          2: '#171717',
          3: '#1C1C1C',
          4: '#2B2B2B',
        },
        fg: {
          DEFAULT: '#EDEDED',
          2: '#CFCFCF',
          3: '#A0A0A0',
          4: '#808080',
          5: '#666666',
        },
        line: {
          DEFAULT: 'rgba(255,255,255,0.07)',
          strong: 'rgba(255,255,255,0.14)',
        },
        accent: {
          DEFAULT: '#4C9AFF',
          text: '#8DBBFF',
        },
        diff: {
          add: '#3FB950',
          'add-text': '#7EE2A0',
          del: '#F85149',
          'del-text': '#FFA198',
        },
        amber: {
          DEFAULT: '#F0B429',
        },
      },
      // Square corners everywhere; only true circles (status dots) stay round.
      borderRadius: {
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
        full: '9999px',
      },
      fontFamily: {
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
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

