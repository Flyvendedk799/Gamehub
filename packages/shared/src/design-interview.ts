/**
 * The design interview — build a game one layer at a time.
 *
 * Today a build is one prompt in, twenty-six minutes of silence, one artifact
 * out. If the result is wrong the whole thing is wrong, and the only remedy is
 * to describe it again and wait again. The person who asked for "a platformer
 * with a grappling hook" never got to say the things they actually cared about,
 * because nobody asked.
 *
 * So the run starts as a short conversation instead. The agent asks about one
 * layer at a time — world, cast, core loop, win condition, twist — each answer
 * lands as a visible card, and only then does it build. Two things follow:
 *
 *  - **The person sees their game taking shape before a line is written**, and
 *    can correct it while correcting is free.
 *  - **The agent builds against a decided spec** rather than inventing the
 *    unstated half and hoping. Most of the twenty-six-minute run was the model
 *    re-reading a file while it worked out what it was building.
 *
 * Three rules make this a conversation rather than a form:
 *
 *  1. **Every stage is skippable.** "You decide" is a real answer, and the
 *     default. A form you must complete is worse than the prompt box it
 *     replaced.
 *  2. **Suggestions are seeded from the prompt.** Someone who said "underwater
 *     roguelike" should not be offered "medieval castle" first.
 *  3. **It ends early when it knows enough.** A detailed prompt already answers
 *     half of these; asking anyway is a worse experience, not a more thorough
 *     one.
 */

export type LayerId = 'world' | 'cast' | 'loop' | 'victory' | 'twist' | 'feel';

export interface LayerOption {
  readonly id: string;
  readonly label: string;
  /** One line explaining what picking this actually changes. */
  readonly detail?: string | undefined;
}

export interface DesignLayer {
  readonly id: LayerId;
  /** Shown as the card title once answered. */
  readonly title: string;
  /** The question, in the second person. */
  readonly question: string;
  /** Why it is being asked — shown small, so the question does not feel like a form. */
  readonly why: string;
  readonly options: readonly LayerOption[];
  /** Free text is always allowed; this is the placeholder. */
  readonly placeholder: string;
}

export interface LayerAnswer {
  readonly layer: LayerId;
  /** Option id, or null when the answer is free text or a skip. */
  readonly option: string | null;
  /** What the person actually said, or what was inferred. */
  readonly value: string;
  readonly source: 'chosen' | 'typed' | 'inferred' | 'skipped';
}

export interface InterviewState {
  readonly prompt: string;
  readonly answers: readonly LayerAnswer[];
  /** Layers still to ask, in order. */
  readonly remaining: readonly LayerId[];
  readonly done: boolean;
}

/**
 * The layers, in the order they are asked.
 *
 * Ordered by how much each one constrains the rest: the world dictates the
 * cast, the cast dictates the loop, and the twist only makes sense once there
 * is something for it to subvert. Asking for the twist first gets you a twist
 * on nothing.
 */
export const DESIGN_LAYERS: readonly DesignLayer[] = [
  {
    id: 'world',
    title: 'World',
    question: 'Where does this take place?',
    why: 'Sets the art direction and the palette for everything after this.',
    placeholder: 'A flooded city, a space station, somewhere else…',
    options: [
      { id: 'neon-city', label: 'Neon city', detail: 'Rain, signage, hard shadows' },
      { id: 'deep-sea', label: 'Deep sea', detail: 'Pressure, dark, bioluminescence' },
      { id: 'space-hulk', label: 'Derelict ship', detail: 'Corridors, low light, salvage' },
      { id: 'overgrown', label: 'Overgrown ruins', detail: 'Green, crumbling, quiet' },
    ],
  },
  {
    id: 'cast',
    title: 'Who you play',
    question: 'Who or what does the player control?',
    why: 'Decides the sprites, the animation set, and how movement should feel.',
    placeholder: 'A courier, a submarine, a stray cat…',
    options: [
      { id: 'lone-runner', label: 'A lone runner', detail: 'Fast, fragile, on foot' },
      { id: 'small-craft', label: 'A small craft', detail: 'Momentum, thrusters, drift' },
      { id: 'creature', label: 'A creature', detail: 'Climbing, pouncing, organic' },
      { id: 'squad', label: 'A small squad', detail: 'Switch between two or three' },
    ],
  },
  {
    id: 'loop',
    title: 'Core loop',
    question: 'What is the player doing, second to second?',
    why: 'This is the actual game. Everything else decorates it.',
    placeholder: 'Dodging, building, racing, negotiating…',
    options: [
      { id: 'dodge-shoot', label: 'Dodge and shoot', detail: 'Reflex, patterns, near misses' },
      { id: 'traverse', label: 'Traverse and climb', detail: 'Momentum and route-finding' },
      { id: 'gather-build', label: 'Gather and build', detail: 'Resources into structures' },
      { id: 'stealth', label: 'Avoid being seen', detail: 'Sightlines, patience, timing' },
    ],
  },
  {
    id: 'victory',
    title: 'How you win',
    question: 'How does a run end well?',
    why: 'Without this the game cannot be tested, and neither can the agent.',
    placeholder: 'Reach the surface, survive ten waves, out-score a rival…',
    options: [
      { id: 'reach-end', label: 'Reach the end', detail: 'A place to get to' },
      { id: 'survive', label: 'Survive a duration', detail: 'Waves, a timer, a storm' },
      { id: 'score', label: 'Beat a score', detail: 'Chase your own best' },
      { id: 'defeat-boss', label: 'Defeat something', detail: 'One hard fight' },
    ],
  },
  {
    id: 'twist',
    title: 'The twist',
    question: 'What makes this one different?',
    why: 'One unusual rule is what people remember and describe to other people.',
    placeholder: 'Time rewinds when you die, gravity flips on a beat…',
    options: [
      { id: 'time-rewind', label: 'Time rewinds', detail: 'Death undoes a few seconds' },
      { id: 'one-life', label: 'One life only', detail: 'Everything else gets easier' },
      { id: 'gravity-flip', label: 'Gravity flips', detail: 'On input, or on rhythm' },
      { id: 'shrinking-world', label: 'The world shrinks', detail: 'Space runs out, not time' },
    ],
  },
  {
    id: 'feel',
    title: 'Feel',
    question: 'How should it feel to play?',
    why: 'Drives screen shake, hitstop, palette and audio — the difference between working and good.',
    placeholder: 'Heavy and deliberate, twitchy and fast, calm…',
    options: [
      { id: 'crunchy', label: 'Crunchy', detail: 'Shake, hitstop, punch' },
      { id: 'floaty', label: 'Floaty', detail: 'Drift, long arcs, soft landings' },
      { id: 'tense', label: 'Tense', detail: 'Quiet, sparse, sudden' },
      { id: 'playful', label: 'Playful', detail: 'Bouncy, bright, forgiving' },
    ],
  },
];

const LAYER_BY_ID = new Map(DESIGN_LAYERS.map((layer) => [layer.id, layer]));

export function getLayer(id: LayerId): DesignLayer | undefined {
  return LAYER_BY_ID.get(id);
}

/**
 * Words that suggest a layer is already answered by the prompt.
 *
 * Deliberately conservative. A false positive skips a question the person
 * wanted to answer, which is worse than one extra question — so a layer is only
 * treated as answered when the prompt is unambiguous about it.
 */
const LAYER_SIGNALS: Record<LayerId, readonly RegExp[]> = {
  world: [/\b(underwater|space|city|forest|desert|dungeon|castle|station|ruins|island|cave)\b/i],
  cast: [/\b(play as|you are|control(?:ling)? a|character is)\b/i],
  loop: [
    /\b(platformer|shooter|shmup|puzzle|racing|tower ?defen[cs]e|roguelike|metroidvania|rhythm)\b/i,
  ],
  victory: [/\b(win|beat|survive|escape|reach|defeat|score|highest)\b/i],
  twist: [/\b(twist|except|but the|unusual|instead of|gimmick)\b/i],
  feel: [/\b(fast|slow|calm|brutal|cozy|frantic|tense|floaty|heavy|punchy)\b/i],
};

/** Layers the prompt already settles, so they are not asked again. */
export function inferAnsweredLayers(prompt: string): LayerId[] {
  const text = typeof prompt === 'string' ? prompt : '';
  if (text.trim().length === 0) return [];
  const answered: LayerId[] = [];
  for (const layer of DESIGN_LAYERS) {
    const signals = LAYER_SIGNALS[layer.id];
    if (signals.some((pattern) => pattern.test(text))) answered.push(layer.id);
  }
  return answered;
}

export interface StartOptions {
  /** Never ask more than this many questions. */
  readonly maxQuestions?: number | undefined;
  /** Skip inference and ask everything — used when the person asks to be asked. */
  readonly askEverything?: boolean | undefined;
}

const DEFAULT_MAX_QUESTIONS = 4;

/**
 * Begin an interview for a prompt.
 *
 * Layers the prompt already answers are recorded as `inferred` rather than
 * asked, and the rest are capped — five questions before anything happens is a
 * form, and people leave.
 */
export function startInterview(prompt: string, options: StartOptions = {}): InterviewState {
  const maxQuestions = Math.max(1, options.maxQuestions ?? DEFAULT_MAX_QUESTIONS);
  const inferred = options.askEverything ? [] : inferAnsweredLayers(prompt);
  const inferredSet = new Set(inferred);

  const answers: LayerAnswer[] = inferred.map((layer) => ({
    layer,
    option: null,
    value: prompt,
    source: 'inferred',
  }));

  const remaining = DESIGN_LAYERS.filter((layer) => !inferredSet.has(layer.id))
    .slice(0, maxQuestions)
    .map((layer) => layer.id);

  return { prompt, answers, remaining, done: remaining.length === 0 };
}

/** The next question, or null when the interview is over. */
export function nextQuestion(state: InterviewState): DesignLayer | null {
  const next = state.remaining[0];
  return next === undefined ? null : (getLayer(next) ?? null);
}

/**
 * Record an answer and advance.
 *
 * Answering a layer that is not the current question is allowed — someone who
 * jumps ahead in the UI, or an agent filling in what it inferred mid-build,
 * should not be told no.
 */
export function answerLayer(state: InterviewState, answer: LayerAnswer): InterviewState {
  const answers = [...state.answers.filter((a) => a.layer !== answer.layer), answer];
  const remaining = state.remaining.filter((id) => id !== answer.layer);
  return { ...state, answers, remaining, done: remaining.length === 0 };
}

/** Skip a layer: a real answer meaning "you decide". */
export function skipLayer(state: InterviewState, layer: LayerId): InterviewState {
  return answerLayer(state, { layer, option: null, value: '', source: 'skipped' });
}

/** Abandon the remaining questions and start building. */
export function finishInterview(state: InterviewState): InterviewState {
  return { ...state, remaining: [], done: true };
}

export interface DesignBrief {
  readonly prompt: string;
  /** Answered layers, in the canonical layer order. */
  readonly layers: readonly { layer: LayerId; title: string; value: string }[];
  /** Layers the person explicitly left to the agent. */
  readonly delegated: readonly LayerId[];
}

/**
 * Turn the interview into something the agent can build from.
 *
 * Skipped layers are reported separately rather than silently dropped: the
 * agent should know it is choosing, and say what it chose, instead of the
 * person wondering later why their game has a boss they never asked for.
 */
export function toBrief(state: InterviewState): DesignBrief {
  const order = new Map(DESIGN_LAYERS.map((layer, index) => [layer.id, index]));
  const answered = state.answers
    .filter((answer) => answer.source !== 'skipped' && answer.value.trim().length > 0)
    .sort((a, b) => (order.get(a.layer) ?? 0) - (order.get(b.layer) ?? 0))
    .map((answer) => ({
      layer: answer.layer,
      title: getLayer(answer.layer)?.title ?? answer.layer,
      value: answer.value.trim(),
    }));

  return {
    prompt: state.prompt,
    layers: answered,
    delegated: state.answers
      .filter((answer) => answer.source === 'skipped')
      .map((answer) => answer.layer),
  };
}

/** Render the brief as the prompt the build actually receives. */
export function briefToPrompt(brief: DesignBrief): string {
  const lines = [brief.prompt.trim()];
  if (brief.layers.length > 0) {
    lines.push('', 'Decided with the player:');
    for (const layer of brief.layers) lines.push(`- ${layer.title}: ${layer.value}`);
  }
  if (brief.delegated.length > 0) {
    const titles = brief.delegated.map((id) => getLayer(id)?.title ?? id);
    lines.push(
      '',
      `Left to you: ${titles.join(', ')}. Choose something that fits the above, and say what you chose.`,
    );
  }
  return lines.join('\n');
}
