import { PARTY_RATE_LIMITS } from '@playforge/shared';

/**
 * Sliding window rate limiter for counting events within a rolling time window.
 */
export class SlidingWindowRateLimiter {
  private readonly events = new Map<string, number[]>();

  /**
   * Checks whether the request is within `maxRequests` over `windowMs`.
   * Returns true if allowed, false if limit exceeded.
   */
  check(key: string, maxRequests: number, windowMs: number, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    let timestamps = this.events.get(key);

    if (!timestamps) {
      timestamps = [now];
      this.events.set(key, timestamps);
      return true;
    }

    // Filter out expired timestamps
    const active = timestamps.filter((t) => t > cutoff);
    if (active.length >= maxRequests) {
      this.events.set(key, active);
      return false;
    }

    active.push(now);
    this.events.set(key, active);
    return true;
  }

  reset(key?: string): void {
    if (key) {
      this.events.delete(key);
    } else {
      this.events.clear();
    }
  }
}

/**
 * Cooldown rate limiter for actions that require a minimum gap between triggers.
 */
export class CooldownRateLimiter {
  private readonly lastTriggered = new Map<string, number>();

  /**
   * Checks whether at least `cooldownMs` has elapsed since the last trigger.
   * Returns true and records `now` if allowed, false if cooldown still active.
   */
  check(key: string, cooldownMs: number, now = Date.now()): boolean {
    const last = this.lastTriggered.get(key);
    if (last !== undefined && now - last < cooldownMs) {
      return false;
    }
    this.lastTriggered.set(key, now);
    return true;
  }

  getRemainingCooldown(key: string, cooldownMs: number, now = Date.now()): number {
    const last = this.lastTriggered.get(key);
    if (last === undefined) return 0;
    const remaining = cooldownMs - (now - last);
    return remaining > 0 ? remaining : 0;
  }

  reset(key?: string): void {
    if (key) {
      this.lastTriggered.delete(key);
    } else {
      this.lastTriggered.clear();
    }
  }
}

/**
 * PartyRateLimiter bundles per-connection and per-player rate limit rules:
 * - Socket messages: 20 msgs/sec per connection
 * - Emojis: 3 emojis/sec per player
 * - Sound bites: 1 sound per 4 seconds per player
 */
export class PartyRateLimiter {
  private readonly socketLimiter = new SlidingWindowRateLimiter();
  private readonly emojiLimiter = new SlidingWindowRateLimiter();
  private readonly soundLimiter = new CooldownRateLimiter();

  checkSocketMessage(
    connectionId: string,
    maxMsgs = PARTY_RATE_LIMITS.MAX_SOCKET_MSGS_PER_SEC,
    now = Date.now(),
  ): boolean {
    return this.socketLimiter.check(connectionId, maxMsgs, 1000, now);
  }

  checkEmoji(
    memberId: string,
    maxEmojis = PARTY_RATE_LIMITS.MAX_EMOJIS_PER_SEC,
    now = Date.now(),
  ): boolean {
    return this.emojiLimiter.check(memberId, maxEmojis, 1000, now);
  }

  checkSound(
    memberId: string,
    cooldownMs = PARTY_RATE_LIMITS.SOUND_COOLDOWN_MS,
    now = Date.now(),
  ): boolean {
    return this.soundLimiter.check(memberId, cooldownMs, now);
  }

  getRemainingSoundCooldown(
    memberId: string,
    cooldownMs = PARTY_RATE_LIMITS.SOUND_COOLDOWN_MS,
    now = Date.now(),
  ): number {
    return this.soundLimiter.getRemainingCooldown(memberId, cooldownMs, now);
  }

  cleanupConnection(connectionId: string): void {
    this.socketLimiter.reset(connectionId);
  }

  cleanupMember(memberId: string): void {
    this.emojiLimiter.reset(memberId);
    this.soundLimiter.reset(memberId);
  }

  reset(): void {
    this.socketLimiter.reset();
    this.emojiLimiter.reset();
    this.soundLimiter.reset();
  }
}
