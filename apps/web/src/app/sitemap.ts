import { API_BASE } from '@/lib/config';
import { SITE_URL } from '@/lib/site';
import type { MetadataRoute } from 'next';

interface HubFeedGame {
  publishSlug?: string;
  publishedAt?: string;
}

/**
 * Best-effort dynamic entries: the newest published games from the hub feed.
 * The sitemap must never 500 because the API is down, so failures collapse to
 * the static routes only.
 */
async function publishedGameEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const res = await fetch(`${API_BASE}/v1/hub?sort=recent&limit=200`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { games?: HubFeedGame[] };
    return (json.games ?? [])
      .filter((g): g is HubFeedGame & { publishSlug: string } => typeof g.publishSlug === 'string')
      .map((g) => ({
        url: `${SITE_URL}/p/${g.publishSlug}`,
        ...(g.publishedAt ? { lastModified: new Date(g.publishedAt) } : {}),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }));
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const games = await publishedGameEntries();
  return [
    {
      url: SITE_URL,
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${SITE_URL}/hub`,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    ...games,
  ];
}
