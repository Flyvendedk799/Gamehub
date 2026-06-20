import { BRAND_COLORS, BRAND_FONTS, BRAND_MARK, BRAND_WORDMARK } from '@playforge/shared/brand';

/**
 * PlayerZero brand primitives — one source of truth for the logo across the app.
 * `BrandMark` is the rounded-square "P0" tile; `Wordmark` is "Player" + cyan
 * "Zero"; `Logo` is the mark + wordmark lockup. Colors/typography come from the
 * shared brand tokens so the site can never drift from the brand.
 */

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        background: BRAND_COLORS.baseAlt,
        border: '1px solid rgba(255,255,255,0.1)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        fontFamily: BRAND_FONTS.display,
        fontWeight: 700,
        fontSize: size * 0.48,
        lineHeight: 1,
        letterSpacing: size * -0.03,
        color: BRAND_COLORS.text,
        userSelect: 'none',
      }}
    >
      {BRAND_MARK.head}
      <span style={{ color: BRAND_COLORS.cyan }}>{BRAND_MARK.accent}</span>
    </span>
  );
}

/** "Player" (inherits the surrounding text color) + cyan "Zero". Size comes from
 *  the parent via `className` (font-size); weight + tracking are brand-fixed. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={className}
      style={{ fontFamily: BRAND_FONTS.display, fontWeight: 700, letterSpacing: '-0.02em' }}
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
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BrandMark size={markSize} />
      <Wordmark className={wordmarkClassName} />
    </span>
  );
}
