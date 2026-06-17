import type { Metadata } from 'next';
import PlayClient from './play-client';
import { API_BASE } from '@/lib/config';

const BASE = API_BASE;

interface GameMeta {
  title: string;
  thumbnailUrl: string | null;
}

async function fetchGameMeta(slug: string): Promise<GameMeta | null> {
  try {
    const res = await fetch(`${BASE}/v1/hub/games/${slug}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = await res.json() as { game?: { title?: string; thumbnailUrl?: string | null } };
    return {
      title: json.game?.title ?? slug,
      thumbnailUrl: json.game?.thumbnailUrl ?? null,
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = await fetchGameMeta(slug);
  const title = meta?.title ?? slug;
  const description = `Play "${title}" — an AI-generated game on Playforge`;
  const images = meta?.thumbnailUrl
    ? [{ url: meta.thumbnailUrl.startsWith('http') ? meta.thumbnailUrl : `${BASE}${meta.thumbnailUrl}`, width: 640, height: 360, alt: title }]
    : [];

  return {
    title: `${title} — Playforge`,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      ...(images.length > 0 ? { images } : {}),
    },
    twitter: {
      card: images.length > 0 ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(images.length > 0 ? { images: [images[0]!.url] } : {}),
    },
  };
}

export default async function PlayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = await fetchGameMeta(slug);
  return <PlayClient slug={slug} initialTitle={meta?.title} />;
}
