import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Playforge — Build games with AI',
  description: 'Describe a game in natural language, get a playable web game in seconds.',
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
      </head>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
