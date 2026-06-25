import type { Metadata, Viewport } from 'next';
import './globals.css';
import AppShell from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'PlayerZero — Build games with AI',
  description: 'Describe a game. Watch AI build it. Ship in minutes.',
  icons: { icon: '/favicon.svg' },
};

// `viewport-fit=cover` enables env(safe-area-inset-*) on notched iPhones;
// themeColor tints the mobile browser chrome to match the dark UI. No
// user-scalable=no — pinch-zoom stays available (a11y).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The on-screen keyboard shrinks the layout (so dvh heights reflow above it
  // and the chat input stays visible) instead of overlaying the content.
  interactiveWidget: 'resizes-content',
  themeColor: '#0a0a0a',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full bg-[#0a0a0a] text-[#f4f4f5]">
      <head>
        <meta charSet="utf-8" />
        {/* viewport is provided by the `viewport` export above (Next injects it). */}
        {/* Brand fonts — Space Grotesk (display/wordmark) + JetBrains Mono (data).
            Loaded by literal family name so the social-outro <canvas> can use them. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="h-full antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
