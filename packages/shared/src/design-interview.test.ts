/**
 * Design interview tests.
 *
 * The rules that keep this a conversation rather than a form are the ones worth
 * pinning: it must be skippable, it must not ask what the prompt already
 * answered, and it must never grow into a wall of questions before anything
 * happens.
 */

import { describe, expect, it } from 'vitest';
import {
  DESIGN_LAYERS,
  type LayerId,
  answerLayer,
  briefToPrompt,
  finishInterview,
  getLayer,
  inferAnsweredLayers,
  nextQuestion,
  skipLayer,
  startInterview,
  toBrief,
} from './design-interview.js';

describe('the layer set', () => {
  it('asks the world before the twist', () => {
    // A twist only means something once there is something to subvert.
    const ids = DESIGN_LAYERS.map((layer) => layer.id);
    expect(ids.indexOf('world')).toBeLessThan(ids.indexOf('twist'));
    expect(ids.indexOf('cast')).toBeLessThan(ids.indexOf('loop'));
  });

  it('gives every layer a question, a reason and real options', () => {
    for (const layer of DESIGN_LAYERS) {
      expect(layer.question.endsWith('?'), layer.id).toBe(true);
      // The "why" is what stops it reading as a form.
      expect(layer.why.length).toBeGreaterThan(20);
      expect(layer.options.length).toBeGreaterThanOrEqual(3);
      expect(layer.placeholder.length).toBeGreaterThan(0);
      for (const option of layer.options) expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('covers the layers a game actually needs', () => {
    const ids = new Set(DESIGN_LAYERS.map((layer) => layer.id));
    for (const needed of ['world', 'cast', 'loop', 'victory', 'twist', 'feel'] as LayerId[]) {
      expect(ids.has(needed), needed).toBe(true);
    }
  });
});

describe('not asking what it already knows', () => {
  it('infers the world from an explicit setting', () => {
    expect(inferAnsweredLayers('an underwater roguelike')).toContain('world');
  });

  it('infers the loop from a named genre', () => {
    expect(inferAnsweredLayers('a tower defence game')).toContain('loop');
  });

  it('infers nothing from a bare prompt', () => {
    expect(inferAnsweredLayers('make me a game')).toEqual([]);
    expect(inferAnsweredLayers('')).toEqual([]);
  });

  it('skips inferred layers when the interview starts', () => {
    const state = startInterview('an underwater tower defence game where you survive ten waves');
    // World, loop and victory are all stated; asking them back would be
    // interrogating someone about what they just said.
    expect(state.remaining).not.toContain('world');
    expect(state.remaining).not.toContain('loop');
    expect(state.remaining).not.toContain('victory');
  });

  it('records inferences as answers rather than dropping them', () => {
    const state = startInterview('a deep sea platformer');
    const inferred = state.answers.filter((answer) => answer.source === 'inferred');
    expect(inferred.length).toBeGreaterThan(0);
  });

  it('asks everything when told to', () => {
    const state = startInterview('an underwater roguelike', {
      askEverything: true,
      maxQuestions: 9,
    });
    expect(state.remaining).toContain('world');
    expect(state.answers).toEqual([]);
  });
});

describe('never a wall of questions', () => {
  it('caps how many it asks before building', () => {
    const state = startInterview('make me a game');
    // Five questions before anything happens is a form, and people leave.
    expect(state.remaining.length).toBeLessThanOrEqual(4);
  });

  it('honours a tighter cap', () => {
    expect(startInterview('make me a game', { maxQuestions: 2 }).remaining).toHaveLength(2);
  });

  it('is done immediately when the prompt answers everything', () => {
    const state = startInterview(
      'an underwater platformer where you play as a creature, survive ten waves, ' +
        'except gravity flips, and it should feel floaty',
      { maxQuestions: 4 },
    );
    expect(state.done).toBe(true);
    expect(nextQuestion(state)).toBeNull();
  });
});

describe('answering', () => {
  it('walks the questions in order', () => {
    let state = startInterview('make me a game');
    const first = nextQuestion(state);
    expect(first?.id).toBe('world');

    state = answerLayer(state, {
      layer: 'world',
      option: 'deep-sea',
      value: 'Deep sea',
      source: 'chosen',
    });
    expect(nextQuestion(state)?.id).not.toBe('world');
  });

  it('accepts free text', () => {
    let state = startInterview('make me a game');
    state = answerLayer(state, {
      layer: 'world',
      option: null,
      value: 'A flooded cathedral',
      source: 'typed',
    });
    expect(toBrief(state).layers[0]?.value).toBe('A flooded cathedral');
  });

  it('lets an answer be revised without duplicating it', () => {
    let state = startInterview('make me a game');
    state = answerLayer(state, { layer: 'world', option: null, value: 'first', source: 'typed' });
    state = answerLayer(state, { layer: 'world', option: null, value: 'second', source: 'typed' });

    const world = toBrief(state).layers.filter((layer) => layer.layer === 'world');
    expect(world).toHaveLength(1);
    expect(world[0]?.value).toBe('second');
  });

  it('accepts an answer to a layer that was not the current question', () => {
    // Someone jumping ahead in the UI should not be told no.
    let state = startInterview('make me a game');
    state = answerLayer(state, {
      layer: 'feel',
      option: 'crunchy',
      value: 'Crunchy',
      source: 'chosen',
    });
    expect(state.remaining).not.toContain('feel');
  });

  it('finishes when every question is answered', () => {
    let state = startInterview('make me a game');
    while (!state.done) {
      const question = nextQuestion(state);
      if (!question) break;
      state = answerLayer(state, {
        layer: question.id,
        option: question.options[0]?.id ?? null,
        value: question.options[0]?.label ?? 'x',
        source: 'chosen',
      });
    }
    expect(state.done).toBe(true);
    expect(nextQuestion(state)).toBeNull();
  });
});

describe('skipping is a real answer', () => {
  it('advances past a skipped layer', () => {
    let state = startInterview('make me a game');
    const first = nextQuestion(state);
    state = skipLayer(state, first?.id ?? 'world');
    expect(nextQuestion(state)?.id).not.toBe(first?.id);
  });

  it('reports skipped layers as delegated rather than dropping them', () => {
    let state = startInterview('make me a game');
    state = skipLayer(state, 'world');
    const brief = toBrief(state);

    // The agent should know it is choosing, so it can say what it chose.
    expect(brief.delegated).toContain('world');
    expect(brief.layers.map((layer) => layer.layer)).not.toContain('world');
  });

  it('can be abandoned entirely', () => {
    const state = finishInterview(startInterview('make me a game'));
    expect(state.done).toBe(true);
    expect(state.remaining).toEqual([]);
  });
});

describe('the brief handed to the build', () => {
  it('orders layers canonically regardless of answer order', () => {
    let state = startInterview('make me a game', { maxQuestions: 9, askEverything: true });
    state = answerLayer(state, { layer: 'feel', option: null, value: 'Tense', source: 'typed' });
    state = answerLayer(state, {
      layer: 'world',
      option: null,
      value: 'Deep sea',
      source: 'typed',
    });

    expect(toBrief(state).layers.map((layer) => layer.layer)).toEqual(['world', 'feel']);
  });

  it('renders a prompt that carries the decisions', () => {
    let state = startInterview('make me a game', { askEverything: true, maxQuestions: 9 });
    state = answerLayer(state, {
      layer: 'world',
      option: null,
      value: 'Deep sea',
      source: 'typed',
    });
    state = answerLayer(state, {
      layer: 'victory',
      option: null,
      value: 'Reach the surface',
      source: 'typed',
    });
    state = skipLayer(state, 'twist');

    const prompt = briefToPrompt(toBrief(state));
    expect(prompt).toContain('make me a game');
    expect(prompt).toContain('World: Deep sea');
    expect(prompt).toContain('How you win: Reach the surface');
    // And it tells the agent to own — and disclose — what it was left to pick.
    expect(prompt).toContain('Left to you');
    expect(prompt).toContain('say what you chose');
  });

  it('drops empty answers rather than emitting blank lines', () => {
    let state = startInterview('make me a game');
    state = answerLayer(state, { layer: 'world', option: null, value: '   ', source: 'typed' });
    expect(toBrief(state).layers).toHaveLength(0);
  });

  it('is just the prompt when nothing was decided', () => {
    const brief = toBrief(startInterview('make me a game'));
    expect(briefToPrompt(brief)).toBe('make me a game');
  });
});

describe('lookup', () => {
  it('finds a layer by id', () => {
    expect(getLayer('world')?.title).toBe('World');
    expect(getLayer('nope' as LayerId)).toBeUndefined();
  });
});
