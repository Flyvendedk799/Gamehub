import { describe, expect, it } from 'vitest';
import { makeAskUserTool } from './ask-user';

describe('ask_user tool (WS-D)', () => {
  it('fires the host callback with the trimmed question + echoes it in details', async () => {
    let asked: string | null = null;
    const tool = makeAskUserTool((q) => {
      asked = q;
    });
    const result = await tool.execute('c1', { question: '  Endless or a finish line?  ' });
    expect(asked).toBe('Endless or a finish line?');
    expect(result.details.question).toBe('Endless or a finish line?');
    const first = result.content[0];
    expect(first && 'text' in first ? first.text : '').toMatch(/PAUSE/);
  });

  it('is inert (no throw) when no host callback is wired', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute('c1', { question: 'How many levels?' });
    expect(result.details.question).toBe('How many levels?');
  });
});
