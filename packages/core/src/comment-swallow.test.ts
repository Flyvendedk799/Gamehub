import { describe, expect, it } from 'vitest';
import { commentSwallowRefusal } from './comment-swallow.js';

const SRC = ['window.__game.debug.track({', '  opponentHp: () => enemy.hp,', '});'].join('\n');

describe('commentSwallowRefusal', () => {
  it('refuses the run 8db3aa61 edit: a token replaced by a line comment in front of live code', () => {
    expect(commentSwallowRefusal(SRC, 'opponentHp', '// playtest fix')).toMatch(/Refusing/);
  });

  it('allows a comment at the end of a line, and a replacement without one', () => {
    expect(commentSwallowRefusal(SRC, 'enemy.hp,', 'enemy.hp, // live')).toBeNull();
    expect(commentSwallowRefusal(SRC, 'opponentHp', 'enemyHp')).toBeNull();
  });

  it('allows adding a whole comment line', () => {
    expect(commentSwallowRefusal(SRC, '});', '// done\n});')).toBeNull();
  });

  it('allows an edit whose old text already contained the comment', () => {
    expect(commentSwallowRefusal('a(); // old', '// old', '// new')).toBeNull();
  });
});
