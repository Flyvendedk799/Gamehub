import { describe, expect, it } from 'vitest';
import { type Activity, collapseSteps, describeActivity } from '../build-activity';

describe('describeActivity', () => {
  it('names the work, not the tool', () => {
    // "generate_image_asset" tells you nothing unless you wrote the tool.
    expect(describeActivity('generate_image_asset')?.label).toBe('Drawing sprites');
    expect(describeActivity('generate_audio_asset')?.label).toBe('Making sound effects');
    expect(describeActivity('playtest_game')?.label).toBe('Playing it to check');
  });

  it('reads the file being edited', () => {
    const edit = (path: string) =>
      describeActivity('str_replace_based_edit_tool', { command: 'patch', path })?.label;

    expect(edit('src/player.js')).toBe('Writing the player');
    expect(edit('src/enemies.js')).toBe('Writing the enemies');
    expect(edit('src/hud.js')).toBe('Building the UI');
    expect(edit('styles.css')).toBe('Styling the interface');
    expect(edit('index.html')).toBe('Laying out the page');
    expect(edit('src/level1.js')).toBe('Building the world');
  });

  it('falls back to the filename rather than something generic', () => {
    // Seeing the filename is worth something; "Writing code" is not.
    expect(
      describeActivity('str_replace_based_edit_tool', { command: 'create', path: 'src/grapple.js' })
        ?.label,
    ).toBe('Writing grapple.js');
  });

  it('says nothing for a view', () => {
    // The agent reading is not the agent building, and narrating every view
    // buries the real steps.
    expect(
      describeActivity('str_replace_based_edit_tool', { command: 'view', path: 'src/main.js' }),
    ).toBeNull();
  });

  it('says nothing for tools with no user-visible meaning', () => {
    expect(describeActivity('some_internal_tool')).toBeNull();
  });

  it('handles a missing path without throwing', () => {
    expect(describeActivity('str_replace_based_edit_tool', { command: 'patch' })?.label).toBe(
      'Writing code',
    );
    expect(describeActivity('str_replace_based_edit_tool')?.label).toBe('Writing code');
  });

  it('classifies work into kinds the UI can colour', () => {
    expect(describeActivity('declare_game_spec')?.kind).toBe('design');
    expect(describeActivity('generate_image_asset')?.kind).toBe('assets');
    expect(describeActivity('generate_audio_asset')?.kind).toBe('audio');
    expect(describeActivity('verify_artifact')?.kind).toBe('test');
    expect(describeActivity('view_game_feel')?.kind).toBe('polish');
  });
});

describe('collapseSteps', () => {
  const a = (label: string, kind: Activity['kind'] = 'code'): Activity => ({ kind, label });

  it('collapses consecutive repeats into one row with a count', () => {
    // Ten edits to the player controller is one line of work, not ten.
    const steps = collapseSteps([
      a('Writing the player'),
      a('Writing the player'),
      a('Writing the player'),
    ]);
    expect(steps).toEqual([{ kind: 'code', label: 'Writing the player', count: 3 }]);
  });

  it('keeps distinct steps apart', () => {
    const steps = collapseSteps([a('Drawing sprites', 'assets'), a('Writing the player')]);
    expect(steps.map((step) => step.label)).toEqual(['Drawing sprites', 'Writing the player']);
  });

  it('does not merge repeats that are not adjacent', () => {
    // Coming back to a file later is a real, separate piece of work.
    const steps = collapseSteps([
      a('Writing the player'),
      a('Drawing sprites'),
      a('Writing the player'),
    ]);
    expect(steps).toHaveLength(3);
  });

  it('keeps the tail when there are more steps than fit', () => {
    const many = Array.from({ length: 30 }, (_, i) => a(`Step ${i}`));
    const steps = collapseSteps(many, 5);
    // What it is doing now matters more than how it started.
    expect(steps).toHaveLength(5);
    expect(steps[steps.length - 1]?.label).toBe('Step 29');
  });

  it('handles an empty stream', () => {
    expect(collapseSteps([])).toEqual([]);
  });
});

describe('the run that showed nothing', () => {
  it('turns that run’s tool stream into readable progress', () => {
    // The real sequence from run 5f7e6510, abbreviated: a spec, some audio,
    // a pile of edits and views, then playtests.
    const calls: Array<[string, Record<string, unknown> | undefined]> = [
      ['declare_game_spec', undefined],
      ['choose_engine', undefined],
      ['generate_audio_asset', undefined],
      ['generate_audio_asset', undefined],
      ['str_replace_based_edit_tool', { command: 'create', path: 'src/main.js' }],
      ['str_replace_based_edit_tool', { command: 'view', path: 'src/main.js' }],
      ['str_replace_based_edit_tool', { command: 'view', path: 'src/main.js' }],
      ['str_replace_based_edit_tool', { command: 'patch', path: 'src/main.js' }],
      ['playtest_game', undefined],
    ];

    const activities = calls
      .map(([tool, args]) => describeActivity(tool, args))
      .filter((activity): activity is Activity => activity !== null);
    const steps = collapseSteps(activities);

    // The views vanish; what remains is the story of the build.
    expect(steps.map((step) => step.label)).toEqual([
      'Deciding the design',
      'Choosing the engine',
      'Making sound effects',
      'Writing main.js',
      'Playing it to check',
    ]);
    expect(steps[2]?.count).toBe(2);
  });
});
