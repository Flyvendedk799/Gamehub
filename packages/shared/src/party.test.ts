import { describe, expect, it } from 'vitest';
import {
  GRAND_PRIX_POINTS,
  PARTY_BASE32_ALPHABET,
  PARTY_CODE_LENGTH,
  PartyMemberSchema,
  PartyRoomSchema,
  PlaylistConfigSchema,
  RoomState,
} from './party';

describe('Party Shared Contracts', () => {
  it('defines Base32 safe alphabet without 0, O, 1, I, L', () => {
    expect(PARTY_CODE_LENGTH).toBe(6);
    expect(PARTY_BASE32_ALPHABET).not.toContain('0');
    expect(PARTY_BASE32_ALPHABET).not.toContain('O');
    expect(PARTY_BASE32_ALPHABET).not.toContain('1');
    expect(PARTY_BASE32_ALPHABET).not.toContain('I');
    expect(PARTY_BASE32_ALPHABET).not.toContain('L');
    expect(PARTY_BASE32_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
  });

  it('validates Grand Prix placement points', () => {
    expect(GRAND_PRIX_POINTS[1]).toBe(10);
    expect(GRAND_PRIX_POINTS[2]).toBe(7);
    expect(GRAND_PRIX_POINTS[3]).toBe(5);
    expect(GRAND_PRIX_POINTS[4]).toBe(3);
    expect(GRAND_PRIX_POINTS[5]).toBe(1);
    expect(GRAND_PRIX_POINTS[8]).toBe(1);
  });

  it('parses valid PartyMember and PartyRoom schemas', () => {
    const member = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      displayName: 'CaptainAlex',
      avatarId: 'fox',
      avatarColor: '#ff5500',
      role: 'HOST' as const,
      status: 'CONNECTED' as const,
      isHost: true,
      score: 10,
      currentRoundScore: 10,
      hasVetoAvailable: true,
      pingMs: 25,
      joinedAt: 1700000000000,
    };
    expect(PartyMemberSchema.parse(member)).toEqual(member);

    const room = {
      roomId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      roomCode: '234567',
      title: 'Awesome Party',
      isPrivate: false,
      maxActivePlayers: 8,
      allowSpectators: true,
      soundBitesEnabled: true,
      state: 'LOBBY' as const,
      hostId: member.id,
      members: { [member.id]: member },
      playlist: {
        mode: 'POINTS_GAUNTLET' as const,
        totalRounds: 5,
        currentRoundIndex: 0,
        selectionStrategy: 'DEMOCRATIC_VOTE' as const,
        intermissionDurationSec: 10,
      },
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    expect(PartyRoomSchema.parse(room)).toMatchObject({
      roomId: room.roomId,
      roomCode: '234567',
    });
  });
});
