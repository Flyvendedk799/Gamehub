/**
 * Just enough markdown for the agent's replies: paragraphs, bullet lists, **bold** and `code`.
 *
 * The reply is model-written text, so it is parsed into plain data and drawn by React as elements;
 * nothing here ever produces HTML, so there is nothing to sanitise and nothing to inject.
 */

export interface Inline {
  type: 'text' | 'bold' | 'code';
  text: string;
}

export type Block = { type: 'paragraph'; inline: Inline[] } | { type: 'list'; items: Inline[][] };

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    if (match[1] !== undefined) out.push({ type: 'bold', text: match[1] });
    else if (match[2] !== undefined) out.push({ type: 'code', text: match[2] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;

export function parseMarkdownLite(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Inline[][] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ type: 'list', items: list });
      list = null;
    }
  };

  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      list ??= [];
      list.push(parseInline(bullet[1] ?? ''));
      continue;
    }
    // A heading is just emphasis here: the chat has no document structure.
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    flushList();
    if (heading !== null) {
      flushParagraph();
      blocks.push({ type: 'paragraph', inline: [{ type: 'bold', text: heading[1] ?? '' }] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
