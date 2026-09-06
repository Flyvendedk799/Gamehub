/**
 * S11 — same-origin realtime relay for netplay.
 *
 * Games connect to `wss?://<game-host>/rt?room=…` (connect-src 'self').
 * This module is the pure room/state logic; the API mounts it on a WebSocket
 * route. No third-party hosts, no wildcard connect-src.
 */

export interface RtClient {
  id: string;
  room: string;
  send(data: string): void;
}

export interface RtRoom {
  id: string;
  hostId: string;
  clients: Map<string, RtClient>;
  state: Map<string, unknown>;
}

export class RtRelay {
  private readonly rooms = new Map<string, RtRoom>();
  private seq = 0;

  join(roomId: string, send: (data: string) => void): RtClient {
    const id = `p${++this.seq}`;
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, hostId: id, clients: new Map(), state: new Map() };
      this.rooms.set(roomId, room);
    }
    const client: RtClient = { id, room: roomId, send };
    room.clients.set(id, client);
    client.send(
      JSON.stringify({
        type: 'welcome',
        playerId: id,
        isHost: room.hostId === id,
        state: Object.fromEntries(room.state),
      }),
    );
    return client;
  }

  leave(client: RtClient): void {
    const room = this.rooms.get(client.room);
    if (!room) return;
    room.clients.delete(client.id);
    if (room.clients.size === 0) {
      this.rooms.delete(client.room);
      return;
    }
    if (room.hostId === client.id) {
      const next = room.clients.keys().next().value;
      if (typeof next === 'string') room.hostId = next;
    }
  }

  /** Apply a sync message from a client and broadcast the room state. */
  handleMessage(client: RtClient, raw: string): void {
    let msg: { type?: string; key?: string; value?: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string; key?: string; value?: unknown };
    } catch {
      return;
    }
    if (msg.type !== 'sync' || typeof msg.key !== 'string') return;
    const room = this.rooms.get(client.room);
    if (!room) return;
    room.state.set(msg.key, msg.value);
    const payload = JSON.stringify({
      type: 'sync',
      state: Object.fromEntries(room.state),
      from: client.id,
    });
    for (const peer of room.clients.values()) {
      peer.send(payload);
    }
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
