import { InMemoryEventBus } from '@playforge/bus';
import { describe, expect, it } from 'vitest';
import { HeaderAuthenticator } from '../auth';
import { InMemoryProjectRepo } from '../repo';
import { InMemoryRunRepo } from '../run-repo';
import { buildServer } from '../server';

describe('Party Mode - Server Integration Tests', () => {
  function makeApp() {
    return buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
    });
  }

  it('mounts party REST routes on both /api/v1/party and /v1/party in buildServer', async () => {
    const app = makeApp();

    // 1. Create room on /api/v1/party/rooms
    const createRes1 = await app.inject({
      method: 'POST',
      url: '/api/v1/party/rooms',
      payload: { title: 'Lobby 1', hostName: 'Host1' },
    });
    expect(createRes1.statusCode).toBe(201);
    const body1 = createRes1.json();
    expect(body1.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

    // 2. Resolve room on /v1/party/rooms/:code
    const getRes1 = await app.inject({
      method: 'GET',
      url: `/v1/party/rooms/${body1.roomCode}`,
    });
    expect(getRes1.statusCode).toBe(200);
    expect(getRes1.json().title).toBe('Lobby 1');

    // 3. Create room on /v1/party/rooms
    const createRes2 = await app.inject({
      method: 'POST',
      url: '/v1/party/rooms',
      payload: { title: 'Lobby 2', hostName: 'Host2' },
    });
    expect(createRes2.statusCode).toBe(201);
    const body2 = createRes2.json();

    // 4. Join on /api/v1/party/rooms/:code/join
    const joinRes = await app.inject({
      method: 'POST',
      url: `/api/v1/party/rooms/${body2.roomCode}/join`,
      payload: { displayName: 'PlayerTwo' },
    });
    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().room.members[joinRes.json().memberId].displayName).toBe('PlayerTwo');

    // 5. Query directory on /api/v1/party/directory
    const dirRes = await app.inject({
      method: 'GET',
      url: '/api/v1/party/directory',
    });
    expect(dirRes.statusCode).toBe(200);
    expect(dirRes.json().totalRooms).toBeGreaterThanOrEqual(2);

    // 6. Query directory on /v1/party/directory
    const dirRes2 = await app.inject({
      method: 'GET',
      url: '/v1/party/directory',
    });
    expect(dirRes2.statusCode).toBe(200);
    expect(dirRes2.json().totalRooms).toBeGreaterThanOrEqual(2);
  });
});
