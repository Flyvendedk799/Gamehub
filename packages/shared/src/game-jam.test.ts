import { describe, expect, it } from 'vitest';
import {
  JAM_CODE_ALPHABET,
  JAM_CODE_LENGTH,
  JAM_DEFAULT_CONFIG,
  JAM_KEYBOARD_SEATS,
  JAM_MAX_ANSWER_LEN,
  JAM_MAX_NAME_LEN,
  JAM_MAX_ROUNDS,
  JAM_MIN_ROUNDS,
  JAM_PROMPT_DECK,
  JAM_SCHEMA_VERSION,
  type JamAnswer,
  JamCode,
  type JamPlayer,
  type JamState,
  canCompileJam,
  collectJamIdeas,
  compileJamBrief,
  generateJamCode,
  jamChannel,
  jamColorForSeat,
  jamPromptById,
  jamRoundPlan,
  jamTitleFromState,
  normalizeJamCode,
  redactJamState,
  sanitizeJamAnswer,
  sanitizeJamName,
} from './game-jam';

function player(over: Partial<JamPlayer> & { id: string; name: string }): JamPlayer {
  return {
    userId: null,
    color: 'cyan',
    seat: 0,
    isHost: false,
    connected: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function answer(
  over: Partial<JamAnswer> & { id: string; promptId: string; playerId: string },
): JamAnswer {
  return {
    round: 0,
    text: 'idea',
    votes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function state(over: Partial<JamState> = {}): JamState {
  return {
    schemaVersion: JAM_SCHEMA_VERSION,
    id: 'jam_1',
    code: 'ACDE',
    hostPlayerId: 'p1',
    phase: 'lobby',
    config: JAM_DEFAULT_CONFIG,
    round: 0,
    roundPromptIds: jamRoundPlan(JAM_DEFAULT_CONFIG.rounds).map((c) => c.id),
    players: [
      player({ id: 'p1', name: 'Maya', seat: 0, isHost: true, color: 'cyan' }),
      player({ id: 'p2', name: 'Tobi', seat: 1, color: 'lime' }),
    ],
    answers: [],
    answeredPlayerIds: [],
    deadlineAt: null,
    projectId: null,
    runId: null,
    playSlug: null,
    title: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('room codes', () => {
  it('generates codes only from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJamCode();
      expect(code).toHaveLength(JAM_CODE_LENGTH);
      for (const ch of code) expect(JAM_CODE_ALPHABET).toContain(ch);
    }
  });

  it('is deterministic with an injected rand', () => {
    const seq = [0, 0.5, 0.99, 0.25];
    let i = 0;
    const rand = () => seq[i++ % seq.length] ?? 0;
    expect(generateJamCode(rand)).toBe(generateJamCode(() => seq[i++ % seq.length] ?? 0));
  });

  it('excludes every look-alike character', () => {
    for (const ch of '01258BILOSUVZ') expect(JAM_CODE_ALPHABET).not.toContain(ch);
  });

  it('folds look-alikes typed by a human onto the real alphabet', () => {
    expect(normalizeJamCode('a-c d e')).toBe('ACDE');
    expect(normalizeJamCode('0o1l')).toBe('QQJJ');
    expect(normalizeJamCode('5288')).toBe('FXKK');
    expect(normalizeJamCode('uvac')).toBe('WWAC');
  });

  it('truncates over-long input to the code length', () => {
    expect(normalizeJamCode('ACDEFGH')).toHaveLength(JAM_CODE_LENGTH);
  });

  it('parses valid codes case-insensitively and rejects junk', () => {
    expect(JamCode.parse(' acde ')).toBe('ACDE');
    expect(JamCode.safeParse('AC').success).toBe(false);
    expect(JamCode.safeParse('ACD0').success).toBe(false);
  });
});

describe('sanitizers', () => {
  it('strips control characters and angle brackets from names', () => {
    // Replaced with a space, not deleted, so stripped markup can't silently
    // fuse two words into one ("a<b" must never read back as "ab").
    expect(sanitizeJamName('Ma\u0007ya<script>')).toBe('Ma ya script');
  });

  it('keeps punctuation, digits and emoji in names', () => {
    expect(sanitizeJamName("D'Andre-7 🎮")).toBe("D'Andre-7 🎮");
  });

  it('caps a name at the max length', () => {
    expect(sanitizeJamName('x'.repeat(80))).toHaveLength(JAM_MAX_NAME_LEN);
  });

  it('caps an answer at the answer length, not the name length', () => {
    expect(sanitizeJamAnswer('y'.repeat(400))).toHaveLength(JAM_MAX_ANSWER_LEN);
  });

  it('collapses whitespace so a padded answer is not "answered"', () => {
    expect(sanitizeJamAnswer('  a   sinking\n\nship  ')).toBe('a sinking ship');
    expect(sanitizeJamAnswer('   ')).toBe('');
  });
});

describe('seat colors', () => {
  it('assigns a distinct color per seat and wraps past the palette', () => {
    expect(jamColorForSeat(0).id).toBe('cyan');
    expect(jamColorForSeat(1).id).toBe('lime');
    expect(jamColorForSeat(8).id).toBe(jamColorForSeat(0).id);
  });

  it('never returns undefined for a negative seat', () => {
    expect(jamColorForSeat(-1).hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('deck + round plan', () => {
  it('exposes unique prompt ids', () => {
    const ids = JAM_PROMPT_DECK.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a card up by id', () => {
    expect(jamPromptById('coop')?.slot).toBe('coop');
    expect(jamPromptById('nope')).toBeNull();
  });

  it('always ends a jam on the title card, however short', () => {
    for (const n of [JAM_MIN_ROUNDS, 5, JAM_MAX_ROUNDS]) {
      const plan = jamRoundPlan(n);
      expect(plan).toHaveLength(n);
      expect(plan[plan.length - 1]?.slot).toBe('title');
    }
  });

  it('clamps out-of-range round counts', () => {
    expect(jamRoundPlan(1)).toHaveLength(JAM_MIN_ROUNDS);
    expect(jamRoundPlan(999)).toHaveLength(JAM_MAX_ROUNDS);
  });

  it('never repeats a card within one plan', () => {
    const ids = jamRoundPlan(JAM_MAX_ROUNDS).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('redactJamState', () => {
  const answering = state({
    phase: 'prompt',
    round: 1,
    answers: [
      answer({ id: 'a1', promptId: 'setting', playerId: 'p1', round: 0, text: 'a submarine' }),
      answer({ id: 'a2', promptId: 'hero', playerId: 'p1', round: 1, text: 'vending machines' }),
      answer({ id: 'a3', promptId: 'hero', playerId: 'p2', round: 1, text: 'angry crabs' }),
    ],
  });

  it("hides other players' answers for the in-flight round", () => {
    const seen = redactJamState(answering, 'p1');
    expect(seen.answers.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('keeps prior rounds fully visible', () => {
    expect(redactJamState(answering, 'p2').answers.some((a) => a.id === 'a1')).toBe(true);
  });

  it('hides the whole round from a spectator with no player id', () => {
    expect(redactJamState(answering, null).answers.map((a) => a.id)).toEqual(['a1']);
  });

  it('reveals everything once the phase flips to reveal', () => {
    const revealed = redactJamState({ ...answering, phase: 'reveal' }, 'p1');
    expect(revealed.answers).toHaveLength(3);
  });
});

describe('collectJamIdeas', () => {
  const jam = state({
    answers: [
      answer({ id: 'a1', promptId: 'setting', playerId: 'p1', text: 'a sinking submarine' }),
      answer({ id: 'a2', promptId: 'setting', playerId: 'p2', text: 'a haunted mall', votes: 3 }),
      answer({ id: 'a3', promptId: 'hero', playerId: 'p1', text: '  ' }),
    ],
  });

  it('groups answers by prompt in deck order', () => {
    const ideas = collectJamIdeas(jam);
    expect(ideas.map((i) => i.slot)).toEqual(['setting']);
  });

  it('puts the most-voted idea first', () => {
    expect(collectJamIdeas(jam)[0]?.entries[0]?.text).toBe('a haunted mall');
  });

  it('attributes each idea to its author and color', () => {
    const top = collectJamIdeas(jam)[0]?.entries[0];
    expect(top?.author).toBe('Tobi');
    expect(top?.color).toBe('lime');
  });

  it('drops blank answers entirely', () => {
    expect(collectJamIdeas(jam).some((i) => i.slot === 'hero')).toBe(false);
  });

  it('falls back to a neutral author when the player left the roster', () => {
    const orphan = state({
      players: [],
      answers: [answer({ id: 'a1', promptId: 'setting', playerId: 'ghost', text: 'the void' })],
    });
    expect(collectJamIdeas(orphan)[0]?.entries[0]?.author).toBe('Someone');
  });
});

describe('jamTitleFromState', () => {
  it('picks the top-voted title answer', () => {
    const jam = state({
      answers: [
        answer({ id: 'a1', promptId: 'title', playerId: 'p1', text: 'MALL CRAWL' }),
        answer({ id: 'a2', promptId: 'title', playerId: 'p2', text: 'CRAB DEPTH 9', votes: 2 }),
      ],
    });
    expect(jamTitleFromState(jam)).toBe('CRAB DEPTH 9');
  });

  it('breaks a vote tie on the earlier answer', () => {
    const jam = state({
      answers: [
        answer({
          id: 'a1',
          promptId: 'title',
          playerId: 'p1',
          text: 'FIRST',
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
        answer({
          id: 'a2',
          promptId: 'title',
          playerId: 'p2',
          text: 'SECOND',
          createdAt: '2026-01-01T00:00:02.000Z',
        }),
      ],
    });
    expect(jamTitleFromState(jam)).toBe('FIRST');
  });

  it('returns null when nobody named the game', () => {
    expect(jamTitleFromState(state())).toBeNull();
  });
});

describe('compileJamBrief', () => {
  const jam = state({
    players: [
      player({ id: 'p1', name: 'Maya', seat: 0, isHost: true, color: 'cyan' }),
      player({ id: 'p2', name: 'Tobi', seat: 1, color: 'lime' }),
      player({ id: 'p3', name: 'Sam', seat: 2, color: 'amber' }),
    ],
    answers: [
      answer({ id: 'a1', promptId: 'setting', playerId: 'p1', text: 'a sinking neon submarine' }),
      answer({ id: 'a2', promptId: 'hero', playerId: 'p2', text: 'rival vending machines' }),
      answer({ id: 'a3', promptId: 'coop', playerId: 'p3', text: 'one pumps while one steers' }),
      answer({ id: 'a4', promptId: 'title', playerId: 'p1', text: 'CRAB DEPTH 9' }),
    ],
  });

  it('names the project after the room title', () => {
    expect(compileJamBrief(jam).name).toBe('CRAB DEPTH 9');
  });

  it('falls back to the setting when nobody named it', () => {
    const untitled = compileJamBrief(state({ ...jam, answers: jam.answers.slice(0, 3) }));
    expect(untitled.name).toBe('A sinking neon submarine');
  });

  it('falls back again when there are no ideas at all', () => {
    expect(compileJamBrief(state()).name).toBe('Game Jam');
  });

  it('demands local multiplayer for the whole party', () => {
    const { prompt, playerCount } = compileJamBrief(jam);
    expect(playerCount).toBe(3);
    expect(prompt).toContain('LOCAL MULTIPLAYER game for 3 players');
    expect(prompt).toContain('SAME screen');
  });

  it('rules out networking explicitly (published games run under connect-src none)', () => {
    expect(compileJamBrief(jam).prompt).toContain('There is no networking');
  });

  it('includes every idea with its author', () => {
    const { prompt } = compileJamBrief(jam);
    expect(prompt).toContain('a sinking neon submarine');
    expect(prompt).toContain('rival vending machines');
    expect(prompt).toContain('one pumps while one steers');
    expect(prompt).toContain('— Maya');
    expect(prompt).toContain('— Sam');
  });

  it('lists the roster with names and colors so players find themselves', () => {
    const { prompt } = compileJamBrief(jam);
    expect(prompt).toContain('P1 — Maya (cyan)');
    expect(prompt).toContain('P3 — Sam (amber)');
  });

  it('asks the agent to weave contradictions instead of dropping them', () => {
    expect(compileJamBrief(jam).prompt).toContain('WEAVE');
  });

  it('spells out one control scheme per seated player', () => {
    const { prompt } = compileJamBrief(jam);
    expect(prompt).toContain('P1 = WASD');
    expect(prompt).toContain('P3 = IJKL');
    expect(prompt).not.toContain('P4 = Numpad');
  });

  it('caps keyboard schemes at four even for a big room', () => {
    const big = state({
      players: Array.from({ length: 6 }, (_, i) =>
        player({ id: `p${i}`, name: `P${i}`, seat: i, color: jamColorForSeat(i).id }),
      ),
      answers: jam.answers,
    });
    const { prompt, playerCount } = compileJamBrief(big);
    expect(playerCount).toBe(6);
    expect(prompt).toContain('P4 = Numpad');
    expect(prompt).not.toContain('P5 =');
  });

  it('asks for touch zones so phones can play', () => {
    expect(compileJamBrief(jam).prompt).toContain('on-screen control zones');
  });

  it('carries the room engine through', () => {
    const three = compileJamBrief(state({ ...jam, config: { ...jam.config, engine: 'three' } }));
    expect(three.engine).toBe('three');
  });

  it('is deterministic', () => {
    expect(compileJamBrief(jam).prompt).toBe(compileJamBrief(jam).prompt);
  });

  it('caps the project name at the API name limit', () => {
    const shouty = state({
      ...jam,
      answers: [answer({ id: 'a1', promptId: 'title', playerId: 'p1', text: 'Z'.repeat(140) })],
    });
    expect(compileJamBrief(shouty).name.length).toBeLessThanOrEqual(120);
  });

  it('seats at least two players even if someone left mid-jam', () => {
    const lonely = state({ ...jam, players: jam.players.slice(0, 1) });
    expect(compileJamBrief(lonely).playerCount).toBe(2);
  });
});

describe('canCompileJam', () => {
  it('needs two players', () => {
    const solo = state({
      players: [player({ id: 'p1', name: 'Maya', isHost: true })],
      answers: [answer({ id: 'a1', promptId: 'setting', playerId: 'p1', text: 'a mall' })],
    });
    expect(canCompileJam(solo)).toBe(false);
  });

  it('needs at least one real idea', () => {
    expect(canCompileJam(state())).toBe(false);
    expect(
      canCompileJam(
        state({ answers: [answer({ id: 'a', promptId: 'setting', playerId: 'p1', text: '   ' })] }),
      ),
    ).toBe(false);
  });

  it('passes once a party has ideas on the board', () => {
    const ready = state({
      answers: [answer({ id: 'a1', promptId: 'setting', playerId: 'p1', text: 'a mall' })],
    });
    expect(canCompileJam(ready)).toBe(true);
  });
});

describe('jamChannel', () => {
  it('namespaces a room off the run channels', () => {
    expect(jamChannel('abc')).toBe('jam:abc');
  });
});

describe('JAM_KEYBOARD_SEATS', () => {
  it('is the single source for both the brief and the room UI', () => {
    const { prompt } = compileJamBrief(
      state({
        players: Array.from({ length: 4 }, (_, i) =>
          player({ id: `p${i}`, name: `P${i}`, seat: i, color: jamColorForSeat(i).id }),
        ),
        answers: [answer({ id: 'a1', promptId: 'setting', playerId: 'p0', text: 'a mall' })],
      }),
    );
    // Every seat's brief text must actually reach the agent, and its label must
    // describe the same keys — a mismatch tells a player the wrong controls.
    for (const seat of JAM_KEYBOARD_SEATS) {
      expect(prompt).toContain(seat.brief);
    }
    expect(JAM_KEYBOARD_SEATS[0]?.label).toBe('WASD + Space');
    expect(JAM_KEYBOARD_SEATS[0]?.brief).toContain('WASD');
    expect(JAM_KEYBOARD_SEATS[3]?.label).toContain('Numpad');
    expect(JAM_KEYBOARD_SEATS[3]?.brief).toContain('Numpad');
  });

  it('caps at four, the practical ceiling for one keyboard', () => {
    expect(JAM_KEYBOARD_SEATS).toHaveLength(4);
  });
});
