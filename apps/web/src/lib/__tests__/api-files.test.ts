import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ListProjectFilesResponse,
  type ReadProjectFileResponse,
  type WriteProjectFileResponse,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from '../api';
import { API_BASE } from '../config';

/** A vi.fn() fetch stub that always resolves the given JSON body, and lets us
 *  assert the URL/method/body it was called with. */
function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callUrl(mock: ReturnType<typeof vi.fn>): string {
  return String(mock.mock.calls[0]?.[0]);
}
function callInit(mock: ReturnType<typeof vi.fn>): RequestInit {
  return (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listProjectFiles', () => {
  it('GETs /v1/projects/:id/files and parses the response', async () => {
    const body: ListProjectFilesResponse = {
      files: [{ path: 'index.html', size: 12, contentType: 'text/html', isText: true }],
      totalBytes: 12,
      engine: 'phaser',
    };
    const mock = stubFetch(body);

    await expect(listProjectFiles('proj_1')).resolves.toEqual(body);
    expect(callUrl(mock)).toBe(`${API_BASE}/v1/projects/proj_1/files`);
    // GET — no explicit method set on the request init.
    expect(callInit(mock).method).toBeUndefined();
  });
});

describe('readProjectFile', () => {
  it('GETs a single-segment path', async () => {
    const body: ReadProjectFileResponse = {
      path: 'index.html',
      size: 12,
      contentType: 'text/html',
      encoding: 'utf-8',
      content: '<html></html>',
    };
    const mock = stubFetch(body);

    await expect(readProjectFile('proj_1', 'index.html')).resolves.toEqual(body);
    expect(callUrl(mock)).toBe(`${API_BASE}/v1/projects/proj_1/files/index.html`);
  });

  it('encodes each segment of a multi-segment path independently', async () => {
    const body: ReadProjectFileResponse = {
      path: 'assets/my img/p p.png',
      size: 4,
      contentType: 'image/png',
      encoding: 'base64',
      content: 'AAAA',
    };
    const mock = stubFetch(body);

    await readProjectFile('proj_1', 'assets/my img/p p.png');
    // Spaces are percent-encoded, but the "/" separators are preserved.
    expect(callUrl(mock)).toBe(`${API_BASE}/v1/projects/proj_1/files/assets/my%20img/p%20p.png`);
  });
});

describe('writeProjectFile', () => {
  it('PUTs the file URL with a { content } JSON body', async () => {
    const body: WriteProjectFileResponse = {
      ok: true,
      path: 'main.js',
      size: 20,
      manifestKey: 'snapshots/abc/manifest.json',
      snapshotId: 'snap_1',
      filesHash: 'abc',
    };
    const mock = stubFetch(body);

    await expect(writeProjectFile('proj_1', 'main.js', 'const x = 1;')).resolves.toEqual(body);

    expect(callUrl(mock)).toBe(`${API_BASE}/v1/projects/proj_1/files/main.js`);
    const init = callInit(mock);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ content: 'const x = 1;' });
  });
});
