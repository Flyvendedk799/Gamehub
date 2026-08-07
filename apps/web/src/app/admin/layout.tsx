import type { Metadata } from 'next';

// Operational dashboard — never indexed.
export const metadata: Metadata = {
  title: 'Build health',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
