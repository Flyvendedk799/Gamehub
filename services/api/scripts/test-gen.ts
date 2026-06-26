/**
 * Standard local test-generation harness — runs a REAL game generation against
 * the live source with in-process Chromium playtests, billed to the **Claude
 * subscription** (Claude Code OAuth token from the macOS keychain), NOT a metered
 * API key. This is our standard way to smoke-test the engine locally.
 *
 *   pnpm --filter @playforge/api test:gen "<prompt>" [engine] [model]
 *
 * e.g.  pnpm --filter @playforge/api test:gen "a neon rhythm tapper" canvas2d
 *       pnpm --filter @playforge/api test:gen "a fish dodging anchors"   # auto engine
 *
 * Env: TEST_GEN_TIMEOUT_MS (default 480000) — hard wall-clock cap; on timeout the
 * harness force-closes the browser pool and exits 2 (so a wedged playtest can't hang).
 *
 * Why the subscription: we develop under Claude Code's subscription, so test runs
 * should use the same auth. The token is read FRESH from the keychain each run, so
 * it stays valid as Claude Code refreshes it (no baked-in secret).
 */
import { execSync } from 'node:child_process';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { runGeneration } from '../../worker/src/run-generation';
import { makeInProcessBrowserJobs } from '../src/in-process-browser';

/** Read the Claude Code subscription OAuth token (sk-ant-oat…) from the keychain. */
function subscriptionToken(): string {
  let raw: string;
  try {
    raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf8',
    });
  } catch {
    throw new Error(
      'Could not read the Claude Code keychain credential — is Claude Code logged in on this machine?',
    );
  }
  const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  if (typeof tok !== 'string' || !tok.includes('sk-ant-oat')) {
    throw new Error('keychain credential is not a Claude subscription OAuth token (sk-ant-oat…)');
  }
  return tok;
}

type Engine = 'canvas2d' | 'phaser' | 'three';

async function main(): Promise<number> {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('usage: test:gen "<prompt>" [canvas2d|phaser|three] [modelId]');
    return 64;
  }
  const engineArg = process.argv[3] as Engine | undefined;
  const modelId = process.argv[4] || 'claude-opus-4-8';
  const token = subscriptionToken();

  const store = new SnapshotStore(new InMemoryBlobStore());
  const rawBrowser = makeInProcessBrowserJobs();
  // Per-call timeouts: a standalone in-process Chromium pool can occasionally wedge
  // (no reaper, unlike the live API). Race each call so a wedged verdict degrades to
  // null — runGeneration treats null as "no evidence" and the run still finishes —
  // instead of hanging the whole harness. The wall-clock cap below is the backstop.
  const raceNull = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<T | null>((r) => setTimeout(() => r(null), ms))]);
  const browserJobs: typeof rawBrowser = {
    ...rawBrowser,
    runtimeVerify: (html) => raceNull(rawBrowser.runtimeVerify(html), 45_000),
    playtest: (html, steps) => raceNull(rawBrowser.playtest(html, steps), 60_000),
  };

  // Hard wall-clock cap so a wedged in-process playtest can never hang the run.
  const timeoutMs = Number(process.env.TEST_GEN_TIMEOUT_MS ?? 480_000);
  const killer = setTimeout(() => {
    console.error(
      `\n✗ TIMEOUT after ${Math.round(timeoutMs / 1000)}s — force-closing browser pool.`,
    );
    void browserJobs.close().finally(() => process.exit(2));
  }, timeoutMs);
  killer.unref?.();

  console.log(`▶ ${modelId} · ${engineArg ?? 'auto-engine'} · Claude subscription (sk-ant-oat)`);
  console.log(`▶ ${prompt}\n`);

  const t0 = Date.now();
  const result = await runGeneration(
    {
      prompt,
      model: { provider: 'anthropic', modelId },
      apiKey: token,
      provider: 'anthropic',
      ...(engineArg ? { engine: engineArg } : {}),
    },
    { store, browserJobs, maxRepairRounds: 1 },
  );
  clearTimeout(killer);

  console.log(`\n===== RESULT (${((Date.now() - t0) / 1000).toFixed(0)}s) =====`);
  console.log(
    `engine=${result.engine} genre=${result.spec?.genre ?? '—'} ship=${result.shipReason} repair=${result.repairRounds} files=${result.fileCount}`,
  );

  const files: Record<string, string> = {};
  for (const p of Object.keys(result.snapshot.manifest.files ?? {})) {
    files[p] = new TextDecoder().decode(await store.readFile(result.snapshot.manifest, p));
  }
  const index = files['index.html'] ?? '';
  const all = Object.values(files).join('\n');
  const ok = (label: string, pass: boolean, detail = '') =>
    console.log(`  ${pass ? '✅' : '⬜'} ${label}${detail ? ` — ${detail}` : ''}`);

  const artCalls = (all.match(/__game\.art\.(draw|sprite)/g) || []).length;
  ok('art layer injected into the game bootstrap', index.includes('window.__game.art'));
  ok('generated game DRAWS subjects via window.__game.art', artCalls > 0, `${artCalls} call(s)`);
  ok(
    'shipped a real verdict (not blind no_verdict)',
    result.shipReason !== 'no_verdict',
    `ship=${result.shipReason}`,
  );
  ok('debug contract wired (playtestable)', /__game\.debug\.track|__game\.state/.test(all));
  ok('Title/Play/Over screen flow', /screen\s*=|TitleScene|OverScene|'over'/.test(all));
  ok('WebAudio sfx', /createOscillator/.test(all));
  ok('rebindable controls declared', /__game\.controls\.define/.test(all));
  if (/beatmap|rhythm|music|beat/i.test(prompt)) {
    ok(
      'rhythm: used the beatmap substrate',
      /beatmap-synth|generateBeatmap|createBeatmapSynth/.test(all),
    );
  }

  await browserJobs.close();
  return result.shipReason === 'no_verdict' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('\n✗ FAILED:', e?.stack || e);
    process.exit(1);
  });
