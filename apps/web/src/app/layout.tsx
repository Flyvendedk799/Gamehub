import type { Metadata } from 'next';
import './globals.css';
import NavBar from '@/components/NavBar';

export const metadata: Metadata = {
  title: 'PlayerZero — Build games with AI',
  description: 'Describe a game. Watch AI build it. Ship in minutes.',
  icons: { icon: '/favicon.svg' },
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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
        <NavBar />
        <div className="pt-12 h-full">{children}</div>
      </body>
    </html>
  );
}
