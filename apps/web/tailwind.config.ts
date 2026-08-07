import type { Config } from 'tailwindcss';

/**
 * PlayerZero design tokens (identity board v1). Mirrors BRAND_COLORS in
 * `@playforge/shared/brand` — change there first, then here, so the canvas
 * surfaces (social outro) and the DOM can never drift apart.
 *
 * Rules the tokens encode:
 *  - Four-step surface ramp (chrome → ground → surface → raised) separated by
 *    1px hairlines; depth comes from the ramp, never from shadows.
 *  - Signal cyan is the ONLY interactive color; live/pass/fail are state-only.
 *  - Radius is 2px, never more (`rounded`); `rounded-full` exists solely for
 *    status dots.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        void: '#0a0b0c',
        chrome: '#0d0e10',
        ground: '#101112',
        surface: '#16181a',
        raised: '#1c1f21',
        hairline: '#26292c',
        edge: '#35393c',
        ink: {
          DEFAULT: '#f2f4f5',
          2: '#c8ccce',
          3: '#8b9095',
          4: '#5b6165',
        },
        signal: {
          DEFAULT: '#46e6f0',
          bright: '#7ff0f8',
        },
        live: '#ffb04d',
        pass: '#b6f24a',
        fail: '#ff5d3b',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
    borderRadius: {
      none: '0',
      DEFAULT: '2px',
      full: '9999px',
    },
  },
  plugins: [],
};

export default config;
