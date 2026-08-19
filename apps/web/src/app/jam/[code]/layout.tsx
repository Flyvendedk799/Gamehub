import type { Metadata } from 'next';

/**
 * A jam room is private to whoever holds the code and its code recycles once
 * the room closes, so it must never be indexed — an indexed room URL would
 * point a stranger at a live party, or at a different party entirely.
 */
export const metadata: Metadata = {
  title: 'Jam room',
  robots: { index: false, follow: false },
};

export default function JamRoomLayout({ children }: { children: React.ReactNode }) {
  return children;
}
