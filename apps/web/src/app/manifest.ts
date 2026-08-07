import { BRAND_NAME, BRAND_TAGLINE } from '@playforge/shared/brand';
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: `${BRAND_TAGLINE}. Describe a game in plain language and ${BRAND_NAME} builds a real, playable web game in your browser.`,
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0b0c',
    theme_color: '#0a0b0c',
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
