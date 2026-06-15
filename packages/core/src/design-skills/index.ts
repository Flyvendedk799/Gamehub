/**
 * Design-skill starter snippets — JSX modules that the agent can `view` from
 * the virtual filesystem and adapt to the user's brief.
 *
 * Each .jsx file is a complete `<script type="text/babel">` payload with a
 * `// when_to_use:` hint comment at the top so the agent can decide which
 * skill (if any) applies before opening the file.
 */

import { readFileSync } from 'node:fs';

// Vite's `?raw` suffix is unavailable outside the bundler (the cloud agent
// runs under plain Node/tsx); load the sibling .jsx payloads via fs instead.
const raw = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');
const calendarJsx = raw('./calendar.jsx');
const chartSvgJsx = raw('./chart-svg.jsx');
const chatUiJsx = raw('./chat-ui.jsx');
const dashboardJsx = raw('./dashboard.jsx');
const dataTableJsx = raw('./data-table.jsx');
const editorialTypographyJsx = raw('./editorial-typography.jsx');
const footersJsx = raw('./footers.jsx');
const glassmorphismJsx = raw('./glassmorphism.jsx');
const heroesJsx = raw('./heroes.jsx');
const landingPageJsx = raw('./landing-page.jsx');
const pricingJsx = raw('./pricing.jsx');
const slideDeckJsx = raw('./slide-deck.jsx');

const DESIGN_SKILL_FILES = [
  'slide-deck.jsx',
  'dashboard.jsx',
  'landing-page.jsx',
  'chart-svg.jsx',
  'glassmorphism.jsx',
  'editorial-typography.jsx',
  'heroes.jsx',
  'pricing.jsx',
  'footers.jsx',
  'chat-ui.jsx',
  'data-table.jsx',
  'calendar.jsx',
] as const;

export type DesignSkillName = (typeof DESIGN_SKILL_FILES)[number];

export const DESIGN_SKILLS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['slide-deck.jsx', slideDeckJsx],
  ['dashboard.jsx', dashboardJsx],
  ['landing-page.jsx', landingPageJsx],
  ['chart-svg.jsx', chartSvgJsx],
  ['glassmorphism.jsx', glassmorphismJsx],
  ['editorial-typography.jsx', editorialTypographyJsx],
  ['heroes.jsx', heroesJsx],
  ['pricing.jsx', pricingJsx],
  ['footers.jsx', footersJsx],
  ['chat-ui.jsx', chatUiJsx],
  ['data-table.jsx', dataTableJsx],
  ['calendar.jsx', calendarJsx],
] as const);
