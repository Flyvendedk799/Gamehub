import { API_BASE } from '@/lib/config';
import type { Metadata } from 'next';
import PlayClient from './play-client';

const BASE = API_BASE;

interface GameMeta {
  title: string;
  thumbnailUrl: string | null;
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
        thumbnailUrl?: string | null;
        remixCount?: number;
        parentSlug?: string | null;
        projectId?: string | null;
      };
    };
    return {
      title: json.game?.title ?? slug,
      thumbnailUrl: json.game?.thumbnailUrl ?? null,
      remixCount: typeof json.game?.remixCount === 'number' ? json.game.remixCount : 0,
      parentSlug: json.game?.parentSlug ?? null,
      projectId: typeof json.game?.projectId === 'string' ? json.game.projectId : null,
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = await fetchGameMeta(slug);
  const title = meta?.title ?? slug;
  const description = `Play "${title}" — an AI-generated game on PlayerZero`;
  const images = meta?.thumbnailUrl
    ? [
        {
          url: meta.thumbnailUrl.startsWith('http')
            ? meta.thumbnailUrl
            : `${BASE}${meta.thumbnailUrl}`,
          width: 640,
          height: 360,
          alt: title,
        },
      ]
    : [];

  return {
    title: `${title} — PlayerZero`,
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
  return (
    <PlayClient
      slug={slug}
      {...(meta?.title !== undefined ? { initialTitle: meta.title } : {})}
      remixCount={meta?.remixCount ?? 0}
      parentSlug={meta?.parentSlug ?? null}
      {...(meta?.projectId ? { projectId: meta.projectId } : {})}
    />
  );
}
