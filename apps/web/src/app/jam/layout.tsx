import { BRAND_NAME } from '@playforge/shared/brand';
import type { Metadata } from 'next';

const DESCRIPTION =
  'Game Jam — get everyone on their phone, throw ideas at the same questions, and watch them compile into one couch co-op game you all play together.';

export const metadata: Metadata = {
  title: 'Game Jam — build a game with your friends',
  description: DESCRIPTION,
  alternates: { canonical: '/jam' },
  openGraph: {
    title: `Game Jam · ${BRAND_NAME}`,
    description: DESCRIPTION,
    url: '/jam',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: `Game Jam · ${BRAND_NAME}`,
    description: DESCRIPTION,
  },
};

export default function JamLayout({ children }: { children: React.ReactNode }) {
  return children;
}
