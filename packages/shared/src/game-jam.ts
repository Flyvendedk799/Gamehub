/**
 * Game Jam — the party mode.
 *
 * Two or more people join a room from their phones, take turns answering
 * creative prompts ("who's the hero?", "what's the twist?"), and at the end
 * every answer is compiled into ONE brief that the existing generation engine
 * builds into a real, playable game the whole party can play together.
 *
 * This module is the shared contract: room state, the prompt deck, the wire
 * events, and — the important part — `compileJamBrief()`, the PURE function
 * that turns a finished jam into the prompt string handed to the agent. It
 * lives here (not in the API) so the web app can preview the compiled brief
 * before the host hits Build, and so the mapping is unit-testable without a
 * server.
 *
 * ## Why the output is couch co-op, not netplay
 * Published games are served under `connect-src 'none'` (plan §7): generated
 * game code CANNOT open a socket, so online netcode is impossible by design.
 * The party plays TOGETHER ON ONE SCREEN — split keyboard, shared touch zones,
 * gamepads, or hot-seat turns. Every compiled brief says so explicitly, and the
 * deck is written to produce ideas that work that way.
 */
import { z } from 'zod';

/** Bump when the persisted jam payload shape changes (config/answers jsonb). */
export const JAM_SCHEMA_VERSION = 1;

// ── Room codes ───────────────────────────────────────────────────────────────

/**
 * Room-code alphabet. Deliberately excludes the characters that get misread
 * when someone reads a code aloud across a room or squints at a phone:
 * 0/O, 1/I/L, 5/S, 2/Z, 8/B, U/V. What's left is unambiguous over voice.
 */
export const JAM_CODE_ALPHABET = 'ACDEFGHJKMNPQRTWXY34679';
export const JAM_CODE_LENGTH = 4;

const JAM_CODE_RE = new RegExp(`^[${JAM_CODE_ALPHABET}]{${JAM_CODE_LENGTH}}$`);

export const JamCode = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => JAM_CODE_RE.test(s), {
    message: `Room code must be ${JAM_CODE_LENGTH} characters from ${JAM_CODE_ALPHABET}`,
  });
export type JamCode = z.infer<typeof JamCode>;

/**
 * Normalize whatever the user typed into a candidate room code: strip spaces
 * and dashes, uppercase, and fold the ambiguous characters onto ones the
 * alphabet actually uses (someone who hears "oh" types `O`; `0` was never
 * generated). Returns the cleaned string WITHOUT asserting validity — callers
 * parse with `JamCode` when they need the guarantee.
 */
export function normalizeJamCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/[0O]/g, 'Q')
    .replace(/[1IL]/g, 'J')
    .replace(/5/g, 'F')
    .replace(/2/g, 'X')
    .replace(/8/g, 'K')
    .replace(/[UV]/g, 'W')
    .slice(0, JAM_CODE_LENGTH);
}

/** Mint a room code. `rand` is injectable so tests are deterministic. */
export function generateJamCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < JAM_CODE_LENGTH; i++) {
    const idx = Math.floor(rand() * JAM_CODE_ALPHABET.length) % JAM_CODE_ALPHABET.length;
    out += JAM_CODE_ALPHABET.charAt(idx);
  }
  return out;
}

// ── Players ──────────────────────────────────────────────────────────────────

export const JAM_MIN_PLAYERS = 2;
export const JAM_MAX_PLAYERS = 8;
export const JAM_MAX_NAME_LEN = 16;
export const JAM_MAX_ANSWER_LEN = 140;

/**
 * Player colors — one per seat, assigned in join order. These double as the
 * in-game player colors we ask the agent to use, so "I'm the cyan one" holds
 * from the lobby all the way into the built game.
 */
export const JAM_PLAYER_COLORS = [
  { id: 'cyan', hex: '#46e6f0', label: 'Cyan' },
  { id: 'lime', hex: '#b6f24a', label: 'Lime' },
  { id: 'amber', hex: '#ffb04d', label: 'Amber' },
  { id: 'coral', hex: '#ff5d3b', label: 'Coral' },
  { id: 'violet', hex: '#b388ff', label: 'Violet' },
  { id: 'rose', hex: '#ff7ab8', label: 'Rose' },
  { id: 'mint', hex: '#5ef0b0', label: 'Mint' },
  { id: 'sky', hex: '#7cb0ff', label: 'Sky' },
] as const;

export type JamPlayerColor = (typeof JAM_PLAYER_COLORS)[number]['id'];

/** Seat 0 color, spelled out so the wrap helper has a non-optional fallback. */
const FIRST_JAM_COLOR = { id: 'cyan', hex: '#46e6f0', label: 'Cyan' } as const;

/** The seat color for the Nth player to join (wraps if a room exceeds the palette). */
export function jamColorForSeat(seat: number): { id: string; hex: string; label: string } {
  const len = JAM_PLAYER_COLORS.length;
  // The modulo always lands in range; `??` only satisfies noUncheckedIndexedAccess.
  return JAM_PLAYER_COLORS[((Math.trunc(seat) % len) + len) % len] ?? FIRST_JAM_COLOR;
}

/**
 * Control characters (C0 + DEL) and the angle brackets that would let a
 * player-supplied name break out of surrounding markup. Everything else —
 * punctuation, digits, emoji — survives, because party names are expressive.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the entire purpose of this class — stripping them is the point.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f<>]/g;

/**
 * Strip a player-supplied display name down to something safe to render in
 * every surface (roster, reveal cards, the compiled brief that reaches the
 * LLM). Control characters and angle brackets go; length is capped.
 */
export function sanitizeJamName(raw: string): string {
  return raw.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, JAM_MAX_NAME_LEN);
}

/** Same treatment for an idea, with the longer answer cap. */
export function sanitizeJamAnswer(raw: string): string {
  return raw.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, JAM_MAX_ANSWER_LEN);
}

export const JamPlayer = z.object({
  id: z.string().min(1),
  /** Set when the player is signed in; null for a guest who joined by code. */
  userId: z.string().nullable(),
  name: z.string().min(1).max(JAM_MAX_NAME_LEN),
  color: z.string(),
  /** Join order, 0-based. Drives color, turn order, and "Player N" labels. */
  seat: z.number().int().min(0),
  isHost: z.boolean(),
  /** Live WebSocket attached. Players who drop stay in the roster (and keep
   *  their answers) so a phone locking its screen doesn't nuke the round. */
  connected: z.boolean(),
  joinedAt: z.string(),
});
export type JamPlayer = z.infer<typeof JamPlayer>;

// ── The prompt deck ──────────────────────────────────────────────────────────

/**
 * A jam round. `slot` is what the answer BECOMES in the compiled brief — the
 * compiler groups answers by slot, so the deck can be reordered or extended
 * without touching `compileJamBrief`.
 */
export const JamPromptSlot = z.enum([
  'setting',
  'hero',
  'goal',
  'mechanic',
  'hazard',
  'coop',
  'powerup',
  'twist',
  'vibe',
  'title',
]);
export type JamPromptSlot = z.infer<typeof JamPromptSlot>;

export const JamPromptCard = z.object({
  id: z.string(),
  slot: JamPromptSlot,
  /** The question shown on the player's phone — second person, conversational. */
  question: z.string(),
  /** Greyed example text in the input — sets the expected shape of an answer. */
  placeholder: z.string(),
  /** One-line coaching under the question. */
  hint: z.string(),
});
export type JamPromptCard = z.infer<typeof JamPromptCard>;

/**
 * The deck, in play order. Every question is phrased to pull an idea that
 * survives compilation into a LOCAL co-op game: shared screen, 2–8 players,
 * no netcode. Order matters — the early cards fix the world, the middle cards
 * fix the verbs, the late cards add spice.
 */
export const JAM_PROMPT_DECK: ReadonlyArray<JamPromptCard> = [
  {
    id: 'setting',
    slot: 'setting',
    question: 'Where does this game take place?',
    placeholder: 'a sinking neon submarine',
    hint: 'One weird place. Weird beats sensible.',
  },
  {
    id: 'hero',
    slot: 'hero',
    question: 'Who are the players?',
    placeholder: 'rival vending machines',
    hint: 'Everyone in this room plays one of these.',
  },
  {
    id: 'goal',
    slot: 'goal',
    question: 'What are you all trying to do?',
    placeholder: 'refuel the ship before it sinks',
    hint: 'The thing that means you won.',
  },
  {
    id: 'mechanic',
    slot: 'mechanic',
    question: 'What is the one thing you DO the whole game?',
    placeholder: 'fling yourself with a grappling hook',
    hint: 'A verb. Jump, throw, stack, dodge, grab.',
  },
  {
    id: 'coop',
    slot: 'coop',
    question: 'What can you only pull off TOGETHER?',
    placeholder: 'one holds the door while the other runs',
    hint: 'Something impossible alone. This is the heart of it.',
  },
  {
    id: 'hazard',
    slot: 'hazard',
    question: "What's trying to ruin it?",
    placeholder: 'rising acid and angry crabs',
    hint: 'The thing that makes you lose.',
  },
  {
    id: 'powerup',
    slot: 'powerup',
    question: "What's the best pickup in the game?",
    placeholder: 'a soda that reverses gravity',
    hint: 'Rare, loud, slightly unfair.',
  },
  {
    id: 'twist',
    slot: 'twist',
    question: 'What rule would break this game in the best way?',
    placeholder: 'the floor is lava every 10 seconds',
    hint: 'Go too far. We can dial it back.',
  },
  {
    id: 'vibe',
    slot: 'vibe',
    question: 'What does it look and sound like?',
    placeholder: 'sun-bleached 80s arcade, chunky pixels',
    hint: 'Colors, era, mood.',
  },
  {
    id: 'title',
    slot: 'title',
    question: 'Name it.',
    placeholder: 'CRAB DEPTH 9',
    hint: 'Short. Loud. On the cabinet.',
  },
];

export const JAM_MIN_ROUNDS = 3;
export const JAM_MAX_ROUNDS = JAM_PROMPT_DECK.length;
export const JAM_DEFAULT_ROUNDS = 6;

/** Deck lookup by id — used to render a round and to compile answers. */
export function jamPromptById(id: string): JamPromptCard | null {
  return JAM_PROMPT_DECK.find((c) => c.id === id) ?? null;
}

/**
 * The rounds a jam plays, given how many the host asked for. Always starts with
 * the world-building cards and always ends on `title`, so a short 3-round jam
 * still produces a NAMED game rather than a title-less fragment.
 */
export function jamRoundPlan(rounds: number): JamPromptCard[] {
  const total = Math.max(JAM_MIN_ROUNDS, Math.min(JAM_MAX_ROUNDS, Math.floor(rounds)));
  const title = JAM_PROMPT_DECK[JAM_PROMPT_DECK.length - 1];
  const body = JAM_PROMPT_DECK.slice(0, JAM_PROMPT_DECK.length - 1);
  if (!title) return body.slice(0, total);
  return [...body.slice(0, total - 1), title];
}

// ── Answers & votes ──────────────────────────────────────────────────────────

export const JamAnswer = z.object({
  id: z.string(),
  round: z.number().int().min(0),
  promptId: z.string(),
  playerId: z.string(),
  text: z.string().max(JAM_MAX_ANSWER_LEN),
  /** Hype votes from other players during the reveal. Ties break on order. */
  votes: z.number().int().min(0),
  createdAt: z.string(),
});
export type JamAnswer = z.infer<typeof JamAnswer>;

// ── Room state ───────────────────────────────────────────────────────────────

/**
 * Room lifecycle.
 *   lobby    — waiting for friends; host can start once 2 are in
 *   prompt   — everyone answers the current card on their own phone
 *   reveal   — answers flip face-up; players vote for the one they love
 *   building — the compiled brief is generating; the room watches together
 *   ready    — the game is playable; the room gets the play link
 *   ended    — host closed the room
 */
export const JamPhase = z.enum(['lobby', 'prompt', 'reveal', 'building', 'ready', 'ended']);
export type JamPhase = z.infer<typeof JamPhase>;

export const JamEngine = z.enum(['phaser', 'three']);
export type JamEngine = z.infer<typeof JamEngine>;

export const JamConfig = z.object({
  /** How many prompt cards this jam plays. */
  rounds: z.number().int().min(JAM_MIN_ROUNDS).max(JAM_MAX_ROUNDS),
  engine: JamEngine,
  /** Seconds a player has to answer a card. 0 = untimed (host advances). */
  answerSeconds: z.number().int().min(0).max(300),
});
export type JamConfig = z.infer<typeof JamConfig>;

export const JAM_DEFAULT_CONFIG: JamConfig = {
  rounds: JAM_DEFAULT_ROUNDS,
  engine: 'phaser',
  answerSeconds: 60,
};

/** The full room snapshot broadcast to every connected phone on any change. */
export const JamState = z.object({
  schemaVersion: z.number().int(),
  id: z.string(),
  code: z.string(),
  hostPlayerId: z.string(),
  phase: JamPhase,
  config: JamConfig,
  /** 0-based index into `jamRoundPlan(config.rounds)`. */
  round: z.number().int().min(0),
  /** Deck card ids for this jam's rounds, in play order. */
  roundPromptIds: z.array(z.string()),
  players: z.array(JamPlayer),
  /** Answers from COMPLETED rounds plus the current round once revealed.
   *  During `prompt` the current round's answers are withheld (see
   *  `redactJamState`) so nobody copies. */
  answers: z.array(JamAnswer),
  /** Player ids who have answered the current round — drives the "3/5 in" pill
   *  without leaking the answers themselves. */
  answeredPlayerIds: z.array(z.string()),
  /** Epoch ms when the current prompt round's timer expires; null when untimed. */
  deadlineAt: z.number().nullable(),
  /** Set once the host hits Build. */
  projectId: z.string().nullable(),
  runId: z.string().nullable(),
  /** Published play slug, once the built game is live. */
  playSlug: z.string().nullable(),
  /** The title the room landed on, shown in the header the moment it's answered. */
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JamState = z.infer<typeof JamState>;

/**
 * What a given player is allowed to see. During `prompt`, the current round's
 * answers are stripped for everyone else so the room doesn't anchor on whoever
 * typed fastest — the reveal is the payoff. A player always keeps their OWN
 * current answer so their phone can show it back ("locked in: …") after a
 * reconnect.
 */
export function redactJamState(state: JamState, viewerPlayerId: string | null): JamState {
  if (state.phase !== 'prompt') return state;
  return {
    ...state,
    answers: state.answers.filter((a) => a.round !== state.round || a.playerId === viewerPlayerId),
  };
}

// ── Wire events (WebSocket) ──────────────────────────────────────────────────

/** Server → client. `state` carries the full (redacted) room on every change. */
export const JamServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('jam_state'), state: JamState }),
  /** A transient nudge worth animating: someone joined, an answer landed, etc. */
  z.object({
    type: z.literal('jam_toast'),
    kind: z.enum(['join', 'leave', 'answer', 'vote', 'phase', 'error']),
    message: z.string(),
    playerId: z.string().nullable(),
  }),
  z.object({ type: z.literal('jam_error'), error: z.string() }),
]);
export type JamServerEvent = z.infer<typeof JamServerEvent>;

/** Client → server. Kept tiny: everything else goes over REST. */
export const JamClientEvent = z.discriminatedUnion('type', [z.object({ type: z.literal('ping') })]);
export type JamClientEvent = z.infer<typeof JamClientEvent>;

/** Channel name for a jam room's fan-out on the shared event bus. */
export function jamChannel(jamId: string): string {
  return `jam:${jamId}`;
}

// ── Compilation ──────────────────────────────────────────────────────────────

/** Grouped answers, ready to render into the brief. */
export interface JamIdea {
  slot: JamPromptSlot;
  question: string;
  entries: Array<{ author: string; color: string; text: string; votes: number }>;
}

/**
 * Group a jam's answers by prompt slot, in deck order, dropping empties. Within
 * a slot the most-hyped idea leads, so the compiled brief reads with the room's
 * favorite first.
 */
export function collectJamIdeas(state: JamState): JamIdea[] {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const ideas: JamIdea[] = [];
  for (const promptId of state.roundPromptIds) {
    const card = jamPromptById(promptId);
    if (!card) continue;
    const entries = state.answers
      .filter((a) => a.promptId === promptId && a.text.trim() !== '')
      .map((a) => {
        const player = byId.get(a.playerId);
        return {
          author: player?.name ?? 'Someone',
          color: player?.color ?? 'cyan',
          text: a.text.trim(),
          votes: a.votes,
        };
      })
      .sort((a, b) => b.votes - a.votes);
    if (entries.length > 0) ideas.push({ slot: card.slot, question: card.question, entries });
  }
  return ideas;
}

/** The title the room picked — the top-voted `title` answer, if any. */
export function jamTitleFromState(state: JamState): string | null {
  const titlePromptIds = new Set(
    state.roundPromptIds.filter((id) => jamPromptById(id)?.slot === 'title'),
  );
  const candidates = state.answers
    .filter((a) => titlePromptIds.has(a.promptId) && a.text.trim() !== '')
    .sort((a, b) => b.votes - a.votes || (a.createdAt < b.createdAt ? -1 : 1));
  return candidates[0]?.text.trim() ?? null;
}

/** Label used for a slot's heading inside the compiled brief. */
const SLOT_HEADING: Record<JamPromptSlot, string> = {
  setting: 'Setting',
  hero: 'The players are',
  goal: 'Win condition',
  mechanic: 'Core verb',
  hazard: 'Lose condition / threat',
  coop: 'Co-op hook (the most important one)',
  powerup: 'Signature pickup',
  twist: 'The twist rule',
  vibe: 'Art & audio direction',
  title: 'Title',
};

/**
 * Per-player keyboard layouts baked into the brief. Four distinct schemes on
 * one keyboard is the practical ceiling for couch play; a 5th+ player shares
 * via gamepad or a passed phone, which the touch-zone requirement covers.
 */
const KEYBOARD_LAYOUTS = [
  'P1 = WASD to move, Space to act',
  'P2 = Arrow keys to move, Enter to act',
  'P3 = IJKL to move, N to act',
  'P4 = Numpad 8/4/5/6 to move, Numpad 0 to act',
];

export interface CompiledJamBrief {
  /** Project name — the room's title, or a fallback built from the setting. */
  name: string;
  /** The prompt handed to the generation agent. */
  prompt: string;
  engine: JamEngine;
  /** Number of players the game must seat locally. */
  playerCount: number;
}

/**
 * Turn a finished jam into ONE generation brief.
 *
 * The shape is deliberate: the agent gets (1) a hard requirement that this is a
 * same-screen game for N players with per-player controls, (2) the room's ideas
 * grouped by role with attribution, and (3) an instruction to WEAVE conflicting
 * ideas rather than pick a winner — the whole point of a jam is that four
 * incompatible ideas end up in the same game. Attribution is kept because
 * seeing "Maya's acid crabs" in your own game is the moment that sells this.
 *
 * Pure and deterministic: same state in, same string out.
 */
export function compileJamBrief(state: JamState): CompiledJamBrief {
  const ideas = collectJamIdeas(state);
  const playerCount = Math.max(JAM_MIN_PLAYERS, Math.min(JAM_MAX_PLAYERS, state.players.length));
  const title = jamTitleFromState(state);
  const settingIdea = ideas.find((i) => i.slot === 'setting')?.entries[0]?.text;
  const name = title ?? (settingIdea ? toTitleCase(settingIdea) : 'Game Jam');

  const roster = state.players.map((p, i) => `  P${i + 1} — ${p.name} (${p.color})`).join('\n');

  const ideaBlock = ideas
    .map((idea) => {
      const lines = idea.entries
        .map((e) => `  - "${e.text}" — ${e.author}${e.votes > 0 ? ` (${e.votes} votes)` : ''}`)
        .join('\n');
      return `${SLOT_HEADING[idea.slot]}:\n${lines}`;
    })
    .join('\n\n');

  const controls = KEYBOARD_LAYOUTS.slice(0, Math.min(playerCount, KEYBOARD_LAYOUTS.length)).join(
    '; ',
  );

  const prompt = [
    `Build a LOCAL MULTIPLAYER game for ${playerCount} players on ONE shared screen, titled "${name}".`,
    '',
    `This came out of a game jam: ${state.players.length} people each threw in ideas and every one of them has to end up in the game. Where two ideas contradict, WEAVE them together into something stranger rather than dropping one — a jam game is supposed to be a collision.`,
    '',
    'Players in this jam (use these names and colors for the in-game characters):',
    roster,
    '',
    'The ideas:',
    '',
    ideaBlock,
    '',
    'Hard requirements:',
    `- ${playerCount} players play at the SAME TIME on the SAME screen. There is no networking — no sockets, no fetch, no online play. Everything runs locally in one page.`,
    `- Give every player their own controls on one keyboard and label them on the title screen: ${controls}. Also read gamepads via the Gamepad API when present (player N uses gamepad N).`,
    '- Touch devices: render on-screen control zones, one per player, split across the screen, so this is playable on a phone or tablet passed around the group.',
    "- Each player's character is visibly their jam color, with their name above it, so everyone can find themselves instantly.",
    '- The co-op hook above must be a real mechanic, not flavor text — something the group physically cannot do with one player.',
    '- Include a shared score or progress bar the whole room can see, a win screen naming the players, and a lose screen with an instant restart (R or a big on-screen button).',
    '- Start on a title screen showing the game name, the player roster with their colors, the controls above, and a "press any key / tap to start" prompt.',
    '- Nobody should be dead and idle for long: respawn eliminated players quickly, or give them something to do that still affects the others.',
    '- Playable and readable within seconds of loading. No tutorials, no menus beyond the title screen.',
  ].join('\n');

  return { name: name.slice(0, 120), prompt, engine: state.config.engine, playerCount };
}

/** Sentence-cased fallback title from a free-text idea. */
function toTitleCase(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 60);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Is the room ready to build? A jam needs at least two players and at least one
 * idea on the board — a room that skipped every card would otherwise compile
 * into a bare "build a local multiplayer game" with nothing of the party in it.
 */
export function canCompileJam(state: JamState): boolean {
  return state.players.length >= JAM_MIN_PLAYERS && state.answers.some((a) => a.text.trim() !== '');
}
