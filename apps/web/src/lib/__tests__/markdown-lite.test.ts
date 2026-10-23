import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdownLite } from '../markdown-lite';

describe('parseInline', () => {
  it('finds bold and code spans and keeps the text between them', () => {
    expect(parseInline('Hits now **stagger** the enemy via `hitReaction`.')).toEqual([
      { type: 'text', text: 'Hits now ' },
      { type: 'bold', text: 'stagger' },
      { type: 'text', text: ' the enemy via ' },
      { type: 'code', text: 'hitReaction' },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves unmatched markers alone', () => {
    expect(parseInline('a ** b')).toEqual([{ type: 'text', text: 'a ** b' }]);
  });
});

describe('parseMarkdownLite', () => {
  it('reads the host summary shape: bullets', () => {
    const blocks = parseMarkdownLite('- Strikes chain into a combo.\n- Parries slow time.');
    expect(blocks).toEqual([
      {
        type: 'list',
        items: [
          [{ type: 'text', text: 'Strikes chain into a combo.' }],
          [{ type: 'text', text: 'Parries slow time.' }],
        ],
      },
    ]);
  });

  it('joins wrapped lines into one paragraph and splits on blank lines', () => {
    const blocks = parseMarkdownLite('First line\nstill first.\n\nSecond paragraph.');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'text', text: 'First line still first.' }],
    });
  });

  it('mixes a lead-in sentence with a list', () => {
    const blocks = parseMarkdownLite('Here is what changed:\n\n* One\n• Two');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
    expect(blocks[1]).toMatchObject({ type: 'list' });
    if (blocks[1]?.type === 'list') expect(blocks[1].items).toHaveLength(2);
  });

  it('turns a heading into emphasis, and never produces markup from raw html', () => {
    const blocks = parseMarkdownLite('## What I chose\n<script>alert(1)</script>');
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'bold', text: 'What I chose' }],
    });
    // The tag is just text: React will draw it as characters, not as an element.
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'text', text: '<script>alert(1)</script>' }],
    });
  });

  it('returns nothing for empty text', () => {
    expect(parseMarkdownLite('')).toEqual([]);
    expect(parseMarkdownLite('   \n\n')).toEqual([]);
  });
});
