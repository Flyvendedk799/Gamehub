import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const alt = 'PlayerZero — a production console for games. Build games with AI.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Fetch Archivo Expanded 800 as raw TTF for satori. The css2 endpoint returns
 * truetype URLs when the request has no browser user-agent. Best-effort: on any
 * failure the card renders in the bundled default font instead of erroring.
 */
async function loadArchivo(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      'https://fonts.googleapis.com/css2?family=Archivo:wght@800&display=swap',
      { headers: { 'User-Agent': 'satori' } },
    ).then((r) => r.text());
    const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
    if (!url) return null;
    return await fetch(url).then((r) => r.arrayBuffer());
  } catch {
    return null;
  }
}

export default async function OpengraphImage() {
  const archivo = await loadArchivo();

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#0a0b0c',
        padding: 72,
        fontFamily: archivo ? 'Archivo' : 'sans-serif',
      }}
    >
      {/* Kicker */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: '#5b6165',
          fontSize: 22,
          letterSpacing: 4,
        }}
      >
        <span>IDENTITY SYSTEM · SLOT ZERO</span>
        <span style={{ color: '#46e6f0' }}>READY</span>
      </div>

      {/* Lockup */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <div
            style={{
              width: 120,
              height: 120,
              border: '3px solid #46e6f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#f2f4f5',
              fontSize: 56,
              fontWeight: 800,
            }}
          >
            0
          </div>
          <div style={{ display: 'flex', fontSize: 110, fontWeight: 800, letterSpacing: -3 }}>
            <span style={{ color: '#f2f4f5' }}>PLAYER</span>
            <span style={{ color: '#46e6f0' }}>ZERO</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 40,
            color: '#c8ccce',
            fontSize: 34,
            lineHeight: 1.4,
            maxWidth: 900,
          }}
        >
          A production console for games. Describe it — play it minutes later.
        </div>
      </div>

      {/* Base rule */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', height: 2, backgroundColor: '#26292c' }}>
          <div style={{ width: 260, height: 2, backgroundColor: '#46e6f0' }} />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            color: '#5b6165',
            fontSize: 20,
            letterSpacing: 3,
          }}
        >
          <span>BUILD · PUBLISH · REMIX</span>
          <span>PHASER 2D · THREE.JS 3D</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: archivo
        ? [{ name: 'Archivo', data: archivo, style: 'normal' as const, weight: 800 as const }]
        : [],
    },
  );
}
