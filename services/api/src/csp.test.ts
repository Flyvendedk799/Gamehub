import { describe, expect, it } from 'vitest';
import { gameContentCsp } from './server';

/** The served-game CSP is the real anti-exfil boundary. These lock in the two
 *  fixes for the preview console violations (Google Fonts + same-origin <base>)
 *  WITHOUT loosening the exfil-relevant directives. */
describe('gameContentCsp', () => {
  for (const mode of ['preview-multifile', 'single-file'] as const) {
    describe(mode, () => {
      const csp = gameContentCsp('*', mode);

      it('allows Google Fonts (render-only) for premium typography', () => {
        expect(csp).toContain('https://fonts.googleapis.com'); // the <link> stylesheet
        expect(csp).toContain('https://fonts.gstatic.com'); // the @font-face files
        // The font hosts must be on style-src/font-src, never on an exfil channel.
        const styleSrc = csp.split('; ').find((d) => d.startsWith('style-src')) ?? '';
        const fontSrc = csp.split('; ').find((d) => d.startsWith('font-src')) ?? '';
        expect(styleSrc).toContain('https://fonts.googleapis.com');
        expect(fontSrc).toContain('https://fonts.gstatic.com');
      });

      it('allows a SAME-ORIGIN <base> but no cross-origin base hijack', () => {
        expect(csp).toContain("base-uri 'self'");
        expect(csp).not.toContain("base-uri 'none'");
      });

      it('keeps the exfil channels locked (no wildcards on connect/img/script)', () => {
        const get = (d: string) => csp.split('; ').find((x) => x.startsWith(d)) ?? '';
        // No font host leaked onto an exfil-capable directive.
        expect(get('connect-src')).not.toContain('fonts.g');
        expect(get('img-src')).not.toContain('fonts.g');
        expect(get('img-src')).not.toContain('*');
        expect(get('connect-src')).not.toContain('*');
        expect(csp).toContain("default-src 'none'");
      });
    });
  }

  it('published single-file games stay connect-src locked; preview is same-origin only', () => {
    expect(gameContentCsp('*', 'single-file')).toContain("connect-src 'none'");
    expect(gameContentCsp('*', 'preview-multifile')).toContain("connect-src 'self'");
  });
});
