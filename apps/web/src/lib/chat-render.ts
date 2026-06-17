/**
 * Build-log render coalescing (#51). Consecutive `text_delta` events are merged
 * into a single `text` render group with a stable key so a streamed assistant
 * turn renders as one bubble that grows, instead of N index-keyed spans that
 * re-key on every delta. Pure + exported so it can be unit-tested (#16).
 */

import type { SseEvent } from './types';

export type RenderItem =
  | { kind: 'event'; key: string; event: SseEvent }
  | { kind: 'text'; key: string; text: string };

export function buildRenderItems(events: SseEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  let textRunStart = -1;
  let textRunValue = '';

  const flushText = () => {
    if (textRunStart >= 0) {
      // Stable key: the index where this coalesced run began. Appends extend the
      // same run, so the key is stable across re-renders within the turn.
      items.push({ kind: 'text', key: `text-${textRunStart}`, text: textRunValue });
      textRunStart = -1;
      textRunValue = '';
    }
  };

  events.forEach((event, i) => {
    if (event.type === 'text_delta') {
      if (textRunStart < 0) textRunStart = i;
      textRunValue += event.delta;
      return;
    }
    flushText();
    items.push({ kind: 'event', key: `ev-${i}`, event });
  });
  flushText();

  return items;
}
