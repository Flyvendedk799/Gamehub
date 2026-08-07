import type { Metadata } from 'next';

// First-run account setup — never indexed.
export const metadata: Metadata = {
  title: 'Account setup',
  robots: { index: false, follow: false },
};

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
