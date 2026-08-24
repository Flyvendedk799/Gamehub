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
  buildInterviewPlanPrompt,
  extractJsonObject,
  finishInterview,
  getLayer,
  inferAnsweredLayers,
  nextQuestion,
  parseInterviewPlan,
  skipLayer,
  startInterview,
  startInterviewFromPlan,
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

describe('prompt-tailored interviews', () => {
  /** A minimal well-formed plan, as the model is asked to emit it. */
  function rawPlan(overrides: Record<string, unknown> = {}) {
    return {
      settled: [{ layer: 'world', value: 'a flooded neon city' }],
      questions: [
        {
          layer: 'cast',
          title: 'Who you play',
          question: 'Who is moving through the flooded city?',
          why: 'Decides the sprite set and how movement should feel.',
          placeholder: 'A courier on a jet-ski, a salvage diver…',
          options: [
            { label: 'A salvage diver', detail: 'Slow, heavy, tethered' },
            { label: 'A courier on a jet-ski', detail: 'Fast, exposed, loud' },
          ],
        },
      ],
      ...overrides,
    };
  }

  describe('parseInterviewPlan', () => {
    it('keeps a well-formed plan and assigns its own option ids', () => {
      const plan = parseInterviewPlan(rawPlan());
      expect(plan).not.toBeNull();
      expect(plan?.settled).toEqual([{ layer: 'world', value: 'a flooded neon city' }]);
      expect(plan?.questions).toHaveLength(1);
      // Ids come from us, never the model: they are React keys and answer
      // identifiers, and a model emitting duplicates would corrupt both.
      expect(plan?.questions[0]?.options.map((o) => o.id)).toEqual(['cast-0', 'cast-1']);
    });

    it('rejects anything that is not a plan', () => {
      expect(parseInterviewPlan(null)).toBeNull();
      expect(parseInterviewPlan('a plan')).toBeNull();
      expect(parseInterviewPlan({})).toBeNull();
      expect(parseInterviewPlan({ questions: [] })).toBeNull();
    });

    it('drops questions about layers the prompt already settled', () => {
      // Otherwise someone is asked where their game is set immediately after
      // being told the answer on a card.
      const plan = parseInterviewPlan(
        rawPlan({
          questions: [
            {
              layer: 'world',
              question: 'Where is it set?',
              options: [{ label: 'A city' }],
            },
          ],
        }),
      );
      expect(plan).toBeNull();
    });

    it('drops unknown layers, empty questions and optionless questions', () => {
      const plan = parseInterviewPlan({
        settled: [],
        questions: [
          { layer: 'soundtrack', question: 'What music?', options: [{ label: 'Synths' }] },
          { layer: 'loop', question: '   ', options: [{ label: 'Dodging' }] },
          { layer: 'twist', question: 'What is unusual?', options: [] },
          { layer: 'feel', question: 'How should it feel?', options: [{ label: 'Heavy' }] },
        ],
      });
      expect(plan?.questions.map((q) => q.id)).toEqual(['feel']);
    });

    it('caps model-authored text, because it is rendered as UI', () => {
      const plan = parseInterviewPlan({
        settled: [{ layer: 'world', value: 'w'.repeat(500) }],
        questions: [
          {
            layer: 'loop',
            title: 't'.repeat(200),
            question: 'q'.repeat(500),
            options: [{ label: 'l'.repeat(300), detail: 'd'.repeat(300) }],
          },
        ],
      });
      expect(plan?.settled[0]?.value.length).toBeLessThanOrEqual(200);
      expect(plan?.questions[0]?.title.length).toBeLessThanOrEqual(24);
      expect(plan?.questions[0]?.question.length).toBeLessThanOrEqual(140);
      expect(plan?.questions[0]?.options[0]?.label.length).toBeLessThanOrEqual(60);
      expect(plan?.questions[0]?.options[0]?.detail?.length).toBeLessThanOrEqual(80);
    });

    it('caps how many questions and options survive', () => {
      const many = Array.from({ length: 4 }, (_, i) => ({ label: `option ${i}` }));
      const plan = parseInterviewPlan({
        settled: [],
        questions: [{ layer: 'loop', question: 'What do you do?', options: [...many, ...many] }],
      });
      expect(plan?.questions[0]?.options).toHaveLength(4);
    });

    it('deduplicates repeated layers', () => {
      const plan = parseInterviewPlan({
        settled: [],
        questions: [
          { layer: 'loop', question: 'First ask', options: [{ label: 'A' }] },
          { layer: 'loop', question: 'Second ask', options: [{ label: 'B' }] },
        ],
      });
      expect(plan?.questions).toHaveLength(1);
      expect(plan?.questions[0]?.question).toBe('First ask');
    });

    it('restores the canonical layer order whatever the model emitted', () => {
      // The world still constrains the cast, and the twist still needs
      // something to subvert.
      const plan = parseInterviewPlan({
        settled: [],
        questions: [
          { layer: 'twist', question: 'The twist?', options: [{ label: 'A' }] },
          { layer: 'world', question: 'Where?', options: [{ label: 'B' }] },
          { layer: 'loop', question: 'Doing what?', options: [{ label: 'C' }] },
        ],
      });
      expect(plan?.questions.map((q) => q.id)).toEqual(['world', 'loop', 'twist']);
    });

    it('falls back to the static wording for fields the model omitted', () => {
      const plan = parseInterviewPlan({
        settled: [],
        questions: [{ layer: 'victory', question: 'How do you win?', options: [{ label: 'A' }] }],
      });
      expect(plan?.questions[0]?.title).toBe('How you win');
      expect(plan?.questions[0]?.why.length).toBeGreaterThan(0);
    });
  });

  describe('startInterviewFromPlan', () => {
    it('asks the plan questions and cards the settled layers with real values', () => {
      const plan = parseInterviewPlan(rawPlan());
      if (plan === null) throw new Error('expected a plan');
      const state = startInterviewFromPlan('a game in a flooded neon city', plan);

      expect(state.remaining).toEqual(['cast']);
      // The tailored question is reachable — it exists in no static table.
      expect(nextQuestion(state)?.question).toBe('Who is moving through the flooded city?');

      const brief = toBrief(state);
      expect(brief.layers).toEqual([
        { layer: 'world', title: 'World', value: 'a flooded neon city' },
      ]);
    });

    it('carries the tailored title onto the answered card', () => {
      const plan = parseInterviewPlan({
        settled: [],
        questions: [
          {
            layer: 'cast',
            title: 'Your diver',
            question: 'Who is diving?',
            options: [{ label: 'A salvage diver' }],
          },
        ],
      });
      if (plan === null) throw new Error('expected a plan');
      let state = startInterviewFromPlan('underwater game', plan);
      state = answerLayer(state, {
        layer: 'cast',
        option: 'cast-0',
        value: 'A salvage diver',
        source: 'chosen',
      });
      expect(toBrief(state).layers[0]?.title).toBe('Your diver');
    });

    it('honours the question cap', () => {
      const plan = parseInterviewPlan({
        settled: [],
        questions: ['world', 'cast', 'loop', 'victory'].map((layer) => ({
          layer,
          question: `About ${layer}?`,
          options: [{ label: 'A' }],
        })),
      });
      if (plan === null) throw new Error('expected a plan');
      expect(startInterviewFromPlan('p', plan, { maxQuestions: 2 }).remaining).toHaveLength(2);
    });
  });

  describe('extractJsonObject', () => {
    it('reads bare JSON', () => {
      expect(extractJsonObject('{"settled":[]}')).toEqual({ settled: [] });
    });

    it('reads JSON out of a code fence, and out of surrounding prose', () => {
      // Models fence JSON however firmly they are told not to; failing the
      // whole interview over a code fence would be silly.
      expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
      expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
    });

    it('returns null for prose with no JSON, and for malformed JSON', () => {
      expect(extractJsonObject('I cannot help with that.')).toBeNull();
      expect(extractJsonObject('{"a": }')).toBeNull();
      expect(extractJsonObject('')).toBeNull();
    });
  });

  describe('buildInterviewPlanPrompt', () => {
    it('carries the prompt and names every layer', () => {
      const instruction = buildInterviewPlanPrompt('an underwater roguelike');
      expect(instruction).toContain('an underwater roguelike');
      for (const layer of DESIGN_LAYERS) expect(instruction).toContain(layer.id);
    });
  });

  it('does not put the whole prompt on a card when a layer is only inferred', () => {
    // The regexes detect THAT a layer is settled, not what it was settled as.
    // Recording the prompt as the value put the entire prompt on a card titled
    // "World", and again under "World:" in the build prompt.
    const state = startInterview('an underwater roguelike where you escape the depths');
    const brief = toBrief(state);
    expect(brief.layers).toEqual([]);
    expect(briefToPrompt(brief)).not.toContain('World: an underwater roguelike');
  });
});
