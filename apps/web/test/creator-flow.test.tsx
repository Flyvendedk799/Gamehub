// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/components/ChatPanel';
import { DesignInterview } from '../src/components/DesignInterview';
import { PlayableExamples } from '../src/components/PlayableExamples';
import type { SseEvent } from '../src/lib/types';

const { fetchPlan, hubFeed } = vi.hoisted(() => ({ fetchPlan: vi.fn(), hubFeed: vi.fn() }));
vi.mock('@/lib/api', () => ({ fetchInterviewPlan: fetchPlan, getHubFeed: hubFeed }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchPlan.mockReset();
  hubFeed.mockReset();
});

it('shows only real live games with captures, varying genres, and working play links', async () => {
  const game = {
    id: 'one',
    publishSlug: 'tide',
    title: 'Tide',
    genre: 'puzzle',
    thumbnailUrl: 'https://example.test/tide.png',
    status: 'live',
  };
  hubFeed.mockResolvedValue({
    games: [
      game,
      { ...game, id: 'two', title: 'Duplicate genre' },
      { ...game, id: 'three', genre: 'action', status: 'removed_by_mod', title: 'Removed' },
    ],
  });
  await act(async () => root.render(<PlayableExamples />));
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/p/tide');
  expect(container.querySelectorAll('a')).toHaveLength(1);
  expect(container.textContent).not.toContain('Removed');
  expect(container.textContent).not.toContain('Duplicate genre');
});

it('does not invent playable examples when the Hub is unavailable', async () => {
  hubFeed.mockRejectedValue(new Error('offline'));
  await act(async () => root.render(<PlayableExamples />));
  expect(container.textContent).toBe('');
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('interview request lifecycle', () => {
  it('survives StrictMode cleanup and re-subscription without issuing a second model request', async () => {
    let finish!: (value: null) => void;
    fetchPlan.mockReturnValue(
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <DesignInterview prompt="A tide puzzle" onBuild={() => {}} onCancel={() => {}} />
        </StrictMode>,
      ),
    );
    expect(fetchPlan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Build it now');
    await act(async () => finish(null));
    expect(container.textContent).not.toContain('Working out what to ask');
    expect(container.textContent).toContain('general ones');
  });

  it('lets the user build immediately and falls back after a bounded wait', async () => {
    vi.useFakeTimers();
    fetchPlan.mockReturnValue(new Promise(() => {}));
    const build = vi.fn();
    await act(async () =>
      root.render(<DesignInterview prompt="A tide puzzle" onBuild={build} onCancel={() => {}} />),
    );
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Build it now',
    );
    await act(async () => button?.click());
    expect(build).toHaveBeenCalledWith('A tide puzzle');
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.textContent).toContain('general ones');
  });

  it('does not let an old prompt response overwrite a changed prompt', async () => {
    let finishOld!: (value: null) => void;
    fetchPlan
      .mockReturnValueOnce(
        new Promise<null>((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValueOnce(null);
    const render = (prompt: string) => (
      <DesignInterview prompt={prompt} onBuild={() => {}} onCancel={() => {}} />
    );
    await act(async () => root.render(render('Old idea')));
    await act(async () => root.render(render('New idea')));
    await act(async () => finishOld(null));
    expect(container.textContent).toContain('New idea');
    expect(container.textContent).not.toContain('Old idea');
  });
});

it('preserves chat reading position until the user returns to the live tail', async () => {
  const events: SseEvent[] = [
    {
      type: 'user_message',
      runId: 'r',
      content: 'First idea',
      timestamp: new Date().toISOString(),
    },
  ];
  const render = () => <ChatPanel events={[...events]} onSend={() => {}} isStreaming={false} />;
  await act(async () => root.render(render()));
  const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement;
  Object.defineProperties(scroll, {
    scrollHeight: { value: 600, configurable: true },
    clientHeight: { value: 100 },
  });
  scroll.scrollTop = 40;
  await act(async () => scroll.dispatchEvent(new Event('scroll')));
  events.push({
    type: 'assistant_text',
    runId: 'r',
    text: 'New update',
    timestamp: new Date().toISOString(),
  });
  await act(async () => root.render(render()));
  expect(scroll.scrollTop).toBe(40);
  expect(container.textContent).toContain('New updates');
  scroll.scrollTop = 500;
  await act(async () => scroll.dispatchEvent(new Event('scroll')));
  Object.defineProperty(scroll, 'scrollHeight', { value: 700 });
  await act(async () => root.render(render()));
  expect(scroll.scrollTop).toBe(700);
});
