/**
 * Turn tool calls into things a person recognises.
 *
 * The builder used to show `str_replace_based_edit_tool` — or, once the phase
 * hint kicked in, just "Building your game…" for twenty minutes. Both are true
 * and neither tells you anything. Watching a build should feel like watching
 * someone work: drawing the sprites, writing the movement, playing it to check.
 *
 * Everything needed is already in the stream. `tool_execution_start` carries the
 * tool name and its arguments, including the file path, so "editing
 * src/main.js" is knowable — it was simply never phrased.
 *
 * Two rules:
 *
 *  - **Say the thing, not the mechanism.** "Drawing sprites", not
 *    "generate_image_asset". The mechanism is only interesting when it breaks.
 *  - **Accumulate.** A single replaced line hides that anything is progressing;
 *    a list that grows shows the shape of the work and makes a long build feel
 *    like a long build rather than a hang.
 */

export type ActivityKind = 'design' | 'assets' | 'audio' | 'code' | 'test' | 'polish';

export interface Activity {
  readonly kind: ActivityKind;
  /** Present tense, for the live line: "Drawing sprites". */
  readonly label: string;
}

/** What the file being edited actually is, as far as a person cares. */
function describeEdit(path: string | undefined): Activity {
  if (path === undefined || path.length === 0) {
    return { kind: 'code', label: 'Writing code' };
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.css') || lower.includes('style')) {
    return { kind: 'code', label: 'Styling the interface' };
  }
  if (lower.endsWith('.html')) {
    return { kind: 'code', label: 'Laying out the page' };
  }
  if (lower.includes('level') || lower.includes('map') || lower.includes('world')) {
    return { kind: 'code', label: 'Building the world' };
  }
  if (lower.includes('player') || lower.includes('character')) {
    return { kind: 'code', label: 'Writing the player' };
  }
  // 'enem' so both enemy.js and enemies.js land here.
  if (lower.includes('enem') || lower.includes('spawn') || lower.includes('mob')) {
    return { kind: 'code', label: 'Writing the enemies' };
  }
  if (lower.includes('ui') || lower.includes('hud') || lower.includes('menu')) {
    return { kind: 'code', label: 'Building the UI' };
  }
  if (lower.includes('audio') || lower.includes('sound')) {
    return { kind: 'audio', label: 'Wiring up sound' };
  }
  // Named rather than generic: seeing the filename is worth something, and it
  // is the honest answer when the name says nothing else.
  const file = path.split('/').pop() ?? path;
  return { kind: 'code', label: `Writing ${file}` };
}

const STATIC: Record<string, Activity> = {
  declare_game_spec: { kind: 'design', label: 'Deciding the design' },
  amend_game_spec: { kind: 'design', label: 'Revising the design' },
  choose_engine: { kind: 'design', label: 'Choosing the engine' },
  declare_tweak_schema: { kind: 'design', label: 'Setting up live controls' },
  declare_playtest_contract: { kind: 'design', label: 'Deciding how to test it' },
  set_todos: { kind: 'design', label: 'Planning the steps' },

  generate_image_asset: { kind: 'assets', label: 'Drawing sprites' },
  create_game_artifact: { kind: 'assets', label: 'Making art' },
  bind_animation_to_sprite: { kind: 'assets', label: 'Animating sprites' },
  inspect_game_artifact: { kind: 'assets', label: 'Checking the art' },
  list_game_artifacts: { kind: 'assets', label: 'Reviewing the art' },

  generate_audio_asset: { kind: 'audio', label: 'Making sound effects' },

  playtest_game: { kind: 'test', label: 'Playing it to check' },
  verify_artifact: { kind: 'test', label: 'Checking it runs' },
  validate_game_scene: { kind: 'test', label: 'Checking the scene' },
  assert_game_invariants: { kind: 'test', label: 'Checking the rules hold' },
  get_playtest_playbook: { kind: 'test', label: 'Working out how to test it' },
  runtime_verify: { kind: 'test', label: 'Booting the game' },

  list_game_feel: { kind: 'polish', label: 'Looking for polish to add' },
  view_game_feel: { kind: 'polish', label: 'Adding game feel' },
  add_controller_support: { kind: 'polish', label: 'Adding controller support' },
  render_preview: { kind: 'polish', label: 'Rendering a preview' },

  read_url: { kind: 'design', label: 'Reading reference material' },
  list_files: { kind: 'code', label: 'Looking over the files' },
};

/**
 * Describe one tool call.
 *
 * Returns null for calls with nothing worth showing — a `view` is the agent
 * reading, not building, and narrating it would bury the real steps under
 * dozens of "looking at src/main.js".
 */
export function describeActivity(
  toolName: string,
  args?: Record<string, unknown> | undefined,
): Activity | null {
  if (toolName === 'str_replace_based_edit_tool') {
    const command = typeof args?.['command'] === 'string' ? args['command'] : '';
    if (command === 'view') return null;
    const path = typeof args?.['path'] === 'string' ? args['path'] : undefined;
    return describeEdit(path);
  }
  return STATIC[toolName] ?? null;
}

export interface BuildStep {
  readonly kind: ActivityKind;
  readonly label: string;
  /** How many consecutive calls collapsed into this step. */
  readonly count: number;
}

/**
 * Collapse a stream of activities into the list a person reads.
 *
 * Consecutive repeats become one row with a count. Ten edits to the player
 * controller is one line of work, not ten — and rendering it ten times pushes
 * everything else off the screen, which is what made the old view useless.
 */
export function collapseSteps(activities: readonly Activity[], limit = 12): BuildStep[] {
  const steps: BuildStep[] = [];
  for (const activity of activities) {
    const last = steps[steps.length - 1];
    if (last !== undefined && last.label === activity.label) {
      steps[steps.length - 1] = { ...last, count: last.count + 1 };
      continue;
    }
    steps.push({ kind: activity.kind, label: activity.label, count: 1 });
  }
  // Keep the tail: what it is doing now matters more than how it started.
  return steps.length > limit ? steps.slice(steps.length - limit) : steps;
}
