import { describe, expect, it } from 'vitest';
import { PartyRateLimiter } from './rate-limiter';

describe('Party Rate Limiter', () => {
  it('enforces 20 socket messages per second per connection', () => {
    const limiter = new PartyRateLimiter();
    const connId = 'conn-123';
    const now = 10000;

    for (let i = 0; i < 20; i++) {
      expect(limiter.checkSocketMessage(connId, 20, now)).toBe(true);
    }
    // 21st message in the same second should be blocked
    expect(limiter.checkSocketMessage(connId, 20, now)).toBe(false);

    // After 1000ms window rolls over, messages are allowed again
    expect(limiter.checkSocketMessage(connId, 20, now + 1001)).toBe(true);
  });

  it('enforces 3 emojis per second per player', () => {
    const limiter = new PartyRateLimiter();
    const memberId = 'player-456';
    const now = 20000;

    expect(limiter.checkEmoji(memberId, 3, now)).toBe(true);
    expect(limiter.checkEmoji(memberId, 3, now)).toBe(true);
    expect(limiter.checkEmoji(memberId, 3, now)).toBe(true);
    // 4th emoji in same second blocked
    expect(limiter.checkEmoji(memberId, 3, now)).toBe(false);

    // After 1000ms, allowed again
    expect(limiter.checkEmoji(memberId, 3, now + 1001)).toBe(true);
  });

  it('enforces 1 sound bite per 4 seconds per player cooldown', () => {
    const limiter = new PartyRateLimiter();
    const memberId = 'player-789';
    const now = 30000;

    // First sound allowed
    expect(limiter.checkSound(memberId, 4000, now)).toBe(true);

    // Immediate repeat blocked
    expect(limiter.checkSound(memberId, 4000, now + 1000)).toBe(false);
    expect(limiter.checkSound(memberId, 4000, now + 3999)).toBe(false);
    expect(limiter.getRemainingSoundCooldown(memberId, 4000, now + 2500)).toBe(1500);

    // After 4000ms, allowed again
    expect(limiter.checkSound(memberId, 4000, now + 4000)).toBe(true);
  });
});
