import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        surface: '#111111',
        border: '#222222',
        accent: '#6366f1',
        'text-primary': '#f4f4f5',
        'text-muted': '#a1a1aa',
        success: '#22c55e',
        error: '#ef4444',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
