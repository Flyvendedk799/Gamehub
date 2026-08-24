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
  /**
   * The layer definitions in play for THIS interview.
   *
   * Present when the questions were written for the prompt (see
   * `startInterviewFromPlan`); absent for a static interview, which reads
   * `DESIGN_LAYERS` instead. Carried on the state because a tailored question
   * exists nowhere else — there is no table to look it up in.
   */
  readonly layers?: readonly DesignLayer[] | undefined;
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

  // No value: the regexes detect THAT a layer is settled, not what it was
  // settled as. Recording the whole prompt here put the entire prompt on a card
  // titled "World" and again under "World:" in the build prompt. An empty value
  // drops out of the brief, which is the honest outcome — the prompt already
  // says it, and `toBrief` filters empties.
  const answers: LayerAnswer[] = inferred.map((layer) => ({
    layer,
    option: null,
    value: '',
    source: 'inferred',
  }));

  const remaining = DESIGN_LAYERS.filter((layer) => !inferredSet.has(layer.id))
    .slice(0, maxQuestions)
    .map((layer) => layer.id);

  return { prompt, answers, remaining, done: remaining.length === 0 };
}

/**
 * Resolve a layer for an interview: its own tailored definition if it has one,
 * otherwise the static table.
 */
function layerFor(state: InterviewState, id: LayerId): DesignLayer | undefined {
  return state.layers?.find((layer) => layer.id === id) ?? getLayer(id);
}

/** The next question, or null when the interview is over. */
export function nextQuestion(state: InterviewState): DesignLayer | null {
  const next = state.remaining[0];
  return next === undefined ? null : (layerFor(state, next) ?? null);
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
  /** Those layers' titles, resolved against whichever wording was shown. */
  readonly delegatedTitles: readonly string[];
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
      title: layerFor(state, answer.layer)?.title ?? answer.layer,
      value: answer.value.trim(),
    }));

  return {
    prompt: state.prompt,
    layers: answered,
    delegated: state.answers
      .filter((answer) => answer.source === 'skipped')
      .map((answer) => answer.layer),
    delegatedTitles: state.answers
      .filter((answer) => answer.source === 'skipped')
      .map((answer) => layerFor(state, answer.layer)?.title ?? answer.layer),
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
    const titles =
      brief.delegatedTitles.length === brief.delegated.length
        ? brief.delegatedTitles
        : brief.delegated.map((id) => getLayer(id)?.title ?? id);
    lines.push(
      '',
      `Left to you: ${titles.join(', ')}. Choose something that fits the above, and say what you chose.`,
    );
  }
  return lines.join('\n');
}

// ── Prompt-tailored interviews ──────────────────────────────────────────────
//
// The layers above are the SHAPE of the conversation, not its content. Asking
// someone who wrote "an underwater roguelike" whether their game is set in a
// neon city is worse than not asking at all — it says nobody read the prompt.
//
// So the questions themselves are written for the prompt in hand: a model reads
// what the person wrote, extracts what they already settled, and drafts the
// remaining questions with options drawn from THEIR idea. The static layers
// stay as the fallback for when that call fails or is slow, because an
// interview that cannot start is worse than a generic one.

/**
 * A set of questions written for one specific prompt.
 *
 * `settled` is what the prompt already decided, with the value extracted from
 * it — "a flooded neon city", not the whole prompt echoed back. Those layers
 * become cards immediately and are never asked about.
 */
export interface InterviewPlan {
  readonly settled: readonly { layer: LayerId; value: string }[];
  readonly questions: readonly DesignLayer[];
}

/** Hard caps on model-authored text. These strings are rendered as UI. */
const LIMITS = {
  questions: 6,
  options: 4,
  title: 24,
  question: 140,
  why: 160,
  placeholder: 110,
  label: 60,
  detail: 90,
  value: 200,
} as const;

const LAYER_IDS = new Set<string>(DESIGN_LAYERS.map((layer) => layer.id));

/**
 * Trim, collapse whitespace, and cap. Returns '' for anything unusable.
 *
 * Over-long text is cut at a WORD boundary. Cutting at the raw character limit
 * produced options reading "scavenging disturbs i", which looks like a bug
 * rather than a limit.
 */
function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  // Reserve a character for the ellipsis, then back up to the last space.
  const cut = collapsed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the boundary if it leaves most of the text; a very long single
  // word would otherwise collapse to almost nothing.
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

function asLayerId(raw: unknown): LayerId | null {
  return typeof raw === 'string' && LAYER_IDS.has(raw) ? (raw as LayerId) : null;
}

/**
 * Validate a model-authored plan.
 *
 * Strict on purpose: this is model output rendered directly into the UI and
 * folded into the build prompt. Anything malformed is dropped rather than
 * repaired, and a plan with no usable questions returns null so the caller
 * falls back to the static layers instead of showing an empty interview.
 *
 * Option ids are assigned here rather than taken from the model — they are
 * React keys and answer identifiers, and a model that emitted duplicates would
 * otherwise corrupt both.
 */
export function parseInterviewPlan(raw: unknown): InterviewPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as { settled?: unknown; questions?: unknown };

  const seen = new Set<LayerId>();
  const settled: { layer: LayerId; value: string }[] = [];
  if (Array.isArray(source.settled)) {
    for (const entry of source.settled) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const layer = asLayerId(record['layer']);
      const value = clean(record['value'], LIMITS.value);
      if (layer === null || value === '' || seen.has(layer)) continue;
      seen.add(layer);
      settled.push({ layer, value });
    }
  }

  const questions: DesignLayer[] = [];
  if (Array.isArray(source.questions)) {
    for (const entry of source.questions) {
      if (questions.length >= LIMITS.questions) break;
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = asLayerId(record['layer']);
      // A layer the prompt already settled must not also be asked about.
      if (id === null || seen.has(id)) continue;

      const fallback = getLayer(id);
      const question = clean(record['question'], LIMITS.question);
      if (question === '') continue;

      const options: LayerOption[] = [];
      if (Array.isArray(record['options'])) {
        for (const rawOption of record['options']) {
          if (options.length >= LIMITS.options) break;
          if (typeof rawOption !== 'object' || rawOption === null) continue;
          const optionRecord = rawOption as Record<string, unknown>;
          const label = clean(optionRecord['label'], LIMITS.label);
          if (label === '') continue;
          const detail = clean(optionRecord['detail'], LIMITS.detail);
          options.push({
            id: `${id}-${options.length}`,
            label,
            ...(detail === '' ? {} : { detail }),
          });
        }
      }
      // A question with nothing to pick is a text box with extra steps.
      if (options.length === 0) continue;

      seen.add(id);
      questions.push({
        id,
        title: clean(record['title'], LIMITS.title) || (fallback?.title ?? id),
        question,
        why: clean(record['why'], LIMITS.why) || (fallback?.why ?? ''),
        placeholder:
          clean(record['placeholder'], LIMITS.placeholder) || (fallback?.placeholder ?? ''),
        options,
      });
    }
  }

  if (questions.length === 0) return null;

  // Canonical order regardless of what the model emitted: the world still
  // constrains the cast, and the twist still needs something to subvert.
  const order = new Map(DESIGN_LAYERS.map((layer, index) => [layer.id, index]));
  questions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { settled, questions };
}

/**
 * Begin an interview from a prompt-tailored plan.
 *
 * Mirrors `startInterview`, but the questions come from the plan and the
 * settled layers carry the value the model extracted from the prompt, so they
 * show as real cards ("World: a flooded neon city") instead of the prompt
 * repeated back.
 */
export function startInterviewFromPlan(
  prompt: string,
  plan: InterviewPlan,
  options: StartOptions = {},
): InterviewState {
  const maxQuestions = Math.max(1, options.maxQuestions ?? DEFAULT_MAX_QUESTIONS);
  const answers: LayerAnswer[] = plan.settled.map((entry) => ({
    layer: entry.layer,
    option: null,
    value: entry.value,
    source: 'inferred',
  }));
  const asked = plan.questions.slice(0, maxQuestions);
  return {
    prompt,
    answers,
    remaining: asked.map((layer) => layer.id),
    done: asked.length === 0,
    layers: asked,
  };
}

/**
 * The instruction handed to the model that drafts the questions.
 *
 * Lives here rather than in the API so it can be tested, and so the rules it
 * states stay next to the code that enforces them.
 */
export function buildInterviewPlanPrompt(prompt: string): string {
  const layerList = DESIGN_LAYERS.map(
    (layer) => `- ${layer.id} (${layer.title}): ${layer.why}`,
  ).join('\n');

  return [
    'Turn a one-line game idea into a short interview about THAT idea.',
    '',
    'Layers you may ask about:',
    layerList,
    '',
    'Rules:',
    '1. Every question and option must be about THEIR idea. Someone who wrote',
    '   "underwater roguelike" must never be offered "medieval castle".',
    '2. Anything their idea already settles goes in `settled`, phrased in their',
    '   words ("a flooded neon city"). Never ask about a settled layer.',
    '3. At most 4 questions — only where their idea is genuinely open and the',
    '   answer changes what gets built. Fewer is better.',
    '4. Exactly 3 options per question. Each is a real design choice with',
    '   consequences, not a synonym of another.',
    '5. BE BRIEF. Someone is waiting on this: question ≤ 12 words, label ≤ 6',
    '   words, detail ≤ 10 words. Second person, plain, no marketing voice.',
    '',
    'JSON only — no prose, no code fence. Exactly these fields:',
    '{"settled":[{"layer":"world","value":"..."}],',
    ' "questions":[{"layer":"cast","question":"...",',
    '  "options":[{"label":"...","detail":"..."}]}]}',
    '',
    'Their idea:',
    prompt,
  ].join('\n');
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models fence JSON, prefix it with "Here is", or both, however firmly they are
 * told not to. Failing the whole interview over a code fence would be silly.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
