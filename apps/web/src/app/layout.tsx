import { SITE_URL } from '@/lib/site';
import { BRAND_NAME, BRAND_TAGLINE } from '@playforge/shared/brand';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import AppShell from '@/components/AppShell';

const DESCRIPTION = `${BRAND_TAGLINE}. Describe a game in plain language and ${BRAND_NAME} builds a real, playable web game in your browser — then publish it to an instant play link and remix games from the community hub.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BRAND_NAME} — Build games with AI`,
    template: `%s · ${BRAND_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: BRAND_NAME,
  keywords: [
    'AI game builder',
    'make a game with AI',
    'browser games',
    'game generator',
    'Phaser',
    'Three.js',
    'remix games',
    'no-code game development',
  ],
  authors: [{ name: BRAND_NAME }],
  creator: BRAND_NAME,
  publisher: BRAND_NAME,
  alternates: { canonical: '/' },
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: BRAND_NAME,
    title: `${BRAND_NAME} — Build games with AI`,
    description: DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${BRAND_NAME} — Build games with AI`,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  formatDetection: { telephone: false },
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
  themeColor: '#0a0b0c',
  colorScheme: 'dark',
};

/** Site-wide structured data: the organization + the site (with search intent
 *  pointed at the hub). Rendered once in the root layout. */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: BRAND_NAME,
      url: SITE_URL,
      logo: `${SITE_URL}/favicon.svg`,
      slogan: BRAND_TAGLINE,
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: BRAND_NAME,
      url: SITE_URL,
      description: DESCRIPTION,
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full bg-void text-ink">
      <head>
        <meta charSet="utf-8" />
        {/* viewport is provided by the `viewport` export above (Next injects it). */}
        {/* Brand fonts — Archivo (variable: full weight + width axes, so the
            display voice can be Expanded via font-stretch) + JetBrains Mono
            (data). Loaded by literal family name so the social-outro <canvas>
            can use them. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time JSON-LD built solely from brand constants
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </head>
      <body className="h-full antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
