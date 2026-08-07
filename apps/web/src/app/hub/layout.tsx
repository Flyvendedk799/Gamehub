import { BRAND_NAME } from '@playforge/shared/brand';
import type { Metadata } from 'next';

const DESCRIPTION = `The ${BRAND_NAME} community hub — discover, play, rate, and remix AI-built web games. Every game runs instantly in your browser, and every game can be remixed into your own.`;

export const metadata: Metadata = {
  title: 'Community hub — play and remix AI-built games',
  description: DESCRIPTION,
  alternates: { canonical: '/hub' },
  openGraph: {
    title: `Community hub · ${BRAND_NAME}`,
    description: DESCRIPTION,
    url: '/hub',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: `Community hub · ${BRAND_NAME}`,
    description: DESCRIPTION,
  },
};

export default function HubLayout({ children }: { children: React.ReactNode }) {
  return children;
}
