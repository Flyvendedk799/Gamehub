'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_WS_BASE } from '../config';
import { partyAudio } from './PartyAudioBank';
import {
  type ChatMessage,
  type FloatingReaction,
  PARTY_RATE_LIMITS,
  type PartyMember,
  type PartyOpCode,
  type PartyRoom,
  type PartySession,
  type PartySocketMessage,
  type RoomState,
  type SoundBiteId,
} from './party-types';

export type SocketConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface UsePartySocketOptions {
  session: PartySession | null;
  onRoomStateChange?: (state: RoomState) => void;
  onError?: (code: string, message: string) => void;
}

export interface UsePartySocketReturn {
  connectionState: SocketConnectionState;
  room: PartyRoom | null;
  currentMember: PartyMember | null;
  members: PartyMember[];
  pingMs: number;
  votingRemainingSec: number | null;
  countdownValue: number | null;
  activeMinigameId: string | null;
  chatMessages: ChatMessage[];
  floatingReactions: FloatingReaction[];
  comboBlastActive: boolean;
  disconnectedMembersInGrace: PartyMember[];
  errorMessage: string | null;
  // Actions
  setReady: (ready: boolean) => void;
  castVote: (gameId: string) => void;
  triggerVeto: () => void;
  sendEmoji: (emoji: string) => boolean;
  sendSound: (soundId: SoundBiteId) => boolean;
  sendChat: (text: string) => void;
  startMatch: () => void;
  skipIntermission: () => void;
  requestRematch: () => void;
  kickPlayer: (targetMemberId: string) => void;
  leaveRoom: () => void;
}

export function usePartySocket({
  session,
  onRoomStateChange,
  onError,
}: UsePartySocketOptions): UsePartySocketReturn {
  const [connectionState, setConnectionState] = useState<SocketConnectionState>('idle');
  const [room, setRoom] = useState<PartyRoom | null>(null);
  const [pingMs, setPingMs] = useState(25);
  const [votingRemainingSec, setVotingRemainingSec] = useState<number | null>(null);
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const [activeMinigameId, setActiveMinigameId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [comboBlastActive, setComboBlastActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const pingStartRef = useRef<number>(0);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const emojiHistoryRef = useRef<number[]>([]);
  const comboTrackerRef = useRef<{ timestamp: number; memberId: string }[]>([]);
  const comboBlastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Derive current player & member list
  const members: PartyMember[] = room ? (Object.values(room.members) as PartyMember[]) : [];
  const currentMember = session && room ? (room.members[session.memberId] ?? null) : null;

  // Track members in disconnected grace
  const disconnectedMembersInGrace = members.filter(
    (m: PartyMember) => m.status === 'DISCONNECTED_GRACE',
  );

  // Send message helper
  const sendMessage = useCallback(
    (op: PartyOpCode, payload: unknown = {}) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return false;
      }
      seqRef.current += 1;
      const msg: PartySocketMessage = {
        op,
        seq: seqRef.current,
        timestamp: Date.now(),
        roomId: session?.roomId || '',
        payload,
      };
      try {
        socketRef.current.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
    [session?.roomId],
  );

  // Handle incoming message
  const handleIncomingMessage = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: dynamic incoming WebSocket message
    (msg: PartySocketMessage<any>) => {
      const { op, payload } = msg;

      switch (op) {
        case 'room.snapshot':
          if (payload?.room) {
            setRoom(payload.room);
            if (payload.room.activeMinigameId) {
              setActiveMinigameId(payload.room.activeMinigameId);
            }
            if (payload.room.votingState) {
              const rem = Math.max(
                0,
                Math.ceil((payload.room.votingState.expiresAt - Date.now()) / 1000),
              );
              setVotingRemainingSec(rem);
            }
            onRoomStateChange?.(payload.room.state);
          }
          break;

        case 'room.player_joined':
        case 'room.player_updated':
          if (payload?.member) {
            setRoom((prev: PartyRoom | null) => {
              if (!prev) return prev;
              return {
                ...prev,
                members: {
                  ...prev.members,
                  [payload.member.id]: payload.member,
                },
              };
            });
          }
          break;

        case 'room.player_left':
          if (payload?.memberId) {
            setRoom((prev: PartyRoom | null) => {
              if (!prev) return prev;
              const nextMembers = { ...prev.members };
              delete nextMembers[payload.memberId];
              return {
                ...prev,
                members: nextMembers,
              };
            });
          }
          break;

        case 'room.state_changed':
          if (payload?.state) {
            setRoom((prev: PartyRoom | null) => (prev ? { ...prev, state: payload.state } : prev));
            onRoomStateChange?.(payload.state);
            if (payload.state === 'LOBBY') {
              setVotingRemainingSec(null);
              setCountdownValue(null);
              setActiveMinigameId(null);
            }
          }
          break;

        case 'voting.started':
          if (payload?.votingState) {
            setRoom((prev: PartyRoom | null) =>
              prev
                ? { ...prev, votingState: payload.votingState, state: 'GAME_SELECT_VOTING' }
                : prev,
            );
            setVotingRemainingSec(15);
          }
          break;

        case 'voting.tick':
          if (typeof payload?.remainingSec === 'number') {
            setVotingRemainingSec(payload.remainingSec);
          }
          if (payload?.votingState) {
            setRoom((prev: PartyRoom | null) =>
              prev ? { ...prev, votingState: payload.votingState } : prev,
            );
          }
          break;

        case 'voting.resolved':
          if (payload?.winningGameId) {
            setActiveMinigameId(payload.winningGameId);
            setVotingRemainingSec(null);
          }
          break;

        case 'countdown.tick':
          if (typeof payload?.count === 'number') {
            setCountdownValue(payload.count);
            setRoom((prev: PartyRoom | null) => (prev ? { ...prev, state: 'COUNTDOWN' } : prev));
          }
          break;

        case 'game.launch':
          if (payload?.gameId) {
            setActiveMinigameId(payload.gameId);
            setCountdownValue(null);
            setRoom((prev: PartyRoom | null) =>
              prev ? { ...prev, state: 'IN_GAME', activeMinigameId: payload.gameId } : prev,
            );
          }
          break;

        case 'round.finished':
          setRoom((prev: PartyRoom | null) => {
            if (!prev) return prev;
            return {
              ...prev,
              state: 'ROUND_OVER',
              ...(payload?.roomSnapshot ? payload.roomSnapshot : {}),
            };
          });
          break;

        case 'podium.announced':
          setRoom((prev: PartyRoom | null) => {
            if (!prev) return prev;
            return {
              ...prev,
              state: 'PODIUM_CELEBRATION',
              podiumState: payload?.podiumState ?? prev.podiumState,
            };
          });
          break;

        case 'broadcast.reaction': {
          const emoji = payload?.emoji || '❤️';
          const senderId = payload?.memberId || '';
          const senderName = payload?.displayName || 'Player';
          const now = Date.now();

          // Particle placement: strictly in outer 15% gutters (0-15% or 85-100%)
          const gutter = Math.random() > 0.5 ? 'left' : 'right';
          const xPercent = gutter === 'left' ? Math.random() * 12 + 2 : Math.random() * 12 + 86;

          const newReaction: FloatingReaction = {
            id: `rx-${now}-${Math.random().toString(36).substring(2, 7)}`,
            emoji,
            senderId,
            senderName,
            gutter,
            xPercent,
            createdAt: now,
          };

          setFloatingReactions((prev) => [...prev.slice(-30), newReaction]);

          // Combo Blast detection: 3+ players sending 🔥 in 1 second
          if (emoji === '🔥') {
            comboTrackerRef.current.push({ timestamp: now, memberId: senderId });
            // Clean older than 1000ms
            comboTrackerRef.current = comboTrackerRef.current.filter(
              (c) => now - c.timestamp <= 1000,
            );
            const distinctMembers = new Set(comboTrackerRef.current.map((c) => c.memberId));
            if (distinctMembers.size >= 3) {
              setComboBlastActive(true);
              if (comboBlastTimeoutRef.current) clearTimeout(comboBlastTimeoutRef.current);
              comboBlastTimeoutRef.current = setTimeout(() => {
                setComboBlastActive(false);
              }, 2500);
            }
          }
          break;
        }

        case 'broadcast.sound':
          if (payload?.soundId) {
            partyAudio.playSoundBite(payload.soundId as SoundBiteId, true);
          }
          break;

        case 'broadcast.chat':
          if (payload?.message) {
            const chatMsg: ChatMessage = {
              id:
                payload.message.id ||
                `chat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              senderId: payload.message.memberId || '',
              senderName: payload.message.displayName || 'Player',
              avatarId: payload.message.avatarId || 'fox',
              avatarColor: payload.message.avatarColor || '#6366f1',
              text: payload.message.text || '',
              timestamp: payload.message.timestamp || Date.now(),
            };
            setChatMessages((prev) => [...prev.slice(-49), chatMsg]);
          }
          break;

        case 'room.host_migrated':
          if (payload?.newHostId) {
            setRoom((prev: PartyRoom | null) => {
              if (!prev) return prev;
              const nextMembers = { ...prev.members };
              for (const id of Object.keys(nextMembers)) {
                const m = nextMembers[id];
                if (m) {
                  nextMembers[id] = { ...m, isHost: m.id === payload.newHostId };
                }
              }
              return { ...prev, hostId: payload.newHostId, members: nextMembers };
            });
          }
          break;

        case 'room.error':
          setErrorMessage(payload?.message || payload?.code || 'Room error');
          onError?.(payload?.code || 'ROOM_ERROR', payload?.message || 'Room error');
          break;
      }
    },
    [onRoomStateChange, onError],
  );

  // Connect WebSocket
  useEffect(() => {
    if (!session?.roomCode || !session?.sessionToken) {
      setConnectionState('idle');
      return;
    }

    let isUnmounted = false;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    function connect() {
      if (isUnmounted) return;
      setConnectionState((prev) => (prev === 'idle' ? 'connecting' : 'reconnecting'));

      const wsUrl = `${API_WS_BASE}/ws/party?token=${encodeURIComponent(
        session?.sessionToken ?? '',
      )}&code=${encodeURIComponent(session?.roomCode ?? '')}`;

      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        if (isUnmounted) return;
        setConnectionState('connected');
        reconnectAttemptsRef.current = 0;
        setErrorMessage(null);

        // Immediate handshake
        sendMessage('party.join', {
          sessionToken: session?.sessionToken,
          roomCode: session?.roomCode,
        });

        // Start 5s heartbeat
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            pingStartRef.current = Date.now();
            try {
              ws.send(JSON.stringify({ op: 'ping', timestamp: pingStartRef.current }));
            } catch {
              // ignore
            }
          }
        }, PARTY_RATE_LIMITS.PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (isUnmounted) return;
        try {
          const data = JSON.parse(event.data);
          if (data.op === 'pong') {
            const rtt = Math.max(1, Date.now() - pingStartRef.current);
            setPingMs(rtt);
            return;
          }
          handleIncomingMessage(data);
        } catch {
          // ignore
        }
      };

      ws.onclose = (event) => {
        if (isUnmounted) return;
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);

        if (event.code === 1000) {
          setConnectionState('disconnected');
          return;
        }

        setConnectionState('reconnecting');
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 5000);
        reconnectAttemptsRef.current += 1;
        reconnectTimeout = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (isUnmounted) return;
        setConnectionState('error');
      };
    }

    connect();

    return () => {
      isUnmounted = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (socketRef.current) {
        socketRef.current.close(1000, 'Component unmounted');
        socketRef.current = null;
      }
    };
  }, [session?.roomCode, session?.sessionToken, sendMessage, handleIncomingMessage]);

  // Clean reaction particles after 3.5s
  useEffect(() => {
    if (floatingReactions.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setFloatingReactions((prev) => prev.filter((r) => now - r.createdAt < 3500));
    }, 500);
    return () => clearInterval(interval);
  }, [floatingReactions.length]);

  // Client actions
  const setReady = useCallback(
    (ready: boolean) => {
      sendMessage('party.ready', { ready });
    },
    [sendMessage],
  );

  const castVote = useCallback(
    (gameId: string) => {
      sendMessage('party.vote', { gameId });
    },
    [sendMessage],
  );

  const triggerVeto = useCallback(() => {
    partyAudio.playVetoSound();
    sendMessage('party.veto', {});
  }, [sendMessage]);

  const sendEmoji = useCallback(
    (emoji: string) => {
      const now = Date.now();
      // Rate limit: max 3/s
      emojiHistoryRef.current = emojiHistoryRef.current.filter((t) => now - t < 1000);
      if (emojiHistoryRef.current.length >= PARTY_RATE_LIMITS.MAX_EMOJIS_PER_SEC) {
        return false;
      }
      emojiHistoryRef.current.push(now);
      partyAudio.playPop();
      return sendMessage('party.emoji', { emoji });
    },
    [sendMessage],
  );

  const sendSound = useCallback(
    (soundId: SoundBiteId) => {
      if (!partyAudio.canPlaySoundBite()) {
        return false;
      }
      partyAudio.playSoundBite(soundId);
      return sendMessage('party.sound', { soundId });
    },
    [sendMessage],
  );

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      sendMessage('party.chat', { text: trimmed });
    },
    [sendMessage],
  );

  const startMatch = useCallback(() => {
    partyAudio.playUiClick();
    sendMessage('party.start_match', {});
  }, [sendMessage]);

  const skipIntermission = useCallback(() => {
    partyAudio.playUiClick();
    sendMessage('party.skip_intermission', {});
  }, [sendMessage]);

  const requestRematch = useCallback(() => {
    partyAudio.playUiClick();
    sendMessage('party.rematch', {});
  }, [sendMessage]);

  const kickPlayer = useCallback(
    (targetMemberId: string) => {
      sendMessage('party.kick_player', { targetMemberId });
    },
    [sendMessage],
  );

  const leaveRoom = useCallback(() => {
    sendMessage('party.leave', {});
    if (socketRef.current) {
      socketRef.current.close(1000, 'Left room');
    }
  }, [sendMessage]);

  return {
    connectionState,
    room,
    currentMember,
    members,
    pingMs,
    votingRemainingSec,
    countdownValue,
    activeMinigameId,
    chatMessages,
    floatingReactions,
    comboBlastActive,
    disconnectedMembersInGrace,
    errorMessage,
    setReady,
    castVote,
    triggerVeto,
    sendEmoji,
    sendSound,
    sendChat,
    startMatch,
    skipIntermission,
    requestRematch,
    kickPlayer,
    leaveRoom,
  };
}
