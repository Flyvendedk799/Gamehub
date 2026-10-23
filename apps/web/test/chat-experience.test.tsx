// @vitest-environment jsdom
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/components/ChatPanel';
import { TRANSPORT_LOST_MESSAGE } from '../src/lib/event-normalize';
import type { SseEvent } from '../src/lib/types';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const userMsg = (text: string, t = 0): SseEvent => ({
  type: 'user_message',
  runId: 'r1',
  content: text,
  timestamp: at(t),
});
const step = (label: string, t: number): SseEvent => ({
  type: 'progress',
  runId: 'r1',
  label,
  timestamp: at(t),
});
const summary = (text: string, t: number, files?: string[]): SseEvent => ({
  type: 'summary',
  runId: 'r1',
  text,
  timestamp: at(t),
  ...(files !== undefined ? { files } : {}),
});
const complete = (t: number, quality: unknown = null): SseEvent =>
  ({
    type: 'run_complete',
    runId: 'r1',
    snapshotPath: '',
    previewUrl: '/p',
    quality,
    timestamp: at(t),
  }) as SseEvent;

const NOOP = () => {};
const mount = async (
  props: Partial<React.ComponentProps<typeof ChatPanel>> & { events: SseEvent[] },
) =>
  act(async () => {
    root.render(<ChatPanel onSend={NOOP} isStreaming={false} {...props} />);
  });

const text = () => container.textContent ?? '';
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;
const button = (label: RegExp) =>
  [...container.querySelectorAll('button')].find(
    (b) => label.test(b.textContent ?? '') || label.test(b.getAttribute('aria-label') ?? ''),
  );

async function typeInto(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

describe('while the agent works', () => {
  it('shows one live card: the current step as the headline and the earlier ones checked off', async () => {
    await mount({
      isStreaming: true,
      events: [
        userMsg('make combat better'),
        step('Reading through your game', 1),
        step('Editing combat.js and duelist.js', 6),
        step('Testing it in a real browser', 50),
      ],
    });
    const card = container.querySelector('[aria-busy="true"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Testing it in a real browser…');
    expect(card?.textContent).toContain('Reading through your game');
    expect(card?.textContent).toContain('Editing combat.js and duelist.js');
    // The user's own words are there, and none of the old log furniture.
    expect(text()).toContain('make combat better');
    expect(text()).not.toMatch(/Agent started|Agent finished|Build log|RUNNING/);
  });

  it('says when the change is already in the preview', async () => {
    await mount({
      isStreaming: true,
      events: [
        userMsg('x'),
        step('Testing it in a real browser', 3),
        { type: 'draft_ready', runId: 'r1', timestamp: at(4) },
      ],
    });
    expect(text()).toContain('Your change is already in the preview');
  });

  it('lets you write the next request while it works, but does not send it', async () => {
    const onSend = vi.fn();
    await mount({ isStreaming: true, onSend, events: [userMsg('x'), step('Editing a.js', 2)] });
    expect(textarea().disabled).toBe(false);
    await typeInto('and make it faster');
    await press('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect((button(/^send$/i) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('when the agent is done', () => {
  const done = (): SseEvent[] => [
    userMsg('make combat better'),
    step('Reading through your game', 1),
    step('Editing combat.js and hud.js', 20),
    summary('- Attacks now have a clear windup.\n- Parries slow time.', 100, [
      'src/combat.js',
      'src/hud.js',
    ]),
    complete(101, {
      schemaVersion: 1,
      filesHash: 'h',
      status: 'verified',
      booted: true,
      behaviorPassed: true,
      issues: [],
    }),
  ];

  it('reads as a reply: the summary as bullets, how long it took, and what changed', async () => {
    await mount({ events: done() });
    const bullets = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(bullets).toContain('Attacks now have a clear windup.');
    expect(bullets).toContain('Parries slow time.');
    expect(text()).toContain('Worked for 1m 41s');
    expect(text()).toContain('2 files changed');
    expect(text()).toContain('Checks passed');
    // Not the log: no "run/pass" chips and no completion banner.
    expect(text()).not.toMatch(/Ready to play: checks passed|Draft saved/);
  });

  it('keeps the detail one click away, not in your face', async () => {
    await mount({ events: done() });
    expect(text()).not.toContain('src/combat.js');
    await act(async () => button(/2 files changed/)?.click());
    expect(text()).toContain('src/combat.js');
    await act(async () => button(/Worked for/)?.click());
    expect(text()).toContain('Editing combat.js and hud.js');
  });

  it('offers follow-up ideas that fill the box instead of sending', async () => {
    const onSend = vi.fn();
    await mount({ events: done(), onSend });
    await act(async () => button(/more polished/)?.click());
    expect(textarea().value).toBe('Make it look more polished');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends on Enter, and not on Shift+Enter', async () => {
    const onSend = vi.fn();
    await mount({ events: done(), onSend });
    await typeInto('make it harder');
    await press('Enter', { shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await press('Enter');
    expect(onSend).toHaveBeenCalledWith('make it harder');
    expect(textarea().value).toBe('');
  });
});

describe('when a check did not pass', () => {
  const flagged: SseEvent[] = [
    userMsg('make combat better'),
    summary('- Attacks now have a clear windup.', 100),
    complete(101, {
      schemaVersion: 1,
      filesHash: 'h',
      status: 'needs_fixes',
      booted: true,
      behaviorPassed: false,
      issues: ['opponent HP is lower after closing in and striking: did NOT decrease'],
    }),
  ];

  it('says so calmly, keeps the game as shipped, and offers to fix it', async () => {
    const onSend = vi.fn();
    await mount({ events: flagged, onSend });
    expect(text()).toContain('The game runs, but one of my automated checks did not pass.');
    expect(text()).toContain('did NOT decrease');
    // The old copy claimed an older version was being kept; the newest is what shows now.
    expect(text()).not.toMatch(/last verified version is preserved|Draft saved/);
    await act(async () => button(/Ask me to fix it/)?.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toContain('did NOT decrease');
  });
});

describe('when something goes wrong', () => {
  it('is plain about it, hides the raw error until asked, and can try again', async () => {
    const onFixError = vi.fn();
    await mount({
      onFixError,
      events: [
        userMsg('x'),
        step('Editing a.js', 2),
        { type: 'run_error', runId: 'r1', error: 'TypeError: boom at line 3', timestamp: at(5) },
      ],
    });
    expect(text()).toContain('Something went wrong while working on this.');
    expect(text()).not.toContain('TypeError: boom');
    await act(async () => button(/^Details/)?.click());
    expect(text()).toContain('TypeError: boom at line 3');
    await act(async () => button(/Try again/)?.click());
    expect(onFixError).toHaveBeenCalledWith('TypeError: boom at line 3');
  });

  it('does not offer "try again" for a dropped connection', async () => {
    await mount({
      onFixError: NOOP,
      events: [
        userMsg('x'),
        {
          type: 'run_error',
          runId: 'r1',
          error: TRANSPORT_LOST_MESSAGE,
          timestamp: at(5),
        },
      ],
    });
    expect(button(/Try again/)).toBeUndefined();
  });
});

describe('a conversation that was reloaded', () => {
  it('still reads as a conversation: each ask followed by its reply', async () => {
    await mount({
      events: [
        userMsg('make it faster', 0),
        summary('- Faster now.', 5),
        complete(6),
        userMsg('and louder', 60),
        summary('- Louder.', 65),
        complete(66),
      ],
    });
    const body = text();
    const order = ['make it faster', 'Faster now.', 'and louder', 'Louder.'].map((s) =>
      body.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
