'use client';

/**
 * useCollab — Y.js CRDT document synced over the /v1/projects/:id/collab WebSocket relay.
 *
 * The server is a pure binary relay: it forwards every message to all other peers.
 * Clients implement the standard y-websocket sync protocol (step1/step2) among themselves
 * so late-joiners receive the full document state from existing peers.
 *
 * Usage:
 *   const { doc, awareness, peerCount } = useCollab(projectId);
 *   // doc is a Y.Doc — attach Y.Map, Y.Text, etc.
 *   // awareness carries ephemeral user state (cursor, name).
 *   // peerCount is the number of OTHER peers currently connected.
 */

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { API_WS_BASE } from './config';
import { encodeVarUint, readVarUint } from './varint';

const BASE_WS = API_WS_BASE;

// y-websocket message type constants
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  const payload = new Uint8Array(
    encodeVarUint(MSG_SYNC).length +
    encodeVarUint(SYNC_STEP_1).length +
    encodeVarUint(sv.length).length +
    sv.length,
  );
  let offset = 0;
  const write = (a: Uint8Array) => { payload.set(a, offset); offset += a.length; };
  write(encodeVarUint(MSG_SYNC));
  write(encodeVarUint(SYNC_STEP_1));
  write(encodeVarUint(sv.length));
  write(sv);
  return payload;
}

function encodeSyncStep2(doc: Y.Doc, remoteStateVector: Uint8Array): Uint8Array {
  const update = Y.encodeStateAsUpdate(doc, remoteStateVector);
  const payload = new Uint8Array(
    encodeVarUint(MSG_SYNC).length +
    encodeVarUint(SYNC_STEP_2).length +
    encodeVarUint(update.length).length +
    update.length,
  );
  let offset = 0;
  const write = (a: Uint8Array) => { payload.set(a, offset); offset += a.length; };
  write(encodeVarUint(MSG_SYNC));
  write(encodeVarUint(SYNC_STEP_2));
  write(encodeVarUint(update.length));
  write(update);
  return payload;
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const payload = new Uint8Array(
    encodeVarUint(MSG_SYNC).length +
    encodeVarUint(SYNC_UPDATE).length +
    encodeVarUint(update.length).length +
    update.length,
  );
  let offset = 0;
  const write = (a: Uint8Array) => { payload.set(a, offset); offset += a.length; };
  write(encodeVarUint(MSG_SYNC));
  write(encodeVarUint(SYNC_UPDATE));
  write(encodeVarUint(update.length));
  write(update);
  return payload;
}

function decodeMessage(buf: Uint8Array): { msgType: number; syncType?: number; payload?: Uint8Array } | null {
  try {
    let pos = 0;
    const [msgType, p1] = readVarUint(buf, pos);
    pos = p1;
    if (msgType === MSG_SYNC) {
      const [syncType, p2] = readVarUint(buf, pos);
      pos = p2;
      const [len, p3] = readVarUint(buf, pos);
      pos = p3;
      return { msgType, syncType, payload: buf.slice(pos, pos + len) };
    }
    if (msgType === MSG_AWARENESS) {
      return { msgType, payload: buf.slice(pos) };
    }
    return null;
  } catch {
    return null;
  }
}

export interface CollabState {
  doc: Y.Doc;
  /** Number of OTHER peers currently connected to the same room. */
  peerCount: number;
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
}

export function useCollab(projectId: string | null | undefined): CollabState {
  const docRef = useRef<Y.Doc | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [connected, setConnected] = useState(false);

  if (!docRef.current) {
    docRef.current = new Y.Doc();
  }
  const doc = docRef.current;

  useEffect(() => {
    if (!projectId || typeof window === 'undefined') return;

    let ws: WebSocket;
    let destroyed = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (destroyed) return;
      ws = new WebSocket(`${BASE_WS}/v1/projects/${projectId}/collab`);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (destroyed) { ws.close(); return; }
        setConnected(true);
        // Announce ourselves — send sync step1 so peers can reply with their state
        ws.send(encodeSyncStep1(doc));
      };

      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (destroyed) return;
        const raw = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new TextEncoder().encode(String(event.data));

        const decoded = decodeMessage(raw);
        if (!decoded) return;

        if (decoded.msgType === MSG_SYNC) {
          if (decoded.syncType === SYNC_STEP_1 && decoded.payload) {
            // A peer wants our state — respond with step2 (our diff vs their vector)
            ws.send(encodeSyncStep2(doc, decoded.payload));
          } else if ((decoded.syncType === SYNC_STEP_2 || decoded.syncType === SYNC_UPDATE) && decoded.payload) {
            // Apply incoming update silently (origin='remote' to suppress re-broadcast loop)
            Y.applyUpdate(doc, decoded.payload, 'remote');
          }
        } else if (decoded.msgType === MSG_AWARENESS && decoded.payload) {
          // Awareness messages carry peer count (length of awareness states).
          // Each peer corresponds to one entry in the awareness update.
          // We count by the number of clients minus ourselves.
          try {
            const [count] = readVarUint(decoded.payload, 0);
            setPeerCount(Math.max(0, count - 1));
          } catch {
            // ignore malformed awareness
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!destroyed) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    // Forward local doc updates to peers (skip if origin is 'remote' to avoid echo)
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(encodeSyncUpdate(update));
      }
    };
    doc.on('update', onUpdate);

    connect();

    return () => {
      destroyed = true;
      doc.off('update', onUpdate);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [projectId, doc]);

  return { doc, peerCount, connected };
}
