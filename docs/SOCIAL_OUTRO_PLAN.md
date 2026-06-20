# Social Outro Share Card Plan

## Goal

Add an owner-side "Share on social media" feature that creates a 10-second animated outro card for a project. The card should be dynamic per game, use the temporary brand name `X`, and make the build story legible for short marketing clips:

- "This game was made by X"
- Project/game name
- AI runtime in `mm:ss`, based on actual generation work, not project age
- Prompt/loop count, where one completed generation prompt is one loop
- Total token usage
- A public play/remix URL when the project has been published

The first implementation should live in the builder, where owner-only metrics are already available. Public play-page reuse can come after the owner flow is solid.

## Codebase Context

Relevant existing surfaces:

- `apps/web/src/app/projects/[id]/page.tsx` owns the builder page, project state, `previewUrl`, `publishUrl`, run streaming, snapshots, publish, download, and history actions.
- `apps/web/src/components/PreviewPane.tsx` owns the game iframe and toolbar tabs. It is the likely host for a preview-adjacent share/outro action.
- `apps/web/src/lib/api.ts` is the typed frontend API client. New client calls should go here.
- `apps/web/src/lib/types.ts` mirrors frontend project/run/SSE response types.
- `services/api/src/server.ts` already has owner-guarded project routes, run stream routes, `GET /v1/runs/:id/report`, publish routes, and snapshot routes.
- `services/api/src/run-repo.ts` and `services/api/src/drizzle-repos.ts` are the injectable repo boundary for runs.
- `packages/db/src/schema/runs.ts` has token and cost columns already: `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheCreationInputTokens`, `costUsd`, and `creditsCharged`.
- `services/worker/src/run-generation.ts` already sums per-turn token usage from `turn_end` events.
- `services/worker/src/finalize-run.ts` is the canonical completion path for both BullMQ and in-process generation. It currently persists `inputTokens` and `outputTokens`, but not the cached-token columns or `costUsd`.
- `packages/shared/src/pricing.ts` already has token pricing helpers, but the social outro v1 should not show USD unless the persistence path records the model/cost reliably.
- `apps/web/src/components/GameCard.tsx` and `apps/web/src/lib/thumbnail.ts` already model published-game thumbnails and deterministic placeholders.

## Product Definition

Primary user flow:

1. User finishes or publishes a game in the builder.
2. User clicks a new toolbar action, working label: `Share`.
3. A modal opens with an animated social outro preview.
4. The preview can be replayed.
5. The user can export a video file when supported, share via the Web Share API when available, download a fallback file, and copy the play URL when published.

First format:

- Primary: vertical `9:16`, intended for TikTok, Reels, Shorts.
- Resolution target: `1080x1920`.
- Duration: 10 seconds.
- Future presets: `1:1` square and `16:9` landscape.

Metric definitions for v1:

- `aiRuntimeMs`: sum of actual generation work time for completed runs that advanced the current project. Exclude project age, idle time, queue wait, publish smoke tests, thumbnail capture, and social export time.
- `promptLoops`: count of completed generation runs for the project that produced a snapshot. In the UI label this as `prompts` or `loops` depending on final copy; internally use `promptLoops`.
- `totalTokens`: sum of persisted model tokens for those same runs. Use `inputTokens + outputTokens` as the headline because the provider code treats `inputTokens` as total input including cache reads/writes. Also return cached/cache-creation subtotals for future detail.
- `brandName`: hardcode `X` until the Phase 0 brand decision lands.

Open product choices:

- Button label: `Share`, `Share video`, `Social outro`, or `Make outro`.
- Whether failed runs should be included in the displayed build cost. Recommended v1: exclude failed/canceled runs from the "made in" story, but keep the route structure flexible.
- Whether the first export must be MP4. Recommended v1: in-browser WebM plus static PNG fallback; add server-side MP4 rendering as a follow-up if needed for social-platform compatibility.

## Backend Plan

### 1. Add explicit AI runtime persistence

Add additive migration columns to `runs`:

- `ai_started_at timestamp with time zone`
- `ai_finished_at timestamp with time zone`
- `ai_runtime_ms integer not null default 0`

Why: `createdAt` to `finishedAt` can include queue wait and finalization. The user specifically wants actual AI runtime, not time since project creation.

Instrumentation target:

- Start timing after a BullMQ job or in-process fallback is actively executing, near the call into `enqueueRun`/`runGeneration`.
- Stop timing when `runGeneration` resolves or throws.
- Persist even on failure where possible, so internal reporting stays honest.
- For the social summary, aggregate completed snapshot-producing runs by default.

Implementation choices:

- Either thread `aiRuntimeMs` through `GenerationResult` and persist in `finalizeRun`, or add a small `RunRepo.finishRuntime(runId, runtime)` method that worker/main and API/main call in `finally`.
- Prefer threading through `GenerationResult` if it is measured inside `runGeneration`; prefer repo method if measuring around `enqueueRun` in the worker/API execution paths.

### 2. Complete existing token persistence

Update `finalizeRun` to persist:

- `cachedInputTokens: usage.cacheReadTokens`
- `cacheCreationInputTokens: usage.cacheWriteTokens`
- `costUsd` only if the generation result has a trustworthy value; otherwise leave `0` and do not surface USD in the social card.

This closes the current gap where `runGeneration` computes cache usage but `finalizeRun` only writes input/output.

### 3. Add a shared response schema

Create a zod schema in `packages/shared`, for example:

- `SocialOutroSummarySchema`
- `SocialOutroMetricsSchema`

Suggested response shape:

```ts
{
  schemaVersion: 1,
  brandName: "X",
  project: {
    id: string,
    name: string,
    engine: "phaser" | "three" | null,
    updatedAt: string
  },
  share: {
    publishUrl: string | null,
    thumbnailUrl: string | null
  },
  metrics: {
    aiRuntimeMs: number,
    promptLoops: number,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    cacheCreationInputTokens: number,
    totalTokens: number
  }
}
```

### 4. Add an owner-only summary route

Add:

```txt
GET /v1/projects/:id/social-outro
```

Route behavior:

- Require auth.
- Load the project via `deps.repo.get(id)`.
- Return 404 unless the requester owns the project.
- Aggregate runs for that project.
- Include the current published game's `thumbnailUrl` and `/v1/play/:slug` URL when `publishRepo.getByProject(project.id)` exists and is live.
- Do not expose prompt text, file contents, hidden build logs, or raw run event payloads.

Repo boundary:

- Add an injectable read method rather than querying directly from React.
- Good candidates:
  - Add `getProjectSocialMetrics(projectId)` to `RunRepo`.
  - Or add a focused `ProjectSocialSummaryRepo` if keeping `RunRepo` lifecycle-only feels cleaner.

Drizzle aggregation sketch:

- Filter `runs.project_id = projectId`.
- Recommended v1 filter: `status = 'completed'` and `snapshot_manifest_key is not null`.
- `promptLoops = count(*)`.
- `aiRuntimeMs = sum(ai_runtime_ms)`.
- `inputTokens = sum(input_tokens)`.
- `outputTokens = sum(output_tokens)`.
- `cachedInputTokens = sum(cached_input_tokens)`.
- `cacheCreationInputTokens = sum(cache_creation_input_tokens)`.
- `totalTokens = inputTokens + outputTokens`.

In-memory implementation:

- Extend `InMemoryRunRepo` enough for route tests to seed completed runs with metrics.
- Keep existing tests passing by preserving defaults.

## Frontend Plan

### 1. API client and formatting helpers

Add to `apps/web/src/lib/api.ts`:

- `getSocialOutro(projectId: string): Promise<SocialOutroSummary>`

Add pure helpers, likely `apps/web/src/lib/social-outro.ts`:

- `formatRuntime(ms): string` -> `2:07`
- `formatTokens(n): string` -> `428K`, `1.2M`
- `formatLoopLabel(n): string` -> `1 prompt`, `2 prompts`
- `buildOutroTimeline(summary): timeline model`

Unit test these helpers under `apps/web/src/lib/__tests__`.

### 2. Builder integration

In `apps/web/src/app/projects/[id]/page.tsx`:

- Add `showSocialOutro`, `socialOutroSummary`, `isLoadingSocialOutro`, and `socialOutroError` state.
- Add a toolbar button near `Publish`/`Download`, disabled while no preview exists.
- Fetch summary lazily when the user opens the modal.
- Refresh summary after `run_complete` and after `publishProject` succeeds.

Initial button label suggestion:

- `Share`

The modal can clarify the artifact without adding heavy UI copy.

### 3. Component structure

Add components:

- `apps/web/src/components/SocialOutroModal.tsx`
- `apps/web/src/components/SocialOutroPreview.tsx`
- `apps/web/src/components/SocialOutroExportButton.tsx`

Responsibilities:

- Modal: layout, loading/error states, replay/share/download controls.
- Preview: deterministic 10-second animation using summary data.
- Export button: generate/download/share video or fallback image.

### 4. Animation/export implementation

Recommended v1 path:

- Implement the visual as a canvas-driven renderer with a deterministic timeline.
- Draw thumbnail/placeholder, project title, `X` brand lockup, stats, and final CTA.
- Use `canvas.captureStream(60)` plus `MediaRecorder` to export WebM where supported.
- Use `navigator.share({ files })` when available.
- Fallback to PNG export via `canvas.toBlob`.
- Fallback copy: copy published URL when available.

Why canvas first:

- Browser can record canvas reliably without trying to capture a cross-origin iframe.
- No new runtime dependency is required.
- It avoids trying to serialize animated DOM into video.

Thumbnail strategy:

- Use the published `thumbnailUrl` when available.
- If no thumbnail exists, render a deterministic branded placeholder with project name, engine, and stats.
- Follow-up: add a server/browser-worker route to capture the latest owner preview thumbnail without requiring publish.

Timeline suggestion:

- `0.0s - 1.5s`: game frame/thumbnail snaps into a crisp social-card composition.
- `1.5s - 3.0s`: title reveal: `{project.name}`.
- `3.0s - 6.5s`: stat count-up: `Built by X`, `{runtime}`, `{promptLoops}`, `{totalTokens}`.
- `6.5s - 8.5s`: brand beat: `This game was made by X`.
- `8.5s - 10.0s`: final lockup: `{project.name}`, `Play it now` or `Remix it`, URL/slug when published.

Copy notes:

- Use `X` only for brand until final branding.
- Avoid `Playforge` in the social output.
- I interpret the requested "say bye" as "say by X" based on the earlier wording "made by X". If literal goodbye copy is wanted, add it as a design option, not the default.

## Security And Privacy

- The route is owner-only; public play pages must not expose build cost or private creation history without an explicit product decision.
- Do not render raw prompts in the social artifact.
- Do not draw generated HTML directly into the host page. Use thumbnail image or placeholder only.
- Keep generated games in sandboxed iframes, as today.
- Escape user-controlled strings in React. For canvas, draw text directly with measured wrapping and length clamps.
- Keep `brandName: "X"` centralized so the Phase 0 rename can replace it cleanly.

## Tests

Backend:

- DB schema smoke test for new run timing columns.
- `runGeneration` or worker/queue test confirming runtime is recorded and non-negative.
- `finalizeRun` test confirming cached tokens and runtime fields persist.
- Fastify inject tests:
  - owner can fetch `/v1/projects/:id/social-outro`.
  - non-owner receives 404.
  - unpublished project returns `publishUrl: null`.
  - completed runs aggregate loops/runtime/tokens.

Frontend:

- Formatting helper tests for runtime, tokens, singular/plural loops.
- API parser/shape test if shared zod is wired into the client.
- Component smoke test for loading, no-preview, unpublished, and published states.

Manual/visual verification after implementation:

- Open builder on desktop and mobile widths.
- Build/publish a sample game.
- Open the share modal.
- Confirm text does not overlap in 9:16, 1:1 if added, and small modal widths.
- Export WebM where supported.
- Verify fallback PNG/download when `MediaRecorder` or `navigator.share` is unavailable.

## Implementation Order

1. Add shared schema and backend aggregation shape.
2. Add run AI-runtime persistence and finish existing cached-token persistence.
3. Add owner-only social-outro route with tests.
4. Add frontend API client and formatting helper tests.
5. Add the modal with a static first frame.
6. Add the animated timeline.
7. Add WebM/PNG export.
8. Integrate the Claude Design output into the final visual treatment.
9. Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`.

## Claude Design Prompt

Paste this into Claude Design:

```txt
Design a 10-second animated social media outro for a cloud AI game builder.

Context:
- The product lets a user describe a game in natural language, then an AI builds a playable browser game.
- The final brand name is not chosen. Use the temporary brand name "X" everywhere a brand appears.
- Do not use the words Playforge, codesign, PrivateClaudesign, Claude, or any legacy desktop-builder language in the visual output.
- The animation will appear at the end of a short gameplay video, like a polished creator outro.

Primary format:
- Vertical 9:16 social video, 1080x1920.
- Duration: exactly 10 seconds.
- Also show how the composition adapts to 1:1 square if possible.

Dynamic data slots:
- gameName: "Neon Drift Arena"
- thumbnail/gameplay frame: use a clear placeholder image slot that can be replaced by a real game thumbnail.
- aiRuntime: "2:17"
- promptLoops: "3 prompts"
- totalTokens: "428K tokens"
- publishUrl or slug: "x.app/p/neon-drift-arena"
- brandName: "X"

Required message:
- The end must clearly communicate: "This game was made by X"
- Show the game/project name prominently.
- Show the build metrics: AI runtime, prompts/loops, total tokens.
- Make it feel like proof that the game was actually built quickly by AI.

Animation timeline:
- 0.0s to 1.5s: gameplay frame freezes and transforms into a clean social card.
- 1.5s to 3.0s: game title reveal.
- 3.0s to 6.5s: metrics count or snap in one by one: runtime, prompts, tokens.
- 6.5s to 8.5s: brand beat: "This game was made by X".
- 8.5s to 10.0s: final lockup with gameName, "Play it now" or "Remix it", and the URL/slug.

Visual direction:
- Premium, kinetic, game-native, and creator-friendly.
- Use a dark base compatible with the existing builder UI (#0a0a0a and #111111), but do not make it a flat one-note purple interface.
- Accent palette can include electric cyan, lime, amber, or coral alongside restrained indigo.
- The game frame should be the hero. The metrics and brand should support it.
- Avoid generic SaaS hero design, floating marketing cards, gradient orb decoration, emoji logos, or overly rounded pill-heavy UI.
- Use a compact, confident brand mark for "X" that could later be replaced.
- Text must remain readable on mobile. No overlaps. No tiny legal-copy style text.

Deliverables:
- A high-fidelity animated prototype or detailed motion spec.
- Include a first frame, a mid-animation metrics frame, and the final lockup.
- Use named layers/slots for gameName, thumbnail, aiRuntime, promptLoops, totalTokens, publishUrl, and brandName.
- Provide CSS/React-friendly measurements, colors, easing, and timing notes so it can be implemented in a Next.js/Tailwind app.
- Include export button/modal styling for the builder UI: closed button, open modal, replay, download/share, and copy-link states.
```
