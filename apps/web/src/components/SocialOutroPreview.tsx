'use client';

/**
 * SocialOutroPreview — the HTML5 <canvas> renderer for the 10-second animated
 * "share card". It is a faithful canvas port of the DOM-animated Claude
 * prototype (docs/social-outro-prototype/claude-design-output/Outro.dc.html):
 * same layout constants, same `apply(t)` timeline, same easings.
 *
 * Canvas (not DOM) is required so the export pipeline can grab the backing store
 * via `canvas.captureStream()`. The backing store is ALWAYS full export
 * resolution (1080×1920 or 1080×1080); CSS scales it down to fit the wrapper so
 * the export is never degraded by the preview size.
 *
 * The component exposes an imperative handle (see `SocialOutroPreviewHandle`)
 * that the export button + modal drive: `renderAt(t)` paints exactly one frame
 * without touching the preview rAF loop; `pausePreview`/`resumePreview`/`replay`
 * control the loop.
 */

import {
  formatPromptLoops,
  formatRuntime,
  formatTokenCount,
  publicShareUrl,
} from '@/lib/social-outro';
import { BRAND_COLORS, BRAND_MARK, BRAND_NAME, BRAND_WORDMARK } from '@playforge/shared/brand';
import type { SocialOutroSummary } from '@playforge/shared/social-outro';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

export type SocialOutroFormat = '9x16' | '1x1';

export interface SocialOutroPreviewHandle {
  /** The backing canvas at full export resolution (for captureStream). */
  getCanvas(): HTMLCanvasElement | null;
  /** Draw ONE frame at time `t` (seconds, clamped to [0,10]); no loop. */
  renderAt(t: number): void;
  /** Cancel the preview rAF loop (the canvas keeps its last frame). */
  pausePreview(): void;
  /** Restart the preview rAF loop from the current time. */
  resumePreview(): void;
  /** Restart the preview loop from t=0. */
  replay(): void;
}

interface SocialOutroPreviewProps {
  summary: SocialOutroSummary;
  format: SocialOutroFormat;
  /** Applied to the wrapper; the canvas is CSS-scaled to fit inside it. */
  className?: string;
}

// ─── constants ──────────────────────────────────────────────────────────────

const DURATION = 10;
const CARD_W = 1080;
const MARGIN = 80;
const CONTENT_W = 920;

const FONT_DISPLAY = "'Space Grotesk', system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";

const COLOR_BG = BRAND_COLORS.base; // #0a0a0a
const COLOR_TEXT = BRAND_COLORS.text; // #f4f5f7
const COLOR_MUTED = BRAND_COLORS.muted; // rgba(244,245,247,.55)
const COLOR_CYAN = BRAND_COLORS.cyan; // #46e6f0
const COLOR_LIME = BRAND_COLORS.lime; // #b6f24a
const COLOR_AMBER = BRAND_COLORS.amber; // #ffb04d
const COLOR_INDIGO = BRAND_COLORS.indigo; // #7c83ff

interface Layout {
  cardW: number;
  cardH: number;
  chipTop: number;
  thumbTop: number;
  thumbH: number;
  titleTop: number;
  titleSize: number;
  metricsTop: number;
  metricSize: number;
  lockupTop: number;
  ctaH: number;
  ctaFont: number;
  urlSize: number;
}

const LAYOUTS: Record<SocialOutroFormat, Layout> = {
  '9x16': {
    cardW: CARD_W,
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
    urlSize: 26,
  },
  '1x1': {
    cardW: CARD_W,
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
    urlSize: 21,
  },
};

// ─── math helpers (exact, from the prototype) ───────────────────────────────

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const outCubic = (x: number): number => 1 - (1 - x) ** 3;
const outQuint = (x: number): number => 1 - (1 - x) ** 5;
const outBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

// ─── canvas text helpers ─────────────────────────────────────────────────────

/** Width of `text` when drawn glyph-by-glyph with `letterSpacing` between them. */
function measureSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number {
  if (text.length === 0) return 0;
  let w = 0;
  for (const ch of text) {
    w += ctx.measureText(ch).width + letterSpacing;
  }
  return w - letterSpacing;
}

/**
 * Draw `text` left-anchored at (x,y) with manual letter-spacing (canvas has no
 * reliable cross-browser letterSpacing on the 2D context). `textBaseline`
 * should already be set by the caller. Returns the x cursor after the last
 * glyph (no trailing space).
 */
function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
): number {
  let cursor = x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + letterSpacing;
  }
  ctx.textAlign = prevAlign;
  return cursor - letterSpacing;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ─── brand mark + wordmark ───────────────────────────────────────────────────

/** The P0 logomark tile: rounded square, dark fill, hairline border, "P0". */
function drawBrandMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  roundRectPath(ctx, x, y, size, size, size * 0.23);
  ctx.fillStyle = BRAND_COLORS.baseAlt; // #0a0a0c
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();

  const fontSize = size * 0.48;
  const letterSpacing = size * -0.03;
  ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const head = BRAND_MARK.head; // "P"
  const accent = BRAND_MARK.accent; // "0"
  const total = measureSpacedText(ctx, head + accent, letterSpacing);
  const cx = x + size / 2;
  const cy = y + size / 2 + size * 0.02; // small optical nudge
  let cursor = cx - total / 2;
  ctx.fillStyle = COLOR_TEXT;
  cursor = drawSpacedText(ctx, head, cursor, cy, letterSpacing) + letterSpacing;
  ctx.fillStyle = COLOR_CYAN;
  drawSpacedText(ctx, accent, cursor, cy, letterSpacing);
  ctx.restore();
}

/**
 * The "PlayerZero" wordmark (head in base tone, accent in cyan), left-anchored
 * at (x,y) on a middle baseline. Returns the x cursor after the last glyph.
 */
function drawWordmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fontSize: number,
  letterSpacing: number,
): number {
  ctx.save();
  ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR_TEXT;
  let cursor = drawSpacedText(ctx, BRAND_WORDMARK.head, x, y, letterSpacing) + letterSpacing;
  ctx.fillStyle = COLOR_CYAN;
  cursor = drawSpacedText(ctx, BRAND_WORDMARK.accent, cursor, y, letterSpacing);
  ctx.restore();
  return cursor;
}

// ─── derived metric targets ──────────────────────────────────────────────────

interface MetricTargets {
  runtimeSec: number;
  promptCount: number;
  tokenMantissa: number;
  tokenSuffix: string;
  tokenFinal: string;
}

/** Pre-compute the count-up targets from the summary metrics. */
function deriveMetrics(summary: SocialOutroSummary): MetricTargets {
  const runtimeSec = Math.max(0, Math.floor(summary.metrics.aiRuntimeMs / 1000));
  const promptCount = Math.max(0, Math.round(summary.metrics.promptLoops));
  const tokenFinal = formatTokenCount(summary.metrics.totalTokens);
  // Split the formatted token string into mantissa + K/M suffix so the count-up
  // animates the mantissa and appends the suffix (e.g. "428" + "K", "1.3" + "M").
  const match = tokenFinal.match(/^([\d.]+)([KM]?)$/);
  const tokenMantissa = match ? Number.parseFloat(match[1] ?? '0') : 0;
  const tokenSuffix = match ? (match[2] ?? '') : '';
  return { runtimeSec, promptCount, tokenMantissa, tokenSuffix, tokenFinal };
}

// ─── the frame painter ───────────────────────────────────────────────────────

interface DrawContext {
  ctx: CanvasRenderingContext2D;
  L: Layout;
  summary: SocialOutroSummary;
  metrics: MetricTargets;
  thumb: HTMLImageElement | null;
  displayUrl: string | null;
}

/** Background grid: faint white lines on a ~92px cell, radial-masked to center-top. */
function drawGrid(d: DrawContext, opacity: number): void {
  if (opacity <= 0) return;
  const { ctx, L } = d;
  ctx.save();
  // Radial mask: closest-side at 50% 36%, opaque to 50% then fading to transparent.
  const cx = L.cardW / 2;
  const cy = L.cardH * 0.36;
  const radius = Math.min(cx, cy, L.cardW - cx, L.cardH - cy);
  const grad = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, radius);
  grad.addColorStop(0, `rgba(255,255,255,${0.04 * opacity})`);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1;
  const cell = 92;
  ctx.beginPath();
  for (let x = 0; x <= L.cardW; x += cell) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, L.cardH);
  }
  for (let y = 0; y <= L.cardH; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(L.cardW, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Cyan glow behind the thumbnail area. */
function drawGlow(d: DrawContext, opacity: number): void {
  if (opacity <= 0) return;
  const { ctx, L } = d;
  ctx.save();
  ctx.globalAlpha = opacity;
  const cx = L.cardW / 2;
  const cy = L.thumbTop + L.thumbH / 2;
  const radius = Math.max(L.thumbH, 780) * 0.62;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, 'rgba(70,230,240,0.18)');
  grad.addColorStop(0.75, 'rgba(70,230,240,0)');
  grad.addColorStop(1, 'rgba(70,230,240,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, L.cardW, L.cardH);
  ctx.restore();
}

/** Vignette: dark toward the edges. */
function drawVignette(d: DrawContext): void {
  const { ctx, L } = d;
  ctx.save();
  const cx = L.cardW / 2;
  const cy = L.cardH * 0.4;
  const radius = Math.min(cx, cy);
  const grad = ctx.createRadialGradient(cx, cy, radius * 0.58, cx, cy, radius);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, L.cardW, L.cardH);
  ctx.restore();
}

/** Top brand chip: P0 mark + "BUILT WITH PlayerZero". */
function drawChip(d: DrawContext, opacity: number): void {
  if (opacity <= 0) return;
  const { ctx, L } = d;
  ctx.save();
  ctx.globalAlpha = opacity;
  const markSize = 46;
  const y = L.chipTop;
  drawBrandMark(ctx, MARGIN, y, markSize);
  ctx.font = `400 19px ${FONT_MONO}`;
  ctx.fillStyle = COLOR_MUTED;
  ctx.textBaseline = 'middle';
  drawSpacedText(ctx, `BUILT WITH ${BRAND_NAME}`, MARGIN + markSize + 14, y + markSize / 2, 4);
  ctx.restore();
}

/** Cover-draw an image into a box (object-fit: cover) with an optional scale. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw === 0 || ih === 0) return;
  const boxRatio = w / h;
  const imgRatio = iw / ih;
  let dw = w * scale;
  let dh = h * scale;
  if (imgRatio > boxRatio) {
    dh = h * scale;
    dw = dh * imgRatio;
  } else {
    dw = w * scale;
    dh = dw / imgRatio;
  }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** Thumbnail placeholder: diagonal hatch + "GAMEPLAY FRAME". */
function drawThumbPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.fillStyle = '#0d0d10';
  ctx.fillRect(x, y, w, h);
  // 45-degree hatch: lines every 15px, 2px wide.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = -h; i < w + h; i += 15) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
  }
  ctx.stroke();
  ctx.restore();

  ctx.font = `400 23px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(244,245,247,0.42)';
  ctx.textBaseline = 'middle';
  const cx = x + w / 2;
  const label = 'GAMEPLAY FRAME';
  const labelW = measureSpacedText(ctx, label, 5);
  drawSpacedText(ctx, label, cx - labelW / 2, y + h / 2, 5);
  ctx.restore();
}

/** The hero thumbnail frame + the fading-out capture overlays + corner brackets. */
function drawThumb(d: DrawContext, t: number): void {
  const { ctx, L, thumb } = d;
  const x = MARGIN;
  const y = L.thumbTop;
  const w = CONTENT_W;
  const h = L.thumbH;

  ctx.save();
  // Frame clip + bg.
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#111111';
  ctx.fillRect(x, y, w, h);

  const innerScale = lerp(1.06, 1.0, outCubic(seg(t, 0, 1.5)));
  if (thumb && (thumb.naturalWidth || thumb.width) > 0) {
    drawCover(ctx, thumb, x, y, w, h, innerScale);
  } else {
    // Placeholder scales with the inner transform too.
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(innerScale, innerScale);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    drawThumbPlaceholder(ctx, x, y, w, h);
    ctx.restore();
  }

  // Scanlines (fade out 0.2..1.1).
  const scanOp = lerp(0.5, 0, seg(t, 0.2, 1.1));
  if (scanOp > 0) {
    ctx.save();
    ctx.globalAlpha = scanOp;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    for (let ly = y; ly < y + h; ly += 4) {
      ctx.fillRect(x, ly, w, 1);
    }
    ctx.restore();
  }

  // HUD: red dot + "BUILD CAPTURE" (fade out 0.3..1.1).
  const hudOp = 1 - seg(t, 0.3, 1.1);
  if (hudOp > 0) {
    ctx.save();
    ctx.globalAlpha = hudOp;
    const hx = x + 20;
    const hy = y + 20 + 8; // baseline-ish center
    ctx.fillStyle = '#ff5d57';
    ctx.beginPath();
    ctx.arc(hx + 4.5, hy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `400 16px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.textBaseline = 'middle';
    drawSpacedText(ctx, 'BUILD CAPTURE', hx + 9 + 9, hy, 2);
    ctx.restore();
  }

  // Center play circle (fade out 0..0.9 while scaling 1 -> 1.45).
  const pf = seg(t, 0, 0.9);
  const playOp = 1 - pf;
  if (playOp > 0) {
    ctx.save();
    ctx.globalAlpha = playOp;
    const pcx = x + w / 2;
    const pcy = y + h / 2;
    const pscale = lerp(1, 1.45, pf);
    const ringR = (118 / 2) * pscale;
    ctx.fillStyle = 'rgba(10,10,10,0.5)';
    ctx.beginPath();
    ctx.arc(pcx, pcy, ringR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * pscale;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
    // Triangle (points right), nudged right like the prototype's margin-left:9.
    const tw = 36 * pscale;
    const thh = 23 * pscale;
    const triX = pcx - tw / 2 + 9 * pscale;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(triX, pcy - thh);
    ctx.lineTo(triX, pcy + thh);
    ctx.lineTo(triX + tw, pcy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Cyan progress bar bottom (62% filled, fade out 0.5..1.1).
  const vbarOp = 1 - seg(t, 0.5, 1.1);
  if (vbarOp > 0) {
    ctx.save();
    ctx.globalAlpha = vbarOp;
    const bx = x + 26;
    const bw = w - 52;
    const bh = 6;
    const by = y + h - 26 - bh;
    roundRectPath(ctx, bx, by, bw, bh, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fill();
    roundRectPath(ctx, bx, by, bw * 0.62, bh, 3);
    ctx.fillStyle = COLOR_CYAN;
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // end frame clip

  // Cyan corner brackets — drawn OUTSIDE the clip (they sit at 16px inset).
  // Each: opacity seg(a, a+.3), scale 0.5 -> 1 outBack seg(a, a+.55), a = 0.6 + i*0.07.
  const bracketLen = 42;
  const inset = 16;
  const corners: Array<{ cx: number; cy: number; sx: number; sy: number }> = [
    { cx: x + inset, cy: y + inset, sx: 1, sy: 1 }, // top-left
    { cx: x + w - inset, cy: y + inset, sx: -1, sy: 1 }, // top-right
    { cx: x + inset, cy: y + h - inset, sx: 1, sy: -1 }, // bottom-left
    { cx: x + w - inset, cy: y + h - inset, sx: -1, sy: -1 }, // bottom-right
  ];
  corners.forEach((c, i) => {
    const a = 0.6 + i * 0.07;
    const op = seg(t, a, a + 0.3);
    if (op <= 0) return;
    const s = lerp(0.5, 1, outBack(seg(t, a, a + 0.55)));
    ctx.save();
    ctx.globalAlpha = op;
    ctx.translate(c.cx, c.cy);
    ctx.scale(c.sx * s, c.sy * s);
    ctx.strokeStyle = COLOR_CYAN;
    ctx.lineWidth = 3;
    ctx.lineCap = 'square';
    ctx.beginPath();
    // L-shape opening toward the frame interior (origin at the outer corner).
    ctx.moveTo(0, bracketLen);
    ctx.lineTo(0, 0);
    ctx.lineTo(bracketLen, 0);
    ctx.stroke();
    ctx.restore();
  });

  ctx.restore();
}

/** Word-wrap `text` into up to `maxLines` lines for the given font, shrinking the
 *  font size until it fits. Returns the chosen lines + font size. */
function layoutTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  baseSize: number,
  letterSpacing: number,
  maxLines: number,
): { lines: string[]; fontSize: number } {
  let fontSize = baseSize;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureSpacedText(ctx, candidate, letterSpacing) <= maxWidth || current === '') {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    const fits =
      lines.length <= maxLines &&
      lines.every((l) => measureSpacedText(ctx, l, letterSpacing) <= maxWidth);
    if (fits || fontSize <= baseSize * 0.55) {
      // If still over the line budget, truncate the last visible line with an ellipsis.
      if (lines.length > maxLines) {
        const kept = lines.slice(0, maxLines);
        let last = kept[maxLines - 1] ?? '';
        while (last.length > 1 && measureSpacedText(ctx, `${last}…`, letterSpacing) > maxWidth) {
          last = last.slice(0, -1);
        }
        kept[maxLines - 1] = `${last.trimEnd()}…`;
        return { lines: kept, fontSize };
      }
      return { lines, fontSize };
    }
    fontSize = Math.round(fontSize * 0.92);
  }
  return { lines: [text], fontSize };
}

/** Title reveal (clip + translateY) + cyan underline. */
function drawTitle(d: DrawContext, t: number): void {
  const { ctx, L, summary } = d;
  const x = MARGIN;
  const boxTop = L.titleTop;
  const letterSpacing = -2;
  const lineHeight = 1.0;

  const { lines, fontSize } = layoutTitle(
    ctx,
    summary.project.name,
    CONTENT_W,
    L.titleSize,
    letterSpacing,
    2,
  );
  const blockH = lines.length * fontSize * lineHeight;
  // Reveal: clip to the text box, translateY 115% -> 0 (% of the block height).
  const reveal = outQuint(seg(t, 1.5, 2.65));
  const translate = lerp(blockH * 1.15, 0, reveal);

  ctx.save();
  // Clip box: title block + a little padding-bottom (8px in the prototype).
  ctx.beginPath();
  ctx.rect(x, boxTop, CONTENT_W, blockH + 8);
  ctx.clip();
  ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLOR_TEXT;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const baseline = boxTop + translate + (i + 1) * fontSize * lineHeight - fontSize * 0.22;
    drawSpacedText(ctx, line, x, baseline, letterSpacing);
  });
  ctx.restore();

  // Underline: 5px tall, 170px wide, scaleX 0 -> 1 from the left, 20px below block.
  const ulScale = outCubic(seg(t, 2.3, 3.0));
  if (ulScale > 0) {
    const ulY = boxTop + blockH + 8 + 20;
    ctx.save();
    ctx.fillStyle = COLOR_CYAN;
    ctx.fillRect(x, ulY, 170 * ulScale, 5);
    ctx.restore();
  }
}

interface MetricColumn {
  value: string;
  label: string;
}

/** The 3-column metrics row with staggered entrances + count-ups. */
function drawMetrics(d: DrawContext, t: number): void {
  const { ctx, L, metrics } = d;
  const x = MARGIN;
  const top = L.metricsTop;
  const colW = CONTENT_W / 3;

  // Count-up values.
  const runP = outCubic(seg(t, 3.0, 4.1));
  const runSec = Math.round(lerp(0, metrics.runtimeSec, runP));
  const runText = formatRuntime(runSec * 1000);

  const promptP = seg(t, 4.1, 4.9);
  const promptN = Math.round(lerp(0, metrics.promptCount, promptP));
  const promptText = String(promptN);

  const tokenP = seg(t, 5.2, 6.4);
  let tokenText: string;
  if (t >= 6.4) {
    tokenText = metrics.tokenFinal;
  } else {
    const mant = lerp(0, metrics.tokenMantissa, outCubic(tokenP));
    const rounded = metrics.tokenSuffix === 'M' ? Math.round(mant * 10) / 10 : Math.round(mant);
    const mantText =
      metrics.tokenSuffix === 'M' ? String(rounded).replace(/\.0$/, '') : String(rounded);
    tokenText = `${mantText}${metrics.tokenSuffix}`;
  }

  const columns: Array<{ col: MetricColumn; color: string; start: number }> = [
    { col: { value: runText, label: 'AI RUNTIME' }, color: COLOR_CYAN, start: 3.0 },
    { col: { value: promptText, label: 'PROMPTS' }, color: COLOR_LIME, start: 4.1 },
    { col: { value: tokenText, label: 'TOKENS' }, color: COLOR_AMBER, start: 5.2 },
  ];

  columns.forEach(({ col, color, start }, i) => {
    const op = seg(t, start, start + 0.3);
    if (op <= 0) return;
    const ease = outBack(seg(t, start, start + 0.6));
    const ty = lerp(42, 0, ease);
    const sc = lerp(0.9, 1, ease);
    const centerX = x + colW * i + colW / 2;

    ctx.save();
    ctx.globalAlpha = op;
    // translateY + scale about the column center-top.
    ctx.translate(centerX, top + ty);
    ctx.scale(sc, sc);
    ctx.translate(-centerX, -top);

    // Tick (26x3) above the value.
    ctx.fillStyle = color;
    ctx.fillRect(centerX - 13, top, 26, 3);

    // Value (big mono, ls -1), baseline below the tick.
    ctx.font = `700 ${L.metricSize}px ${FONT_MONO}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    const valueY = top + 16 + L.metricSize * 0.82;
    const valueW = measureSpacedText(ctx, col.value, -1);
    drawSpacedText(ctx, col.value, centerX - valueW / 2, valueY, -1);

    // Label (17px mono, ls3, muted), 14px below the value.
    ctx.font = `400 17px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(244,245,247,0.5)';
    const labelY = valueY + 14 + 14;
    const labelW = measureSpacedText(ctx, col.label, 3);
    drawSpacedText(ctx, col.label, centerX - labelW / 2, labelY, 3);

    ctx.restore();
  });
}

/** The final lockup: two CTA buttons + url chip + wordmark. */
function drawLockup(d: DrawContext, t: number): void {
  const { ctx, L, displayUrl } = d;
  const op = seg(t, 8.5, 8.95);
  if (op <= 0) return;
  const ty = lerp(42, 0, outQuint(seg(t, 8.5, 9.35)));
  const x = MARGIN;
  const top = L.lockupTop + ty;

  ctx.save();
  ctx.globalAlpha = op;

  // Two CTA buttons side by side, gap 18.
  const gap = 18;
  const btnW = (CONTENT_W - gap) / 2;
  const btnH = L.ctaH;

  // Filled: "▶ Play it now".
  roundRectPath(ctx, x, top, btnW, btnH, 9);
  ctx.fillStyle = COLOR_CYAN;
  ctx.fill();
  ctx.fillStyle = '#06181a';
  ctx.font = `600 ${L.ctaFont}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('▶ Play it now', x + btnW / 2, top + btnH / 2);

  // Outline: "↻ Remix it".
  const x2 = x + btnW + gap;
  roundRectPath(ctx, x2, top, btnW, btnH, 9);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText('↻ Remix it', x2 + btnW / 2, top + btnH / 2);
  ctx.textAlign = 'left';

  // Row below (margin-top 24).
  const rowY = top + btnH + 24 + L.urlSize / 2 + 6;
  // Left: indigo ↗ + display url (omit entirely if null).
  if (displayUrl) {
    ctx.font = `400 ${L.urlSize}px ${FONT_MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_INDIGO;
    ctx.fillText('↗', x, rowY);
    const arrowW = ctx.measureText('↗').width;
    ctx.fillStyle = 'rgba(244,245,247,0.72)';
    ctx.fillText(displayUrl, x + arrowW + 11, rowY);
  }

  // Right (margin-left auto): P0 mark (40px) + "PlayerZero" wordmark.
  const markSize = 40;
  const wmFont = 30;
  const wmLs = -1;
  ctx.font = `700 ${wmFont}px ${FONT_DISPLAY}`;
  const wmW = measureSpacedText(ctx, BRAND_WORDMARK.head + BRAND_WORDMARK.accent, wmLs);
  const rightBlockW = markSize + 13 + wmW;
  const rightX = x + CONTENT_W - rightBlockW;
  const markY = rowY - markSize / 2;
  drawBrandMark(ctx, rightX, markY, markSize);
  drawWordmark(ctx, rightX + markSize + 13, rowY, wmFont, wmLs);

  ctx.restore();
}

/** The full-card brand-beat overlay: "THIS GAME WAS MADE BY" + big lockup. */
function drawBrandBeat(d: DrawContext, t: number): void {
  const { ctx, L } = d;
  const overlayOp = clamp01(seg(t, 6.4, 6.9) - seg(t, 8.2, 8.7));
  if (overlayOp <= 0) return;

  ctx.save();
  ctx.globalAlpha = overlayOp;
  ctx.fillStyle = 'rgba(8,8,9,0.92)';
  ctx.fillRect(0, 0, L.cardW, L.cardH);
  ctx.restore();

  const cx = L.cardW / 2;
  const cy = L.cardH / 2;

  // "THIS GAME WAS MADE BY" — its own fade window.
  const txtOp = clamp01(seg(t, 6.6, 7.1) - seg(t, 8.2, 8.6));
  if (txtOp > 0) {
    ctx.save();
    ctx.globalAlpha = txtOp;
    ctx.font = `400 27px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(244,245,247,0.6)';
    ctx.textBaseline = 'middle';
    const label = 'THIS GAME WAS MADE BY';
    const w = measureSpacedText(ctx, label, 9);
    drawSpacedText(ctx, label, cx - w / 2, cy - 110, 9);
    ctx.restore();
  }

  // Big lockup: P0 mark (180) + "PlayerZero" (106px, ls -3); scale .4->1 + rotate -10->0.
  const scale = lerp(0.4, 1, outBack(seg(t, 6.55, 7.2)));
  const rotate = lerp(-10, 0, outCubic(seg(t, 6.55, 7.4))) * (Math.PI / 180);
  ctx.save();
  ctx.globalAlpha = overlayOp;
  const markSize = 180;
  const wmFont = 106;
  const wmLs = -3;
  const gap = 36;
  ctx.font = `700 ${wmFont}px ${FONT_DISPLAY}`;
  const wmW = measureSpacedText(ctx, BRAND_WORDMARK.head + BRAND_WORDMARK.accent, wmLs);
  const blockW = markSize + gap + wmW;
  const lockupCY = cy + 30;
  ctx.translate(cx, lockupCY);
  ctx.rotate(rotate);
  ctx.scale(scale, scale);
  // Draw centered around origin.
  const startX = -blockW / 2;
  drawBrandMark(ctx, startX, -markSize / 2, markSize);
  drawWordmark(ctx, startX + markSize + gap, 0, wmFont, wmLs);
  ctx.restore();
}

/** Paint exactly one frame at time `t` (the single source of truth for drawing). */
function drawFrame(d: DrawContext, tRaw: number): void {
  const { ctx, L } = d;
  const t = Math.max(0, Math.min(DURATION, tRaw));

  // Card background.
  ctx.save();
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, L.cardW, L.cardH);
  ctx.restore();

  // Bottom-up layers.
  drawGrid(d, seg(t, 0, 1.2));
  drawGlow(d, seg(t, 0, 1.4));
  drawVignette(d);
  drawChip(d, seg(t, 0.3, 1.0));
  drawThumb(d, t);
  drawTitle(d, t);
  drawMetrics(d, t);
  drawLockup(d, t);
  drawBrandBeat(d, t);
}

// ─── component ───────────────────────────────────────────────────────────────

const SocialOutroPreview = forwardRef<SocialOutroPreviewHandle, SocialOutroPreviewProps>(
  ({ summary, format, className }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const timeRef = useRef(0);
    const lastTsRef = useRef<number | null>(null);
    const thumbRef = useRef<HTMLImageElement | null>(null);

    // Stable refs to the latest props so the rAF loop never goes stale.
    const summaryRef = useRef(summary);
    const formatRef = useRef(format);
    summaryRef.current = summary;
    formatRef.current = format;

    // All of these only read refs, so they are referentially stable (empty deps)
    // — which lets the rAF loop, effects, and the imperative handle share them
    // without going stale and without re-subscribing.
    const paint = useCallback((t: number): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const L = LAYOUTS[formatRef.current];
      const s = summaryRef.current;
      const d: DrawContext = {
        ctx,
        L,
        summary: s,
        metrics: deriveMetrics(s),
        thumb: thumbRef.current,
        displayUrl: publicShareUrl(s.share.publishUrl),
      };
      drawFrame(d, t);
    }, []);

    const stopLoop = useCallback((): void => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
    }, []);

    const startLoop = useCallback((): void => {
      if (rafRef.current != null) return; // already running
      lastTsRef.current = null;
      const tick = (ts: number): void => {
        if (lastTsRef.current == null) lastTsRef.current = ts;
        const dt = (ts - lastTsRef.current) / 1000;
        lastTsRef.current = ts;
        let t = timeRef.current + dt;
        if (t >= DURATION) t -= DURATION;
        timeRef.current = t;
        paint(t);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }, [paint]);

    useImperativeHandle(
      ref,
      (): SocialOutroPreviewHandle => ({
        getCanvas: () => canvasRef.current,
        renderAt: (t: number) => {
          // Single frame, independent of the loop. Does NOT auto-resume.
          const clamped = Math.max(0, Math.min(DURATION, t));
          timeRef.current = clamped;
          paint(clamped);
        },
        pausePreview: () => stopLoop(),
        resumePreview: () => startLoop(),
        replay: () => {
          timeRef.current = 0;
          stopLoop();
          paint(0);
          startLoop();
        },
      }),
      [paint, stopLoop, startLoop],
    );

    // Load the thumbnail image whenever the source changes.
    useEffect(() => {
      const url = summary.share.thumbnailUrl;
      if (!url) {
        thumbRef.current = null;
        paint(timeRef.current);
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous'; // keep the export canvas untainted
      let cancelled = false;
      img.onload = () => {
        if (cancelled) return;
        thumbRef.current = img;
        paint(timeRef.current);
      };
      img.onerror = () => {
        if (cancelled) return;
        thumbRef.current = null; // fall back to the placeholder
        paint(timeRef.current);
      };
      img.src = url;
      return () => {
        cancelled = true;
      };
    }, [summary.share.thumbnailUrl, paint]);

    // Wait for the brand fonts, then (re)start the preview. Draw a fallback frame
    // immediately so the canvas is never blank, then redraw once fonts resolve.
    useEffect(() => {
      let cancelled = false;
      paint(timeRef.current); // immediate fallback-font frame
      startLoop();

      const markReady = (): void => {
        if (cancelled) return;
        paint(timeRef.current); // redraw with real fonts
      };

      if (typeof document !== 'undefined' && 'fonts' in document) {
        const wanted = [
          '700 84px "Space Grotesk"',
          '400 19px "JetBrains Mono"',
          '700 64px "JetBrains Mono"',
        ];
        Promise.all([
          document.fonts.ready,
          ...wanted.map((f) => document.fonts.load(f).catch(() => undefined)),
        ])
          .then(markReady)
          .catch(markReady);
      }

      return () => {
        cancelled = true;
        stopLoop();
      };
    }, [paint, startLoop, stopLoop]);

    // Redraw immediately when format or summary changes; reset to t=0 on format change.
    const prevFormatRef = useRef(format);
    useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas) {
        const L = LAYOUTS[format];
        if (canvas.width !== L.cardW || canvas.height !== L.cardH) {
          canvas.width = L.cardW;
          canvas.height = L.cardH;
        }
      }
      if (prevFormatRef.current !== format) {
        prevFormatRef.current = format;
        timeRef.current = 0;
        lastTsRef.current = null;
      }
      // Point the loop's stable ref at the freshest props before repainting, so
      // a new summary (or format) is reflected on the very next frame.
      summaryRef.current = summary;
      formatRef.current = format;
      paint(timeRef.current);
    }, [format, summary, paint]);

    const L = LAYOUTS[format];

    return (
      <div className={className}>
        <canvas
          ref={canvasRef}
          width={L.cardW}
          height={L.cardH}
          aria-label={`Animated share card for ${summary.project.name}, built with ${BRAND_NAME}`}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            aspectRatio: `${L.cardW} / ${L.cardH}`,
            margin: '0 auto',
            borderRadius: 14,
          }}
        />
      </div>
    );
  },
);

SocialOutroPreview.displayName = 'SocialOutroPreview';

// Exported both ways on purpose: the modal + export-button wiring import the
// named `SocialOutroPreview`, while `default` keeps it ergonomic for any
// dynamic import. Both reference the same forwardRef component.
export { SocialOutroPreview };
export default SocialOutroPreview;
