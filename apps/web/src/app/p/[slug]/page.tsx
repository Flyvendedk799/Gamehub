import { API_BASE } from '@/lib/config';
import { SITE_URL, safeJsonLd } from '@/lib/site';
import { BRAND_NAME } from '@playforge/shared/brand';
import type { Metadata } from 'next';
import PlayClient from './play-client';

const BASE = API_BASE;

interface GameMeta {
  title: string;
  description: string | null;
  genre: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  playCount: number;
  ratingAvg: number;
  ratingCount: number;
  publishedAt: string | null;
  /** #3.6 — remix lineage for the play page. */
  remixCount: number;
  parentSlug: string | null;
  /** Project this published game belongs to — scopes the cloud-save relay. */
  projectId: string | null;
}

async function fetchGameMeta(slug: string): Promise<GameMeta | null> {
  try {
    const res = await fetch(`${BASE}/v1/hub/games/${slug}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      game?: {
        title?: string;
        description?: string | null;
        genre?: string | null;
        tags?: string[];
        thumbnailUrl?: string | null;
        playCount?: number;
        ratingAvg?: number;
        ratingCount?: number;
        publishedAt?: string;
        remixCount?: number;
        parentSlug?: string | null;
        projectId?: string | null;
      };
    };
    return {
      title: json.game?.title ?? slug,
      description: json.game?.description ?? null,
      genre: json.game?.genre ?? null,
      tags: Array.isArray(json.game?.tags) ? json.game.tags : [],
      thumbnailUrl: json.game?.thumbnailUrl ?? null,
      playCount: typeof json.game?.playCount === 'number' ? json.game.playCount : 0,
      ratingAvg: typeof json.game?.ratingAvg === 'number' ? json.game.ratingAvg : 0,
      ratingCount: typeof json.game?.ratingCount === 'number' ? json.game.ratingCount : 0,
      publishedAt: json.game?.publishedAt ?? null,
      remixCount: typeof json.game?.remixCount === 'number' ? json.game.remixCount : 0,
      parentSlug: json.game?.parentSlug ?? null,
      projectId: typeof json.game?.projectId === 'string' ? json.game.projectId : null,
    };
  } catch {
    return null;
  }
}

function thumbnailAbsolute(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith('http') ? url : `${BASE}${url}`;
}

export async function generateMetadata({
  params,
}: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = await fetchGameMeta(slug);
  const title = meta?.title ?? slug;
  const description =
    meta?.description?.trim() ||
    `Play "${title}" free in your browser — an AI-built web game on ${BRAND_NAME}. Rate it, climb the leaderboard, or remix it into your own game.`;
  const thumb = thumbnailAbsolute(meta?.thumbnailUrl ?? null);
  const images = thumb ? [{ url: thumb, width: 640, height: 360, alt: title }] : [];

  return {
    title: `Play ${title}`,
    description,
    alternates: { canonical: `/p/${slug}` },
    ...(meta && meta.tags.length > 0 ? { keywords: meta.tags } : {}),
    openGraph: {
      title: `${title} · ${BRAND_NAME}`,
      description,
      url: `/p/${slug}`,
      type: 'website',
      siteName: BRAND_NAME,
      ...(images.length > 0 ? { images } : {}),
    },
    twitter: {
      card: images.length > 0 ? 'summary_large_image' : 'summary',
      title: `${title} · ${BRAND_NAME}`,
      description,
      ...(images.length > 0 ? { images: [images[0]!.url] } : {}),
    },
  };
}

export default async function PlayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = await fetchGameMeta(slug);

  // Structured data: this page IS the game. Rating/interaction figures come
  // straight from the hub record and are only asserted when they exist.
  const jsonLd = meta
    ? {
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: meta.title,
        url: `${SITE_URL}/p/${slug}`,
        playMode: 'SinglePlayer',
        applicationCategory: 'Game',
        gamePlatform: 'Web browser',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@id': `${SITE_URL}/#organization` },
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.genre ? { genre: meta.genre } : {}),
        ...(meta.tags.length > 0 ? { keywords: meta.tags.join(', ') } : {}),
        ...(thumbnailAbsolute(meta.thumbnailUrl)
          ? { image: thumbnailAbsolute(meta.thumbnailUrl) }
          : {}),
        ...(meta.publishedAt ? { datePublished: meta.publishedAt } : {}),
        ...(meta.ratingCount > 0
          ? {
              aggregateRating: {
                '@type': 'AggregateRating',
                ratingValue: Number(meta.ratingAvg.toFixed(2)),
                ratingCount: meta.ratingCount,
                bestRating: 5,
                worstRating: 1,
              },
            }
          : {}),
        ...(meta.playCount > 0
          ? {
              interactionStatistic: {
                '@type': 'InteractionCounter',
                interactionType: 'https://schema.org/PlayGameAction',
                userInteractionCount: meta.playCount,
              },
            }
          : {}),
      }
    : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: safeJsonLd escapes `<`, so user-authored strings can't break out of the script tag
          dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
        />
      )}
      <PlayClient
        slug={slug}
        {...(meta?.title !== undefined ? { initialTitle: meta.title } : {})}
        remixCount={meta?.remixCount ?? 0}
        parentSlug={meta?.parentSlug ?? null}
        {...(meta?.projectId ? { projectId: meta.projectId } : {})}
      />
    </>
  );
}
