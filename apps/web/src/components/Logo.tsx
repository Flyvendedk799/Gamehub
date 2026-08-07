import { BRAND_COLORS, BRAND_FONTS, BRAND_MARK, BRAND_WORDMARK } from '@playforge/shared/brand';

/**
 * PlayerZero brand primitives — one source of truth for the logo across the app.
 * `BrandMark` is direction A "Slot Zero" from the identity board: a sharp square
 * with a signal-cyan hairline frame holding a lone "0" — the empty slot you
 * build from. `Wordmark` is "PLAYER" + cyan "ZERO" in Archivo Expanded 800;
 * `Logo` is the mark + wordmark lockup. Colors/typography come from the shared
 * brand tokens so the site can never drift from the brand.
 */

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width: size,
        height: size,
        border: `${Math.max(1, size * 0.025)}px solid ${BRAND_COLORS.cyan}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        fontFamily: BRAND_FONTS.display,
        fontWeight: 800,
        fontStretch: '112%',
        fontSize: size * 0.43,
        lineHeight: 1,
        color: BRAND_COLORS.text,
        userSelect: 'none',
      }}
    >
      {BRAND_MARK.glyph}
    </span>
  );
}

/** "PLAYER" (inherits the surrounding text color) + cyan "ZERO", uppercase in
 *  Archivo Expanded. Size comes from the parent via `className` (font-size);
 *  weight + width + tracking are brand-fixed. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        fontFamily: BRAND_FONTS.display,
        fontWeight: 800,
        fontStretch: '118%',
        letterSpacing: '-0.03em',
        textTransform: 'uppercase',
      }}
    >
      {BRAND_WORDMARK.head}
      <span style={{ color: BRAND_COLORS.cyan }}>{BRAND_WORDMARK.accent}</span>
    </span>
  );
}

export function Logo({
  markSize = 28,
  className = '',
  wordmarkClassName = '',
}: {
  markSize?: number;
  className?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark size={markSize} />
      <Wordmark className={wordmarkClassName} />
    </span>
  );
}
