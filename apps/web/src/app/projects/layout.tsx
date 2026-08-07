import type { Metadata } from 'next';

// Account-bound workspace (project list + editor) — never indexed.
export const metadata: Metadata = {
  title: 'Your projects',
  robots: { index: false, follow: false },
};

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
