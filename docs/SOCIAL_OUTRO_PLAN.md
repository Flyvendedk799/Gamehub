# Social Outro Share Card Implementation Document

## Objective

Build an owner-side "Share" feature that generates a 10-second animated social outro for a game project. The artifact is meant to be placed at the end of short marketing/gameplay videos and should prove the game was built quickly by AI.

Required end-state message:

- "This game was made by X"
- The project/game name
- AI runtime shown as minutes and seconds
- Prompt/loop count, where one successful generation loop counts as one prompt
- Total token usage
- A play/remix URL when the project is published

Important brand rule: production UI for this feature must use `X` as the placeholder brand name until the final Phase 0 brand is chosen. The Claude Design prototype uses `PlayerZero`; treat that as prototype-only visual exploration, not product copy.

## Included Design Files

The uploaded Claude Design zip has been copied into the repo so the next implementer does not need access to the user's Downloads folder.

Source archive:

- `docs/social-outro-prototype/claude-design-output.zip`

Extracted Claude Design output:

- `docs/social-outro-prototype/claude-design-output/Neon Drift Outro.dc.html`
- `docs/social-outro-prototype/claude-design-output/Outro.dc.html`
- `docs/social-outro-prototype/claude-design-output/PZMark.dc.html`
- `docs/social-outro-prototype/claude-design-output/PlayerZero Brand.dc.html`
- `docs/social-outro-prototype/claude-design-output/PlayerZero Logo Options.dc.html`
- `docs/social-outro-prototype/claude-design-output/support.js`
- `docs/social-outro-prototype/claude-design-output/.thumbnail`

Rendered reference screenshots:

- `docs/social-outro-prototype/board-screenshot.png`
- `docs/social-outro-prototype/outro-screenshot.png`

How to use these files:

- Use `Outro.dc.html` as the source of truth for layout constants, animation timing, easing, count-up logic, and data slots.
- Use `Neon Drift Outro.dc.html` as the source of truth for the builder modal/export UI and the design-board overview.
- Use `PZMark.dc.html`, `PlayerZero Brand.dc.html`, and `PlayerZero Logo Options.dc.html` only as brand-mark exploration. Do not ship `PlayerZero` copy or the `P0` mark unless the final brand decision explicitly chooses it.
- Do not ship `support.js` or the `dc-*` custom element runtime in the app. Re-implement the design natively in React/canvas.

## Existing Code Context

Primary integration points:

- `apps/web/src/app/projects/[id]/page.tsx`
  - Builder page owner state.
  - Has `project`, `previewUrl`, `publishUrl`, `events`, run streaming, publish, download, and history controls.
- `apps/web/src/components/PreviewPane.tsx`
  - Preview iframe and preview toolbar. Useful if the share button is placed near preview controls rather than top builder controls.
- `apps/web/src/lib/api.ts`
  - Frontend API client. Add the social-outro fetch call here.
- `apps/web/src/lib/types.ts`
  - Frontend mirror types if a shared schema is not immediately wired.
- `services/api/src/server.ts`
  - Owner-guarded project routes, run report route, publish route, snapshot route, play route.
- `services/api/src/run-repo.ts`
  - Injectable run repo contract. Add social metrics aggregation here or create a focused repo.
- `services/api/src/drizzle-repos.ts`
  - Drizzle implementations for project/run/chat/snapshot repos.
- `packages/db/src/schema/runs.ts`
  - Existing token/cost columns: `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheCreationInputTokens`, `costUsd`, `creditsCharged`.
- `services/worker/src/run-generation.ts`
  - Already accumulates token usage from `turn_end`.
- `services/worker/src/finalize-run.ts`
  - Canonical completion path for both BullMQ worker and API in-process fallback.
  - Currently persists `inputTokens` and `outputTokens`; must also persist cached-token fields.
- `packages/shared/src/pricing.ts`
  - Has implied-cost helpers. Do not expose USD in the social outro until model/cost persistence is complete and labelled.

## Product Scope

V1 includes:

- Owner-only builder action labelled `Share` or `Export`.
- Modal with animated outro preview.
- Format selector with `9:16` and `1:1`.
- `16:9` may be visible as disabled or omitted in V1 because the prototype provides no 16:9 layout constants.
- Replay control.
- Download/share export:
  - Primary: WebM video via `canvas.captureStream(60)` and `MediaRecorder`.
  - Fallback: PNG still via `canvas.toBlob`.
  - Optional: Web Share API when available.
- Copy play link when the project is published.

V1 does not include:

- Public unauthenticated social metrics.
- Server-side MP4 rendering.
- Capturing live iframe video directly.
- Shipping the Claude Design custom-element HTML.
- Final brand rename.

## Metric Definitions

### AI Runtime

Display field: `aiRuntime`.

Persisted field: `aiRuntimeMs`.

Definition: active agent runtime for successful generation loops that produced project snapshots. Exclude project age, queue wait, idle user time, publish smoke tests, thumbnail capture, and social export time.

Recommended V1 measurement:

- Start a monotonic timer immediately before `enqueueRun` calls `runGeneration`.
- Stop it when `runGeneration` resolves or throws.
- Persist the elapsed time on the `runs` row.
- Aggregate only completed runs with `snapshotManifestKey` set for the social summary.

This measures active generation orchestration, including deterministic tool/verify/playtest work. If the product later needs pure model-call runtime, add provider-level LLM request timers separately.

### Prompt Loops

Display field: `promptLoops`.

Definition: count of successful generation loops that produced a snapshot for the project.

Recommended V1 aggregation:

- Count `runs.status = 'completed'` where `snapshot_manifest_key is not null`.
- Exclude failed, canceled, and still-paused runs.
- Include completed resume runs because they are real agent loops unless a future product decision says to collapse pause/resume into one prompt.

### Tokens

Display field: `totalTokens`.

Definition: total persisted model tokens for the included runs.

Recommended V1 headline:

- `totalTokens = inputTokens + outputTokens`

Reason: provider code treats `inputTokens` as total input, including uncached input, cache reads, and cache writes. Return cached subtotals for future detail but keep the card simple.

Do not show USD in V1 unless the implementation also persists a trustworthy `costUsd` and labels it clearly as actual or implied.

## Backend Implementation

### 1. Shared Schema

Add a shared schema so API, web, and tests agree on the response shape.

Suggested new file:

- `packages/shared/src/social-outro.ts`

Suggested exports:

```ts
import { z } from 'zod';

export const SOCIAL_OUTRO_SCHEMA_VERSION = 1 as const;

export const SocialOutroProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(['phaser', 'three']).nullable(),
  updatedAt: z.string(),
});

export const SocialOutroShareSchema = z.object({
  publishUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});

export const SocialOutroMetricsSchema = z.object({
  aiRuntimeMs: z.number().int().nonnegative(),
  promptLoops: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const SocialOutroSummarySchema = z.object({
  schemaVersion: z.literal(SOCIAL_OUTRO_SCHEMA_VERSION),
  brandName: z.literal('X'),
  project: SocialOutroProjectSchema,
  share: SocialOutroShareSchema,
  metrics: SocialOutroMetricsSchema,
});

export type SocialOutroSummary = z.infer<typeof SocialOutroSummarySchema>;
export type SocialOutroMetrics = z.infer<typeof SocialOutroMetricsSchema>;
```

Export it from `packages/shared/src/index.ts`.

### 2. Database Schema

Add additive columns to `runs` in `packages/db/src/schema/runs.ts`:

```ts
aiStartedAt: timestamp('ai_started_at', { withTimezone: true }),
aiFinishedAt: timestamp('ai_finished_at', { withTimezone: true }),
aiRuntimeMs: integer('ai_runtime_ms').notNull().default(0),
```

Add a Drizzle SQL migration:

```sql
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_started_at" timestamp with time zone;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_finished_at" timestamp with time zone;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_runtime_ms" integer NOT NULL DEFAULT 0;
```

Also update `packages/db/src/schema/schema.test.ts` so the `runs carry resume state + token metering` test includes:

- `cached_input_tokens`
- `cache_creation_input_tokens`
- `ai_started_at`
- `ai_finished_at`
- `ai_runtime_ms`

### 3. Runtime Persistence

Recommended contract addition in `services/api/src/run-repo.ts`:

```ts
export interface RunRuntimeUpdate {
  startedAt: Date;
  finishedAt: Date;
  runtimeMs: number;
}

export interface RunRepo {
  // existing methods...
  setRuntime(id: string, update: RunRuntimeUpdate): Promise<void>;
}
```

In-memory implementation:

- Add optional `aiStartedAt`, `aiFinishedAt`, and `aiRuntimeMs` fields to the in-memory `Run` shape or keep a private side map used by aggregation.
- Preserve all existing method behavior.

Drizzle implementation:

```ts
async setRuntime(id: string, update: RunRuntimeUpdate): Promise<void> {
  await this.db
    .update(schema.runs)
    .set({
      aiStartedAt: update.startedAt,
      aiFinishedAt: update.finishedAt,
      aiRuntimeMs: update.runtimeMs,
      updatedAt: new Date(),
    })
    .where(eq(schema.runs.id, id));
}
```

Worker paths to instrument:

- `services/worker/src/main.ts`
- `services/api/src/main.ts` in-process fallback

Wrap the active generation call:

```ts
const aiStartedAt = new Date();
const aiStartMs = performance.now();
try {
  const result = await enqueueRun(...);
  // existing finalizeRun path
} finally {
  const aiFinishedAt = new Date();
  const aiRuntimeMs = Math.max(0, Math.round(performance.now() - aiStartMs));
  await runRepo.setRuntime(runId, { startedAt: aiStartedAt, finishedAt: aiFinishedAt, runtimeMs: aiRuntimeMs });
}
```

If `performance` is not imported in Node, use `node:perf_hooks`.

### 4. Finish Token Persistence

Update `services/worker/src/finalize-run.ts` in both paused and completed paths:

```ts
cachedInputTokens: usage.cacheReadTokens,
cacheCreationInputTokens: usage.cacheWriteTokens,
```

Keep `costUsd` unchanged unless the implementation threads through real cost. Do not guess.

### 5. Aggregation Contract

Add a metrics type to `services/api/src/run-repo.ts`:

```ts
export interface ProjectSocialMetrics {
  aiRuntimeMs: number;
  promptLoops: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}
```

Add method:

```ts
getProjectSocialMetrics(projectId: string): Promise<ProjectSocialMetrics>;
```

Drizzle aggregation:

```ts
const [row] = await this.db
  .select({
    promptLoops: sql<number>`count(*)::int`,
    aiRuntimeMs: sql<number>`coalesce(sum(${schema.runs.aiRuntimeMs}), 0)::int`,
    inputTokens: sql<number>`coalesce(sum(${schema.runs.inputTokens}), 0)::bigint`,
    outputTokens: sql<number>`coalesce(sum(${schema.runs.outputTokens}), 0)::bigint`,
    cachedInputTokens: sql<number>`coalesce(sum(${schema.runs.cachedInputTokens}), 0)::bigint`,
    cacheCreationInputTokens: sql<number>`coalesce(sum(${schema.runs.cacheCreationInputTokens}), 0)::bigint`,
  })
  .from(schema.runs)
  .where(
    and(
      eq(schema.runs.projectId, projectId),
      eq(schema.runs.status, 'completed'),
      sql`${schema.runs.snapshotManifestKey} is not null`,
    ),
  );
```

Return zeros when no row exists.

### 6. API Route

Add to `services/api/src/server.ts` near the other owner-only project routes:

```txt
GET /v1/projects/:id/social-outro
```

Behavior:

- Require authenticated user.
- Load project with `deps.repo.get(id)`.
- Return 404 unless project exists and `project.ownerId === user.userId`.
- Load metrics from `deps.runRepo.getProjectSocialMetrics(project.id)`.
- Load published info with `deps.publishRepo?.getByProject(project.id)`.
- Include `publishUrl` only when the published game exists and `status === 'live'`.
- Include `thumbnailUrl` from the live published game when available.
- Return `brandName: 'X'`.

Response construction:

```ts
const totalTokens = metrics.inputTokens + metrics.outputTokens;
return reply.send({
  schemaVersion: 1,
  brandName: 'X',
  project: {
    id: project.id,
    name: project.name,
    engine: project.engine,
    updatedAt: project.updatedAt,
  },
  share: {
    publishUrl: livePublished ? `/v1/play/${livePublished.publishSlug}` : null,
    thumbnailUrl: livePublished?.thumbnailUrl ?? null,
  },
  metrics: {
    ...metrics,
    totalTokens,
  },
});
```

Security requirements:

- Owner-only.
- Do not return raw prompts.
- Do not return run event payloads.
- Do not return file paths or generated code.
- Do not expose metrics on public play pages in V1.

## Frontend Implementation

### 1. API Client

In `apps/web/src/lib/api.ts`, add:

```ts
export async function getSocialOutro(projectId: string): Promise<SocialOutroSummary> {
  return apiFetch<SocialOutroSummary>(`/v1/projects/${projectId}/social-outro`);
}
```

Import the shared type if practical:

```ts
import type { SocialOutroSummary } from '@playforge/shared';
```

If the web app cannot import the shared type cleanly yet, mirror the type in `apps/web/src/lib/types.ts` and keep field names identical.

### 2. Formatting Helpers

Add `apps/web/src/lib/social-outro.ts`.

Required helpers:

```ts
export function formatRuntime(ms: number): string;
export function formatTokenCount(tokens: number): string;
export function formatPromptLoops(count: number): string;
export function publicShareUrl(pathOrUrl: string | null): string | null;
```

Expected formatting:

- `formatRuntime(0)` -> `0:00`
- `formatRuntime(137000)` -> `2:17`
- `formatTokenCount(428000)` -> `428K`
- `formatTokenCount(1250000)` -> `1.3M`
- `formatPromptLoops(1)` -> `1 prompt`
- `formatPromptLoops(3)` -> `3 prompts`

Use `Math.round` for token display. Keep data labels short because the canvas layout is tight.

### 3. Builder State Integration

In `apps/web/src/app/projects/[id]/page.tsx`:

Add state:

```ts
const [showSocialOutro, setShowSocialOutro] = useState(false);
const [socialOutro, setSocialOutro] = useState<SocialOutroSummary | null>(null);
const [isLoadingSocialOutro, setIsLoadingSocialOutro] = useState(false);
const [socialOutroError, setSocialOutroError] = useState<string | null>(null);
```

Add lazy loader:

```ts
async function loadSocialOutro() {
  if (!projectId) return;
  setIsLoadingSocialOutro(true);
  setSocialOutroError(null);
  try {
    setSocialOutro(await getSocialOutro(projectId));
  } catch (err) {
    setSocialOutroError(describeApiError(err));
  } finally {
    setIsLoadingSocialOutro(false);
  }
}
```

Open behavior:

- Clicking `Share` sets `showSocialOutro` true and calls `loadSocialOutro`.
- Disable button when `!previewUrl` or `isStreaming`.
- Refresh after `run_complete`.
- Refresh after `handlePublish` succeeds.

Recommended toolbar placement:

- Top builder header near `Download`, `Publish`, and `History`.
- Label: `Share`.
- On small screens, keep text short. Icon is optional if no icon library exists.

### 4. Component Files

Add:

- `apps/web/src/components/SocialOutroModal.tsx`
- `apps/web/src/components/SocialOutroPreview.tsx`
- `apps/web/src/components/SocialOutroExportButton.tsx`

Do not nest cards inside cards. Keep the modal as a single dialog surface with a preview area and controls.

`SocialOutroModal` props:

```ts
interface SocialOutroModalProps {
  open: boolean;
  summary: SocialOutroSummary | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReload: () => void;
}
```

Required states:

- Loading skeleton.
- Error with retry.
- Unpublished share link state: show "Publish to get a play link" or disable copy-link.
- Published state: show and copy final URL.
- Exporting state.
- Export complete.
- Copy-confirmed state.

### 5. Canvas Renderer

Use canvas for the animated preview/export rather than animated DOM capture.

Suggested structure in `SocialOutroPreview.tsx`:

- `canvasRef`
- `requestAnimationFrame` loop for preview
- `renderFrame(ctx, frameState, t)`
- `prepareAssets(summary)` to load thumbnail if present
- `replay()` imperative handle or prop-driven `replayKey`

Canvas dimensions:

- `9:16`: `1080 x 1920`
- `1:1`: `1080 x 1080`

On-screen preview:

- Use CSS to scale the canvas down.
- Preserve aspect ratio.
- Do not resize the actual backing canvas below export resolution.

Formats:

```ts
type SocialOutroFormat = '9x16' | '1x1';
```

Use layout constants from the Claude Design prototype.

`9x16` layout:

```ts
{
  cardW: 1080,
  cardH: 1920,
  chipTop: 122,
  thumbTop: 250,
  thumbH: 620,
  titleTop: 942,
  titleSize: 84,
  metricsTop: 1150,
  metricSize: 64,
  lockupTop: 1540,
  ctaH: 96,
  ctaFont: 32,
  urlSize: 26
}
```

`1x1` layout:

```ts
{
  cardW: 1080,
  cardH: 1080,
  chipTop: 56,
  thumbTop: 132,
  thumbH: 432,
  titleTop: 602,
  titleSize: 60,
  metricsTop: 720,
  metricSize: 46,
  lockupTop: 888,
  ctaH: 76,
  ctaFont: 27,
  urlSize: 21
}
```

Palette:

- Base: `#0a0a0a`
- Alternate base from brand board: `#08080a`
- Surface: `#111111`, `#121214`, `#141416`
- Text: `#f4f5f7`
- Muted text: `rgba(244,245,247,0.55)`
- Cyan primary: `#46e6f0`
- Lime metric: `#b6f24a`
- Amber metric: `#ffb04d`
- Indigo link: `#7c83ff`

Typography:

- Prototype uses Space Grotesk for display/UI and JetBrains Mono for data.
- Recommended implementation:
  - Use `next/font/google` in `apps/web/src/app/layout.tsx`, or
  - Use CSS font stacks in the canvas until fonts are loaded.
- Canvas rendering must wait for `document.fonts.ready` before export.
- If adding fonts globally is too invasive, load them only in the component with CSS and use fallback until ready.

Brand mark:

- Implement a temporary `X` tile, not `P0`.
- Suggested mark: dark rounded square with a bold `X`, cyan accent stroke or cyan half of the glyph.
- Keep mark component replaceable:

```ts
function drawBrandMark(ctx, x, y, size, brandName = 'X') { ... }
```

Canvas text:

- Clamp long game names to max two lines.
- Use measured text wrapping.
- Reduce title font size if needed; do not let text overlap metrics.
- Never draw raw unbounded URLs; use slug/host truncation in canvas.

### 6. Animation Timeline

Use the prototype's exact timing and easing.

Easing functions:

```ts
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const outQuint = (x: number) => 1 - (1 - x) ** 5;
const outBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
```

Segment helper:

```ts
function seg(t: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (t - start) / (end - start)));
}
```

Timeline:

- `0.0s - 1.5s`: gameplay freeze becomes card.
  - Grid/glow fade in.
  - Top brand chip fades in.
  - Thumbnail scales from 1.06 to 1.0.
  - Play icon, HUD, scan lines, and progress bar fade out.
  - Corner brackets snap in with `outBack`.
- `1.5s - 3.0s`: title reveal.
  - Title slides up from masked area using `outQuint`.
  - Cyan underline scales in from left.
- `3.0s - 6.5s`: metrics snap/count.
  - Runtime metric enters at `3.0s`.
  - Prompt metric enters at `4.1s`.
  - Token metric enters at `5.2s`.
  - Runtime counts from `0:00` to formatted runtime.
  - Prompts count from `0` to numeric prompt count.
  - Tokens count from `0` to token display number/suffix.
- `6.5s - 8.5s`: brand beat overlay.
  - Dark overlay fades in from `6.4s - 6.9s`.
  - Text: `THIS GAME WAS MADE BY`.
  - Brand lockup scales from `0.4` to `1.0` and rotates from `-10deg` to `0deg`.
  - Overlay fades out from `8.2s - 8.7s`.
- `8.5s - 10.0s`: final lockup.
  - CTA buttons and URL slide up and fade in.
  - Final brand lockup remains visible.

The preview should loop. Export should record exactly 10 seconds from `t = 0` to `t = 10`.

### 7. Export Implementation

`SocialOutroExportButton` should accept:

```ts
interface ExportProps {
  canvas: HTMLCanvasElement | null;
  format: SocialOutroFormat;
  fileBaseName: string;
}
```

Video export:

```ts
const stream = canvas.captureStream(60);
const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
```

Fallbacks:

- If VP9 is unsupported, try `video/webm;codecs=vp8`.
- If `MediaRecorder` is unavailable, export PNG.
- If `navigator.share` supports files, offer share after blob creation.
- Always offer download.

Important export detail:

- The preview loop and the export loop must not fight over the same `requestAnimationFrame` state.
- Implement `renderAt(t)` as pure as possible.
- For export, drive time manually for 600 frames at 60 FPS or record a timed loop for 10 seconds.
- The simplest reliable V1 is:
  - pause preview
  - start recorder
  - run an export animation from `t = 0`
  - stop recorder at 10 seconds
  - resume preview

File naming:

- `social-outro-${safeProjectSlug}-9x16.webm`
- `social-outro-${safeProjectSlug}-1x1.webm`
- PNG fallback: `.png`

### 8. Builder Modal UI

Translate `Neon Drift Outro.dc.html` into native React/Tailwind.

Prototype UI decisions to keep:

- Dark overlay with subtle blur.
- Modal width around `600px` on desktop.
- Preview thumbnail on the left.
- Format segmented control (`9:16`, `1:1`, optional disabled `16:9`).
- Primary cyan button: `Download video`.
- Secondary outline button: `Replay`.
- Copy-link field with copied state:
  - Default border `#242426`
  - Copied border/background `#b6f24a`
  - Copied label `Copied`
- Helper copy: "Anyone with the link can play it now or remix it."

Production copy changes:

- Replace `made by PlayerZero` with `made by X`.
- Replace `playerzero.gg/...` with the actual published play URL or placeholder.
- Use `X`, not `PlayerZero`, in every brand slot.

Accessibility:

- Use `role="dialog"` and `aria-modal="true"`.
- Close on Escape.
- Trap focus in modal.
- Buttons need explicit `type="button"`.
- Canvas preview needs an accessible text summary, for example:
  - `Animated outro preview for Neon Drift Arena: made by X in 2:17, 3 prompts, 428K tokens.`

## Exact File Change Checklist

Backend/shared:

- `packages/shared/src/social-outro.ts`
- `packages/shared/src/index.ts`
- `packages/db/src/schema/runs.ts`
- `packages/db/src/schema/schema.test.ts`
- `packages/db/drizzle/<next>_social_outro_runtime.sql`
- `services/api/src/run-repo.ts`
- `services/api/src/drizzle-repos.ts`
- `services/api/src/server.ts`
- `services/api/src/server.test.ts`
- `services/api/src/main.ts`
- `services/worker/src/main.ts`
- `services/worker/src/finalize-run.ts`
- Add/update worker tests for runtime/token persistence if needed.

Frontend:

- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/types.ts` only if not importing shared type.
- `apps/web/src/lib/social-outro.ts`
- `apps/web/src/lib/__tests__/social-outro.test.ts`
- `apps/web/src/app/projects/[id]/page.tsx`
- `apps/web/src/components/SocialOutroModal.tsx`
- `apps/web/src/components/SocialOutroPreview.tsx`
- `apps/web/src/components/SocialOutroExportButton.tsx`
- Optional: `apps/web/src/components/SocialOutroBrandMark.tsx`
- Optional font integration: `apps/web/src/app/layout.tsx` and/or `apps/web/src/app/globals.css`

Docs/assets already added:

- `docs/social-outro-prototype/claude-design-output.zip`
- `docs/social-outro-prototype/claude-design-output/*`
- `docs/social-outro-prototype/board-screenshot.png`
- `docs/social-outro-prototype/outro-screenshot.png`

## Testing Plan

Backend tests:

- Schema smoke test includes new run runtime columns.
- `RunRepo.getProjectSocialMetrics`:
  - aggregates completed snapshot runs.
  - excludes failed/canceled/queued/running/paused runs.
  - returns zeros for projects with no completed runs.
  - sums cached tokens separately.
- `GET /v1/projects/:id/social-outro`:
  - owner receives 200.
  - non-owner receives 404.
  - unauthenticated receives 401.
  - unpublished project returns `publishUrl: null`.
  - published live project returns `/v1/play/:slug` and thumbnail URL.
  - response never includes prompt text.
- `finalizeRun` persists cached token fields.
- Runtime timing is non-negative and persists on completion.

Frontend unit tests:

- `formatRuntime`.
- `formatTokenCount`.
- `formatPromptLoops`.
- URL normalization/copy-link helper.
- Safe filename helper.

Frontend component/manual tests:

- Modal loading state.
- Modal error and retry state.
- Unpublished state.
- Published state.
- Replay resets animation to first frame.
- Format switch changes canvas dimensions.
- Long project names wrap or shrink without overlap.
- Copy link button enters and exits copied state.
- Export WebM where supported.
- PNG fallback when `MediaRecorder` is missing.

Visual verification:

- Compare against `docs/social-outro-prototype/outro-screenshot.png`.
- Verify at desktop and narrow mobile widths.
- Verify 9:16 and 1:1.
- Verify final lockup at `t = 9.6s` includes:
  - game name
  - runtime
  - prompt count
  - token count
  - "Play it now"
  - "Remix it"
  - published URL when available
  - `X` brand, not `PlayerZero`

Recommended commands:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

If the full suite is too slow while iterating:

```bash
pnpm --filter @playforge/api test
pnpm --filter @playforge/web test
pnpm --filter @playforge/db test
pnpm --filter @playforge/worker test
```

## Acceptance Criteria

The feature is complete when:

- A project owner can open a `Share` modal from the builder after a game exists.
- The modal renders a 10-second animated preview matching the included Claude Design direction.
- Every brand mention in the production feature says `X`.
- The outro displays project name, AI runtime, prompt loops, total tokens, and play URL when published.
- AI runtime does not use project age or `createdAt` to `now`.
- Prompt loops are successful generation loops, not chat message count.
- Total tokens come from persisted run usage.
- The owner-only API route is tested and does not expose private prompts or generated code.
- The user can replay the preview.
- The user can download a WebM or PNG fallback.
- The user can copy the published play link when one exists.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass, or any skipped command is explicitly documented.

## Future Work

- Server-side MP4 export via browser-worker or a dedicated render worker.
- 16:9 layout constants and export preset.
- Automatic fresh thumbnail capture from the current owner preview without requiring publish.
- Public-page "share this game" version with only public metrics, if product approves exposing build stats.
- Replace `X` with final brand after Phase 0 naming and global rename.
