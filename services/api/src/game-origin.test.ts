import { describe, expect, it } from 'vitest';
import { projectGameOrigin, readPreviewTicket, signPreviewTicket } from './game-origin';

describe('isolated game origins and scoped preview authorization', () => {
  it('separates projects and refuses non-origin/insecure configuration', () => {
    expect(projectGameOrigin('https://games.example.com', 'a')).not.toBe(
      projectGameOrigin('https://games.example.com', 'b'),
    );
    expect(() => projectGameOrigin('http://games.example.com', 'a')).toThrow();
    expect(() => projectGameOrigin('https://games.example.com/path', 'a')).toThrow();
  });
  it('rejects expired, tampered and differently signed tickets', () => {
    const ticket = {
      projectId: 'a',
      manifestKey: 'manifests/hash.json',
      engine: 'phaser' as const,
      expiresAt: 1000,
    };
    const signed = signPreviewTicket(ticket, 'secret');
    expect(readPreviewTicket(signed, 'secret', 999)).toEqual(ticket);
    expect(readPreviewTicket(signed, 'secret', 1000)).toBeNull();
    expect(readPreviewTicket(`${signed}x`, 'secret', 999)).toBeNull();
    expect(readPreviewTicket(signed, 'different', 999)).toBeNull();
  });
});
