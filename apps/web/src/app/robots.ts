import { SITE_URL } from '@/lib/site';
import type { MetadataRoute } from 'next';

/**
 * Crawl policy: the public surfaces (home, hub, play pages, creator profiles)
 * are indexable; everything account-bound or operational is not. The private
 * segments also carry `robots: noindex` metadata — this file keeps crawlers
 * from spending budget there at all.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/projects',
          '/settings',
          '/onboarding',
          '/admin',
          '/auth/',
          // Individual jam rooms only — the /jam landing stays crawlable. Rooms
          // are short-lived, private to whoever holds the code, and their codes
          // recycle, so an indexed room URL is worse than useless.
          '/jam/',
          '/v1/', // same-origin API proxy — never crawlable content
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
