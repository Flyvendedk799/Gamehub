import { API_BASE } from '@/lib/config';
import { SITE_URL, safeJsonLd } from '@/lib/site';
import { BRAND_NAME } from '@playforge/shared/brand';
import type { Metadata } from 'next';

interface CreatorMeta {
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
}

/** Best-effort server-side profile fetch for metadata + JSON-LD. */
async function fetchCreator(handle: string): Promise<CreatorMeta | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(handle)}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      displayName?: string;
      bio?: string | null;
      avatarUrl?: string | null;
    };
    return {
      displayName: json.displayName ?? handle,
      bio: json.bio ?? null,
      avatarUrl: json.avatarUrl ?? null,
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const creator = await fetchCreator(handle);
  const name = creator?.displayName ?? `@${handle}`;
  const description =
    creator?.bio?.trim() ||
    `Games built by ${name} on ${BRAND_NAME} — play them instantly in your browser, or remix them into your own.`;

  return {
    title: `${name} (@${handle})`,
    description,
    alternates: { canonical: `/u/${handle}` },
    openGraph: {
      title: `${name} (@${handle}) · ${BRAND_NAME}`,
      description,
      url: `/u/${handle}`,
      type: 'profile',
      ...(creator?.avatarUrl ? { images: [{ url: creator.avatarUrl, alt: name }] } : {}),
    },
    twitter: {
      card: 'summary',
      title: `${name} (@${handle}) · ${BRAND_NAME}`,
      description,
    },
  };
}

export default async function CreatorLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const creator = await fetchCreator(handle);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: creator?.displayName ?? `@${handle}`,
      alternateName: `@${handle}`,
      url: `${SITE_URL}/u/${handle}`,
      ...(creator?.avatarUrl ? { image: creator.avatarUrl } : {}),
      ...(creator?.bio ? { description: creator.bio } : {}),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safeJsonLd escapes `<`, so user-authored strings can't break out of the script tag
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      {children}
    </>
  );
}
