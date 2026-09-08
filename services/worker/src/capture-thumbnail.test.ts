import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { type CaptureThumbnailPorts, captureProjectThumbnail } from './capture-thumbnail';

/** A valid 1×1 PNG, base64 — same fixture the API's publish-thumbnail tests use. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seedSnapshot(store: SnapshotStore): Promise<string> {
  const { manifestKey } = await store.write([
    {
      path: 'index.html',
      bytes: Buffer.from(
        '<!doctype html><html><head></head><body><canvas id="game"></canvas>' +
          '<script type="module" src="src/main.js"></script></body></html>',
      ),
    },
    { path: 'src/main.js', bytes: Buffer.from('window.__game = { debug: {} };') },
  ]);
  return manifestKey;
}

function ports(
  store: SnapshotStore,
  overrides: Partial<CaptureThumbnailPorts> = {},
): CaptureThumbnailPorts & { written: Array<[string, string]>; seenHtml: string[] } {
  const written: Array<[string, string]> = [];
  const seenHtml: string[] = [];
  return {
    store,
    screenshot: async (htmlContent) => {
      seenHtml.push(htmlContent);
      return { pngBase64: PNG_1x1 };
    },
    setThumbnail: async (projectId, thumbnailUrl) => {
      written.push([projectId, thumbnailUrl]);
    },
    written,
    seenHtml,
    ...overrides,
  };
}

describe('captureProjectThumbnail', () => {
  it('bundles the snapshot, stores the PNG, and stamps the project', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const manifestKey = await seedSnapshot(store);
    const p = ports(store);

    const captured = await captureProjectThumbnail(p, {
      manifestKey,
      engine: 'canvas2d',
      projectId: 'proj_1',
    });

    expect(captured).toBe(true);
    expect(p.written).toHaveLength(1);
    const [projectId, url] = p.written[0] ?? ['', ''];
    expect(projectId).toBe('proj_1');
    // The URL the web app resolves against the API origin — never a bare blob key.
    expect(url).toMatch(/^\/v1\/blobs\/[a-f0-9]{16,}$/);
    // It captured from the game's OWN bundle: the multi-file snapshot is
    // exported to ONE self-contained HTML document, with the entry module
    // inlined as a data: URL rather than left as a relative `src` the headless
    // browser could never resolve.
    const html = p.seenHtml[0] ?? '';
    expect(html).toContain('data:text/javascript');
    expect(html).not.toContain('src="src/main.js"');
  });

  it('reports no capture (and writes nothing) when the browser returns no frame', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const manifestKey = await seedSnapshot(store);
    const p = ports(store, { screenshot: async () => null });

    const captured = await captureProjectThumbnail(p, {
      manifestKey,
      engine: 'canvas2d',
      projectId: 'proj_1',
    });

    expect(captured).toBe(false);
    expect(p.written).toHaveLength(0);
  });
});
