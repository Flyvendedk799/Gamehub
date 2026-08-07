import type { Metadata } from 'next';

// Auth surfaces carry no indexable content.
export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
