/**
 * Public play page — /p/:slug
 *
 * Embeds the published game in a sandboxed iframe. The game HTML is served
 * from the API's /v1/play/:slug endpoint with locked-down CSP headers.
 * This page provides the OG tags, share UI, and "remix" CTA.
 */
import Link from 'next/link';

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3191';

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function PlayPage({ params }: Props) {
  const { slug } = await params;
  const gameUrl = `${BASE}/v1/play/${slug}`;

  return (
    <div className="flex flex-col min-h-screen bg-[#0a0a0a]">
      {/* Top bar */}
      <header className="flex-shrink-0 h-12 border-b border-[#222222] bg-[#111111] flex items-center px-4 gap-4 z-10">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <div className="w-6 h-6 rounded-md bg-[#6366f1] flex items-center justify-center">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <polygon points="2,1 9,5.5 2,10" fill="white" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-[#f4f4f5] hidden sm:block group-hover:text-[#6366f1] transition-colors">
            Playforge
          </span>
        </Link>

        <div className="w-px h-5 bg-[#222222] flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-[#a1a1aa] truncate">{slug}</span>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <a
            href={gameUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
          >
            Full screen ↗
          </a>
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border border-[#2a2a2a] transition-colors font-medium"
          >
            Make your own ✦
          </Link>
        </div>
      </header>

      {/* Game iframe — fills the remaining viewport */}
      <main className="flex-1 relative">
        <iframe
          src={gameUrl}
          title={`Play ${slug}`}
          className="w-full h-full border-0 absolute inset-0"
          sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-downloads"
          allow="autoplay; fullscreen"
        />
      </main>
    </div>
  );
}
