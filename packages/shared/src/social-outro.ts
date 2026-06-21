/**
 * Social-outro contract — the owner-only summary that drives the 10-second
 * animated "share card" (proof a game was built fast by AI). Shared by the API
 * (response), the web app (fetch + canvas render), and tests so the shape can't
 * drift. See docs/SOCIAL_OUTRO_PLAN.md.
 *
 * Security: this summary is owner-only and intentionally carries NO prompts, run
 * event payloads, file paths, or generated code — only aggregate build metrics +
 * the public play link.
 */
import { z } from 'zod';
import { BRAND_NAME } from './brand';

export const SOCIAL_OUTRO_SCHEMA_VERSION = 1 as const;

export const SocialOutroProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(['phaser', 'three', 'canvas2d']).nullable(),
  updatedAt: z.string(),
});
export type SocialOutroProject = z.infer<typeof SocialOutroProjectSchema>;

export const SocialOutroShareSchema = z.object({
  /** Public play path/URL when the game is published live, else null. */
  publishUrl: z.string().nullable(),
  /** Thumbnail of the live published game, else null. */
  thumbnailUrl: z.string().nullable(),
});
export type SocialOutroShare = z.infer<typeof SocialOutroShareSchema>;

export const SocialOutroMetricsSchema = z.object({
  /** Active agent runtime across successful generation loops, milliseconds. */
  aiRuntimeMs: z.number().int().nonnegative(),
  /** Count of successful generation loops that produced a snapshot. */
  promptLoops: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  /** Headline figure: inputTokens + outputTokens. */
  totalTokens: z.number().int().nonnegative(),
});
export type SocialOutroMetrics = z.infer<typeof SocialOutroMetricsSchema>;

export const SocialOutroSummarySchema = z.object({
  schemaVersion: z.literal(SOCIAL_OUTRO_SCHEMA_VERSION),
  /** The product brand shown on the card ("made by …"). */
  brandName: z.literal(BRAND_NAME),
  project: SocialOutroProjectSchema,
  share: SocialOutroShareSchema,
  metrics: SocialOutroMetricsSchema,
});
export type SocialOutroSummary = z.infer<typeof SocialOutroSummarySchema>;
