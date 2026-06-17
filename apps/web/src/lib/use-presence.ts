'use client';

/**
 * usePresence — connects to GET /v1/projects/:id/presence (WebSocket).
 *
 * Tracks how many people are viewing the project and fires onPreviewUpdated
 * whenever another collaborator's run completes (preview_updated event),
 * so the local preview pane can auto-reload.
 */

import { useEffect, useRef, useState } from 'react';
import { API_WS_BASE } from './config';

const BASE_WS = API_WS_BASE;

interface PresenceMessage {
  type: string;
  projectId?: string;
  count?: number;
  previewUrl?: string;
}

export interface PresenceState {
  /** Number of viewers currently connected to this project (including self). */
  viewerCount: number;
  /** Whether the presence WebSocket is connected. */
  connected: boolean;
}

export function usePresence(
  projectId: string | null | undefined,
  opts?: {
    /** Called when another collaborator's generation completes with a new preview URL. */
    onPreviewUpdated?: (previewUrl: string) => void;
  },
): PresenceState {
  const [viewerCount, setViewerCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!projectId || typeof window === 'undefined') return;

    let destroyed = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (destroyed) return;
      const ws = new WebSocket(`${BASE_WS}/v1/projects/${projectId}/presence`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (destroyed) { ws.close(); return; }
        setConnected(true);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (destroyed) return;
        try {
          const msg = JSON.parse(event.data) as PresenceMessage;
          if (msg.type === 'presence' && typeof msg.count === 'number') {
            setViewerCount(msg.count);
          } else if (msg.type === 'preview_updated' && msg.previewUrl) {
            optsRef.current?.onPreviewUpdated?.(msg.previewUrl);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setViewerCount(0);
        if (!destroyed) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => { ws.close(); };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [projectId]);

  return { viewerCount, connected };
}
