import { type Db, createDb, schema } from '@playforge/db';
import type { GameSpec } from '@playforge/shared';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
/**
 * Dev seed script — creates a usable dev account with known credentials AND a
 * starter showcase gallery of playable, remixable published games (#3.7).
 * Run once after applying migrations:
 *   DATABASE_URL=postgres://... pnpm --filter @playforge/api seed
 *
 * Idempotent: re-running skips both the dev account and any showcase game that
 * already exists (matched on its stable publish slug).
 */
import { eq } from 'drizzle-orm';
import { generateSessionToken, hashPassword, sessionExpiresAt } from './auth';

const DEV_EMAIL = 'dev@playforge.local';
const DEV_PASSWORD = 'devpassword123';
const DEV_HANDLE = 'devuser';
const DEV_DISPLAY_NAME = 'Dev User';
const FREE_TIER_CREDITS = 100;

/** Stable slug prefix so a re-run can detect + skip already-seeded showcase games. */
const SHOWCASE_PREFIX = 'showcase';

interface ShowcaseSeed {
  slug: string;
  name: string;
  engine: 'three' | 'phaser';
  genre: string;
  brief: string;
}

/**
 * Four starter gallery games — real engine/genre pairs mirrored from the bundled
 * GAME_EXAMPLE_BRIEFS (@playforge/templates) so each seeded entry is believable.
 * Inlined (not imported) to keep the seed self-contained.
 */
const SHOWCASE_SEEDS: ShowcaseSeed[] = [
  {
    slug: `${SHOWCASE_PREFIX}-phaser-platformer`,
    name: '2D platformer (Phaser)',
    engine: 'phaser',
    genre: 'platformer',
    brief:
      'Make a 2D side-scrolling platformer with jump physics, a flag at the level end, and at least one enemy that patrols a fixed range. Player dies on enemy contact and respawns.',
  },
  {
    slug: `${SHOWCASE_PREFIX}-phaser-puzzle`,
    name: 'Match-3 puzzle (Phaser)',
    engine: 'phaser',
    genre: 'puzzle',
    brief:
      'Match-3 puzzle on a 6x8 grid. Tap two adjacent tiles to swap; three-in-a-row clears + adds 100 to the score. Cascade matches award 2x. Music + clear SFX.',
  },
  {
    slug: `${SHOWCASE_PREFIX}-three-fps`,
    name: 'FPS wave defense (Three.js)',
    engine: 'three',
    genre: 'fps',
    brief:
      'First-person shooter with WASD movement, mouse look, and waves of enemies. Each wave gets harder. Player has 3 lives, ammo refills between waves, exit door appears after wave 5.',
  },
  {
    slug: `${SHOWCASE_PREFIX}-three-runner`,
    name: 'Endless runner (Three.js)',
    engine: 'three',
    genre: 'runner',
    brief:
      'Endless runner along a track. Player auto-advances; jump (Space) clears low obstacles; left/right (A/D) dodges side obstacles. Speed ramps up over time. Game ends on collision; show distance + best.',
  },
];

/** A minimal GameSpec good enough for genre/tag filtering + viewer rendering. */
function showcaseGameSpec(seed: ShowcaseSeed): GameSpec {
  return {
    schemaVersion: 1,
    genre: seed.genre as GameSpec['genre'],
    dimensions: seed.engine === 'three' ? '3d' : '2d',
    perspective: seed.engine === 'three' ? 'first_person' : 'side_scroll',
    cameraKind: 'static',
    primaryInputs: ['keyboard'],
    numActors: 1,
    winCondition: seed.brief.slice(0, 200),
    loseCondition: 'Run out of lives.',
    features: {},
  };
}

/**
 * A tiny, fully self-contained, network-free playable HTML bundle. NOT an
 * engine build — a clickable canvas demo with the `window.__game` contract so
 * it boots at /v1/play/:slug and can be remixed. Keeps the seed offline (no CDN
 * fetch) while still being a real, openable game.
 */
function showcaseBundle(seed: ShowcaseSeed): string {
  const title = seed.name.replace(/[<&]/g, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b12;color:#e6e6f0;font:600 16px/1.5 system-ui,sans-serif;overflow:hidden}
  #wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px}
  canvas{background:#15151f;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
  .meta{opacity:.8;font-size:13px}
</style></head>
<body><div id="wrap">
  <canvas id="c" width="480" height="320"></canvas>
  <div class="meta">${title} — click the canvas to score. A Playforge showcase.</div>
</div>
<script>
  (function(){
    var c=document.getElementById('c'),x=c.getContext('2d'),score=0,running=true;
    function draw(){
      x.clearRect(0,0,c.width,c.height);
      x.fillStyle='#a78bfa';x.font='bold 22px system-ui';
      x.fillText('${title}',20,40);
      x.fillStyle='#e6e6f0';x.font='16px system-ui';
      x.fillText('Score: '+score,20,80);
    }
    c.addEventListener('click',function(){ score++; draw(); });
    draw();
    // Minimal window.__game contract so the runtime bridge recognises a game.
    window.__game={ getState:function(){return {score:score,running:running};},
      restart:function(){score=0;draw();} };
  })();
</script>
</body></html>`;
}

async function seed() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  const db = createDb(databaseUrl);

  // ── Dev account (idempotent) ──────────────────────────────────────────────
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, DEV_EMAIL));

  let userId: string;
  if (existing) {
    userId = existing.id;
    console.log(`Dev account already exists: @${DEV_HANDLE} (${DEV_EMAIL})`);
    console.log(`Password: ${DEV_PASSWORD}`);
  } else {
    const passwordHash = await hashPassword(DEV_PASSWORD);
    const [user] = await db
      .insert(schema.users)
      .values({ email: DEV_EMAIL, passwordHash, handle: DEV_HANDLE, displayName: DEV_DISPLAY_NAME })
      .returning({ id: schema.users.id });

    if (!user) throw new Error('User insert returned no row');
    userId = user.id;

    await db.insert(schema.creditLedger).values({
      userId: user.id,
      delta: FREE_TIER_CREDITS,
      reason: 'welcome_grant',
    });

    const token = generateSessionToken();
    await db
      .insert(schema.sessions)
      .values({ token, userId: user.id, expiresAt: sessionExpiresAt() });

    console.log('Dev account created:');
    console.log(`  Email:    ${DEV_EMAIL}`);
    console.log(`  Password: ${DEV_PASSWORD}`);
    console.log(`  Handle:   @${DEV_HANDLE}`);
    console.log(`  Token:    ${token}`);
  }

  // ── Starter showcase gallery (idempotent) ─────────────────────────────────
  await seedShowcase(db, userId);
}

/**
 * Insert ≥4 playable, remixable published games owned by the dev user (#3.7).
 * For each: the REQUIRED parent `projects` row first (NOT-NULL FK), then a
 * `published_games` row with a real bundleKey pointing at a self-contained HTML
 * blob in the same object store the API serves from. Idempotent — skips any
 * game whose stable slug already exists.
 */
async function seedShowcase(db: Db, ownerId: string): Promise<void> {
  const blobDir = process.env['BLOB_DIR'] ?? '.playforge-blobs';
  const store = new SnapshotStore(new LocalFsBlobStore(blobDir));

  let created = 0;
  for (const seed of SHOWCASE_SEEDS) {
    const [already] = await db
      .select({ id: schema.publishedGames.id })
      .from(schema.publishedGames)
      .where(eq(schema.publishedGames.publishSlug, seed.slug));
    if (already) continue;

    // Parent project row first — published_games.project_id is a NOT-NULL FK.
    const [project] = await db
      .insert(schema.projects)
      .values({
        ownerId,
        slug: seed.slug,
        name: seed.name,
        engine: seed.engine,
        visibility: 'public',
        gameSpec: showcaseGameSpec(seed),
      })
      .returning({ id: schema.projects.id });
    if (!project) throw new Error(`project insert returned no row for ${seed.slug}`);

    // Real bundle in object storage so /v1/play/:slug serves it.
    const bundleKey = await store.putBlob(Buffer.from(showcaseBundle(seed), 'utf8'));

    await db.insert(schema.publishedGames).values({
      projectId: project.id,
      publishSlug: seed.slug,
      title: seed.name,
      bundleKey,
      description: seed.brief.slice(0, 200),
      tags: [seed.genre, 'showcase'],
      gameSpec: showcaseGameSpec(seed),
      status: 'live',
    });
    created += 1;
  }

  if (created > 0) {
    console.log(`Showcase gallery: inserted ${created} published game(s).`);
  } else {
    console.log('Showcase gallery already seeded — skipped.');
  }
}

void seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
